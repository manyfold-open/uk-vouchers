/**
 * Finding offers on a retailer's page. A scout agent uses this as a first pass: it lists the
 * codes and offer lines on a page, each with a passage copied from the page that the server
 * will find again. The agent still reads the page, writes the titles (English and Chinese),
 * picks the category and eligibility, and decides what is really a live offer.
 *
 * Plain functions with no I/O, so they are easy to test.
 */

import { visibleText } from '../src/quote.ts';

export interface CodeCandidate {
  code: string;
  quote: string;
  confidence: 'high' | 'medium';
  expires_hint: string | null;
}

export interface OfferCandidate {
  quote: string;
  kinds: string[];
  expires_hint: string | null;
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
  STANDARD CLICK&COLLECT FAQ FAQS HELP COOKIES PRIVACY POLICY LOGIN LOG IN OUT BAG CART UNIDAYS TOTUM ASOS HTML CSS JSON
  NEW-IN SIZE GUIDE RETURNS`.split(/\s+/),
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
const EXPIRES = /\b(?:ends?|until|expires?|valid (?:until|till|to)|offer ends|closes)\s+((?:midnight|11\.?59\s?pm)?[^.!?\n]{0,10}?\d{1,2}(?:st|nd|rd|th)?\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*(?:\s+\d{4})?|tonight|midnight\s+\w+|sunday|monday|tuesday|wednesday|thursday|friday|saturday)/i;

/** Lines of visible text, whitespace squeezed, short noise dropped. */
export function textLines(html: string): string[] {
  const lines = visibleText(html)
    .replace(/&nbsp;|&#160;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&pound;|&#163;/g, '£')
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

export function extractOffers(html: string, pageUrl: string): Extraction {
  const lines = textLines(html);
  const codes = new Map<string, CodeCandidate>();
  const offers: OfferCandidate[] = [];

  for (const line of lines) {
    const expires = line.match(EXPIRES)?.[1]?.trim() ?? null;
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
        if (!prev || (prev.confidence === 'medium' && confidence === 'high')) {
          codes.set(token, { code: token, quote: clip(line, m.index!), confidence, expires_hint: expires });
        }
      }
    }
    const kinds = OFFER_KINDS.filter(([, re]) => re.test(line)).map(([k]) => k);
    if (kinds.length && line.length >= 12) offers.push({ quote: clip(line, 0), kinds, expires_hint: expires });
  }

  return { codes: [...codes.values()], offers: offers.slice(0, 40), offer_links: offerLinks(html, pageUrl) };
}

/** Links on the same site that look like offers pages, for the scout to open next. */
export function offerLinks(html: string, pageUrl: string): { url: string; text: string }[] {
  const base = new URL(pageUrl);
  const host = base.hostname.replace(/^www\./, '');
  const out = new Map<string, string>();
  for (const m of html.matchAll(/<a\b[^>]*href=["']([^"'#]+)["'][^>]*>([\s\S]{0,300}?)<\/a>/gi)) {
    const text = m[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    let url: URL;
    try {
      url = new URL(m[1].replace(/&amp;/g, '&'), base);
    } catch {
      continue;
    }
    const sameSite = url.hostname.replace(/^www\./, '') === host || url.hostname.endsWith(`.${host}`);
    if (!sameSite || !/^https?:$/.test(url.protocol)) continue;
    const hay = `${url.pathname} ${text}`.toLowerCase();
    if (/\b(offers?|promotions?|promo|deals?|discounts?|vouchers?|coupons?|sale|student|clearance|savings?)\b/.test(hay)) {
      url.hash = '';
      if (!out.has(url.href)) out.set(url.href, text.slice(0, 80));
    }
  }
  return [...out].slice(0, 15).map(([url, text]) => ({ url, text }));
}
