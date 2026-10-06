import { Decimal } from 'decimal.js';
import { NormalizedPosition } from '../brokers/types';
import { RiskConfig } from '../../src/types/risk';
import { PnlResult, PnlCalculationOptions } from './types';
import { calculateAggregatePnl } from './calculator';
import { getTradingDateKolkata } from '../risk/engine';

/**
 * Phase 4 — Authoritative Server-Side P&L Engine.
 *
 * CRITICAL ARCHITECTURAL BOUNDARIES:
 * - Server-authoritative: Browser/client is NEVER the source of truth for P&L.
 * - Decoupled from Risk Engine: Produces PnlResult for API/UI display only.
 * - Does NOT invoke RiskEngine.evaluate().
 * - Does NOT mutate RiskSession or create locks/warnings.
 * - Gross Trading P&L only (brokerage, STT, taxes are excluded).
 */
export class PnlEngine {
  /**
   * Phase 1 legacy signature for scalar numbers.
   */
  public static calculate(
    realised: number,
    unrealised: number
  ): {
    realisedPnl: number;
    unrealisedPnl: number;
    totalPnl: number;
    grossTradingPnl: number;
    label: string;
    tradingDate: string;
  };

  /**
   * Phase 4 authoritative position calculation.
   */
  public static calculate(
    positions: NormalizedPosition[],
    config?: Partial<RiskConfig>,
    evaluationTime?: Date
  ): PnlResult;

  public static calculate(
    input: number | NormalizedPosition[],
    param2?: number | Partial<RiskConfig>,
    param3?: Date
  ): any {
    // Phase 1 legacy support: calculate(realised: number, unrealised: number)
    if (typeof input === 'number') {
      const realised = input;
      const unrealised = typeof param2 === 'number' ? param2 : 0;
      const total = new Decimal(realised).plus(new Decimal(unrealised)).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toNumber();
      return {
        realisedPnl: realised,
        unrealisedPnl: unrealised,
        totalPnl: total,
        grossTradingPnl: total,
        label: 'Gross Trading P&L',
        tradingDate: getTradingDateKolkata(new Date()),
      };
    }

    // Phase 4 pipeline: calculate(positions: NormalizedPosition[], config?: Partial<RiskConfig>, evaluationTime?: Date)
    const positions = Array.isArray(input) ? input : [];
    const config = typeof param2 === 'object' && param2 !== null ? param2 : undefined;
    const options: PnlCalculationOptions = {
      includeRealisedPnl: config?.includeRealisedPnl !== false,
      includeUnrealisedPnl: config?.includeUnrealisedPnl !== false,
      evaluationTime: param3 || new Date(),
    };

    return calculateAggregatePnl(positions, options);
  }
}
