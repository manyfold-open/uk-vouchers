/**
 * Taking records from scouts. Each record in a batch gets its own answer — accepted,
 * duplicate, invalid (every field error), over_cap — so a scout can fix its batch in the
 * same run. Cheapest checks first: fields, then duplicates, then the cap, then the server
 * reads each source page once to see whether the quoted passage is really there.
 *
 * With `defer` (the Worker passes ctx.waitUntil), the page reads happen after the answer
 * is sent: scouts get their results at once, and quote_found is filled in moments later.
 * Pages that could not be read then are tried again by the cron (backfillQuoteChecks).
 *
 * An accepted record is stored as pending with its first revision and a verify task.
 * Text that addresses AI agents is accepted but flagged for the admin, with no task.
 */

import { fetchPage } from './fetch-page.ts';
import { quoteOnPage } from './quote.ts';
import { standing, type Token } from './tokens.ts';
import { HttpError, newId, nowIso } from './util.ts';
import { identityKey, retailerDomain, sameOffer, validateVoucher, type FieldError, type Provenance, type Voucher } from './voucher.ts';

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
  | { index: number; result: 'accepted'; id: string; quote_found: boolean | null; quote_check: 'done' | 'queued'; flagged: boolean }
  | { index: number; result: 'duplicate'; id: string }
  | { index: number; result: 'invalid'; errors: FieldError[] }
  | { index: number; result: 'over_cap'; message: string };

export async function submitRecords(
  db: D1Database,
  token: Token,
  body: unknown,
  fetcher: typeof fetch = fetch,
  now = new Date(),
  defer?: (work: Promise<unknown>) => void,
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

  // Offers with no code, live at the same retailers: caught when only the wording differs.
  const liveNoCode = new Map<string, { id: string; data: Voucher }[]>();
  const domains = [...new Set(valid.filter((v) => !v.voucher.code).map((v) => retailerDomain(v.voucher)))];
  if (domains.length) {
    const { results: rows } = await db
      .prepare(`SELECT id, retailer_domain, data_json FROM vouchers WHERE status IN ('pending', 'verified') AND retailer_domain IN (${domains.map(() => '?').join(',')})`)
      .bind(...domains)
      .all<{ id: string; retailer_domain: string; data_json: string }>();
    for (const row of rows) {
      const list = liveNoCode.get(row.retailer_domain) ?? [];
      list.push({ id: row.id, data: JSON.parse(row.data_json) as Voucher });
      liveNoCode.set(row.retailer_domain, list);
    }
  }
  const similar = (v: Voucher) => (liveNoCode.get(retailerDomain(v)) ?? []).find((r) => sameOffer(v, r.data))?.id;

  // The server's own look at each source page, once per URL.
  const pages = new Map<string, Promise<string | null>>();
  const page = (url: string) => {
    if (!pages.has(url)) pages.set(url, fetchPage(url, fetcher, 8000).then((p) => (p.ok ? p.html : null)));
    return pages.get(url)!;
  };

  const s = await standing(db, token.id);
  let pending = s.pending;
  const queued: string[] = [];
  const stamp = nowIso(now);

  for (const v of valid) {
    const existing = live.get(v.key) ?? similar(v.voucher);
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
    const html = defer ? undefined : await page(v.provenance.source_url);
    const quoteFound = html === undefined || html === null ? null : quoteOnPage(html, v.provenance.evidence);
    const texts = [v.voucher.title_en, v.voucher.title_zh, v.voucher.terms_en ?? '', v.voucher.terms_zh ?? '', v.provenance.evidence];
    const flagged = looksAimedAtAgents(texts);
    const id = newId('v');
    const statements = [
      db
        .prepare(
          `INSERT INTO vouchers (id, identity_key, retailer_domain, status, verification_level, data_json, source_url, evidence,
             quote_found, quote_checked_at, expires_on, submitted_by, flagged, created_at, updated_at)
           VALUES (?, ?, ?, 'pending', NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          id, v.key, retailerDomain(v.voucher), JSON.stringify(v.voucher), v.provenance.source_url, v.provenance.evidence,
          quoteFound === null ? null : quoteFound ? 1 : 0, defer ? null : stamp, v.voucher.expires_on, token.id, flagged ? 1 : 0, stamp, stamp,
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
    if (!v.voucher.code) {
      const d = retailerDomain(v.voucher);
      liveNoCode.set(d, [...(liveNoCode.get(d) ?? []), { id, data: v.voucher }]);
    }
    pending++;
    results.push({ index: v.index, result: 'accepted', id, quote_found: quoteFound, quote_check: defer ? 'queued' : 'done', flagged });
    if (defer) queued.push(id);
  }
  if (defer && queued.length) defer(checkQuotes(db, queued, fetcher));

  results.sort((a, b) => a.index - b.index);
  return { results, standing: await standing(db, token.id) };
}

/**
 * Read each record's source page and record whether its passage is there. One read per URL.
 * A page that cannot be read leaves quote_found empty; quote_checked_at is set either way,
 * so the cron tries a record at most once more.
 */
export async function checkQuotes(db: D1Database, ids: string[], fetcher: typeof fetch = fetch, now = new Date()) {
  if (!ids.length) return;
  const { results } = await db
    .prepare(`SELECT id, source_url, evidence FROM vouchers WHERE id IN (${ids.map(() => '?').join(',')})`)
    .bind(...ids)
    .all<{ id: string; source_url: string; evidence: string }>();
  const pages = new Map<string, Promise<string | null>>();
  for (const r of results) {
    if (!pages.has(r.source_url)) pages.set(r.source_url, fetchPage(r.source_url, fetcher, 8000).then((p) => (p.ok ? p.html : null)));
    const html = await pages.get(r.source_url)!;
    const found = html === null ? null : quoteOnPage(html, r.evidence) ? 1 : 0;
    await db.prepare('UPDATE vouchers SET quote_found = ?, quote_checked_at = ? WHERE id = ?').bind(found, nowIso(now), r.id).run();
  }
}

/** The cron's share: pending records whose page was never read, or could not be read last time. */
export async function backfillQuoteChecks(db: D1Database, fetcher: typeof fetch = fetch, limit = 25, now = new Date()) {
  const hourAgo = new Date(now.getTime() - 3_600_000).toISOString();
  const { results } = await db
    .prepare(
      `SELECT id FROM vouchers WHERE status = 'pending' AND quote_found IS NULL
         AND (quote_checked_at IS NULL OR (quote_checked_at < ? AND quote_checked_at > created_at AND created_at > ?))
       LIMIT ?`,
    )
    .bind(hourAgo, new Date(now.getTime() - 86_400_000).toISOString(), limit)
    .all<{ id: string }>();
  await checkQuotes(db, results.map((r) => r.id), fetcher, now);
  return results.length;
}
