// Edge cases found by probing the live API and the submit/verify flow (2026-11-17).
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.ts';
import { parseListQuery } from '../src/public.ts';
import { resetSchemaCache } from '../src/schema.ts';
import { EXAMPLE, validateVoucher } from '../src/voucher.ts';
import { createD1 } from './d1.ts';

const NOW = new Date('2026-11-16T12:00:00Z');
const PAGE = `<html><body><p>${EXAMPLE.evidence}</p></body></html>`;
const fakeFetch = (async (input: RequestInfo | URL) =>
  String(input).startsWith('https://www.example-beauty.co.uk')
    ? new Response(PAGE, { headers: { 'content-type': 'text/html' } })
    : new Response('nope', { status: 404 })) as typeof fetch;

let db: D1Database;
const app = createApp({ fetcher: fakeFetch, now: () => NOW });
async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await app.request(
    path,
    { method, headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) },
    { DB: db, ADMIN_PASSWORD: 'pw' },
  );
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
}
const check = (over: Record<string, unknown>) => validateVoucher({ ...EXAMPLE.data, ...over }, EXAMPLE, NOW);
const fields = (r: ReturnType<typeof check>) => (r.ok ? [] : r.errors.map((e) => e.field));

beforeEach(() => {
  db = createD1();
  resetSchemaCache();
});

describe('submit validation edges', () => {
  it('refuses dates that do not exist instead of rolling them over', () => {
    expect(fields(check({ expires_on: '2027-02-30' }))).toEqual(['expires_on']);
    expect(fields(check({ starts_on: '2026-11-31' }))).toEqual(['starts_on']);
    expect(check({ expires_on: '2028-02-29' }).ok).toBe(true); // leap day
  });

  it('needs a value for percent and fixed offers, also when it is sent as null', () => {
    expect(fields(check({ discount_type: 'percent', discount_value: null }))).toEqual(['discount_value']);
    expect(fields(check({ discount_type: 'fixed', discount_value: null }))).toEqual(['discount_value']);
    expect(check({ discount_type: 'free-delivery', discount_value: null }).ok).toBe(true);
  });

  it('refuses Simplified Chinese titles and terms', () => {
    expect(fields(check({ title_zh: '美妆满 £40 八折优惠码' }))).toEqual(['title_zh']);
    expect(fields(check({ terms_zh: '礼品卡除外，每人限用一次，会员专享。' }))).toEqual(['terms_zh']);
    expect(check({ title_zh: '保養品滿 £40 打 8 折', terms_zh: '禮品卡除外，每人限用一次。' }).ok).toBe(true);
  });
});

describe('public read edges', () => {
  it('reads filter values case-insensitively', () => {
    const q = parseListQuery({ category: 'Beauty', eligibility: ' STUDENT ', sort: 'Best' });
    expect(q).toMatchObject({ category: 'beauty', eligibility: 'student', sort: 'best' });
  });

  it('uses the default for any limit or page that is not a whole number of 1 or more', () => {
    for (const limit of ['0', '-5', 'abc', '']) expect(parseListQuery({ limit }).limit).toBe(20);
    expect(parseListQuery({ limit: '2.7' }).limit).toBe(2);
    expect(parseListQuery({ limit: '1000' }).limit).toBe(100);
    for (const page of ['0', '-1', 'x']) expect(parseListQuery({ page }).page).toBe(1);
  });

  it('answers unknown routes with JSON', async () => {
    const res = await call('GET', '/api/nope');
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/No such route/);
  });
});
