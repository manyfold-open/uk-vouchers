/**
 * The verifiers' side. A verifier leases open tasks (never for records its own token sent),
 * checks each record against its source, and sends one verdict per task:
 *
 *   verified   the source states the offer as recorded (corrections allowed) → public, level L1
 *   rejected   the page opened and does not support the record
 *   duplicate  the same offer is already live (duplicate_of)
 *   expired    the offer has ended or been withdrawn
 *   unsure     could not decide; reason says why. A page that would not open is always
 *              "unsure", never grounds to reject. The task goes to another verifier, and
 *              after two verifiers could not decide, to the admin.
 *
 * Recheck tasks run the same way for records already public: verified keeps them public,
 * anything else takes them down as expired.
 */

import { suspendIfFailing, type Token } from './tokens.ts';
import { HttpError, newId, nowIso, plusMinutes } from './util.ts';
import { addDays, identityKey, today, validateVoucher, type Voucher } from './voucher.ts';

export const LEASE_MINUTES = 30;
export const LEASE_MAX = 10;
export const UNSURE_LIMIT = 2;
/** Verified records are checked again this often. Coupons change fast. */
export const RECHECK_HOURS = 24;

const VERDICTS = ['verified', 'rejected', 'duplicate', 'expired', 'unsure'] as const;
type Verdict = (typeof VERDICTS)[number];

interface TaskRow {
  id: string;
  voucher_id: string;
  kind: 'verify' | 'recheck';
  status: string;
  leased_by: string | null;
  lease_until: string | null;
  skip_tokens: string;
}

export async function releaseExpiredLeases(db: D1Database, now = new Date()) {
  await db
    .prepare("UPDATE tasks SET status = 'open', leased_by = NULL, lease_until = NULL WHERE status = 'leased' AND lease_until < ?")
    .bind(nowIso(now))
    .run();
}

export async function leaseTasks(db: D1Database, token: Token, limit = LEASE_MAX, now = new Date()) {
  await releaseExpiredLeases(db, now);
  const want = Math.max(1, Math.min(LEASE_MAX, Math.floor(limit) || LEASE_MAX));
  const until = plusMinutes(now, LEASE_MINUTES);

  const held = await db
    .prepare("SELECT COUNT(*) AS n FROM tasks WHERE status = 'leased' AND leased_by = ?")
    .bind(token.id)
    .first<{ n: number }>();
  const room = Math.max(0, want - (held?.n ?? 0));

  if (room > 0) {
    const { results: open } = await db
      .prepare(
        `SELECT t.id FROM tasks t JOIN vouchers v ON v.id = t.voucher_id
         WHERE t.status = 'open' AND v.submitted_by != ? AND v.flagged = 0
           AND NOT EXISTS (SELECT 1 FROM json_each(t.skip_tokens) WHERE json_each.value = ?)
         ORDER BY CASE t.kind WHEN 'recheck' THEN 0 ELSE 1 END, t.created_at
         LIMIT ?`,
      )
      .bind(token.id, token.id, room)
      .all<{ id: string }>();
    if (open.length) {
      await db.batch(
        open.map((t) =>
          db
            .prepare("UPDATE tasks SET status = 'leased', leased_by = ?, lease_until = ? WHERE id = ? AND status = 'open'")
            .bind(token.id, until, t.id),
        ),
      );
    }
  }

  const { results } = await db
    .prepare(
      `SELECT t.id AS task_id, t.kind, t.lease_until, t.note, v.id AS voucher_id, v.status, v.data_json, v.source_url,
              v.evidence, v.quote_found, v.verified_at
       FROM tasks t JOIN vouchers v ON v.id = t.voucher_id
       WHERE t.status = 'leased' AND t.leased_by = ? ORDER BY t.created_at`,
    )
    .bind(token.id)
    .all<Record<string, unknown>>();
  return results.map((r) => ({
    task_id: r.task_id,
    kind: r.kind,
    lease_until: r.lease_until,
    note: r.note ?? null,
    voucher: {
      id: r.voucher_id,
      status: r.status,
      data: JSON.parse(r.data_json as string),
      source_url: r.source_url,
      evidence: r.evidence,
      quote_found_by_server: r.quote_found === null ? null : r.quote_found === 1,
      verified_at: r.verified_at,
    },
  }));
}

export type VerdictResult = { index: number; task_id: string; result: 'applied' | 'invalid'; status?: string; errors?: string[] };

