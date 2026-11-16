/**
 * Taking records from scouts. Each record in a batch gets its own answer — accepted,
 * duplicate, invalid (every field error), over_cap — so a scout can fix its batch in the
 * same run. Cheapest checks first: fields, then duplicates, then the cap, then the server
 * reads each source page once to see whether the quoted passage is really there.
 *
 * An accepted record is stored as pending with its first revision and a verify task.
 * Text that addresses AI agents is accepted but flagged for the admin, with no task.
 */

import { fetchPage } from './fetch-page.ts';
import { quoteOnPage } from './quote.ts';
import { standing, type Token } from './tokens.ts';
import { HttpError, newId, nowIso } from './util.ts';
import { identityKey, retailerDomain, validateVoucher, type FieldError, type Provenance, type Voucher } from './voucher.ts';

export const BATCH_MAX = 20;

const AIMED_AT_AGENTS: readonly RegExp[] = [
  /\bignore (all |any |the )?(previous|prior|above|earlier) (instructions|prompts|messages)\b/i,
  /\bdisregard (all |any |the )?(previous|prior|above|earlier)\b/i,
  /\b(system|developer) prompt\b/i,
  /\byou are (now )?(an? )?(ai|assistant|agent|language model|llm)\b/i,
  /\b(mark|set|label) (this|it|them|all|every)( records?)? (as )?(verified|approved|valid)\b/i,
  /<\/?(script|iframe|object|embed|img)\b/i,
];

export const looksAimedAtAgents = (texts: readonly string[]) =>
  texts.some((t) => AIMED_AT_AGENTS.some((p) => p.test(t)));

export type SubmitResult =
  | { index: number; result: 'accepted'; id: string; quote_found: boolean | null; flagged: boolean }
  | { index: number; result: 'duplicate'; id: string }
  | { index: number; result: 'invalid'; errors: FieldError[] }
  | { index: number; result: 'over_cap'; message: string };

export async function submitRecords(
  db: D1Database,
  token: Token,
  body: unknown,
  fetcher: typeof fetch = fetch,
  now = new Date(),
): Promise<{ results: SubmitResult[]; standing: Awaited<ReturnType<typeof standing>> }> {
  const records = (body as { records?: unknown })?.records;
  if (!Array.isArray(records) || records.length === 0) {
    throw new HttpError(400, 'Send {"records": [{"data": {...}, "source_url": "...", "evidence": "..."}]}.');
  }
  if (records.length > BATCH_MAX) throw new HttpError(413, `Send at most ${BATCH_MAX} records per call.`);

  const results: SubmitResult[] = [];
  const valid: { index: number; voucher: Voucher; provenance: Provenance; key: string }[] = [];
  records.forEach((item, index) => {
    const r = (item ?? {}) as Record<string, unknown>;
    const checked = validateVoucher(r.data, { source_url: r.source_url, evidence: r.evidence }, now);
    if (!checked.ok) results.push({ index, result: 'invalid', errors: checked.errors });
    else valid.push({ index, voucher: checked.voucher, provenance: checked.provenance, key: identityKey(checked.voucher) });
  });

  // Duplicates of live records, in one query.
  const live = new Map<string, string>();
  if (valid.length) {
    const keys = [...new Set(valid.map((v) => v.key))];
    const { results: rows } = await db
      .prepare(`SELECT id, identity_key FROM vouchers WHERE status IN ('pending', 'verified') AND identity_key IN (${keys.map(() => '?').join(',')})`)
      .bind(...keys)
      .all<{ id: string; identity_key: string }>();
    for (const row of rows) live.set(row.identity_key, row.id);
  }

  // The server's own look at each source page, once per URL.
  const pages = new Map<string, Promise<string | null>>();
  const page = (url: string) => {
    if (!pages.has(url)) pages.set(url, fetchPage(url, fetcher, 8000).then((p) => (p.ok ? p.html : null)));
    return pages.get(url)!;
  };

  const s = await standing(db, token.id);
  let pending = s.pending;
  const stamp = nowIso(now);

  for (const v of valid) {
    const existing = live.get(v.key);
    if (existing) {
      results.push({ index: v.index, result: 'duplicate', id: existing });
      continue;
    }
    if (pending >= s.cap) {
      results.push({
        index: v.index,
        result: 'over_cap',
        message: `You have ${pending} records waiting for review, your limit is ${s.cap}. Each verified record raises it by one.`,
      });
      continue;
    }
    const html = await page(v.provenance.source_url);
    const quoteFound = html === null ? null : quoteOnPage(html, v.provenance.evidence);
    const texts = [v.voucher.title_en, v.voucher.title_zh, v.voucher.terms_en ?? '', v.voucher.terms_zh ?? '', v.provenance.evidence];
    const flagged = looksAimedAtAgents(texts);
    const id = newId('v');
    const statements = [
      db
        .prepare(
          `INSERT INTO vouchers (id, identity_key, retailer_domain, status, verification_level, data_json, source_url, evidence,
             quote_found, expires_on, submitted_by, flagged, created_at, updated_at)
           VALUES (?, ?, ?, 'pending', NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          id, v.key, retailerDomain(v.voucher), JSON.stringify(v.voucher), v.provenance.source_url, v.provenance.evidence,
          quoteFound === null ? null : quoteFound ? 1 : 0, v.voucher.expires_on, token.id, flagged ? 1 : 0, stamp, stamp,
        ),
      db
        .prepare('INSERT INTO revisions (voucher_id, actor, action, before_json, after_json, created_at) VALUES (?, ?, ?, NULL, ?, ?)')
        .bind(id, token.id, 'submit', JSON.stringify({ status: 'pending', data: v.voucher, ...v.provenance }), stamp),
    ];
    if (!flagged) {
      statements.push(
        db
          .prepare("INSERT INTO tasks (id, voucher_id, kind, status, created_at) VALUES (?, ?, 'verify', 'open', ?)")
          .bind(newId('t'), id, stamp),
      );
    }
    try {
      await db.batch(statements);
    } catch (error) {
      // Another submit took the identity between our check and our insert.
      if (/UNIQUE/i.test(String(error))) {
        const row = await db
          .prepare("SELECT id FROM vouchers WHERE identity_key = ? AND status IN ('pending', 'verified')")
          .bind(v.key)
          .first<{ id: string }>();
        results.push({ index: v.index, result: 'duplicate', id: row?.id ?? '' });
        continue;
      }
      throw error;
    }
    live.set(v.key, id);
    pending++;
    results.push({ index: v.index, result: 'accepted', id, quote_found: quoteFound, flagged });
  }

  results.sort((a, b) => a.index - b.index);
  return { results, standing: await standing(db, token.id) };
}
