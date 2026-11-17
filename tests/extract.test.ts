import { describe, expect, it } from 'vitest';
import { datesIn, extractOffers, offerLinks } from '../scout/extract-lib.ts';
import { blockedPage } from '../src/fetch-page.ts';
import { quoteOnPage } from '../src/quote.ts';

const TODAY = '2026-11-16';
const html = `<html><head><style>.x{}</style><script>var CODE="NOTME1"</script></head><body>
<header><a href="/offers">Offers</a> <a href="/student-discount">Student discount</a> <a href="https://other.com/sale">x</a>
<a href="/p/15861510/">Offer lipstick</a> <a href="/help/gift-cards">Gift card offers</a> <a href="/women/ctas/coded-promos/promo-17/">Best of Brands</a></header>
<div class="banner">Extra 20% off everything with code <strong>FESTIVE20</strong>. Ends midnight 30th November.</div>
<p>Free next day delivery when you spend &pound;50</p>
<p>Use code SAVE10 at checkout for &pound;10 off orders over &pound;75</p>
<p>Shop the NEW collection in 250ML bottles. UK sizes.</p>
<p>Buy one get one half price on all skincare</p>
<p>Caroline Hirons&#x27; picks: 25% off</p>
<ul><li>Up To 20% Off ( 676 )</li></ul>
<p>Use code PAYDAY15 for 15% off Made to Measure.</p><p>The offer is valid from 23rd October 2026 until 11:59pm on 2nd November 2026 ("Expiry Date").</p>
</body></html>`;

describe('extractOffers', () => {
  const out = extractOffers(html, 'https://www.shop.co.uk/', TODAY);
  const code = (c: string) => out.codes.find((x) => x.code === c)!;

  it('finds codes next to the word code, not words or sizes', () => {
    expect(out.codes.map((c) => c.code).sort()).toEqual(['FESTIVE20', 'PAYDAY15', 'SAVE10']);
  });

  it('reads end dates, and marks codes that already ended', () => {
    expect(code('FESTIVE20')).toMatchObject({ expires_on_guess: '2026-11-30', expired: false, scope_hint: 'sitewide' });
    expect(code('PAYDAY15')).toMatchObject({ expires_on_guess: '2026-11-02', expired: true, scope_hint: 'selected' });
    expect(code('SAVE10').expires_on_guess).toBeNull();
  });

  it('gives passages the server finds on the page again, with entities decoded', () => {
    for (const c of out.codes) expect(quoteOnPage(html, c.quote)).toBe(true);
    for (const o of out.offers) expect(quoteOnPage(html, o.quote)).toBe(true);
    expect(out.offers.map((o) => o.quote)).toContain("Caroline Hirons' picks: 25% off");
  });

  it('lists offer lines by kind, without filter counts', () => {
    const kinds = out.offers.flatMap((o) => o.kinds);
    expect(kinds).toEqual(expect.arrayContaining(['percent', 'fixed', 'free-delivery', 'bogo']));
    expect(out.offers.some((o) => o.quote.includes('676'))).toBe(false);
  });

  it('lists same-site offers pages best first, never products or gift cards', () => {
    expect(out.offer_links.map((l) => l.url)).toEqual([
      'https://www.shop.co.uk/women/ctas/coded-promos/promo-17/',
      'https://www.shop.co.uk/offers',
      'https://www.shop.co.uk/student-discount',
    ]);
  });

  it('marks a code that only lives in one product’s data', () => {
    const page = '<div><span>Dress</span><span>with code: RSVP</span></div><script>{"discountCode":"RSVP","discountBenefitValue":25}</script>';
    expect(extractOffers(page, 'https://www.asos.com/women/dresses/', TODAY).codes[0]).toMatchObject({ code: 'RSVP', scope_hint: 'product' });
  });
});

describe('datesIn', () => {
  it('reads UK dates, filling in the year', () => {
    expect(datesIn('until 11:59pm on 2nd November 2026', TODAY)).toEqual(['2026-11-02']);
    expect(datesIn('Ends 31 Dec', TODAY)).toEqual(['2026-12-31']);
    expect(datesIn('Ends 2nd January', TODAY)).toEqual(['2027-01-02']);
    expect(datesIn('valid to 05/12/2026', TODAY)).toEqual(['2026-12-05']);
    expect(datesIn('Ends November 30, 2026', TODAY)).toEqual(['2026-11-30']);
  });
});

describe('blockedPage', () => {
  it('spots bot checks that answer 200', () => {
    expect(blockedPage('<html><head><title>Pardon Our Interruption</title></head></html>')).toMatch(/bot check/);
    expect(blockedPage('<title>Just a moment...</title>')).toMatch(/bot check/);
    expect(blockedPage('<title>Boots | Offers</title><p>20% off</p>')).toBeNull();
  });
});

it('offerLinks keeps promotion terms and delivery info under /help, and skips products and gift vouchers', () => {
  const page = `<a href="/info/help/promotions-terms-and-conditions">Promotion T&Cs</a>
    <a href="/p/beauty-box/the-advent-calendar/17691490/">Offer box</a>
    <a href="/gift-vouchers/">Gift voucher offers</a> <a href="/evouchers">eVoucher deals</a> <a href="/help/delivery">Help: delivery offers</a>`;
  expect(offerLinks(page, 'https://www.dunelm.com/').map((l) => l.url)).toEqual([
    'https://www.dunelm.com/info/help/promotions-terms-and-conditions',
    'https://www.dunelm.com/help/delivery',
  ]);
});

it('offerLinks keeps delivery information pages even without offer words', () => {
  const page = '<a href="/delivery-information">Delivery</a> <a href="/help/returns">Returns</a> <a href="/p/delivery-van/123">Toy van</a>';
  expect(offerLinks(page, 'https://www.shop.co.uk/').map((l) => l.url)).toEqual(['https://www.shop.co.uk/delivery-information']);
});

it('leaves site chrome out of a code’s context', () => {
  const page = '<p>Skip to main content</p><p>Menu</p><p>Enjoy 15% Off Your First Order Using Code FIRST15</p><p>Shop skincare</p>';
  expect(extractOffers(page, 'https://www.spacenk.com/', '2026-11-16').codes[0].context).toEqual(['Shop skincare']);
});

it('offerLinks ignores other sites', () => {
  expect(offerLinks('<a href="https://other.com/offers">Offers</a>', 'https://www.shop.co.uk/')).toEqual([]);
});
