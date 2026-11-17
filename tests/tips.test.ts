import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.ts';
import { resetSchemaCache } from '../src/schema.ts';
import { TIPS_PER_HOUR } from '../src/tips.ts';
import { issueToken } from '../src/tokens.ts';
import { EXAMPLE } from '../src/voucher.ts';
import { createD1 } from './d1.ts';

let now = new Date('2026-11-17T12:00:00Z');
const app = createApp({ now: () => now });
let db: D1Database;

async function call(method: string, path: string, body?: unknown, opts: { ip?: string; token?: string } = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json', 'cf-connecting-ip': opts.ip ?? '1.1.1.1' };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  const res = await app.request(path, { method, headers, body: body ? JSON.stringify(body) : undefined }, { DB: db });
  return { status: res.status, body: (await res.json().catch(() => null)) as any, cache: res.headers.get('cache-control') };
}

beforeEach(async () => {
  db = createD1();
  resetSchemaCache();
  now = new Date('2026-11-17T12:00:00Z');
  await call('GET', '/api/meta');
});

describe('shopper tips', () => {
  it('queues a tip, counts repeats on one row, and normalises the code', async () => {
    const first = await call('POST', '/api/tips', { retailer: 'Boots', code: 'save 15', claim: '15% off beauty' });
    expect(first.status).toBe(202);
    expect(first.body).toMatchObject({ status: 'queued', repeat: false });
    const again = await call('POST', '/api/tips', { retailer: 'boots', code: 'SAVE15' }, { ip: '2.2.2.2' });
    expect(again.body).toMatchObject({ status: 'queued', id: first.body.id, repeat: true });
    const row = await db.prepare('SELECT code, asks, claim FROM tips').first<any>();
    expect(row).toEqual({ code: 'SAVE15', asks: 2, claim: '15% off beauty' });
  });

  it('rejects tips without a retailer or with a malformed code, and rate limits per address', async () => {
    expect((await call('POST', '/api/tips', { code: 'SAVE15' })).status).toBe(400);
    expect((await call('POST', '/api/tips', { retailer: 'Boots', code: 'x!' })).status).toBe(400);
    for (let i = 0; i < TIPS_PER_HOUR; i++) expect((await call('POST', '/api/tips', { retailer: `Shop ${i}`, code: 'CODE10' })).status).toBe(202);
    expect((await call('POST', '/api/tips', { retailer: 'One more', code: 'CODE10' })).status).toBe(429);
  });

  it('says when the code is already a live record', async () => {
    await db
      .prepare(
        `INSERT INTO vouchers (id, identity_key, retailer_domain, status, verification_level, data_json, source_url, evidence,
         expires_on, submitted_by, verified_at, created_at, updated_at) VALUES ('v1', 'k1', 'example-beauty.co.uk', 'verified', 'L1', ?, ?, ?, NULL, 't', ?, ?, ?)`,
      )
      .bind(JSON.stringify({ ...EXAMPLE.data, expires_on: null }), EXAMPLE.source_url, EXAMPLE.evidence, now.toISOString(), now.toISOString(), now.toISOString())
      .run();
    const res = await call('POST', '/api/tips', { retailer: EXAMPLE.data.retailer, code: EXAMPLE.data.code!.toLowerCase() });
    expect(res.body).toEqual({ status: 'already_live', voucher_id: 'v1' });
  });

  it('lets a scout lease tips (most asked first), resolve its own, and not someone else’s', async () => {
    const a = (await call('POST', '/api/tips', { retailer: 'Argos', code: 'ARGOS10' })).body.id;
    const b = (await call('POST', '/api/tips', { retailer: 'Boots', code: 'BOOTS5' })).body.id;
    await call('POST', '/api/tips', { retailer: 'Boots', code: 'BOOTS5' }, { ip: '3.3.3.3' });
    const scout = await issueToken(db, 'scout', 'uv-scout-a');
    const other = await issueToken(db, 'scout', 'uv-scout-b');
    const verifier = await issueToken(db, 'verifier', 'uv-verifier-1');

    expect((await call('GET', '/api/tips')).status).toBe(401);
    expect((await call('GET', '/api/tips', undefined, { token: verifier.token })).status).toBe(403);
    const leased = await call('GET', '/api/tips', undefined, { token: scout.token });
    expect(leased.body.tips.map((t: any) => t.id)).toEqual([b, a]);
    expect(leased.cache).toBeNull();
    expect((await call('GET', '/api/tips', undefined, { token: other.token })).body.tips).toEqual([]);

    expect((await call('POST', `/api/tips/${a}`, { outcome: 'not_found' }, { token: scout.token })).status).toBe(400);
    expect((await call('POST', `/api/tips/${a}`, { outcome: 'not_found', note: 'x' }, { token: other.token })).status).toBe(409);
    const done = await call('POST', `/api/tips/${a}`, { outcome: 'not_found', note: 'promo terms and offers pages' }, { token: scout.token });
    expect(done.body).toEqual({ id: a, status: 'not_found' });
    expect((await call('POST', `/api/tips/${b}`, { outcome: 'submitted', voucher_id: 'v_9' }, { token: scout.token })).body.status).toBe('submitted');
  });

  it('returns a lapsed lease to the queue', async () => {
    const id = (await call('POST', '/api/tips', { retailer: 'Argos', code: 'ARGOS10' })).body.id;
    const one = await issueToken(db, 'scout', 'a');
    const two = await issueToken(db, 'scout', 'b');
    expect((await call('GET', '/api/tips', undefined, { token: one.token })).body.tips).toHaveLength(1);
    now = new Date(now.getTime() + 31 * 60_000);
    expect((await call('GET', '/api/tips', undefined, { token: two.token })).body.tips.map((t: any) => t.id)).toEqual([id]);
  });
});
