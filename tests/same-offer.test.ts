import { describe, expect, it } from 'vitest';
import { sameOffer } from '../src/voucher.ts';

const v = (retailer: string, title_en: string) =>
  ({ retailer, retailer_url: 'https://x.example', title_en, code: null, discount_type: 'percent', discount_value: 20, min_spend_gbp: null, eligibility: 'everyone' }) as any;

// Real pairs from the first day of live data.
describe('sameOffer', () => {
  it.each([
    ['Marks & Spencer', '20% off selected coats', '20% off selected coats and jackets'],
    ['The Body Shop', '3 for 2 on Body Care & Haircare', '3 for 2 on selected body care & haircare'],
    ['Cult Beauty', '20% off your app order', '20% off your order in the Cult Beauty app'],
    ['Currys', '10% off all printers for students via Student Beans', 'Students: 10% off all printers at Currys'],
    ['Samsung UK', '10% student discount at the Samsung Education Store', 'Students: 10% off at the Samsung education store'],
    ['Deliveroo', '£15 off £20 minimum spend for new students', 'Students: £15 off £20 minimum spend at Deliveroo (new customers)'],
  ])('same offer at %s: "%s" / "%s"', (r, a, b) => expect(sameOffer(v(r, a), v(r, b))).toBe(true));

  it.each([
    ['Marks & Spencer', '20% off selected coats', "20% off selected women's partywear"],
    ['Marks & Spencer', '20% off selected coats', '20% off selected kidswear'],
    ['Trainline', '25% off Greater Anglia Duo tickets for 2 adults travelling at weekends', '25% off Northern Duo tickets for two adults travelling together at weekends'],
    ['Currys', '10% off all printers for students via Student Beans', 'Students: 10% off Windows laptops at Currys'],
    ['Samsung UK', '10% student discount at the Samsung Education Store', 'Students: 10% off Galaxy Book6 Pro'],
    ['John Lewis', '20% off Christmas lights', '20% off Christmas trees'],
  ])('different offers at %s: "%s" / "%s"', (r, a, b) => expect(sameOffer(v(r, a), v(r, b))).toBe(false));
});
