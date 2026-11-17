import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.ts';
import { compare, parseLang, parseListQuery, strength, type PublicRow } from '../src/public.ts';
import { resetSchemaCache } from '../src/schema.ts';
import { EXAMPLE, type Voucher } from '../src/voucher.ts';
import { createD1 } from './d1.ts';

const NOW = new Date('2026-11-16T12:00:00Z');
const app = createApp({ now: () => NOW });
let db: D1Database;

const voucher = (over: Partial<Voucher> = {}): Voucher => ({ ...(EXAMPLE.data as Voucher), ...over });

async function publish(id: string, over: Partial<Voucher> = {}, verifiedAt = '2026-11-16T08:00:00Z', source = EXAMPLE.source_url) {
  const data = voucher(over);
  await db
    .prepare(
      `INSERT INTO vouchers (id, identity_key, retailer_domain, status, verification_level, data_json, source_url, evidence,
       expires_on, submitted_by, verified_at, created_at, updated_at) VALUES (?, ?, ?, 'verified', 'L1', ?, ?, ?, ?, 't', ?, ?, ?)`,
    )
    .bind(id, id, 'example-beauty.co.uk', JSON.stringify(data), source, EXAMPLE.evidence, data.expires_on, verifiedAt, verifiedAt, verifiedAt)
    .run();
}

async function get(path: string, headers: Record<string, string> = {}) {
  const res = await app.request(path, { headers }, { DB: db });
  return { res, body: (await res.json()) as any };
}

beforeEach(async () => {
  db = createD1();
  resetSchemaCache();
  await get('/api/meta'); // creates the schema
});

describe('query parsing', () => {
  it('reads any zh variant as Chinese', () => {
    for (const v of ['zh', 'ZH', 'zh-TW', 'zh-Hant', 'zh_TW']) expect(parseLang(v)).toBe('zh');
    for (const v of [undefined, '', 'en', 'english', 'zhx']) expect(parseLang(v)).toBe('en');
  });

  it('refuses unknown filter values instead of returning nothing', () => {
    expect(() => parseListQuery({ category: 'makeup' })).toThrow(/category must be one of: beauty/);
    expect(() => parseListQuery({ eligibility: 'students' })).toThrow(/eligibility must be one of/);
    expect(() => parseListQuery({ sort: 'cheapest' })).toThrow(/sort must be one of: best, newest, ending/);
    expect(parseListQuery({ limit: '500', page: '-2' })).toMatchObject({ limit: 100, page: 1, sort: 'newest' });
  });
});

describe('ranking', () => {
  const row = (id: string, over: Partial<Voucher>, verified_at = '2026-11-16T08:00:00Z'): PublicRow => ({
    id, data: voucher(over), source_url: '', evidence: '', verification_level: 'L1', verified_at,
  });

  it('compares percentages, fixed amounts and free delivery on one scale', () => {
    expect(strength(voucher({ discount_type: 'percent', discount_value: 20 }))).toBe(20);
    expect(strength(voucher({ discount_type: 'fixed', discount_value: 10, min_spend_gbp: 40 }))).toBe(20);
    expect(strength(voucher({ discount_type: 'fixed', discount_value: 10, min_spend_gbp: null }))).toBe(20);
    expect(strength(voucher({ discount_type: 'free-delivery', discount_value: null }))).toBe(5);
  });

  it('best puts offers for everyone first, then the biggest saving, then no minimum spend', () => {
    const rows = [
      row('student-50', { eligibility: 'student', discount_value: 50 }),
      row('all-10', { discount_value: 10 }),
      row('all-25-min', { discount_value: 25, min_spend_gbp: 40 }),
      row('all-25', { discount_value: 25, min_spend_gbp: null }),
    ];
    expect(rows.sort(compare('best')).map((r) => r.id)).toEqual(['all-25', 'all-25-min', 'all-10', 'student-50']);
  });

  it('ending puts the soonest end date first and open-ended offers last', () => {
    const rows = [row('open', { expires_on: null }), row('jan', { expires_on: '2027-01-31' }), row('dec', { expires_on: '2026-12-01' })];
    expect(rows.sort(compare('ending')).map((r) => r.id)).toEqual(['dec', 'jan', 'open']);
  });
});

describe('GET /api/vouchers', () => {
  it('sorts on request and returns the new fields', async () => {
    await publish('v_small', { discount_value: 10 }, '2026-11-16T10:00:00Z');
    await publish('v_big', { discount_value: 30 }, '2026-11-15T10:00:00Z', 'https://www.myunidays.com/GB/en-GB/partners/example');
    expect((await get('/api/vouchers')).body.vouchers.map((v: any) => v.id)).toEqual(['v_small', 'v_big']);
    const best = (await get('/api/vouchers?sort=best&lang=zh-TW')).body;
    expect(best.sort).toBe('best');
    expect(best.vouchers.map((v: any) => v.id)).toEqual(['v_big', 'v_small']);
    expect(best.vouchers[0]).toMatchObject({
      title: '保養品滿 £40 打 8 折',
      retailer_url: 'https://www.example-beauty.co.uk',
      retailer_domain: 'example-beauty.co.uk',
      discount_type_zh: '折扣 %',
      source_type: 'retailer-site',
      via: 'UNiDAYS',
    });
    expect(best.vouchers[1].via).toBeNull();
  });

  it('hides offers past their end date before maintenance runs', async () => {
    await publish('v_live', { expires_on: '2026-11-16' });
    await publish('v_ended', { expires_on: '2026-11-15' });
    expect((await get('/api/vouchers')).body.vouchers.map((v: any) => v.id)).toEqual(['v_live']);
    expect((await get('/api/vouchers/v_ended')).res.status).toBe(404);
    expect((await get('/export.json')).body.vouchers).toHaveLength(1);
  });

  it('answers a bad filter with 400 and the allowed values', async () => {
    const { res, body } = await get('/api/vouchers?category=makeup');
    expect(res.status).toBe(400);
    expect(body.error).toContain('beauty');
  });

  it('allows any origin and lets edges cache for a minute', async () => {
    const { res } = await get('/api/vouchers', { origin: 'https://narra.example' });
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('cache-control')).toBe('public, max-age=60');
    const bad = await get('/api/vouchers?sort=nope');
    expect(bad.res.headers.get('cache-control')).toBeNull();
  });
});

describe('GET /api/meta', () => {
  it('lists every filter value with its Chinese label', async () => {
    const { body } = await get('/api/meta');
    expect(body.sorts).toEqual(['best', 'newest', 'ending']);
    expect(body.categories).toContainEqual({ value: 'beauty', zh: '美妝' });
    expect(body.eligibility).toContainEqual({ value: 'student', zh: '學生' });
  });
});

describe('text search', () => {
  it('finds offers by the partner scheme they come through, so "unidays" finds UNiDAYS offers', async () => {
    await publish('v_uni', { title_en: '10% off for students', title_zh: '學生 9 折', code: null }, undefined, 'https://www.myunidays.com/GB/en-GB/partners/example/view');
    await publish('v_own', { title_en: '20% off skincare', title_zh: '保養品 8 折', code: null });
    const { body } = await get('/api/vouchers?q=unidays');
    expect(body.vouchers.map((v: any) => v.id)).toEqual(['v_uni']);
    expect(body.vouchers[0].via).toBe('UNiDAYS');
  });
});
