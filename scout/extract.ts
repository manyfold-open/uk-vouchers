#!/usr/bin/env node
/**
 * node scout/extract.ts <url> [<url> …]
 *
 * Opens each page and prints JSON: the codes and offer lines found, each with a passage the
 * server will find on the page, plus links to the site's other offers pages.
 */

import { fetchPage } from '../src/fetch-page.ts';
import { extractOffers } from './extract-lib.ts';

const urls = process.argv.slice(2);
if (!urls.length) {
  console.error('Usage: node scout/extract.ts <url> [<url> …]');
  process.exit(1);
}

const out = [];
for (const url of urls) {
  const page = await fetchPage(url);
  if (!page.ok) {
    out.push({ url, ok: false, reason: page.reason });
    continue;
  }
  out.push({ url, final_url: page.url, ok: true, ...extractOffers(page.html, page.url) });
  await new Promise((r) => setTimeout(r, 1000));
}
console.log(JSON.stringify(out, null, 2));
