import { Decimal } from 'decimal.js';
import { NormalizedPosition } from '../brokers/types';
import { PositionPnl, PnlCalculationOptions, PnlResult } from './types';
import { getTradingDateKolkata } from '../risk/engine';

export class PnlValidationError extends Error {
  constructor(message: string, public readonly tradingsymbol?: string, public readonly token?: number) {
    super(`[PnlValidationError] ${message}${tradingsymbol ? ` (Symbol: ${tradingsymbol})` : ''}`);
    this.name = 'PnlValidationError';
  }
}

/**
 * Validates financial inputs for a normalized position before P&L calculation.
 * Rejects NaN, Infinity, negative prices, and malformed numeric fields without silent coercion.
 */
export function validatePositionForPnl(pos: NormalizedPosition): void {
  const sym = pos.tradingsymbol || 'UNKNOWN';
  const token = pos.instrumentToken;

  if (typeof token !== 'number' || !Number.isInteger(token) || token <= 0) {
    throw new PnlValidationError(`Invalid instrumentToken: ${token}`, sym, token);
  }

  if (typeof pos.quantity !== 'number' || !Number.isFinite(pos.quantity)) {
    throw new PnlValidationError(`Invalid quantity: ${pos.quantity}`, sym, token);
  }

  if (typeof pos.averagePrice !== 'number' || !Number.isFinite(pos.averagePrice) || pos.averagePrice < 0) {
    throw new PnlValidationError(`averagePrice must be a finite non-negative number: ${pos.averagePrice}`, sym, token);
  }

  if (typeof pos.lastPrice !== 'number' || !Number.isFinite(pos.lastPrice) || pos.lastPrice < 0) {
    throw new PnlValidationError(`lastPrice must be a finite non-negative number: ${pos.lastPrice}`, sym, token);
  }

  if (typeof pos.realisedPnl !== 'number' || !Number.isFinite(pos.realisedPnl)) {
    throw new PnlValidationError(`realisedPnl must be a finite number: ${pos.realisedPnl}`, sym, token);
  }
}

/**
 * Calculates position-level current-day Gross P&L using decimal-safe arithmetic.
 *
 * Handles:
 * 1. Pure Intraday positions (opened and/or closed today)
 * 2. Carried-Forward positions (referenced against closePrice / previous day reference)
 * 3. Mixed positions (overnight quantity + today's trade executions)
 * 4. Multiplier handling (scales contract economics without multiplying by lotSize twice)
 * 5. Closed zero-quantity positions (daily realized retained, daily unrealized = 0)
 */
