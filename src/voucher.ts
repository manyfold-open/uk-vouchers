/**
 * What a voucher record is, and the rules a submitted one must pass.
 *
 * Every user-facing text comes in English and Traditional Chinese (title_en / title_zh,
 * terms_en / terms_zh), because the Narra agent answers in both. Everything else is
 * language-neutral: enums, numbers, dates, URLs.
 *
 * Runs in the Worker and in plain Node (the scout tools and tests), so it imports
 * nothing and uses only type syntax Node can strip.
 */

export const DISCOUNT_TYPES = ['percent', 'fixed', 'free-delivery', 'bogo', 'gift', 'cashback', 'other'] as const;
export const CATEGORIES = [
  'beauty', 'fashion', 'luxury', 'grocery', 'home', 'electronics', 'health',
  'travel', 'food-delivery', 'kids', 'sports', 'pets', 'other',
] as const;
export const ELIGIBILITY = ['everyone', 'new-customer', 'student', 'nhs-blue-light', 'members', 'app-only'] as const;
export const SOURCE_TYPES = ['retailer-site', 'newsletter', 'partner-scheme', 'social'] as const;

export type DiscountType = (typeof DISCOUNT_TYPES)[number];
export type Category = (typeof CATEGORIES)[number];
export type Eligibility = (typeof ELIGIBILITY)[number];
export type SourceType = (typeof SOURCE_TYPES)[number];

/** Chinese labels the Narra agent shows next to the enum values. */
export const LABELS_ZH: Record<string, string> = {
  percent: '折扣 %', fixed: '現折 £', 'free-delivery': '免運', bogo: '買一送一', gift: '滿額贈', cashback: '現金回饋', other: '其他',
  beauty: '美妝', fashion: '時尚', luxury: '精品', grocery: '超市', home: '居家', electronics: '3C 電子', health: '保健藥妝',
  travel: '旅遊', 'food-delivery': '外送餐飲', kids: '母嬰兒童', sports: '運動戶外', pets: '寵物',
  everyone: '所有人', 'new-customer': '新客限定', student: '學生', 'nhs-blue-light': 'NHS / Blue Light', members: '會員限定', 'app-only': 'App 限定',
};

export interface Voucher {
  retailer: string;
  retailer_url: string;
  title_en: string;
  title_zh: string;
  code: string | null;
  discount_type: DiscountType;
  discount_value: number | null;
  min_spend_gbp: number | null;
  category: Category;
  eligibility: Eligibility;
  starts_on: string | null;
  expires_on: string | null;
  offer_url: string;
  terms_en: string | null;
  terms_zh: string | null;
  source_type: SourceType;
}

export interface Provenance {
  /** The page the facts were read on. Must belong to the retailer or a partner scheme. */
  source_url: string;
  /** A passage copied word for word from source_url that states the offer (and the code, if any). */
  evidence: string;
}

export interface FieldError {
  field: string;
  message: string;
}

/**
 * Pages that can state another company's offer: the student and key-worker schemes.
 * Coupon aggregators (HotUKDeals, VoucherCodes, …) are deliberately absent: a scout may
 * use them as a hint, but the record's source must be the retailer itself or one of these.
 */
export const PARTNER_SOURCES = [
  'myunidays.com', 'studentbeans.com', 'totum.com', 'bluelightcard.co.uk',
  'healthservicediscounts.com', 'nhsdiscounts.org.uk',
] as const;

const CODE_RE = /^[A-Z0-9][A-Z0-9_-]{2,31}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Registrable-ish host: lowercased, without a leading www. */
export const hostOf = (url: string): string => new URL(url).hostname.toLowerCase().replace(/^www\./, '');

/** Whether `host` is `domain` or one of its subdomains. */
export const sameSite = (host: string, domain: string): boolean => host === domain || host.endsWith(`.${domain}`);

/** The retailer's domain, which identifies it across records ("boots.com"). */
export const retailerDomain = (v: Pick<Voucher, 'retailer_url'>): string => hostOf(v.retailer_url);

/**
 * One identity per live offer: the retailer and the code, or for an automatic discount
 * the retailer and its English title, lowercased with punctuation squeezed out.
 */
export function identityKey(v: Pick<Voucher, 'retailer_url' | 'code' | 'title_en'>): string {
  const who = retailerDomain(v);
  if (v.code) return `${who}|code:${v.code.toUpperCase()}`;
  return `${who}|title:${v.title_en.toLowerCase().replace(/[^\p{L}\p{N}%£]+/gu, ' ').trim()}`;
}

