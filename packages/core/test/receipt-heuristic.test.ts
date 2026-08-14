/**
 * The on-device receipt parser (heuristic.ts).
 *
 * These assert the floor the parser has to clear without a model: recover a
 * total and a list of priced lines from the kind of text ML Kit hands back, in
 * minor units, and be honest — through `confidence` — when it could not.
 */

import { describe, expect, it } from 'vitest';

import { LOW_CONFIDENCE, checkReceipt, parseReceiptText } from '../src/receipt/index';

describe('parseReceiptText', () => {
  it('reads a clean grocery bill: items, total, count, reconciles', () => {
    const receipt = parseReceiptText(
      ['FreshMart', 'Milk 1L        2.50', 'Bread          1.20', 'Eggs x6        3.00', 'TOTAL          6.70'].join(
        '\n',
      ),
    );

    expect(receipt.items).toHaveLength(3);
    expect(receipt.items.map((item) => item.total)).toEqual([250, 120, 300]);
    expect(receipt.grandTotal).toBe(670);
    expect(receipt.merchant).toBe('FreshMart');
    expect(checkReceipt(receipt).reconciles).toBe(true);
    expect(receipt.confidence).toBeGreaterThanOrEqual(LOW_CONFIDENCE);
  });

  it('separates tax, tip and subtotal from items on a restaurant bill', () => {
    const receipt = parseReceiptText(
      [
        'Cafe Rio',
        'Burger         10.00',
        'Fries           4.00',
        'Subtotal       14.00',
        'Tax             1.40',
        'Tip             2.00',
        'Total          17.40',
      ].join('\n'),
    );

    expect(receipt.items).toHaveLength(2);
    expect(receipt.subtotal).toBe(1400);
    expect(receipt.taxes.reduce((sum, tax) => sum + tax.amount, 0)).toBe(140);
    expect(receipt.tip).toBe(200);
    expect(receipt.grandTotal).toBe(1740);
    expect(checkReceipt(receipt).reconciles).toBe(true);
  });

  it('treats a discount as a negative extra, not an item', () => {
    const receipt = parseReceiptText(
      ['Store', 'Shirt          20.00', 'Discount       -5.00', 'Total          15.00'].join('\n'),
    );

    expect(receipt.items).toHaveLength(1);
    expect(receipt.items[0]?.total).toBe(2000);
    expect(receipt.discounts).toHaveLength(1);
    expect(receipt.discounts[0]?.amount).toBe(500);
    expect(receipt.grandTotal).toBe(1500);
    expect(checkReceipt(receipt).reconciles).toBe(true);
  });

  it('detects the currency from a symbol in the text', () => {
    const receipt = parseReceiptText(['Chai        ₹40.00', 'TOTAL      ₹40.00'].join('\n'));
    expect(receipt.currency).toBe('INR');
    expect(receipt.grandTotal).toBe(4000);
  });

  it('falls back to the caller currency when the text carries none', () => {
    const receipt = parseReceiptText('Coffee 3.00\nTotal 3.00', { currency: 'EUR' });
    expect(receipt.currency).toBe('EUR');
  });

  it('scales a decimal-free amount to minor units', () => {
    const receipt = parseReceiptText('Water 20\nTotal 20', { currency: 'INR' });
    expect(receipt.grandTotal).toBe(2000);
  });

  it('drops payment-mechanics noise instead of counting it as an item', () => {
    const receipt = parseReceiptText(
      ['Deli', 'Sandwich       8.00', 'Total          8.00', 'Cash          10.00', 'Change         2.00'].join(
        '\n',
      ),
    );
    expect(receipt.items).toHaveLength(1);
    expect(receipt.grandTotal).toBe(800);
    expect(checkReceipt(receipt).reconciles).toBe(true);
  });

  it('returns an empty, zero-confidence result for unreadable text', () => {
    const receipt = parseReceiptText('~~~ receipt unreadable ~~~\n????\n@@@@');
    expect(receipt.items).toHaveLength(0);
    expect(receipt.grandTotal).toBe(0);
    expect(receipt.confidence).toBe(0);
  });

  it('lowers confidence when no total was printed and it had to be inferred', () => {
    const withTotal = parseReceiptText('Tea 2.00\nCake 3.00\nTotal 5.00');
    const noTotal = parseReceiptText('Tea 2.00\nCake 3.00');
    expect(noTotal.grandTotal).toBe(500);
    expect(noTotal.confidence).toBeLessThan(withTotal.confidence);
  });

  it('never throws on arbitrary input', () => {
    expect(() => parseReceiptText('')).not.toThrow();
    expect(() => parseReceiptText('\n\n\n')).not.toThrow();
    expect(() => parseReceiptText('12345')).not.toThrow();
  });
});