export function calculatePositionPnl(pos: NormalizedPosition): PositionPnl {
  validatePositionForPnl(pos);

  const qty = pos.quantity;
  const avgPrice = pos.averagePrice;
  const lastPrice = pos.lastPrice;
  const closePrice = typeof pos.closePrice === 'number' && pos.closePrice > 0 ? pos.closePrice : 0;
  const multiplier = typeof pos.multiplier === 'number' && pos.multiplier > 0 ? pos.multiplier : 1;

  const dayBuyQty = typeof pos.dayBuyQuantity === 'number' && Number.isFinite(pos.dayBuyQuantity) ? pos.dayBuyQuantity : 0;
  const dayBuyVal = typeof pos.dayBuyValue === 'number' && Number.isFinite(pos.dayBuyValue) ? pos.dayBuyValue : 0;
  const daySellQty = typeof pos.daySellQuantity === 'number' && Number.isFinite(pos.daySellQuantity) ? pos.daySellQuantity : 0;
  const daySellVal = typeof pos.daySellValue === 'number' && Number.isFinite(pos.daySellValue) ? pos.daySellValue : 0;

  // Determine overnight quantity:
  // If explicitly given, use it; if closePrice > 0, compute from conservation: Q_overnight = Q_net - dayBuyQty + daySellQty
  let overnightQty = 0;
  if (typeof pos.overnightQuantity === 'number' && Number.isFinite(pos.overnightQuantity)) {
    overnightQty = pos.overnightQuantity;
  } else if (closePrice > 0) {
    overnightQty = qty - dayBuyQty + daySellQty;
  }

  const multDec = new Decimal(multiplier);

  let dailyRealisedDec = new Decimal(0);
  let dailyUnrealisedDec = new Decimal(0);

  // CASE 1: Pure Intraday (overnightQty === 0)
  if (overnightQty === 0) {
    if (qty === 0) {
      // Fully closed intraday position
      if (daySellQty > 0 && dayBuyQty > 0) {
        dailyRealisedDec = new Decimal(daySellVal).minus(new Decimal(dayBuyVal)).times(multDec);
      } else {
        dailyRealisedDec = new Decimal(pos.realisedPnl).times(multDec);
      }
      dailyUnrealisedDec = new Decimal(0);
    } else if (qty > 0) {
      // Long position remaining from today's trades
      if (daySellQty > 0 && dayBuyQty > 0) {
        const avgBuyDec = new Decimal(dayBuyVal).dividedBy(new Decimal(dayBuyQty));
        const avgSellDec = new Decimal(daySellVal).dividedBy(new Decimal(daySellQty));
        dailyRealisedDec = avgSellDec.minus(avgBuyDec).times(new Decimal(daySellQty)).times(multDec);
        dailyUnrealisedDec = new Decimal(lastPrice).minus(avgBuyDec).times(new Decimal(qty)).times(multDec);
      } else {
        // No intraday sales or pure open position
        dailyRealisedDec = new Decimal(pos.realisedPnl);
        dailyUnrealisedDec = new Decimal(lastPrice).minus(new Decimal(avgPrice)).times(new Decimal(qty)).times(multDec);
      }
    } else {
      // Short position remaining from today's trades (qty < 0)
      if (dayBuyQty > 0 && daySellQty > 0) {
        const avgSellDec = new Decimal(daySellVal).dividedBy(new Decimal(daySellQty));
        const avgBuyDec = new Decimal(dayBuyVal).dividedBy(new Decimal(dayBuyQty));
        dailyRealisedDec = avgSellDec.minus(avgBuyDec).times(new Decimal(dayBuyQty)).times(multDec);
        dailyUnrealisedDec = new Decimal(lastPrice).minus(avgSellDec).times(new Decimal(qty)).times(multDec);
      } else {
        // No intraday buys (covers) or pure open short position
        dailyRealisedDec = new Decimal(pos.realisedPnl);
        dailyUnrealisedDec = new Decimal(lastPrice).minus(new Decimal(avgPrice)).times(new Decimal(qty)).times(multDec);
      }
    }
  }
  // CASE 2: Pure Carried-Forward (overnightQty !== 0 and no trades today)
  else if (dayBuyQty === 0 && daySellQty === 0) {
    if (closePrice <= 0) {
      throw new PnlValidationError(
        'Missing authoritative previous closePrice for carried-forward position. Daily reference required.',
        pos.tradingsymbol,
        pos.instrumentToken
      );
    }
    dailyRealisedDec = new Decimal(0);
    // Unrealized against previous close / daily reference price
    dailyUnrealisedDec = new Decimal(lastPrice).minus(new Decimal(closePrice)).times(new Decimal(qty)).times(multDec);
  }
  // CASE 3: Mixed Position (overnightQty !== 0 and trading occurred today)
  else {
    if (closePrice <= 0) {
      throw new PnlValidationError(
        'Missing authoritative previous closePrice for carried-forward position. Daily reference required.',
        pos.tradingsymbol,
        pos.instrumentToken
      );
    }
    const refPriceDec = new Decimal(closePrice);

    if (overnightQty > 0) {
      // Carried long position
      const avgSellDec = daySellQty > 0 ? new Decimal(daySellVal).dividedBy(new Decimal(daySellQty).times(multDec)) : new Decimal(0);
      const avgBuyDec = dayBuyQty > 0 ? new Decimal(dayBuyVal).dividedBy(new Decimal(dayBuyQty).times(multDec)) : new Decimal(0);

      // Sells close overnight units first
      const closedFromOvernight = Math.min(overnightQty, daySellQty);
      const realisedFromOvernight = avgSellDec.minus(refPriceDec).times(new Decimal(closedFromOvernight)).times(multDec);

      // Any excess sold beyond overnight units opened new intraday short positions
      let intradayRealised = new Decimal(0);
      const excessSold = Math.max(0, daySellQty - overnightQty);
      if (excessSold > 0 && dayBuyQty > 0) {
        const roundTrips = Math.min(excessSold, dayBuyQty);
        intradayRealised = avgSellDec.minus(avgBuyDec).times(new Decimal(roundTrips)).times(multDec);
      }
      dailyRealisedDec = realisedFromOvernight.plus(intradayRealised);

      // Unrealized on remaining open quantity
      if (qty > 0) {
        // Remaining overnight units
        const remainingOvernight = Math.max(0, Math.min(overnightQty - daySellQty, qty));
        const overnightUnrealised = new Decimal(lastPrice).minus(refPriceDec).times(new Decimal(remainingOvernight)).times(multDec);

        // Remaining intraday bought units
        const remainingIntraday = qty - remainingOvernight;
        const intradayUnrealised = remainingIntraday > 0
          ? new Decimal(lastPrice).minus(avgBuyDec).times(new Decimal(remainingIntraday)).times(multDec)
          : new Decimal(0);

        dailyUnrealisedDec = overnightUnrealised.plus(intradayUnrealised);
      } else if (qty < 0) {
        // Position flipped short (Reversal)
        dailyUnrealisedDec = new Decimal(lastPrice).minus(avgSellDec).times(new Decimal(qty)).times(multDec);
      } else {
        dailyUnrealisedDec = new Decimal(0);
      }
    } else {
      // Carried short position (overnightQty < 0)
      const absOvernight = Math.abs(overnightQty);
      const avgBuyDec = dayBuyQty > 0 ? new Decimal(dayBuyVal).dividedBy(new Decimal(dayBuyQty).times(multDec)) : new Decimal(0);
      const avgSellDec = daySellQty > 0 ? new Decimal(daySellVal).dividedBy(new Decimal(daySellQty).times(multDec)) : new Decimal(0);

      // Buys cover overnight short units first
      const closedFromOvernight = Math.min(absOvernight, dayBuyQty);
      const realisedFromOvernight = refPriceDec.minus(avgBuyDec).times(new Decimal(closedFromOvernight)).times(multDec);

      // Any excess bought beyond overnight units opened new intraday long positions
      let intradayRealised = new Decimal(0);
      const excessBought = Math.max(0, dayBuyQty - absOvernight);
      if (excessBought > 0 && daySellQty > 0) {
        const roundTrips = Math.min(excessBought, daySellQty);
        intradayRealised = avgSellDec.minus(avgBuyDec).times(new Decimal(roundTrips)).times(multDec);
      }
      dailyRealisedDec = realisedFromOvernight.plus(intradayRealised);

      // Unrealized on remaining open quantity
      if (qty < 0) {
        // Remaining overnight short units
        const remainingOvernightShort = Math.max(0, Math.min(absOvernight - dayBuyQty, Math.abs(qty)));
        const overnightUnrealised = new Decimal(lastPrice).minus(refPriceDec).times(new Decimal(-remainingOvernightShort)).times(multDec);

        // Remaining intraday short units
        const remainingIntradayShort = Math.abs(qty) - remainingOvernightShort;
        const intradayUnrealised = remainingIntradayShort > 0
          ? new Decimal(lastPrice).minus(avgSellDec).times(new Decimal(-remainingIntradayShort)).times(multDec)
          : new Decimal(0);

        dailyUnrealisedDec = overnightUnrealised.plus(intradayUnrealised);
      } else if (qty > 0) {
        // Position flipped long (Reversal)
        dailyUnrealisedDec = new Decimal(lastPrice).minus(avgBuyDec).times(new Decimal(qty)).times(multDec);
      } else {
        dailyUnrealisedDec = new Decimal(0);
      }
    }
  }

  // Daily Gross P&L
  const dailyGrossDec = dailyRealisedDec.plus(dailyUnrealisedDec);

  const roundedRealised = dailyRealisedDec.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toNumber();
  const roundedUnrealised = dailyUnrealisedDec.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toNumber();
  const roundedGross = dailyGrossDec.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toNumber();

  return {
    instrumentToken: pos.instrumentToken,
    tradingsymbol: pos.tradingsymbol,
    exchange: pos.exchange,
    segment: pos.segment,
    instrumentType: pos.instrumentType,
    product: pos.product,
    quantity: pos.quantity,
    averagePrice: pos.averagePrice,
    lastPrice: pos.lastPrice,
    closePrice: pos.closePrice,
    multiplier,
    overnightQuantity: overnightQty,
    dailyRealisedPnl: roundedRealised,
    dailyUnrealisedPnl: roundedUnrealised,
    dailyGrossPnl: roundedGross,
    realisedPnl: roundedRealised,
    unrealisedPnl: roundedUnrealised,
    totalPnl: roundedGross,
    isFno: pos.isFno === true,
  };
}

