import { randomUUID } from 'node:crypto';
import { Decimal } from 'decimal.js';

export interface TaxLot {
  readonly id: string;
  readonly symbol: string;
  readonly acquisitionFillId: string;
  readonly acquiredAt: Date;
  readonly acquisitionPrice: Decimal;
  readonly originalQuantity: Decimal;
  remainingQuantity: Decimal;
  basisPerShare: Decimal;
}

export interface LotDisposition {
  readonly id: string;
  readonly saleFillId: string;
  readonly lotId: string;
  readonly symbol: string;
  readonly soldAt: Date;
  readonly quantity: Decimal;
  readonly proceeds: Decimal;
  readonly costBasis: Decimal;
  readonly realizedPnl: Decimal;
}

export interface CostBasisAdjustment {
  readonly id: string;
  readonly lotId: string;
  readonly reason: 'WASH_SALE' | 'CORPORATE_ACTION' | 'BROKER_RECONCILIATION' | 'MANUAL';
  readonly amount: Decimal;
  readonly detail: string;
  readonly adjustedAt: Date;
}

export interface WashSaleRecord {
  readonly id: string;
  readonly saleFillId: string;
  readonly replacementLotId: string;
  readonly symbol: string;
  readonly replacementQuantity: Decimal;
  readonly disallowedLoss: Decimal;
  readonly detectedAt: Date;
}

interface PendingWashLoss {
  readonly saleFillId: string;
  readonly symbol: string;
  readonly soldAt: Date;
  remainingQuantity: Decimal;
  lossPerShare: Decimal;
}

export interface SaleResult {
  readonly dispositions: readonly LotDisposition[];
  readonly realizedPnl: Decimal;
  readonly washSales: readonly WashSaleRecord[];
}

const WASH_WINDOW_MS = 30 * 24 * 60 * 60 * 1_000;

export class TaxLotBook {
  private readonly lots: TaxLot[] = [];
  private readonly dispositions: LotDisposition[] = [];
  private readonly adjustments: CostBasisAdjustment[] = [];
  private readonly washSales: WashSaleRecord[] = [];
  private readonly pendingLosses: PendingWashLoss[] = [];

  public constructor(private readonly idFactory: () => string = randomUUID) {}

  public acquire(input: {
    symbol: string;
    fillId: string;
    acquiredAt: Date;
    quantity: Decimal.Value;
    price: Decimal.Value;
  }): TaxLot {
    const quantity = new Decimal(input.quantity);
    const price = new Decimal(input.price);
    if (!quantity.gt(0) || !price.gt(0)) throw new Error('Invalid acquisition');
    const lot: TaxLot = {
      id: this.idFactory(),
      symbol: input.symbol,
      acquisitionFillId: input.fillId,
      acquiredAt: new Date(input.acquiredAt),
      acquisitionPrice: price,
      originalQuantity: quantity,
      remainingQuantity: quantity,
      basisPerShare: price,
    };
    this.lots.push(lot);
    this.applyFutureReplacementLosses(lot);
    return lot;
  }

  public disposeFifo(input: {
    symbol: string;
    fillId: string;
    soldAt: Date;
    quantity: Decimal.Value;
    price: Decimal.Value;
  }): SaleResult {
    let remaining = new Decimal(input.quantity);
    const price = new Decimal(input.price);
    if (!remaining.gt(0) || !price.gt(0)) throw new Error('Invalid disposition');
    const eligible = this.lots
      .filter(
        (lot) =>
          lot.symbol === input.symbol &&
          lot.remainingQuantity.gt(0) &&
          lot.acquiredAt.getTime() <= input.soldAt.getTime(),
      )
      .sort((left, right) => left.acquiredAt.getTime() - right.acquiredAt.getTime());
    if (
      eligible.reduce((sum, lot) => sum.plus(lot.remainingQuantity), new Decimal(0)).lt(remaining)
    )
      throw new Error('Insufficient tax-lot quantity');

    const saleDispositions: LotDisposition[] = [];
    for (const lot of eligible) {
      if (!remaining.gt(0)) break;
      const quantity = Decimal.min(remaining, lot.remainingQuantity);
      const costBasis = quantity.mul(lot.basisPerShare);
      const proceeds = quantity.mul(price);
      const disposition: LotDisposition = {
        id: this.idFactory(),
        saleFillId: input.fillId,
        lotId: lot.id,
        symbol: input.symbol,
        soldAt: new Date(input.soldAt),
        quantity,
        proceeds,
        costBasis,
        realizedPnl: proceeds.minus(costBasis),
      };
      lot.remainingQuantity = lot.remainingQuantity.minus(quantity);
      remaining = remaining.minus(quantity);
      saleDispositions.push(disposition);
      this.dispositions.push(disposition);
    }

    const saleWashSales: WashSaleRecord[] = [];
    for (const disposition of saleDispositions.filter((item) => item.realizedPnl.isNegative())) {
      const lossPerShare = disposition.realizedPnl.abs().div(disposition.quantity);
      let lossQuantity = disposition.quantity;
      const priorReplacements = this.lots
        .filter(
          (lot) =>
            lot.symbol === input.symbol &&
            lot.remainingQuantity.gt(0) &&
            lot.acquiredAt.getTime() < input.soldAt.getTime() &&
            input.soldAt.getTime() - lot.acquiredAt.getTime() <= WASH_WINDOW_MS &&
            lot.id !== disposition.lotId,
        )
        .sort((left, right) => left.acquiredAt.getTime() - right.acquiredAt.getTime());
      for (const replacement of priorReplacements) {
        if (!lossQuantity.gt(0)) break;
        const appliedQuantity = Decimal.min(lossQuantity, replacement.remainingQuantity);
        saleWashSales.push(
          this.applyWashLoss(
            input.fillId,
            input.symbol,
            input.soldAt,
            replacement,
            appliedQuantity,
            lossPerShare,
          ),
        );
        lossQuantity = lossQuantity.minus(appliedQuantity);
      }
      if (lossQuantity.gt(0))
        this.pendingLosses.push({
          saleFillId: input.fillId,
          symbol: input.symbol,
          soldAt: new Date(input.soldAt),
          remainingQuantity: lossQuantity,
          lossPerShare,
        });
    }
    return {
      dispositions: saleDispositions,
      realizedPnl: saleDispositions.reduce(
        (sum, disposition) => sum.plus(disposition.realizedPnl),
        new Decimal(0),
      ),
      washSales: saleWashSales,
    };
  }