const STOP = new Set(['the', 'a', 'an', 'and', 'or', 'of', 'on', 'for', 'with', 'to', 'in', 'at', 'your', 'you', 'off', 'when', 'over', 'all', 'up']);
/** Words every offer title shares; they say nothing about which products an offer covers. */
const GENERIC = new Set([
  'selected', 'select', 'discount', 'discounts', 'save', 'get', 'extra', 'deal', 'deals', 'offer', 'offers', 'sale', 'now',
  'student', 'students', 'via', 'unidays', 'totum', 'nhs', 'everyone', 'only', 'exclusive',
  'shop', 'online', 'store', 'here', 'today', 'just', 'every', 'one', 'two', 'per', 'less', 'more', 'than', 'is', 'are',
  'enjoy', 'plus', 'from', 'by', 'everything', 'sitewide', 'storewide',
]);
/** Scheme names made of ordinary words, removed as whole phrases so "blue jeans" keeps "blue". */
const SCHEMES = /\b(blue light card|blue light|student beans)\b/gi;
const words = (t: string) =>
  new Set(t.toLowerCase().replace(/[^\p{L}\p{N}%£]+/gu, ' ').split(' ').filter((w) => w && !STOP.has(w)));

/**
 * Whether two offers with no code are the same offer worded differently: same retailer, same
 * discount, same people and minimum spend, and titles that share most of their words.
 * Codes are matched exactly by identityKey instead.
 */
export function sameOffer(a: Voucher, b: Voucher): boolean {
  if (a.code || b.code) return false;
  if (retailerDomain(a) !== retailerDomain(b)) return false;
  if (a.discount_type !== b.discount_type || a.discount_value !== b.discount_value) return false;
  if (a.eligibility !== b.eligibility || (a.min_spend_gbp ?? 0) !== (b.min_spend_gbp ?? 0)) return false;
  // Compare what the offer covers, not how it is phrased: drop amounts, generic deal words and the
  // retailer's own name, plus single letters ("M&S", "women's"), then require most of the remaining words to match (Jaccard >= 0.5).
  // "20% off selected coats" and "20% off selected kidswear" share only generic words: different offers.
  const name = words(a.retailer);
  const content = (t: string) =>
    new Set([...words(t.replace(SCHEMES, ' '))].filter((w) => w.length > 1 && !GENERIC.has(w) && !name.has(w) && !/^[£%\d]/.test(w)));
  const x = content(a.title_en);
  const y = content(b.title_en);
  // Titles with nothing specific left ("20% off everything") match each other, never a specific one.
  if (x.size === 0 || y.size === 0) return x.size === y.size;
  // Names that only one title has (a route, a range, a brand: "Greater Anglia" vs "Northern") mean different offers.
  const names = (t: string, other: Set<string>) =>
    t.split(/\s+/).slice(1).filter((w) => /^\p{Lu}/u.test(w)).map((w) => w.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ''))
      .filter((w) => w && content(t).has(w) && !other.has(w));
  if (names(a.title_en, y).length > 0 && names(b.title_en, x).length > 0) return false;
  const shared = [...x].filter((w) => y.has(w)).length;
  return shared / (x.size + y.size - shared) >= 0.5;
}

const isUrl = (value: unknown): value is string => {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
};

/** A real calendar date: "2026-02-30" is refused rather than read as 2 March. */
const isDate = (value: unknown): value is string => {
  if (typeof value !== 'string' || !DATE_RE.test(value)) return false;
  const ms = Date.parse(`${value}T00:00:00Z`);
  return !Number.isNaN(ms) && new Date(ms).toISOString().slice(0, 10) === value;
};

/**
 * Characters that only appear in Simplified Chinese (their Traditional forms differ), common in
 * offer text: 优惠码 购买 运费 会员 满减 赠 … One of them means the text was not written in Traditional.
 */
const SIMPLIFIED = /[优码购买卖运费会员选门页订单装妆电时个双这们为学价满减赠领关]/u;

export const today = (now = new Date()): string => now.toISOString().slice(0, 10);
export const addDays = (date: string, days: number): string =>
  new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

/**
 * Check one submitted record. Returns the cleaned record, or every error at once so an
 * agent can fix its whole batch in one go.
 */
