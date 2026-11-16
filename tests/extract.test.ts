import { describe, expect, it } from 'vitest';
import { extractOffers } from '../scout/extract-lib.ts';
import { quoteOnPage } from '../src/quote.ts';

const html = `<html><head><style>.x{}</style><script>var CODE="NOTME1"</script></head><body>
<header><a href="/offers">Offers</a> <a href="/student-discount">Student discount</a> <a href="https://other.com/sale">x</a></header>
<div class="banner">Extra 20% off everything with code <strong>FESTIVE20</strong>. Ends midnight 30th November.</div>
<p>Free next day delivery when you spend &pound;50</p>
<p>Use code SAVE10 at checkout for &pound;10 off orders over &pound;75</p>
<p>Shop the NEW collection in 250ML bottles. UK sizes.</p>
<p>Buy one get one half price on all skincare</p>
</body></html>`;

describe('extractOffers', () => {
  const out = extractOffers(html, 'https://www.shop.co.uk/');

  it('finds codes next to the word code, not words or sizes', () => {
    expect(out.codes.map((c) => c.code).sort()).toEqual(['FESTIVE20', 'SAVE10']);
    expect(out.codes.find((c) => c.code === 'FESTIVE20')).toMatchObject({ confidence: 'high', expires_hint: expect.stringContaining('30th November') });
  });

  it('gives passages the server finds on the page again', () => {
    for (const c of out.codes) expect(quoteOnPage(html, c.quote)).toBe(true);
    for (const o of out.offers) expect(quoteOnPage(html, o.quote)).toBe(true);
  });

  it('lists offer lines by kind', () => {
    const kinds = out.offers.flatMap((o) => o.kinds);
    expect(kinds).toEqual(expect.arrayContaining(['percent', 'fixed', 'free-delivery', 'bogo']));
  });

  it('lists same-site offers pages only', () => {
    expect(out.offer_links.map((l) => l.url)).toEqual(['https://www.shop.co.uk/offers', 'https://www.shop.co.uk/student-discount']);
  });
});