  public adjustBasis(input: {
    lotId: string;
    amount: Decimal.Value;
    reason: CostBasisAdjustment['reason'];
    detail: string;
    adjustedAt: Date;
  }): CostBasisAdjustment {
    const lot = this.lots.find((candidate) => candidate.id === input.lotId);
    if (lot === undefined) throw new Error('Tax lot not found');
    const amount = new Decimal(input.amount);
    if (!lot.remainingQuantity.gt(0)) throw new Error('Cannot adjust a depleted lot');
    lot.basisPerShare = lot.basisPerShare.plus(amount.div(lot.remainingQuantity));
    const adjustment = { id: this.idFactory(), ...input, amount };
    this.adjustments.push(adjustment);
    return adjustment;
  }

  public reconcile(
    lotId: string,
    brokerRemainingBasis: Decimal.Value,
    at: Date,
  ): CostBasisAdjustment {
    const lot = this.lots.find((candidate) => candidate.id === lotId);
    if (lot === undefined) throw new Error('Tax lot not found');
    const current = lot.basisPerShare.mul(lot.remainingQuantity);
    return this.adjustBasis({
      lotId,
      amount: new Decimal(brokerRemainingBasis).minus(current),
      reason: 'BROKER_RECONCILIATION',
      detail: 'Aligned remaining cost basis with broker statement',
      adjustedAt: at,
    });
  }

  public reportWashSales(): readonly WashSaleRecord[] {
    return [...this.washSales];
  }

  public snapshot(): {
    lots: readonly TaxLot[];
    dispositions: readonly LotDisposition[];
    adjustments: readonly CostBasisAdjustment[];
  } {
    return {
      lots: [...this.lots],
      dispositions: [...this.dispositions],
      adjustments: [...this.adjustments],
    };
  }

  private applyFutureReplacementLosses(lot: TaxLot): void {
    for (const pending of this.pendingLosses) {
      if (
        pending.symbol !== lot.symbol ||
        !pending.remainingQuantity.gt(0) ||
        lot.acquiredAt.getTime() < pending.soldAt.getTime() ||
        lot.acquiredAt.getTime() - pending.soldAt.getTime() > WASH_WINDOW_MS
      )
        continue;
      const applied = Decimal.min(pending.remainingQuantity, lot.remainingQuantity);
      this.applyWashLoss(
        pending.saleFillId,
        pending.symbol,
        lot.acquiredAt,
        lot,
        applied,
        pending.lossPerShare,
      );
      pending.remainingQuantity = pending.remainingQuantity.minus(applied);
    }
  }

  private applyWashLoss(
    saleFillId: string,
    symbol: string,
    detectedAt: Date,
    replacement: TaxLot,
    quantity: Decimal,
    lossPerShare: Decimal,
  ): WashSaleRecord {
    const disallowedLoss = quantity.mul(lossPerShare);
    replacement.basisPerShare = replacement.basisPerShare.plus(lossPerShare);
    const record: WashSaleRecord = {
      id: this.idFactory(),
      saleFillId,
      replacementLotId: replacement.id,
      symbol,
      replacementQuantity: quantity,
      disallowedLoss,
      detectedAt: new Date(detectedAt),
    };
    this.washSales.push(record);
    this.adjustments.push({
      id: this.idFactory(),
      lotId: replacement.id,
      reason: 'WASH_SALE',
      amount: disallowedLoss,
      detail: `Disallowed loss from sale fill ${saleFillId}`,
      adjustedAt: new Date(detectedAt),
    });
    return record;
  }
}
