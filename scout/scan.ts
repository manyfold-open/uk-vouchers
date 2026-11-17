#!/usr/bin/env node
/**
 * node scout/scan.ts [--only boots,asos] [--part A|B] [--concurrency 8] [--pages 6]
 *
 * Walks the watchlist: opens each retailer's home page, then up to --pages of its offers,
 * promotion-terms and delivery pages, and writes every candidate found to
 * scout/out/candidates-<date>.json, with a summary on stderr. A scout agent reads that file,
 * checks each candidate on the page, writes the record (with title_en and title_zh) and
 * submits it.
 *
 * Fast but polite: several retailers are scanned at once (--concurrency), but each site still
 * gets one request at a time with a second between them. Codes already live on the public API
 * are marked `already_live: true` so the agent can skip them.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchPage } from '../src/fetch-page.ts';
import { extractOffers, type CodeCandidate, type Extraction, type OfferCandidate } from './extract-lib.ts';

const args: string[] = process.argv.slice(2);
const opt = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const only = opt('--only')?.toLowerCase().split(',').filter(Boolean) ?? null;
const part = opt('--part')?.toUpperCase();
const concurrency = Math.max(1, Number(opt('--concurrency') ?? 8));
const maxPages = Math.max(0, Number(opt('--pages') ?? 6));
const here = dirname(fileURLToPath(import.meta.url));
const started = Date.now();

type Retailer = { name: string; url: string; category: string };
const { retailers } = JSON.parse(readFileSync(join(here, 'retailers.json'), 'utf8')) as { retailers: Retailer[] };
let chosen = retailers;
// Same split the scout prompt uses: part A is the first half of the watchlist, part B the rest.
if (part === 'A') chosen = retailers.slice(0, Math.ceil(retailers.length / 2));
if (part === 'B') chosen = retailers.slice(Math.ceil(retailers.length / 2));
if (only) chosen = chosen.filter((r) => only.some((o: string) => r.name.toLowerCase().includes(o) || r.url.includes(o)));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Codes already verified and live, per retailer domain, so the agent does not redo them. */
async function liveCodes(): Promise<Set<string>> {
  const api = process.env.UK_VOUCHERS_API;
  const live = new Set<string>();
  if (!api) return live;
  try {
    const res = await fetch(`${api.replace(/\/$/, '')}/export.json`, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return live;
    const { vouchers } = (await res.json()) as { vouchers: { code: string | null; retailer_domain: string }[] };
    for (const v of vouchers) if (v.code) live.add(`${v.retailer_domain.replace(/^www\./, '')}|${v.code.toUpperCase()}`);
  } catch {
    // Not fatal: without the list every candidate is simply a lead.
  }
  return live;
}

const domainOf = (url: string) => new URL(url).hostname.replace(/^www\./, '');

async function scanRetailer(retailer: Retailer, live: Set<string>) {
  const pages: { url: string; codes: (CodeCandidate & { already_live?: boolean })[]; offers: OfferCandidate[] }[] = [];
  const failures: { url: string; reason: string }[] = [];
  // Banners repeat on every page: keep each code and offer line once, where it was first seen.
  const seenCodes = new Set<string>();
  const seenOffers = new Set<string>();
  const domain = domainOf(retailer.url);
  const keep = (url: string, found: Extraction) => {
    const codes = found.codes
      .filter((c) => !seenCodes.has(c.code) && seenCodes.add(c.code))
      .map((c) => (live.has(`${domain}|${c.code}`) ? { ...c, already_live: true } : c));
    const offers = found.offers.filter((o) => !seenOffers.has(o.quote) && seenOffers.add(o.quote));
    pages.push({ url, codes, offers });
  };
  const home = await fetchPage(retailer.url);
  if (!home.ok) {
    failures.push({ url: retailer.url, reason: home.reason });
    console.error(`✗ ${retailer.name}: ${home.reason}`);
    return { retailer, pages, failures };
  }
  const first = extractOffers(home.html, home.url);
  keep(home.url, first);
  const queue = first.offer_links.slice(0, maxPages);
  const opened = new Set([home.url]);
  while (queue.length) {
    const link = queue.shift()!;
    if (opened.has(link.url)) continue;
    opened.add(link.url);
    await sleep(1000); // one request a second per site
    const page = await fetchPage(link.url);
    if (!page.ok) {
      failures.push({ url: link.url, reason: page.reason });
      // A site that blocks or times out twice will not open the rest either.
      if (failures.length >= 2) break;
      continue;
    }
    keep(page.url, extractOffers(page.html, page.url));
  }
  const all = pages.flatMap((p) => p.codes);
  const fresh = all.filter((c) => !c.expired && !c.already_live).length;
  const known = all.filter((c) => c.already_live).length;
  const offers = pages.reduce((n, p) => n + p.offers.length, 0);
  console.error(
    `✓ ${retailer.name}: ${pages.length} pages, ${fresh} new codes${known ? ` (+${known} already live)` : ''}, ${offers} offer lines` +
      (failures.length ? `, ${failures.length} failed (${[...new Set(failures.map((f) => f.reason))].join('; ')})` : ''),
  );
  return { retailer, pages, failures };
}

const live = await liveCodes();
const results: Awaited<ReturnType<typeof scanRetailer>>[] = new Array(chosen.length);
let next = 0;
await Promise.all(
  Array.from({ length: Math.min(concurrency, chosen.length) }, async () => {
    while (next < chosen.length) {
      const i = next++;
      results[i] = await scanRetailer(chosen[i], live);
    }
  }),
);

mkdirSync(join(here, 'out'), { recursive: true });
const file = join(here, 'out', `candidates-${new Date().toISOString().slice(0, 10)}${part ? `-${part}` : ''}.json`);
writeFileSync(file, JSON.stringify({ scanned_at: new Date().toISOString(), results }, null, 2));
const codes = results.flatMap((r) => r.pages.flatMap((p) => p.codes)).filter((c) => !c.expired && !c.already_live);
console.error(
  `Scanned ${chosen.length} retailers in ${Math.round((Date.now() - started) / 1000)}s: ${codes.length} new codes ` +
    `(${codes.filter((c) => c.confidence === 'high' && c.scope_hint === 'sitewide').length} high-confidence sitewide), ` +
    `${results.filter((r) => !r.pages.length).length} blocked. Wrote ${file}`,
);
