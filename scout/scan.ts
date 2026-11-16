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
import { extractOffers, type Extraction } from './extract-lib.ts';

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
  const pages: ({ url: string; ok: true } & Omit<Extraction, 'offer_links'>)[] = [];
  const failures: { url: string; reason: string }[] = [];
  const home = await fetchPage(retailer.url);
  if (!home.ok) {
    failures.push({ url: retailer.url, reason: home.reason });
    results.push({ retailer, pages, failures });
    console.error(`✗ ${retailer.name}: ${home.reason}`);
    continue;
  }
  const first = extractOffers(home.html, home.url);
  pages.push({ url: home.url, ok: true, codes: first.codes, offers: first.offers });
  for (const link of first.offer_links.slice(0, maxPages)) {
    await sleep(1000);
    const page = await fetchPage(link.url);
    if (!page.ok) {
      failures.push({ url: link.url, reason: page.reason });
      continue;
    }
    const found = extractOffers(page.html, page.url);
    pages.push({ url: page.url, ok: true, codes: found.codes, offers: found.offers });
  }
  const codes = pages.reduce((n, p) => n + p.codes.length, 0);
  const offers = pages.reduce((n, p) => n + p.offers.length, 0);
  console.error(`✓ ${retailer.name}: ${pages.length} pages, ${codes} codes, ${offers} offer lines${failures.length ? `, ${failures.length} failed` : ''}`);
  results.push({ retailer, pages, failures });
  await sleep(1000);
}

mkdirSync(join(here, 'out'), { recursive: true });
const file = join(here, 'out', `candidates-${new Date().toISOString().slice(0, 10)}.json`);
writeFileSync(file, JSON.stringify({ scanned_at: new Date().toISOString(), results }, null, 2));
console.error(`Wrote ${file}`);
