/**
 * One Worker for the whole service: the agents' API, the public read API that the Narra
 * agent uses, and a small admin API. D1 holds all state. Only verified records are public.
 */

import { Hono, type Context } from 'hono';
import watchlist from '../scout/retailers.json' with { type: 'json' };
import { ensureSchema } from './schema.ts';
import { scoutSkill, verifierSkill } from './skill.ts';
import { backfillQuoteChecks, submitRecords } from './submit.ts';
import { authenticate, issueToken, standing } from './tokens.ts';
import { HttpError, nowIso, safeEqual } from './util.ts';
import { adminDecide, applyVerdicts, leaseTasks, maintenance } from './verify.ts';
import { LABELS_ZH, type Voucher } from './voucher.ts';

export interface Env {
  DB: D1Database;
  ADMIN_PASSWORD?: string;
}

type AppContext = Context<{ Bindings: Env }>;

export function createApp(options: { fetcher?: typeof fetch; now?: () => Date; defer?: (work: Promise<unknown>) => void } = {}) {
  const fetcher = options.fetcher ?? ((input, init) => fetch(input, init));
  const now = options.now ?? (() => new Date());
  const app = new Hono<{ Bindings: Env }>();

  app.use('*', async (c, next) => {
    await ensureSchema(c.env.DB);
    await next();
  });

  app.onError((error, c) => {
    if (error instanceof HttpError) return c.json({ error: error.message }, error.status);
    console.error(error);
    return c.json({ error: 'Something went wrong on our side. Try again in a minute.' }, 500);
  });

  const origin = (c: AppContext) => new URL(c.req.url).origin;
  const json = async (c: AppContext) => {
    try {
      return await c.req.json();
    } catch {
      throw new HttpError(400, 'The body must be JSON.');
    }
  };
  const admin = (c: AppContext) => {
    const expected = c.env.ADMIN_PASSWORD;
    const given = c.req.header('x-admin-password') ?? '';
    if (!expected) throw new HttpError(403, 'The admin API is closed until ADMIN_PASSWORD is set.');
    if (!safeEqual(given, expected)) throw new HttpError(401, 'Send the admin password as x-admin-password.');
  };

  // ---- Health and agent instructions ----
  app.get('/api/health', (c) => c.json({ status: 'ok' }));
  app.get('/skill/scout.md', (c) => c.text(scoutSkill(origin(c)), 200, { 'content-type': 'text/markdown; charset=utf-8' }));
  app.get('/skill/verifier.md', (c) => c.text(verifierSkill(origin(c)), 200, { 'content-type': 'text/markdown; charset=utf-8' }));
  app.get('/api/watchlist', (c) => c.json(watchlist));

  // ---- Scouts ----
  app.post('/api/join', async (c) => {
    const body = (await json(c).catch(() => ({}))) as { label?: unknown };
    const ip = c.req.header('cf-connecting-ip') ?? 'local';
    const hourAgo = new Date(now().getTime() - 3_600_000).toISOString();
    const recent = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM join_log WHERE ip = ? AND created_at > ?').bind(ip, hourAgo).first<{ n: number }>();
    if ((recent?.n ?? 0) >= 5) throw new HttpError(429, 'At most 5 tokens per hour from one address. Reuse the token you have.');
    await c.env.DB.prepare('INSERT INTO join_log (ip, created_at) VALUES (?, ?)').bind(ip, nowIso(now())).run();
    const label = typeof body.label === 'string' && body.label.trim() ? body.label.trim().slice(0, 60) : 'scout';
    const issued = await issueToken(c.env.DB, 'scout', label);
    return c.json({ ...issued, note: 'Shown once. Keep it as UK_VOUCHERS_TOKEN in your .env.', skill: `${origin(c)}/skill/scout.md` }, 201);
  });

  app.get('/api/me', async (c) => {
    const token = await authenticate(c.env.DB, c.req.header('authorization'), ['scout', 'verifier']);
    return c.json({ id: token.id, role: token.role, label: token.label, status: token.status, standing: await standing(c.env.DB, token.id) });
  });

  app.post('/api/records', async (c) => {
    const token = await authenticate(c.env.DB, c.req.header('authorization'), ['scout', 'verifier']);
    // Answer at once; the server's reading of each source page continues after the response.
    let defer: ((work: Promise<unknown>) => void) | undefined;
    try {
      const ctx = c.executionCtx;
      defer = (work) => ctx.waitUntil(work.catch((error) => console.error('quote check', error)));
    } catch {
      defer = options.defer;
    }
    return c.json(await submitRecords(c.env.DB, token, await json(c), fetcher, now(), defer));
  });

  // ---- Verifiers ----
  app.get('/api/tasks', async (c) => {
    const token = await authenticate(c.env.DB, c.req.header('authorization'), ['verifier']);
    return c.json({ tasks: await leaseTasks(c.env.DB, token, Number(c.req.query('limit') ?? 10), now()) });
  });

  app.post('/api/verdicts', async (c) => {
    const token = await authenticate(c.env.DB, c.req.header('authorization'), ['verifier']);
    return c.json({ results: await applyVerdicts(c.env.DB, token, await json(c), now()) });
  });

  // ---- Public reads (what the Narra agent uses) ----
  app.get('/api/vouchers', async (c) => {
    const q = c.req.query();
    const lang = q.lang === 'zh' ? 'zh' : 'en';
    const { results } = await c.env.DB
      .prepare("SELECT id, data_json, source_url, evidence, verification_level, verified_at FROM vouchers WHERE status = 'verified' ORDER BY verified_at DESC")
      .all<{ id: string; data_json: string; source_url: string; evidence: string; verification_level: string; verified_at: string }>();
    const text = (q.q ?? '').toLowerCase();
    const rows = results
      .map((r) => ({ ...r, data: JSON.parse(r.data_json) as Voucher }))
      .filter((r) => !q.retailer || r.data.retailer.toLowerCase().includes(q.retailer.toLowerCase()) || r.data.retailer_url.includes(q.retailer.toLowerCase()))
      .filter((r) => !q.category || r.data.category === q.category)
      .filter((r) => !q.eligibility || r.data.eligibility === q.eligibility)
      .filter((r) => !text || [r.data.retailer, r.data.title_en, r.data.title_zh, r.data.code ?? ''].join(' ').toLowerCase().includes(text));
    const limit = Math.min(100, Math.max(1, Number(q.limit) || 20));
    const page = Math.max(1, Number(q.page) || 1);
    return c.json({
      total: rows.length,
      page,
      vouchers: rows.slice((page - 1) * limit, page * limit).map((r) => publicVoucher(r, lang)),
    });
  });

  app.get('/api/vouchers/:id', async (c) => {
    const row = await c.env.DB
      .prepare("SELECT id, data_json, source_url, evidence, verification_level, verified_at FROM vouchers WHERE id = ? AND status = 'verified'")
      .bind(c.req.param('id'))
      .first<{ id: string; data_json: string; source_url: string; evidence: string; verification_level: string; verified_at: string }>();
    if (!row) throw new HttpError(404, 'No public voucher has this id.');
    return c.json(publicVoucher({ ...row, data: JSON.parse(row.data_json) }, c.req.query('lang') === 'zh' ? 'zh' : 'en'));
  });

  app.get('/export.json', async (c) => {
    const { results } = await c.env.DB
      .prepare("SELECT id, data_json, source_url, evidence, verification_level, verified_at FROM vouchers WHERE status = 'verified' ORDER BY verified_at DESC")
      .all<{ id: string; data_json: string; source_url: string; evidence: string; verification_level: string; verified_at: string }>();
    return c.json({ license: 'CC-BY-4.0', vouchers: results.map((r) => publicVoucher({ ...r, data: JSON.parse(r.data_json) }, 'en')) });
  });

  // ---- Admin ----
  app.post('/api/admin/tokens', async (c) => {
    admin(c);
    const body = (await json(c)) as { label?: string; role?: string; capabilities?: string[] };
    if (body.role !== 'verifier' && body.role !== 'scout') throw new HttpError(400, 'role must be verifier or scout.');
    if (!body.label) throw new HttpError(400, 'label is required: who runs this agent.');
    return c.json(await issueToken(c.env.DB, body.role, body.label, body.capabilities ?? []), 201);
  });

  app.get('/api/admin/tokens', async (c) => {
    admin(c);
    const { results } = await c.env.DB
      .prepare('SELECT id, role, label, status, created_at, last_used_at FROM tokens ORDER BY created_at')
      .all();
    return c.json({ tokens: results });
  });

  // Revoke, suspend or reactivate a token. Tasks it holds go back to the pool at once.
  app.post('/api/admin/tokens/:id', async (c) => {
    admin(c);
    const body = (await json(c)) as { status?: string };
    if (body.status !== 'active' && body.status !== 'suspended' && body.status !== 'revoked') {
      throw new HttpError(400, 'status must be active, suspended or revoked.');
    }
    const id = c.req.param('id');
    const res = await c.env.DB.prepare('UPDATE tokens SET status = ? WHERE id = ?').bind(body.status, id).run();
    if (!res.meta.changes) throw new HttpError(404, 'No token has this id.');
    if (body.status !== 'active') {
      await c.env.DB
        .prepare("UPDATE tasks SET status = 'open', leased_by = NULL, lease_until = NULL WHERE leased_by = ? AND status = 'leased'")
        .bind(id)
        .run();
    }
    return c.json({ id, status: body.status });
  });

  app.get('/api/admin/overview', async (c) => {
    admin(c);
    const { results: records } = await c.env.DB.prepare('SELECT status, COUNT(*) AS n FROM vouchers GROUP BY status').all();
    const { results: tasks } = await c.env.DB.prepare('SELECT kind, status, COUNT(*) AS n FROM tasks GROUP BY kind, status').all();
    const { results: review } = await c.env.DB
      .prepare(
        `SELECT v.id, v.data_json, v.source_url, v.evidence, v.flagged, t.id AS task_id, t.note FROM vouchers v
         LEFT JOIN tasks t ON t.voucher_id = v.id AND t.status = 'needs_human'
         WHERE (v.flagged = 1 AND v.status = 'pending') OR t.id IS NOT NULL LIMIT 50`,
      )
      .all();
    return c.json({ records, tasks, review });
  });

  app.post('/api/admin/records/:id', async (c) => {
    admin(c);
    return c.json(await adminDecide(c.env.DB, c.req.param('id'), await json(c), now()));
  });

  app.post('/api/admin/maintenance', async (c) => {
    admin(c);
    return c.json(await maintenance(c.env.DB, now()));
  });

  return app;
}

