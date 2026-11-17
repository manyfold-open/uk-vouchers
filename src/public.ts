/**
 * The public read API that the Narra agent uses: query parsing, ranking and the shape of a
 * public voucher. Only verified records that have not ended are ever shown.
 */

import { HttpError } from './util.ts';
import { CATEGORIES, ELIGIBILITY, LABELS_ZH, PARTNER_SOURCES, hostOf, retailerDomain, sameSite, today, type Voucher } from './voucher.ts';

export type Lang = 'en' | 'zh';
export const SORTS = ['best', 'newest', 'ending'] as const;
export type Sort = (typeof SORTS)[number];

export interface PublicRow {
  id: string;
  data: Voucher;
  source_url: string;
  evidence: string;
  verification_level: string;
  verified_at: string;
}

/** "zh", "zh-TW", "zh-Hant", "ZH" all mean Traditional Chinese; anything else is English. */
export const parseLang = (value: string | undefined): Lang => (value && /^zh(?:$|[-_])/i.test(value) ? 'zh' : 'en');

/** Partner scheme names, for "via UNiDAYS"-style answers. */
const SCHEME_NAMES: Record<string, string> = {
  'myunidays.com': 'UNiDAYS',
  'studentbeans.com': 'Student Beans',
  'totum.com': 'TOTUM',
  'bluelightcard.co.uk': 'Blue Light Card',
  'healthservicediscounts.com': 'Health Service Discounts',
  'nhsdiscounts.org.uk': 'NHS Discounts',
};

export interface ListQuery {
  lang: Lang;
  sort: Sort;
  retailer: string;
  category: string;
  eligibility: string;
  text: string;
  limit: number;
  page: number;
}

function oneOf(name: string, value: string | undefined, allowed: readonly string[]): string {
  if (!value) return '';
  if (!allowed.includes(value)) throw new HttpError(400, `${name} must be one of: ${allowed.join(', ')}. See /api/meta.`);
  return value;
}

/** Reads the list query. Unknown category, eligibility or sort values are a 400, not an empty list. */
export function parseListQuery(q: Record<string, string>): ListQuery {
  return {
    lang: parseLang(q.lang),
    sort: (oneOf('sort', q.sort, SORTS) || 'newest') as Sort,
    retailer: (q.retailer ?? '').trim().toLowerCase(),
    category: oneOf('category', q.category, CATEGORIES),
    eligibility: oneOf('eligibility', q.eligibility, ELIGIBILITY),
    text: (q.q ?? '').trim().toLowerCase(),
    limit: Math.min(100, Math.max(1, Math.floor(Number(q.limit)) || 20)),
    page: Math.max(1, Math.floor(Number(q.page)) || 1),
  };
}

/** Whether an offer is still running on `now` (its end date is today or later, or unknown). */
export const isLive = (v: Voucher, now: Date): boolean => !v.expires_on || v.expires_on >= today(now);

export function matches(r: PublicRow, q: ListQuery): boolean {
  const d = r.data;
  if (q.retailer && !d.retailer.toLowerCase().includes(q.retailer) && !d.retailer_url.toLowerCase().includes(q.retailer)) return false;
  if (q.category && d.category !== q.category) return false;
  if (q.eligibility && d.eligibility !== q.eligibility) return false;
  if (q.text && ![d.retailer, d.title_en, d.title_zh, d.code ?? ''].join(' ').toLowerCase().includes(q.text)) return false;
  return true;
}

/**
 * Roughly how much an offer saves, as a percentage of the basket, so different kinds compare:
 * a percentage as is; a fixed amount against its minimum spend (or £50 when there is none);
 * free delivery as a small saving. Unknown values count as nothing.
 */
export function strength(v: Voucher): number {
  const value = v.discount_value ?? 0;
  switch (v.discount_type) {
    case 'percent':
    case 'cashback':
      return value;
    case 'fixed':
      return (value / Math.max(v.min_spend_gbp ?? 0, 50)) * 100;
    case 'bogo':
      return 25;
    case 'free-delivery':
      return 5;
    default:
      return 0;
  }
}

/**
 * best: open to everyone first, then the biggest saving, then no minimum spend, then newest.
 * newest: most recently checked first. ending: soonest end date first, open-ended last.
 */
export function compare(sort: Sort): (a: PublicRow, b: PublicRow) => number {
  const newest = (a: PublicRow, b: PublicRow) => b.verified_at.localeCompare(a.verified_at);
  if (sort === 'newest') return newest;
  if (sort === 'ending') {
    return (a, b) => (a.data.expires_on ?? '9999').localeCompare(b.data.expires_on ?? '9999') || newest(a, b);
  }
  return (a, b) =>
    Number(a.data.eligibility !== 'everyone') - Number(b.data.eligibility !== 'everyone') ||
    strength(b.data) - strength(a.data) ||
    (a.data.min_spend_gbp ?? 0) - (b.data.min_spend_gbp ?? 0) ||
    newest(a, b);
}

export function publicVoucher(r: PublicRow, lang: Lang) {
  const d = r.data;
  const source = hostOf(r.source_url);
  const scheme = PARTNER_SOURCES.find((p) => sameSite(source, p));
  return {
    id: r.id,
    retailer: d.retailer,
    retailer_url: d.retailer_url,
    retailer_domain: retailerDomain(d),
    title: lang === 'zh' ? d.title_zh : d.title_en,
    title_en: d.title_en,
    title_zh: d.title_zh,
    code: d.code,
    discount_type: d.discount_type,
    discount_type_zh: LABELS_ZH[d.discount_type],
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
    source_type: d.source_type,
    via: scheme ? SCHEME_NAMES[scheme] ?? scheme : null,
    verification_level: r.verification_level,
    last_checked_at: r.verified_at,
    source_url: r.source_url,
    evidence: r.evidence,
  };
}

/** Every value the list filters accept, with Chinese labels, for agents to build queries from. */
export function meta() {
  const labelled = (values: readonly string[]) => values.map((value) => ({ value, zh: LABELS_ZH[value] }));
  return {
    langs: ['en', 'zh'],
    sorts: SORTS,
    categories: labelled(CATEGORIES),
    eligibility: labelled(ELIGIBILITY),
    limit: { default: 20, max: 100 },
  };
}
