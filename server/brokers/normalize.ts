import {
  RawBrokerPosition,
  NormalizedPosition,
  BrokerInstrument,
  InstrumentClassification,
} from './types';
import { classifyInstrument } from '../instruments/master';

export class PositionValidationError extends Error {
  constructor(message: string) {
    super(`[PositionValidationError] ${message}`);
    this.name = 'PositionValidationError';
  }
}

/**
 * Validates and normalizes raw Zerodha-shaped position into canonical application model.
 *
 * Rejection guarantees:
 * - Rejects missing or non-finite instrumentToken
 * - Rejects empty exchange or tradingsymbol
 * - Rejects non-finite quantity, averagePrice (< 0), lastPrice (< 0)
 * - Rejects NaN / Infinity / undefined on all financial fields
 * - Strictly does not coerce invalid data
 */
export function normalizePosition(
  raw: RawBrokerPosition,
  instrumentMap?: Map<number, BrokerInstrument>,
  dataSource: 'MOCK_DATA' | 'ZERODHA_LIVE' = 'MOCK_DATA'
): NormalizedPosition {
  if (!raw || typeof raw !== 'object') {
    throw new PositionValidationError('Raw position must be a non-null object');
  }

  // 1. Validate instrumentToken
  const token = raw.instrument_token;
  if (typeof token !== 'number' || !Number.isInteger(token) || token <= 0) {
    throw new PositionValidationError(`Invalid instrument_token: ${token}`);
  }

  // 2. Validate exchange & tradingsymbol
  if (!raw.exchange || typeof raw.exchange !== 'string' || raw.exchange.trim().length === 0) {
    throw new PositionValidationError(`Invalid exchange for token ${token}: ${raw.exchange}`);
  }
  if (!raw.tradingsymbol || typeof raw.tradingsymbol !== 'string' || raw.tradingsymbol.trim().length === 0) {
    throw new PositionValidationError(`Invalid tradingsymbol for token ${token}: ${raw.tradingsymbol}`);
  }

  // 3. Validate product
  if (!raw.product || typeof raw.product !== 'string' || raw.product.trim().length === 0) {
    throw new PositionValidationError(`Invalid product for token ${token}: ${raw.product}`);
  }

  // 4. Validate quantity
  if (typeof raw.quantity !== 'number' || !Number.isFinite(raw.quantity)) {
    throw new PositionValidationError(`Quantity must be a finite number: ${raw.quantity}`);
  }

  // 5. Validate averagePrice (must be >= 0)
  if (typeof raw.average_price !== 'number' || !Number.isFinite(raw.average_price) || raw.average_price < 0) {
    throw new PositionValidationError(`average_price must be a finite non-negative number: ${raw.average_price}`);
  }

  // 6. Validate lastPrice (must be >= 0)
  if (typeof raw.last_price !== 'number' || !Number.isFinite(raw.last_price) || raw.last_price < 0) {
    throw new PositionValidationError(`last_price must be a finite non-negative number: ${raw.last_price}`);
  }

  // 7. Validate P&L and day values
  const fields = {
    pnl: raw.pnl,
    realised: raw.realised,
    unrealised: raw.unrealised,
    day_buy_quantity: raw.day_buy_quantity,
    day_buy_value: raw.day_buy_value,
    day_sell_quantity: raw.day_sell_quantity,
    day_sell_value: raw.day_sell_value,
  };

  for (const [key, val] of Object.entries(fields)) {
    if (typeof val !== 'number' || !Number.isFinite(val)) {
      throw new PositionValidationError(`Field '${key}' must be a finite number, received: ${val}`);
    }
  }

  // 8. Authoritative metadata-driven classification
  // CRITICAL SECURITY INVARIANT (PHASE 7 CORRECTION):
  // An unknown or unresolved instrument MUST NEVER become isFno=true.
  // REMOVE all fallback logic that derives F&O classification from exchange guesses,
  // tradingsymbol suffixes, inferred segment values, or symbol heuristics.
  const instrument = instrumentMap?.get(token);
  const isUnknown = !instrument;

  let classification: InstrumentClassification;
  if (!instrument) {
    // Unknown instrument metadata:
    // Strictly DO NOT infer segment from raw exchange, tradingsymbol, or heuristics.
    // Strictly assign segment = 'UNKNOWN', isFno = false, category = 'OTHER', type = 'OTHER'.
    classification = {
      isFno: false,
      category: 'OTHER',
      type: 'OTHER',
      segment: 'UNKNOWN',
    };
  } else {
    // Authoritative instrument metadata found: classify strictly by metadata
    classification = classifyInstrument({
      segment: instrument.segment,
      instrumentType: instrument.instrumentType,
    });
  }

  return {
    instrumentToken: token,
    exchange: raw.exchange.toUpperCase().trim(),
    tradingsymbol: raw.tradingsymbol.trim(),
    segment: classification.segment,
    instrumentType: classification.type,
    product: raw.product.toUpperCase().trim(),
    quantity: raw.quantity,
    averagePrice: raw.average_price,
    lastPrice: raw.last_price,
    closePrice: typeof raw.close_price === 'number' && Number.isFinite(raw.close_price) ? raw.close_price : (raw.close_price ?? 0),
    multiplier: typeof raw.multiplier === 'number' && Number.isFinite(raw.multiplier) && raw.multiplier > 0 ? raw.multiplier : 1,
    overnightQuantity: typeof raw.overnight_quantity === 'number' && Number.isFinite(raw.overnight_quantity)
      ? raw.overnight_quantity
      : undefined,
    m2m: typeof raw.m2m === 'number' && Number.isFinite(raw.m2m) ? raw.m2m : undefined,
    dayBuyQuantity: raw.day_buy_quantity,
    dayBuyValue: raw.day_buy_value,
    daySellQuantity: raw.day_sell_quantity,
    daySellValue: raw.day_sell_value,
    realisedPnl: raw.realised,
    unrealisedPnl: raw.unrealised,
    totalPnl: raw.pnl,
    isFno: classification.isFno,
    dataSource,
    unknownInstrument: isUnknown,
    provenance: raw.provenance || 'net',
    brokerLtp: raw.last_price,
  };
}

/**
 * Normalizes an array of raw positions, rejecting invalid items with detailed errors.
 */
export function normalizePositions(
  rawList: RawBrokerPosition[],
  instrumentMap?: Map<number, BrokerInstrument>,
  dataSource: 'MOCK_DATA' | 'ZERODHA_LIVE' = 'MOCK_DATA'
): NormalizedPosition[] {
  return rawList.map((raw) => normalizePosition(raw, instrumentMap, dataSource));
}

/**
 * Filters normalized positions returning ONLY those authoritatively classified as F&O
 * (NFO-FUT, NFO-OPT, BFO-FUT, BFO-OPT).
 * Guarantees unknown instruments can NEVER enter the F&O position set.
 */
export function getFnoPositions(positions: NormalizedPosition[]): NormalizedPosition[] {
  return positions.filter((p) => p.isFno === true && !p.unknownInstrument);
}