export async function applyVerdicts(db: D1Database, token: Token, body: unknown, now = new Date()): Promise<VerdictResult[]> {
  const verdicts = (body as { verdicts?: unknown })?.verdicts;
  if (!Array.isArray(verdicts) || verdicts.length === 0) {
    throw new HttpError(400, 'Send {"verdicts": [{"task_id": "...", "verdict": "verified", "reason": "..."}]}.');
  }
  if (verdicts.length > 20) throw new HttpError(413, 'Send at most 20 verdicts per call.');

  const stamp = nowIso(now);
  const out: VerdictResult[] = [];
  const touchedScouts = new Set<string>();

  for (const [index, item] of verdicts.entries()) {
    const v = (item ?? {}) as Record<string, unknown>;
    const taskId = String(v.task_id ?? '');
    const errors: string[] = [];
    const verdict = v.verdict as Verdict;
    if (!VERDICTS.includes(verdict)) errors.push(`verdict must be one of: ${VERDICTS.join(', ')}`);
    const reason = typeof v.reason === 'string' ? v.reason.trim().slice(0, 500) : '';
    if (!reason) errors.push('reason is required: say what you saw on the source page');

    const task = await db.prepare('SELECT * FROM tasks WHERE id = ?').bind(taskId).first<TaskRow>();
    if (!task) errors.push('task_id is not a task');
    else if (task.status !== 'leased' || task.leased_by !== token.id || (task.lease_until ?? '') < stamp) {
      errors.push('this task is not leased to you (or the lease ran out): lease it again from GET /api/tasks');
    }
    const row = task
      ? await db
          .prepare('SELECT id, status, data_json, submitted_by, expires_on FROM vouchers WHERE id = ?')
          .bind(task.voucher_id)
          .first<{ id: string; status: string; data_json: string; submitted_by: string; expires_on: string | null }>()
      : null;
    if (task && !row) errors.push('the record for this task no longer exists');

    // Corrections are re-checked against the same rules as a submit.
    // A verifier may also send a fresh `evidence` passage from the same source page, which
    // lets a correction add a code the scout's quote did not contain.
    let data = row ? (JSON.parse(row.data_json) as Voucher) : null;
    let newEvidence: string | null = null;
    const hasCorrections = v.corrections && typeof v.corrections === 'object';
    const hasEvidence = typeof v.evidence === 'string' && v.evidence.trim() !== '';
    if (data && verdict === 'verified' && (hasCorrections || hasEvidence)) {
      const merged = { ...data, ...(hasCorrections ? (v.corrections as object) : {}) };
      const current = await db.prepare('SELECT source_url, evidence FROM vouchers WHERE id = ?').bind(row!.id).first<{ source_url: string; evidence: string }>();
      const provenance = hasEvidence ? { source_url: current?.source_url, evidence: v.evidence } : current;
      const checked = validateVoucher(merged, provenance, now);
      if (!checked.ok) errors.push(...checked.errors.map((e) => `${e.field === 'evidence' ? 'evidence' : `corrections.${e.field}`} ${e.message}`));
      else {
        data = checked.voucher;
        if (hasEvidence) newEvidence = checked.provenance.evidence;
      }
    }
    const newKey = data ? identityKey(data) : null;
    if (data && row && newKey) {
      const clash = await db
        .prepare("SELECT id FROM vouchers WHERE identity_key = ? AND id != ? AND status IN ('pending','verified')")
        .bind(newKey, row.id)
        .first<{ id: string }>();
      if (clash && verdict === 'verified') errors.push(`after corrections this record is the same offer as ${clash.id}: send verdict duplicate with duplicate_of instead`);
    }
    let duplicateOf: string | null = null;
    if (verdict === 'duplicate') {
      duplicateOf = typeof v.duplicate_of === 'string' ? v.duplicate_of : null;
      const target = duplicateOf
        ? await db.prepare("SELECT id FROM vouchers WHERE id = ? AND status IN ('pending','verified')").bind(duplicateOf).first()
        : null;
      if (!target || duplicateOf === row?.id) errors.push('duplicate_of must be the id of another live record');
    }

    if (errors.length || !task || !row || !data) {
      out.push({ index, task_id: taskId, result: 'invalid', errors });
      continue;
    }

    const before = { status: row.status, data: JSON.parse(row.data_json) };
    const statements: D1PreparedStatement[] = [];
    let newStatus = row.status;

    if (verdict === 'unsure') {
      const skips: string[] = [...JSON.parse(task.skip_tokens), token.id];
      const toHuman = skips.length >= UNSURE_LIMIT;
      statements.push(
        db
          .prepare('UPDATE tasks SET status = ?, leased_by = NULL, lease_until = NULL, skip_tokens = ?, note = ? WHERE id = ?')
          .bind(toHuman ? 'needs_human' : 'open', JSON.stringify(skips), reason, task.id),
      );
      statements.push(
        db
          .prepare('INSERT INTO revisions (voucher_id, actor, action, before_json, after_json, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .bind(row.id, token.id, 'unsure', JSON.stringify(before), JSON.stringify(before), reason, stamp),
      );
    } else {
      const recheck = task.kind === 'recheck';
      if (verdict === 'verified') newStatus = 'verified';
      else if (recheck || verdict === 'expired') newStatus = 'expired';
      else newStatus = 'rejected';
      const verified = newStatus === 'verified';
      statements.push(
        db
          .prepare(
            `UPDATE vouchers SET status = ?, data_json = ?, identity_key = ?, evidence = COALESCE(?, evidence), expires_on = ?,
               verification_level = ?, verified_at = ?, next_check_at = ?, updated_at = ? WHERE id = ?`,
          )
          .bind(
            newStatus, JSON.stringify(data), newKey, newEvidence, data.expires_on, verified ? 'L1' : null, verified ? stamp : null,
            verified ? new Date(now.getTime() + RECHECK_HOURS * 3_600_000).toISOString() : null, stamp, row.id,
          ),
        db.prepare("UPDATE tasks SET status = 'done', done_at = ?, note = ? WHERE id = ?").bind(stamp, `${verdict}: ${reason}`, task.id),
        db
          .prepare('INSERT INTO revisions (voucher_id, actor, action, before_json, after_json, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .bind(
            row.id, token.id, recheck ? `recheck:${verdict}` : verdict, JSON.stringify(before),
            JSON.stringify({ status: newStatus, data, duplicate_of: duplicateOf }), reason, stamp,
          ),
      );
      touchedScouts.add(row.submitted_by);
    }
    await db.batch(statements);
    out.push({ index, task_id: taskId, result: 'applied', status: newStatus });
  }

  for (const scout of touchedScouts) await suspendIfFailing(db, scout);
  return out;
}

/**
 * Housekeeping, run by the cron and on demand: free expired leases, take down offers past
 * their end date, and queue a recheck for every public record that is due.
 */
export async function maintenance(db: D1Database, now = new Date()) {
  await releaseExpiredLeases(db, now);
  const stamp = nowIso(now);
  const day = today(now);

  const { results: ended } = await db
    .prepare("SELECT id, status, data_json FROM vouchers WHERE status IN ('pending','verified') AND expires_on IS NOT NULL AND expires_on < ?")
    .bind(day)
    .all<{ id: string; status: string; data_json: string }>();
  for (const r of ended) {
    await db.batch([
      db.prepare("UPDATE vouchers SET status = 'expired', updated_at = ? WHERE id = ?").bind(stamp, r.id),
      db.prepare("UPDATE tasks SET status = 'done', done_at = ?, note = 'expired by date' WHERE voucher_id = ? AND status IN ('open','leased','needs_human')").bind(stamp, r.id),
      db
        .prepare("INSERT INTO revisions (voucher_id, actor, action, before_json, after_json, reason, created_at) VALUES (?, 'system', 'expire', ?, ?, 'past expires_on', ?)")
        .bind(r.id, JSON.stringify({ status: r.status }), JSON.stringify({ status: 'expired' }), stamp),
    ]);
  }

  const { results: due } = await db
    .prepare(
      `SELECT v.id FROM vouchers v WHERE v.status = 'verified' AND v.next_check_at <= ?
         AND NOT EXISTS (SELECT 1 FROM tasks t WHERE t.voucher_id = v.id AND t.status IN ('open','leased','needs_human'))
       LIMIT 500`,
    )
    .bind(stamp)
    .all<{ id: string }>();
  if (due.length) {
    await db.batch(
      due.map((r) => db.prepare("INSERT INTO tasks (id, voucher_id, kind, status, created_at) VALUES (?, ?, 'recheck', 'open', ?)").bind(newId('t'), r.id, stamp)),
    );
  }
  return { expired: ended.length, rechecks_queued: due.length, tomorrow: addDays(day, 1) };
}
