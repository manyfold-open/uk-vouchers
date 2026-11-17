import { describe, expect, it } from 'vitest';
import { sameOffer, type Voucher } from '../src/voucher.ts';

const offer = (title_en: string, extra: Partial<Voucher> = {}): Voucher => ({
  retailer: 'Marks & Spencer',
  retailer_url: 'https://www.marksandspencer.com',
  title_en,
  title_zh: '測試優惠',
  code: null,
  discount_type: 'percent',
  discount_value: 20,
  min_spend_gbp: null,
  category: 'fashion',
  eligibility: 'everyone',
  starts_on: null,
  expires_on: null,
  offer_url: 'https://www.marksandspencer.com/offers',
  terms_en: null,
  terms_zh: null,
  source_type: 'retailer-site',
  ...extra,
});

describe('sameOffer', () => {
  it('matches the same offer worded differently', () => {
    expect(sameOffer(offer('20% off selected coats'), offer('Save 20% on coats'))).toBe(true);
    expect(sameOffer(offer('20% off women’s coats and jackets'), offer('Get 20% off coats & jackets for women'))).toBe(true);
    expect(sameOffer(offer('20% off coats and jackets'), offer('Extra 20% off jackets and coats online'))).toBe(true);
  });

  it('keeps apart offers that share only generic words', () => {
    expect(sameOffer(offer('20% off selected coats'), offer('20% off selected kidswear'))).toBe(false);
    expect(sameOffer(offer('Student discount: 20% off dresses'), offer('Student discount: 20% off shoes'))).toBe(false);
  });

  it('ignores the retailer’s own name', () => {
    expect(sameOffer(offer('M&S: 20% off coats'), offer('20% off coats at Marks and Spencer'))).toBe(true);
  });

  it('removes scheme names as phrases but keeps the same words elsewhere', () => {
    const nhs = { eligibility: 'nhs-blue-light' } as const;
    expect(sameOffer(offer('Blue Light Card: 20% off coats', nhs), offer('20% off coats for NHS staff', nhs))).toBe(true);
    expect(sameOffer(offer('20% off blue jeans'), offer('20% off black jeans'))).toBe(false);
  });

  it('matches catch-all titles with each other but not with specific ones', () => {
    expect(sameOffer(offer('20% off everything'), offer('Save 20% online today'))).toBe(true);
    expect(sameOffer(offer('20% off everything'), offer('20% off coats'))).toBe(false);
  });

  it('requires the same terms, retailer and no code', () => {
    const base = offer('20% off coats');
    expect(sameOffer(base, offer('20% off coats', { discount_value: 25 }))).toBe(false);
    expect(sameOffer(base, offer('20% off coats', { eligibility: 'student' }))).toBe(false);
    expect(sameOffer(base, offer('20% off coats', { min_spend_gbp: 50 }))).toBe(false);
    expect(sameOffer(base, offer('20% off coats', { retailer_url: 'https://www.next.co.uk' }))).toBe(false);
    expect(sameOffer(base, offer('20% off coats', { code: 'COATS20' }))).toBe(false);
    expect(sameOffer(base, offer('20% off coats', { min_spend_gbp: 0 }))).toBe(true);
  });
});