function publicVoucher(
  r: { id: string; data: Voucher; source_url: string; evidence: string; verification_level: string; verified_at: string },
  lang: 'en' | 'zh',
) {
  const d = r.data;
  return {
    id: r.id,
    retailer: d.retailer,
    title: lang === 'zh' ? d.title_zh : d.title_en,
    title_en: d.title_en,
    title_zh: d.title_zh,
    code: d.code,
    discount_type: d.discount_type,
    discount_value: d.discount_value,
    min_spend_gbp: d.min_spend_gbp,
    category: d.category,
    category_zh: LABELS_ZH[d.category],
    eligibility: d.eligibility,
    eligibility_zh: LABELS_ZH[d.eligibility],
    starts_on: d.starts_on,
    expires_on: d.expires_on,
    offer_url: d.offer_url,
    terms: lang === 'zh' ? d.terms_zh ?? d.terms_en : d.terms_en,
    verification_level: r.verification_level,
    last_checked_at: r.verified_at,
    source_url: r.source_url,
    evidence: r.evidence,
  };
}

const app = createApp();

export default {
  fetch: app.fetch,
  async scheduled(_controller: ScheduledController, env: Env) {
    await ensureSchema(env.DB);
    await maintenance(env.DB);
    await backfillQuoteChecks(env.DB);
  },
} satisfies ExportedHandler<Env>;
