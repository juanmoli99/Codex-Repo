import { describe, expect, it } from 'vitest';
import { TaxLotBook } from './book.js';

describe('TaxLotBook', () => {
  it('disposes FIFO and applies a future wash-sale loss to replacement basis', () => {
    let id = 0;
    const book = new TaxLotBook(() => `id-${(id += 1)}`);
    const first = book.acquire({
      symbol: 'AAPL',
      fillId: 'buy-1',
      acquiredAt: new Date('2026-01-01T14:00:00Z'),
      quantity: 10,
      price: 100,
    });
    const sale = book.disposeFifo({
      symbol: 'AAPL',
      fillId: 'sell-1',
      soldAt: new Date('2026-02-01T14:00:00Z'),
      quantity: 10,
      price: 90,
    });
    expect(sale.realizedPnl.toFixed()).toBe('-100');
    expect(first.remainingQuantity.toFixed()).toBe('0');
    const replacement = book.acquire({
      symbol: 'AAPL',
      fillId: 'buy-2',
      acquiredAt: new Date('2026-02-15T14:00:00Z'),
      quantity: 6,
      price: 95,
    });
    expect(replacement.basisPerShare.toFixed()).toBe('105');
    expect(book.reportWashSales()[0]?.disallowedLoss.toFixed()).toBe('60');
  });

  it('refuses to dispose more shares than registered', () => {
    const book = new TaxLotBook();
    book.acquire({ symbol: 'AAPL', fillId: 'b', acquiredAt: new Date(), quantity: 1, price: 10 });
    expect(() =>
      book.disposeFifo({ symbol: 'AAPL', fillId: 's', soldAt: new Date(), quantity: 2, price: 9 }),
    ).toThrow('Insufficient tax-lot quantity');
  });
});
