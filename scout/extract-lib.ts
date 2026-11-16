/**
 * Finding offers on a retailer's page. A scout agent uses this as a first pass: it lists the
 * codes and offer lines on a page, each with a passage copied from the page that the server
 * will find again. The agent still reads the page, writes the titles (English and Chinese),
 * picks the category and eligibility, and decides what is really a live, sitewide offer.
 *
 * Plain functions with no I/O, so they are easy to test.
 */

import { decodeEntities, visibleText } from '../src/quote.ts';

export interface CodeCandidate {
  code: string;
  quote: string;
  confidence: 'high' | 'medium';
  /** The passage that states an end date, if one was found near the code. */
  expires_hint: string | null;
  /** That end date as YYYY-MM-DD, when it could be read. */
  expires_on_guess: string | null;
  /** True when expires_on_guess is before today: skip it. */
  expired: boolean;
  /** sitewide: nothing says otherwise. selected: the text limits it to some products or services. product: found only in one product's data. */
  scope_hint: 'sitewide' | 'selected' | 'product';
  /** How many times the code appears in the page source: many repeats usually mean product tiles. */
  occurrences: number;
  /** The lines around the quote, for the agent to judge. */
  context: string[];
}

export interface OfferCandidate {
  quote: string;
  kinds: string[];
  expires_hint: string | null;
  expires_on_guess: string | null;
  expired: boolean;
}

export interface Extraction {
  codes: CodeCandidate[];
  offers: OfferCandidate[];
  offer_links: { url: string; text: string }[];
}

/** Upper-case words that are never codes. */
const NOT_CODES = new Set(
  `CODE CODES OFF FREE SALE SHOP NOW UK GB VAT NEW GBP SAVE PROMO VOUCHER VOUCHERS DISCOUNT DELIVERY ONLINE APP NHS
  STUDENT STUDENTS ENDS EXTRA BLACK FRIDAY CYBER MONDAY CHRISTMAS XMAS WOMEN MEN KIDS HOME BEAUTY GIFT GIFTS TERMS
  CONDITIONS APPLY ONLY ALL AND THE FOR WITH YOUR OUR USE ENTER CHECKOUT BASKET ORDER ORDERS SIGN JOIN MORE INFO
  HERE CLICK TAP SPEND OFFER OFFERS DEAL DEALS LIMITED TIME TODAY EXCLUSIVE MEMBERS MEMBER ACCOUNT EMAIL NEXT DAY
  STANDARD FAQ FAQS HELP COOKIES PRIVACY POLICY LOGIN LOG IN OUT BAG CART UNIDAYS TOTUM ASOS HTML CSS JSON
  SIZE GUIDE RETURNS ENJOY HERE NEW-IN EXPIRY DATE PROMOTION PROMOTIONS`.split(/\s+/),
);

