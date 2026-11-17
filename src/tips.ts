/**
 * Codes shoppers tell us about ("I used SAVE15 at Boots"). A tip is a lead, never a record:
 * a scout looks for the code on the retailer's own pages and, if it is there, submits it the
 * normal way (so the quote check and a verifier still stand between a tip and the public list).
 * POST /api/tips is public, so it takes short text only, is rate limited per address, and
 * repeat tips for the same retailer and code are counted on one row.
 */

import { HttpError, newId, nowIso } from './util.ts';

export const TIPS_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS tips (
    id TEXT PRIMARY KEY, retailer TEXT NOT NULL, code TEXT NOT NULL, claim TEXT, url TEXT,
    asks INTEGER NOT NULL DEFAULT 1, status TEXT NOT NULL DEFAULT 'open', outcome_note TEXT, voucher_id TEXT,
    leased_by TEXT, lease_until TEXT, resolved_by TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS tips_status ON tips (status, asks, created_at)`,
  `CREATE INDEX IF NOT EXISTS tips_key ON tips (retailer, code)`,
];

export const TIPS_PER_HOUR = 10;
export const TIP_LEASE_MINUTES = 30;
/** What a scout can say about a tip once it has looked. */
export const TIP_OUTCOMES = ['submitted', 'already_live', 'not_found', 'not_a_code'] as const;
type Outcome = (typeof TIP_OUTCOMES)[number];

const CODE = /^[A-Z0-9][A-Z0-9_-]{2,31}$/;
const text = (v: unknown, n: number) => (typeof v === 'string' && v.trim() ? v.trim().replace(/\s+/g, ' ').slice(0, n) : null);

async function limit(db: D1Database, ip: string, now: Date) {
  const hourAgo = new Date(now.getTime() - 3_600_000).toISOString();
  const row = await db.prepare("SELECT COUNT(*) AS n FROM signal_log WHERE ip = ? AND kind = 'tip' AND created_at > ?").bind(ip, hourAgo).first<{ n: number }>();
  if ((row?.n ?? 0) >= TIPS_PER_HOUR) throw new HttpError(429, `At most ${TIPS_PER_HOUR} tips per hour from one address.`);
  await db.prepare("INSERT INTO signal_log (ip, kind, created_at) VALUES (?, 'tip', ?)").bind(ip, nowIso(now)).run();
}

/** A live public record with this code whose retailer name or domain matches the tip's retailer. */
async function liveMatch(db: D1Database, retailer: string, code: string): Promise<string | null> {
  const r = retailer.toLowerCase().replace(/^www\./, '');
  const row = await db
    .prepare(
      `SELECT id FROM vouchers WHERE status = 'verified' AND upper(json_extract(data_json, '$.code')) = ?
       AND (lower(json_extract(data_json, '$.retailer')) LIKE ? OR retailer_domain LIKE ?) LIMIT 1`,
    )
    .bind(code, `%${r}%`, `%${r}%`)
    .first<{ id: string }>();
  return row?.id ?? null;
}

/**
 * Record a shopper's tip. Answers whether the code is already a live record (so the chat agent
 * can show it at once) and otherwise queues it for the scouts.
 */
export async function recordTip(db: D1Database, body: Record<string, unknown>, ip: string, now: Date) {
  const retailer = text(body.retailer, 60);
  const code = text(body.code, 32)?.toUpperCase().replace(/\s+/g, '') ?? null;
  if (!retailer) throw new HttpError(400, 'retailer is required: the shop the code is for.');
  if (!code || !CODE.test(code)) throw new HttpError(400, 'code must be 3–32 letters, digits, - or _.');
  let url = text(body.url, 300);
  if (url) {
    try {
      const u = new URL(url);
      if (!/^https?:$/.test(u.protocol)) url = null;
    } catch {
      url = null;
    }
  }
  const claim = text(body.claim, 200);
  await limit(db, ip, now);

  const live = await liveMatch(db, retailer, code);
  if (live) return { status: 'already_live' as const, voucher_id: live };

  const key = retailer.toLowerCase();
  const open = await db
    .prepare("SELECT id FROM tips WHERE lower(retailer) = ? AND code = ? AND status IN ('open', 'leased')")
    .bind(key, code)
    .first<{ id: string }>();
  if (open) {
    await db
      .prepare('UPDATE tips SET asks = asks + 1, claim = COALESCE(claim, ?), url = COALESCE(url, ?), updated_at = ? WHERE id = ?')
      .bind(claim, url, nowIso(now), open.id)
      .run();
    return { status: 'queued' as const, id: open.id, repeat: true };
  }
  const id = newId('tip');
  await db
    .prepare('INSERT INTO tips (id, retailer, code, claim, url, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(id, retailer, code, claim, url, nowIso(now), nowIso(now))
    .run();
  return { status: 'queued' as const, id, repeat: false };
}

/** Lease open tips to a scout, most asked and oldest first. A lease lapses after TIP_LEASE_MINUTES. */
export async function leaseTips(db: D1Database, tokenId: string, want: number, now: Date) {
  const at = nowIso(now);
  await db.prepare("UPDATE tips SET status = 'open', leased_by = NULL, lease_until = NULL WHERE status = 'leased' AND lease_until < ?").bind(at).run();
  const n = Math.max(1, Math.min(20, Math.floor(want) || 10));
  const { results } = await db
    .prepare("SELECT id FROM tips WHERE status = 'open' ORDER BY asks DESC, created_at ASC LIMIT ?")
    .bind(n)
    .all<{ id: string }>();
  const until = new Date(now.getTime() + TIP_LEASE_MINUTES * 60_000).toISOString();
  for (const { id } of results) {
    await db.prepare("UPDATE tips SET status = 'leased', leased_by = ?, lease_until = ?, updated_at = ? WHERE id = ? AND status = 'open'").bind(tokenId, until, at, id).run();
  }
  const { results: tips } = await db
    .prepare("SELECT id, retailer, code, claim, url, asks, created_at FROM tips WHERE leased_by = ? AND status = 'leased' ORDER BY asks DESC, created_at ASC")
    .bind(tokenId)
    .all();
  return tips;
}

/** A scout's answer for one tip it holds. */
export async function resolveTip(db: D1Database, tokenId: string, id: string, body: Record<string, unknown>, now: Date) {
  const outcome = body.outcome as Outcome;
  if (!TIP_OUTCOMES.includes(outcome)) throw new HttpError(400, `outcome must be one of ${TIP_OUTCOMES.join(', ')}.`);
  const note = text(body.note, 300);
  if (outcome !== 'submitted' && outcome !== 'already_live' && !note) throw new HttpError(400, 'Say in note which pages you checked.');
  const voucherId = text(body.voucher_id, 40);
  const tip = await db.prepare('SELECT status, leased_by FROM tips WHERE id = ?').bind(id).first<{ status: string; leased_by: string | null }>();
  if (!tip) throw new HttpError(404, 'No tip has this id.');
  if (tip.status !== 'leased' || tip.leased_by !== tokenId) throw new HttpError(409, 'Lease this tip with GET /api/tips first; it is not yours.');
  await db
    .prepare("UPDATE tips SET status = ?, outcome_note = ?, voucher_id = ?, resolved_by = ?, leased_by = NULL, lease_until = NULL, updated_at = ? WHERE id = ?")
    .bind(outcome, note, voucherId, tokenId, nowIso(now), id)
    .run();
  return { id, status: outcome };
}
