/**
 * Is a passage on a page? Copying text between tools changes entities, quotes, dashes and
 * spacing, so both sides are made uniform before comparing. Idea from manyfold-data's
 * src/shared/quote.ts, written smaller for this project.
 */

const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', pound: '£', euro: '€',
  ndash: '-', mdash: '-', lsquo: "'", rsquo: "'", ldquo: '"', rdquo: '"', hellip: '…', copy: '©', reg: '®', trade: '™',
};

export function normalize(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&([a-z]+);/gi, (m, name: string) => ENTITIES[name.toLowerCase()] ?? m)
    .replace(/[­​-‏⁠﻿]/g, '')
    .normalize('NFKC')
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[‐‑‒–—−]/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/ ([,.;:!?)])/g, '$1')
    .trim()
    .toLowerCase();
}

/** Visible text of a page: scripts, styles and tags dropped. */
export const visibleText = (html: string): string =>
  html
    .replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|li|h[1-6]|section|article|tr|td|span|a|button)>/gi, '$&\n')
    .replace(/<[^>]+>/g, ' ');

/** Text pages ship inside JSON (Next.js and similar): string escapes undone. */
export const embeddedText = (html: string): string =>
  html
    .replace(/\\u([0-9a-f]{4})/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\n/g, ' ')
    .replace(/\\"/g, '"')
    .replace(/<[^>]+>/g, ' ');

export function quoteOnPage(html: string, quote: string): boolean {
  const wanted = normalize(quote);
  if (!wanted) return false;
  return normalize(visibleText(html)).includes(wanted) || normalize(embeddedText(html)).includes(wanted);
}
