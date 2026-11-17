#!/usr/bin/env node
/**
 * node scout/extract.ts <url> [<url> …]
 *
 * Opens each page and prints JSON: the codes and offer lines found, each with a passage the
 * server will find on the page, plus links to the site's other offers pages. Different sites
 * are opened at the same time; pages on one site one at a time, a second apart. Output keeps
 * the order the URLs were given in.
 */

import { fetchPage } from '../src/fetch-page.ts';
import { extractOffers } from './extract-lib.ts';

const urls: string[] = process.argv.slice(2);
if (!urls.length) {
  console.error('Usage: node scout/extract.ts <url> [<url> …]');
  process.exit(1);
}

const host = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
};
const bySite = new Map<string, number[]>();
urls.forEach((url, i) => bySite.set(host(url), [...(bySite.get(host(url)) ?? []), i]));

const out: unknown[] = new Array(urls.length);
await Promise.all(
  [...bySite.values()].map(async (indexes) => {
    for (const [n, i] of indexes.entries()) {
      if (n) await new Promise((r) => setTimeout(r, 1000));
      const url = urls[i];
      const page = await fetchPage(url);
      out[i] = page.ok ? { url, final_url: page.url, ok: true, ...extractOffers(page.html, page.url) } : { url, ok: false, reason: page.reason };
    }
  }),
);
console.log(JSON.stringify(out, null, 2));
