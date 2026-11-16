#!/usr/bin/env node
/**
 * node scout/scan.ts [--only boots,asos] [--depth 1]
 *
 * Walks the watchlist: opens each retailer's home page, then up to 4 of its offers pages,
 * and writes every candidate found to scout/out/candidates-<date>.json, with a summary on
 * stderr. A scout agent reads that file, checks each candidate on the page, writes the
 * record (with title_en and title_zh) and submits it. Polite: one request a second, one site
 * at a time.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchPage } from '../src/fetch-page.ts';
import { extractOffers, type CodeCandidate, type Extraction, type OfferCandidate } from './extract-lib.ts';

const args = process.argv.slice(2);
const only = args.includes('--only') ? args[args.indexOf('--only') + 1].toLowerCase().split(',') : null;
const maxPages = 4;
const here = dirname(fileURLToPath(import.meta.url));

const { retailers } = JSON.parse(readFileSync(join(here, 'retailers.json'), 'utf8')) as {
  retailers: { name: string; url: string; category: string }[];
};
const chosen = retailers.filter((r) => !only || only.some((o: string) => r.name.toLowerCase().includes(o) || r.url.includes(o)));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const results: unknown[] = [];

for (const retailer of chosen) {
  const pages: { url: string; codes: CodeCandidate[]; offers: OfferCandidate[] }[] = [];
  const failures: { url: string; reason: string }[] = [];
  // Banners repeat on every page: keep each code and offer line once, where it was first seen.
  const seenCodes = new Set<string>();
  const seenOffers = new Set<string>();
  const keep = (url: string, found: Extraction) => {
    const codes = found.codes.filter((c) => !seenCodes.has(c.code) && seenCodes.add(c.code));
    const offers = found.offers.filter((o) => !seenOffers.has(o.quote) && seenOffers.add(o.quote));
    pages.push({ url, codes, offers });
  };
  const home = await fetchPage(retailer.url);
  if (!home.ok) {
    failures.push({ url: retailer.url, reason: home.reason });
    results.push({ retailer, pages, failures });
    console.error(`✗ ${retailer.name}: ${home.reason}`);
    continue;
  }
  const first = extractOffers(home.html, home.url);
  keep(home.url, first);
  for (const link of first.offer_links.slice(0, maxPages)) {
    await sleep(1000);
    const page = await fetchPage(link.url);
    if (!page.ok) {
      failures.push({ url: link.url, reason: page.reason });
      continue;
    }
    keep(page.url, extractOffers(page.html, page.url));
  }
  const all = pages.flatMap((p) => p.codes);
  const live = all.filter((c) => !c.expired).length;
  const offers = pages.reduce((n, p) => n + p.offers.length, 0);
  console.error(
    `✓ ${retailer.name}: ${pages.length} pages, ${live} codes${all.length > live ? ` (+${all.length - live} expired)` : ''}, ${offers} offer lines` +
      (failures.length ? `, ${failures.length} failed (${[...new Set(failures.map((f) => f.reason))].join('; ')})` : ''),
  );
  results.push({ retailer, pages, failures });
  await sleep(1000);
}

mkdirSync(join(here, 'out'), { recursive: true });
const file = join(here, 'out', `candidates-${new Date().toISOString().slice(0, 10)}.json`);
writeFileSync(file, JSON.stringify({ scanned_at: new Date().toISOString(), results }, null, 2));
console.error(`Wrote ${file}`);