/**
 * Aggregates F&O Gross Trading P&L across normalized positions.
 *
 * Rules:
 * 1. Only positions with isFno === true contribute to aggregate F&O P&L.
 * 2. Equities (isFno === false) are strictly excluded from aggregates.
 * 3. Closed zero-quantity positions (quantity === 0) contribute their daily realized P&L.
 * 4. Config inclusion flags (includeRealisedPnl, includeUnrealisedPnl) govern grossTradingPnl.
 */
export function calculateAggregatePnl(
  positions: NormalizedPosition[],
  options: PnlCalculationOptions = {}
): PnlResult {
  const evalDate = options.evaluationTime || new Date();
  const tradingDate = options.tradingDate || getTradingDateKolkata(evalDate);

  const includeRealised = options.includeRealisedPnl !== false;
  const includeUnrealised = options.includeUnrealisedPnl !== false;

  const positionPnls: PositionPnl[] = positions.map(calculatePositionPnl);

  let fnoRealisedDec = new Decimal(0);
  let fnoUnrealisedDec = new Decimal(0);
  let fnoCount = 0;

  for (const p of positionPnls) {
    if (p.isFno) {
      fnoRealisedDec = fnoRealisedDec.plus(new Decimal(p.dailyRealisedPnl ?? p.realisedPnl));
      fnoUnrealisedDec = fnoUnrealisedDec.plus(new Decimal(p.dailyUnrealisedPnl ?? p.unrealisedPnl));
      fnoCount++;
    }
  }

  const fnoTotalDec = fnoRealisedDec.plus(fnoUnrealisedDec);

  // Apply RiskConfig inclusion flags
  const includedRealisedDec = includeRealised ? fnoRealisedDec : new Decimal(0);
  const includedUnrealisedDec = includeUnrealised ? fnoUnrealisedDec : new Decimal(0);
  const grossTradingPnlDec = includedRealisedDec.plus(includedUnrealisedDec);

  const roundedRealised = fnoRealisedDec.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toNumber();
  const roundedUnrealised = fnoUnrealisedDec.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toNumber();
  const roundedTotal = fnoTotalDec.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toNumber();
  const roundedIncRealised = includedRealisedDec.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toNumber();
  const roundedIncUnrealised = includedUnrealisedDec.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toNumber();
  const roundedGross = grossTradingPnlDec.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toNumber();

  return {
    tradingDate,
    dailyRealisedPnl: roundedRealised,
    dailyUnrealisedPnl: roundedUnrealised,
    dailyGrossPnl: roundedTotal,
    realisedPnl: roundedRealised,
    unrealisedPnl: roundedUnrealised,
    totalPnl: roundedTotal,
    includedRealisedPnl: roundedIncRealised,
    includedUnrealisedPnl: roundedIncUnrealised,
    grossTradingPnl: roundedGross,
    fnoPositionCount: fnoCount,
    totalPositionCount: positions.length,
    positions: positionPnls,
    source: 'MOCK_ZERODHA_PHASE_3',
    calculatedAt: evalDate.toISOString(),
  };
}
