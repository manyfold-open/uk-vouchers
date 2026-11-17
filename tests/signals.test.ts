import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.ts';
import { resetSchemaCache } from '../src/schema.ts';
import { DEMAND_PER_HOUR } from '../src/signals.ts';
import { EXAMPLE } from '../src/voucher.ts';
import { createD1 } from './d1.ts';

const NOW = new Date('2026-11-16T12:00:00Z');
const app = createApp({ now: () => NOW });
let db: D1Database;

async function call(method: string, path: string, body?: unknown, ip = '1.1.1.1') {
  const res = await app.request(
    path,
    { method, headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip }, body: body ? JSON.stringify(body) : undefined },
    { DB: db },
  );
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
}

async function publish(id: string) {
  await db
    .prepare(
      `INSERT INTO vouchers (id, identity_key, retailer_domain, status, verification_level, data_json, source_url, evidence,
       expires_on, submitted_by, verified_at, created_at, updated_at) VALUES (?, ?, 'example-beauty.co.uk', 'verified', 'L1', ?, ?, ?, NULL, 't', ?, ?, ?)`,
    )
    .bind(id, id, JSON.stringify({ ...EXAMPLE.data, expires_on: null }), EXAMPLE.source_url, EXAMPLE.evidence, NOW.toISOString(), NOW.toISOString(), NOW.toISOString())
    .run();
}

beforeEach(async () => {
  db = createD1();
  resetSchemaCache();
  await call('GET', '/api/meta');
});

describe('demand', () => {
  it('counts unmet searches per day and lists the most asked first', async () => {
    for (let i = 0; i < 3; i++) expect((await call('POST', '/api/demand', { retailer: 'Boots' })).status).toBe(204);
    await call('POST', '/api/demand', { category: 'beauty', eligibility: 'student' });
    const { body } = await call('GET', '/api/demand');
    expect(body.unmet[0]).toMatchObject({ retailer: 'boots', asks: 3 });
    expect(body.unmet[1]).toMatchObject({ category: 'beauty', eligibility: 'student', asks: 1 });
  });

  it('keeps only known filter values and refuses empty or too many asks', async () => {
    await call('POST', '/api/demand', { category: 'makeup', q: 'Lipstick' });
    expect((await call('GET', '/api/demand')).body.unmet[0]).toMatchObject({ category: null, q: 'lipstick' });
    expect((await call('POST', '/api/demand', {})).status).toBe(400);
    for (let i = 0; i < DEMAND_PER_HOUR; i++) await call('POST', '/api/demand', { q: 'x' }, '9.9.9.9');
    expect((await call('POST', '/api/demand', { q: 'x' }, '9.9.9.9')).status).toBe(429);
  });
});

describe('reports', () => {
  it('queues one recheck and counts one report per reporter', async () => {
    await publish('v_1');
    const first = await call('POST', '/api/vouchers/v_1/report', { reporter: 'narra:alice', reason: 'code expired at checkout' });
    expect(first.body).toMatchObject({ reports_7d: 1, recheck_queued: true, counted: true, warning: false });
    const again = await call('POST', '/api/vouchers/v_1/report', { reporter: 'narra:alice' });
    expect(again.body).toMatchObject({ reports_7d: 1, recheck_queued: false, counted: false });
    await call('POST', '/api/vouchers/v_1/report', { reporter: 'narra:bob' });
    const third = await call('POST', '/api/vouchers/v_1/report', { reporter: 'narra:carol' });
    expect(third.body).toMatchObject({ reports_7d: 3, warning: true });
    const tasks = await db.prepare("SELECT kind, note FROM tasks WHERE voucher_id = 'v_1'").all<{ kind: string; note: string }>();
    expect(tasks.results).toEqual([{ kind: 'recheck', note: 'shopper report: code expired at checkout' }]);
    expect((await call('GET', '/api/vouchers')).body.vouchers[0].reports_7d).toBe(3);
  });

  it('refuses reports on vouchers that are not public', async () => {
    expect((await call('POST', '/api/vouchers/v_nope/report', {})).status).toBe(404);
  });
});