export function validateVoucher(
  input: unknown,
  provenance: unknown,
  now = new Date(),
): { ok: true; voucher: Voucher; provenance: Provenance } | { ok: false; errors: FieldError[] } {
  const errors: FieldError[] = [];
  const err = (field: string, message: string) => errors.push({ field, message });
  const raw = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const prov = (provenance && typeof provenance === 'object' ? provenance : {}) as Record<string, unknown>;

  const text = (field: string, max: number, required: boolean): string | null => {
    const value = raw[field];
    if (value === undefined || value === null || value === '') {
      if (required) err(field, 'is required');
      return null;
    }
    if (typeof value !== 'string') return err(field, 'must be a string'), null;
    const trimmed = value.replace(/\s+/g, ' ').trim();
    if (trimmed.length > max) err(field, `must be at most ${max} characters`);
    return trimmed;
  };
  const oneOf = <T extends string>(field: string, values: readonly T[]): T => {
    const value = raw[field];
    if (typeof value !== 'string' || !values.includes(value as T)) err(field, `must be one of: ${values.join(', ')}`);
    return value as T;
  };
  const num = (field: string, min: number, max: number): number | null => {
    const value = raw[field];
    if (value === undefined || value === null) return null;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
      err(field, `must be a number from ${min} to ${max}`);
      return null;
    }
    return value;
  };
  const date = (field: string): string | null => {
    const value = raw[field];
    if (value === undefined || value === null || value === '') return null;
    if (!isDate(value)) return err(field, 'must be a date written YYYY-MM-DD'), null;
    return value;
  };

  const retailer = text('retailer', 80, true);
  const retailer_url = raw.retailer_url;
  if (!isUrl(retailer_url)) err('retailer_url', 'must be the retailer’s home page, e.g. https://www.boots.com');
  const title_en = text('title_en', 160, true);
  const title_zh = text('title_zh', 120, true);
  if (title_zh && (!/\p{Script=Han}/u.test(title_zh) || SIMPLIFIED.test(title_zh))) err('title_zh', 'must be written in Traditional Chinese');

  let code = text('code', 32, false);
  if (code) {
    code = code.toUpperCase();
    if (!CODE_RE.test(code)) err('code', 'must be the code exactly as shoppers type it: 3–32 letters, digits, - or _');
  }

  const discount_type = oneOf('discount_type', DISCOUNT_TYPES);
  const discount_value = num('discount_value', 0, discount_type === 'percent' ? 100 : 10_000);
  if ((discount_type === 'percent' || discount_type === 'fixed') && discount_value === null && (raw.discount_value === undefined || raw.discount_value === null)) {
    err('discount_value', `is required when discount_type is ${discount_type}`);
  }
  const min_spend_gbp = num('min_spend_gbp', 0, 100_000);
  const category = oneOf('category', CATEGORIES);
  const eligibility = oneOf('eligibility', ELIGIBILITY);
  const source_type = oneOf('source_type', SOURCE_TYPES);

  const starts_on = date('starts_on');
  const expires_on = date('expires_on');
  const day = today(now);
  if (expires_on && expires_on < day) err('expires_on', 'is in the past: expired offers are not collected');
  if (starts_on && starts_on > addDays(day, 30)) err('starts_on', 'is more than 30 days away: submit it closer to the date');
  if (starts_on && expires_on && starts_on > expires_on) err('expires_on', 'is before starts_on');

  const offer_url = raw.offer_url;
  if (!isUrl(offer_url)) err('offer_url', 'must be the retailer’s page for this offer');
  const terms_en = text('terms_en', 400, false);
  const terms_zh = text('terms_zh', 300, false);
  if (terms_zh && SIMPLIFIED.test(terms_zh)) err('terms_zh', 'must be written in Traditional Chinese');

  // Provenance: an official source, and a passage from it that states the offer.
  const source_url = prov.source_url;
  const evidence = typeof prov.evidence === 'string' ? prov.evidence.replace(/\s+/g, ' ').trim() : '';
  if (!isUrl(source_url)) {
    err('source_url', 'must be the page the offer was read on');
  } else if (isUrl(retailer_url)) {
    const host = hostOf(source_url);
    const own = retailerDomain({ retailer_url });
    if (!sameSite(host, own) && !PARTNER_SOURCES.some((p) => sameSite(host, p))) {
      err('source_url', `must be on ${own} or a partner scheme (${PARTNER_SOURCES.join(', ')}); coupon sites are hints, not sources`);
    }
  }
  if (isUrl(offer_url) && isUrl(retailer_url)) {
    const own = retailerDomain({ retailer_url });
    const host = hostOf(offer_url);
    if (!sameSite(host, own) && !PARTNER_SOURCES.some((p) => sameSite(host, p))) {
      err('offer_url', `must be on ${own} or a partner scheme`);
    }
  }
  if (evidence.length < 20 || evidence.length > 600) err('evidence', 'must be a passage of 20–600 characters copied word for word from source_url');
  else if (code && !evidence.toUpperCase().includes(code)) err('evidence', 'must contain the code itself');

  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    voucher: {
      retailer: retailer!, retailer_url: retailer_url as string, title_en: title_en!, title_zh: title_zh!, code,
      discount_type, discount_value, min_spend_gbp, category, eligibility, starts_on, expires_on,
      offer_url: offer_url as string, terms_en, terms_zh, source_type,
    },
    provenance: { source_url: source_url as string, evidence },
  };
}

/** The example record the scout skill shows. Made up; it passes validateVoucher. */
export const EXAMPLE = {
  data: {
    retailer: 'Example Beauty',
    retailer_url: 'https://www.example-beauty.co.uk',
    title_en: '20% off skincare when you spend £40',
    title_zh: '保養品滿 £40 打 8 折',
    code: 'GLOW20',
    discount_type: 'percent',
    discount_value: 20,
    min_spend_gbp: 40,
    category: 'beauty',
    eligibility: 'everyone',
    starts_on: null,
    expires_on: '2026-12-31',
    offer_url: 'https://www.example-beauty.co.uk/offers',
    terms_en: 'Excludes gift cards. One use per customer.',
    terms_zh: '禮品卡除外，每人限用一次。',
    source_type: 'retailer-site',
  },
  source_url: 'https://www.example-beauty.co.uk/offers',
  evidence: 'Get 20% off skincare when you spend £40 or more with code GLOW20. Ends 31 December 2026.',
};
