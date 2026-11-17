/**
 * What shoppers tell us through the chat agent: searches that found nothing (so scouts know
 * what to look for next) and "this code didn't work" reports (so verifiers look again soon).
 * Both are public write endpoints, so they take only enum values and short text, aggregate
 * instead of logging every hit, and are rate limited per address.
 */

import { HttpError, newId, nowIso } from './util.ts';
import { CATEGORIES, ELIGIBILITY, today } from './voucher.ts';

export const SIGNALS_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS demand (
    key TEXT NOT NULL, day TEXT NOT NULL, retailer TEXT, category TEXT, eligibility TEXT, q TEXT,
    asks INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (key, day))`,
  `CREATE TABLE IF NOT EXISTS reports (
    id TEXT PRIMARY KEY, voucher_id TEXT NOT NULL, reporter TEXT NOT NULL, reason TEXT, created_at TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS reports_voucher ON reports (voucher_id, created_at)`,
  `CREATE TABLE IF NOT EXISTS signal_log (ip TEXT NOT NULL, kind TEXT NOT NULL, created_at TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS signal_log_ip ON signal_log (ip, kind, created_at)`,
];

export const DEMAND_PER_HOUR = 120;
export const REPORTS_PER_HOUR = 20;
/** Distinct reporters in 7 days after which a public voucher carries a warning. */
export const REPORT_WARNING = 3;

const clip = (v: unknown, n: number) => (typeof v === 'string' && v.trim() ? v.trim().toLowerCase().slice(0, n) : null);
const oneOf = (v: unknown, allowed: readonly string[]) => (typeof v === 'string' && allowed.includes(v) ? v : null);

async function limit(db: D1Database, ip: string, kind: string, perHour: number, now: Date) {
  const hourAgo = new Date(now.getTime() - 3_600_000).toISOString();
  const row = await db.prepare('SELECT COUNT(*) AS n FROM signal_log WHERE ip = ? AND kind = ? AND created_at > ?').bind(ip, kind, hourAgo).first<{ n: number }>();
  if ((row?.n ?? 0) >= perHour) throw new HttpError(429, `At most ${perHour} per hour from one address.`);
  await db.prepare('INSERT INTO signal_log (ip, kind, created_at) VALUES (?, ?, ?)').bind(ip, kind, nowIso(now)).run();
}

/** A search that found nothing. Counted per day; only filters and a short product word are kept. */
export async function recordDemand(db: D1Database, body: Record<string, unknown>, ip: string, now: Date) {
  const retailer = clip(body.retailer, 60);
  const category = oneOf(body.category, CATEGORIES);
  const eligibility = oneOf(body.eligibility, ELIGIBILITY);
  const q = clip(body.q, 40);
  if (!retailer && !category && !eligibility && !q) throw new HttpError(400, 'Send at least one of retailer, category, eligibility, q.');
  await limit(db, ip, 'demand', DEMAND_PER_HOUR, now);
  const key = [retailer, category, eligibility, q].map((x) => x ?? '').join('|');
  await db
    .prepare(
      `INSERT INTO demand (key, day, retailer, category, eligibility, q, asks) VALUES (?, ?, ?, ?, ?, ?, 1)
       ON CONFLICT (key, day) DO UPDATE SET asks = asks + 1`,
    )
    .bind(key, today(now), retailer, category, eligibility, q)
    .run();
}

/** Unmet searches over the last `days`, most asked first: the scouts' to-do list. */
export async function unmetDemand(db: D1Database, days: number, now: Date) {
  const since = today(new Date(now.getTime() - days * 86_400_000));
  const { results } = await db
    .prepare(
      `SELECT retailer, category, eligibility, q, SUM(asks) AS asks, MAX(day) AS last_day FROM demand
       WHERE day >= ? GROUP BY key ORDER BY asks DESC, last_day DESC LIMIT 50`,
    )
    .bind(since)
    .all();
  return { days, since, unmet: results };
}

/**
 * "This code didn't work." Counts one report per reporter per voucher per week, and queues a
 * recheck at once unless one is already waiting.
 */
export async function reportVoucher(db: D1Database, voucherId: string, body: Record<string, unknown>, ip: string, now: Date) {
  const live = await db.prepare("SELECT id FROM vouchers WHERE id = ? AND status = 'verified'").bind(voucherId).first();
  if (!live) throw new HttpError(404, 'No public voucher has this id.');
  await limit(db, ip, 'report', REPORTS_PER_HOUR, now);
  const reporter = clip(body.reporter, 80) ?? `ip:${ip}`;
  const reason = typeof body.reason === 'string' ? body.reason.trim().slice(0, 200) : null;
  const weekAgo = new Date(now.getTime() - 7 * 86_400_000).toISOString();
  const seen = await db
    .prepare('SELECT 1 FROM reports WHERE voucher_id = ? AND reporter = ? AND created_at > ?')
    .bind(voucherId, reporter, weekAgo)
    .first();
  if (!seen) {
    await db.prepare('INSERT INTO reports (id, voucher_id, reporter, reason, created_at) VALUES (?, ?, ?, ?, ?)').bind(newId('r'), voucherId, reporter, reason, nowIso(now)).run();
  }
  const waiting = await db
    .prepare("SELECT 1 FROM tasks WHERE voucher_id = ? AND kind = 'recheck' AND status IN ('open', 'leased')")
    .bind(voucherId)
    .first();
  if (!waiting) {
    await db
      .prepare("INSERT INTO tasks (id, voucher_id, kind, status, note, created_at) VALUES (?, ?, 'recheck', 'open', ?, ?)")
      .bind(newId('t'), voucherId, `shopper report: ${reason ?? 'did not work'}`.slice(0, 220), nowIso(now))
      .run();
  }
  return { reports_7d: await reportCount(db, voucherId, now), recheck_queued: !waiting, counted: !seen };
}

export async function reportCount(db: D1Database, voucherId: string, now: Date): Promise<number> {
  const weekAgo = new Date(now.getTime() - 7 * 86_400_000).toISOString();
  const row = await db.prepare('SELECT COUNT(*) AS n FROM reports WHERE voucher_id = ? AND created_at > ?').bind(voucherId, weekAgo).first<{ n: number }>();
  return row?.n ?? 0;
}

/** Report counts for many vouchers in one query (for list responses). */
export async function reportCounts(db: D1Database, now: Date): Promise<Map<string, number>> {
  const weekAgo = new Date(now.getTime() - 7 * 86_400_000).toISOString();
  const { results } = await db
    .prepare('SELECT voucher_id, COUNT(*) AS n FROM reports WHERE created_at > ? GROUP BY voucher_id')
    .bind(weekAgo)
    .all<{ voucher_id: string; n: number }>();
  return new Map(results.map((r) => [r.voucher_id, r.n]));
}