const CODE_TOKEN = /\b([A-Z][A-Z0-9]{2,19}(?:-[A-Z0-9]{2,10})?|[0-9]{2,6}[A-Z][A-Z0-9]{1,15})\b/g;
const CODE_WORD = /\b(?:promo|discount|voucher|coupon|offer)?\s*codes?\b|\buse\b|\benter\b|\bapply\b/i;
const OFFER_KINDS: [string, RegExp][] = [
  ['percent', /\b\d{1,2}(?:\.\d)?\s?% off\b|\bup to \d{1,2}% off\b|\bextra \d{1,2}%/i],
  ['fixed', /£\s?\d+(?:\.\d{2})? off\b|\bsave £\s?\d+/i],
  ['free-delivery', /\bfree (?:next[- ]day |standard |uk |express )?(?:delivery|shipping)\b/i],
  ['bogo', /\bbuy one,? get one\b|\b3 for 2\b|\b2 for £?\d+|\bbogof?\b|\bhalf price\b/i],
  ['gift', /\bfree gift\b|\bgift with purchase\b|\bgwp\b/i],
  ['student', /\bstudent discount\b|\bunidays\b|\bstudent beans\b/i],
];
const SELECTED = /\bselected\b|\bthis (?:item|product)\b|\bonly (?:on|applies to|valid on)\b|\bmade to measure\b|\bexcluding\b.*\bexcept\b|\bon (?:all )?[a-z]+ (?:lines|ranges?) only\b/i;
const END_WORD = /\b(?:ends?|until|till|expires?|expiry|valid (?:until|till|to|between)|offer ends|closes|before|between|to)\b/i;

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const MONTH = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const DAY_MONTH = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?(?:\\s+of)?\\s+${MONTH}\\b,?(?:\\s+(\\d{4}))?`, 'gi');
const MONTH_DAY = new RegExp(`\\b${MONTH}\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b,?(?:\\s+(\\d{4}))?`, 'gi');
const NUMERIC = /\b(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})\b/g;

const iso = (y: number, m: number, d: number): string | null => {
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCDate() === d ? date.toISOString().slice(0, 10) : null;
};

/**
 * Every date written in a passage, as YYYY-MM-DD, in UK order (day before month). A date
 * without a year takes today's year, or next year when that would put it more than four
 * months in the past (a December page mentioning "2nd January").
 */
export function datesIn(text: string, today: string): string[] {
  const year = Number(today.slice(0, 4));
  const withYear = (y: string | undefined, m: number, d: number) => {
    if (y) return iso(y.length === 2 ? 2000 + Number(y) : Number(y), m, d);
    const guess = iso(year, m, d);
    if (!guess) return null;
    const monthsBack = (Date.parse(today) - Date.parse(guess)) / (30 * 86_400_000);
    return monthsBack > 4 ? iso(year + 1, m, d) : guess;
  };
  const out: string[] = [];
  for (const m of text.matchAll(DAY_MONTH)) out.push(withYear(m[3], MONTHS.indexOf(m[2].slice(0, 3).toLowerCase()) + 1, Number(m[1])) ?? '');
  for (const m of text.matchAll(MONTH_DAY)) out.push(withYear(m[3], MONTHS.indexOf(m[1].slice(0, 3).toLowerCase()) + 1, Number(m[2])) ?? '');
  for (const m of text.matchAll(NUMERIC)) out.push(withYear(m[3], Number(m[2]), Number(m[1])) ?? '');
  return out.filter(Boolean);
}

/** The end date stated in these lines, if any: the latest date in a passage that talks about an end. */
function endDate(lines: string[], today: string): { hint: string | null; date: string | null; expired: boolean } {
  for (const line of lines) {
    if (!END_WORD.test(line)) continue;
    const dates = datesIn(line, today);
    if (dates.length) {
      const date = dates.sort().at(-1)!;
      return { hint: line.length > 200 ? line.slice(0, 200) : line, date, expired: date < today };
    }
    if (/\b(?:tonight|today only|ends today)\b/i.test(line)) return { hint: line, date: today, expired: false };
  }
  return { hint: null, date: null, expired: false };
}

/** Lines of visible text, entities decoded, whitespace squeezed, short noise dropped. */
export function textLines(html: string): string[] {
  const lines = decodeEntities(visibleText(html))
    .split(/\n+/)
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter((l) => l.length >= 6 && l.length <= 600);
  return [...new Set(lines)];
}

const clip = (line: string, around: number, max = 300): string => {
  if (line.length <= max) return line;
  const start = Math.max(0, around - max / 2);
  // Cut on word boundaries so the passage is still found on the page.
  const slice = line.slice(start, start + max);
  return slice.replace(/^\S*\s/, '').replace(/\s\S*$/, '');
};

/** A filter or facet label with a result count, like "Up To 20% Off ( 676 )". */
const FACET = /\(\s*\d[\d,]*\s*\)\s*$/;

export function extractOffers(html: string, pageUrl: string, today = new Date().toISOString().slice(0, 10)): Extraction {
  const lines = textLines(html);
  const codes = new Map<string, CodeCandidate>();
  const offers: OfferCandidate[] = [];
  const occurrences = (code: string) => html.split(code).length - 1;

  lines.forEach((line, i) => {
    const near = lines.slice(i, i + 3);
    if (CODE_WORD.test(line)) {
      for (const m of line.matchAll(CODE_TOKEN)) {
        const token = m[1];
        if (NOT_CODES.has(token) || /^\d+$/.test(token) || /^(?:[A-Z]{2,3}\d{1,2}|\d+(?:ML|G|KG|CM|MM|GB|TB|HZ|W))$/.test(token)) continue;
        const before = line.slice(Math.max(0, m.index! - 40), m.index!);
        const nearCodeWord = /\b(?:code|use|enter|apply)\b[\s:'"“‘]*$/i.test(before) || /code[:\s]*['"“‘]?$/i.test(before);
        const hasDigitAndLetter = /\d/.test(token) && /[A-Z]/.test(token);
        if (!nearCodeWord && !hasDigitAndLetter) continue;
        const confidence = nearCodeWord ? 'high' : 'medium';
        const prev = codes.get(token);
        if (prev && !(prev.confidence === 'medium' && confidence === 'high')) continue;
        const end = endDate(near, today);
        const count = occurrences(token);
        const context = lines.slice(Math.max(0, i - 2), i + 3).filter((l) => l !== line);
        codes.set(token, {
          code: token,
          quote: clip(line, m.index!),
          confidence,
          expires_hint: end.hint,
          expires_on_guess: end.date,
          expired: end.expired,
          scope_hint: SELECTED.test([line, ...context].join(' ')) || count > 6 ? 'selected' : 'sitewide',
          occurrences: count,
          context,
        });
      }
    }
    if (FACET.test(line) || line.length < 12 || line.length > 220) return;
    const kinds = OFFER_KINDS.filter(([, re]) => re.test(line)).map(([k]) => k);
    if (kinds.length) {
      const end = endDate(near, today);
      offers.push({ quote: clip(line, 0), kinds, expires_hint: end.hint, expires_on_guess: end.date, expired: end.expired });
    }
  });

  // Codes that live only in a product's data (e.g. "discountCode":"RSVP"): one product, not sitewide.
  for (const m of html.matchAll(/"(?:discountCode|promoCode|promotionCode|couponCode|voucherCode)"\s*:\s*"([A-Z0-9][A-Z0-9_-]{2,31})"/g)) {
    const token = m[1];
    const known = codes.get(token);
    if (known) {
      known.scope_hint = 'product';
      continue;
    }
    const line = lines.find((l) => l.includes(token));
    if (!line) continue; // A code no shopper can see is not something to quote.
    codes.set(token, {
      code: token, quote: clip(line, line.indexOf(token)), confidence: 'medium', expires_hint: null, expires_on_guess: null,
      expired: false, scope_hint: 'product', occurrences: occurrences(token), context: [],
    });
  }

  return { codes: [...codes.values()], offers: offers.slice(0, 40), offer_links: offerLinks(html, pageUrl) };
}

/** Pages that look like offers but never are: products, gift cards, help and accounts. */
const NOT_OFFER_PAGES = /\/p\/\d|\/product[s]?\/|\/dp\/|gift-?cards?|\/help\b|customer-?services?|\/faqs?\b|\/account|\/login|\/sign-?in|\/basket|\/cart|\/stores?\//i;

/** Links on the same site that look like offers pages, best first, for the scout to open next. */
export function offerLinks(html: string, pageUrl: string): { url: string; text: string }[] {
  const base = new URL(pageUrl);
  const host = base.hostname.replace(/^www\./, '');
  const found = new Map<string, { text: string; score: number }>();
  for (const m of html.matchAll(/<a\b[^>]*href=["']([^"'#]+)["'][^>]*>([\s\S]{0,300}?)<\/a>/gi)) {
    const text = decodeEntities(m[2].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
    let url: URL;
    try {
      url = new URL(decodeEntities(m[1]), base);
    } catch {
      continue;
    }
    const sameSite = url.hostname.replace(/^www\./, '') === host || url.hostname.endsWith(`.${host}`);
    if (!sameSite || !/^https?:$/.test(url.protocol) || NOT_OFFER_PAGES.test(url.pathname)) continue;
    const hay = `${url.pathname} ${text}`.toLowerCase();
    let score = 0;
    if (/(coded-?promo|promo-?codes?|discount-?codes?|voucher|coupon)/.test(hay)) score = 3;
    else if (/\b(offers?|promotions?|promo|deals?|discounts?|student)\b/.test(hay)) score = 2;
    else if (/\b(sale|clearance|savings?)\b/.test(hay)) score = 1;
    if (/terms|conditions|t-?and-?c/.test(hay) && /promo|offer/.test(hay)) score = Math.max(score, 3); // promotions T&Cs list codes and dates
    if (!score) continue;
    url.hash = '';
    const prev = found.get(url.href);
    if (!prev || prev.score < score) found.set(url.href, { text: text.slice(0, 80), score });
  }
  return [...found]
    .sort((a, b) => b[1].score - a[1].score)
    .slice(0, 15)
    .map(([url, { text }]) => ({ url, text }));
}
