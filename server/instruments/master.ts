import { BrokerInstrument, InstrumentClassification } from '../brokers/types';

/**
 * Metadata-driven F&O Classification Engine.
 *
 * CRITICAL ARCHITECTURAL GUARANTEE:
 * Does NOT classify F&O based on tradingsymbol string heuristics (e.g. endsWith("CE"),
 * endsWith("PE"), endsWith("FUT")).
 * Classification is STRICTLY driven by instrument metadata (segment & instrumentType).
 */
export function classifyInstrument(instrument: {
  segment?: string;
  instrumentType?: string;
}): InstrumentClassification {
  if (!instrument.segment) {
    return {
      isFno: false,
      category: 'OTHER',
      type: 'OTHER',
      segment: 'UNKNOWN',
    };
  }

  const seg = instrument.segment.toUpperCase().trim();
  const rawType = (instrument.instrumentType || '').toUpperCase().trim();

  // 1. Explicit Futures Segments
  if (seg === 'NFO-FUT' || seg === 'BFO-FUT') {
    return {
      isFno: true,
      category: 'FNO',
      type: 'FUTURE',
      segment: seg,
    };
  }

  // 2. Explicit Options Segments
  if (seg === 'NFO-OPT' || seg === 'BFO-OPT') {
    return {
      isFno: true,
      category: 'FNO',
      type: 'OPTION',
      segment: seg,
    };
  }

  // 3. Normalized NFO / BFO segments with instrumentType
  if (seg === 'NFO' || seg === 'BFO') {
    if (rawType === 'FUT') {
      return {
        isFno: true,
        category: 'FNO',
        type: 'FUTURE',
        segment: `${seg}-FUT`,
      };
    }
    if (rawType === 'CE' || rawType === 'PE' || rawType === 'OPT') {
      return {
        isFno: true,
        category: 'FNO',
        type: 'OPTION',
        segment: `${seg}-OPT`,
      };
    }
  }

  // 4. Equity Segments (NSE-EQ, BSE-EQ, NSE, BSE)
  if (seg === 'NSE-EQ' || seg === 'BSE-EQ' || (seg === 'NSE' && rawType === 'EQ') || (seg === 'BSE' && rawType === 'EQ')) {
    return {
      isFno: false,
      category: 'EQUITY',
      type: 'EQUITY',
      segment: seg,
    };
  }

  return {
    isFno: false,
    category: 'OTHER',
    type: 'OTHER',
    segment: seg,
  };
}

/**
 * Backward-compatible helper for Phase 1 / Phase 2 checks.
 */
export function isFuturesAndOptions(instrument: { segment?: string; instrumentType?: string }): boolean {
  return classifyInstrument(instrument).isFno;
}

/**
 * Deterministic Mock Instrument Master (Phase 3 Fixtures).
 * All tokens are realistic fictional IDs clearly isolated from live brokerage.
 */
export const MOCK_INSTRUMENT_MASTER: BrokerInstrument[] = [
  // 1. NIFTY FUT
  {
    instrumentToken: 110001,
    exchange: 'NFO',
    tradingsymbol: 'NIFTY26OCTFUT',
    name: 'NIFTY 50 OCT 2026 FUTURES',
    segment: 'NFO-FUT',
    instrumentType: 'FUT',
    expiry: '2026-10-29',
    strike: null,
    tickSize: 0.05,
    lotSize: 25,
  },
  // 2. NIFTY CALL OPTION
  {
    instrumentToken: 110002,
    exchange: 'NFO',
    tradingsymbol: 'NIFTY26O2925500CE',
    name: 'NIFTY 29 OCT 25500 CE',
    segment: 'NFO-OPT',
    instrumentType: 'CE',
    expiry: '2026-10-29',
    strike: 25500,
    tickSize: 0.05,
    lotSize: 25,
  },
  // 3. NIFTY PUT OPTION
  {
    instrumentToken: 110003,
    exchange: 'NFO',
    tradingsymbol: 'NIFTY26O2924500PE',
    name: 'NIFTY 29 OCT 24500 PE',
    segment: 'NFO-OPT',
    instrumentType: 'PE',
    expiry: '2026-10-29',
    strike: 24500,
    tickSize: 0.05,
    lotSize: 25,
  },
  // 4. BANKNIFTY FUT
  {
    instrumentToken: 120001,
    exchange: 'NFO',
    tradingsymbol: 'BANKNIFTY26OCTFUT',
    name: 'BANKNIFTY OCT 2026 FUTURES',
    segment: 'NFO-FUT',
    instrumentType: 'FUT',
    expiry: '2026-10-29',
    strike: null,
    tickSize: 0.05,
    lotSize: 15,
  },
  // 5. BANKNIFTY CALL OPTION
  {
    instrumentToken: 120002,
    exchange: 'NFO',
    tradingsymbol: 'BANKNIFTY26O2952500CE',
    name: 'BANKNIFTY 29 OCT 52500 CE',
    segment: 'NFO-OPT',
    instrumentType: 'CE',
    expiry: '2026-10-29',
    strike: 52500,
    tickSize: 0.05,
    lotSize: 15,
  },
  // 6. BANKNIFTY PUT OPTION
  {
    instrumentToken: 120003,
    exchange: 'NFO',
    tradingsymbol: 'BANKNIFTY26O2951500PE',
    name: 'BANKNIFTY 29 OCT 51500 PE',
    segment: 'NFO-OPT',
    instrumentType: 'PE',
    expiry: '2026-10-29',
    strike: 51500,
    tickSize: 0.05,
    lotSize: 15,
  },
  // 7. BFO FUT (SENSEX)
  {
    instrumentToken: 130001,
    exchange: 'BFO',
    tradingsymbol: 'SENSEX26OCTFUT',
    name: 'SENSEX OCT 2026 FUTURES',
    segment: 'BFO-FUT',
    instrumentType: 'FUT',
    expiry: '2026-10-30',
    strike: null,
    tickSize: 0.05,
    lotSize: 10,
  },
  // 8. BFO OPT (SENSEX CALL)
  {
    instrumentToken: 130002,
    exchange: 'BFO',
    tradingsymbol: 'SENSEX26O3082000CE',
    name: 'SENSEX 30 OCT 82000 CE',
    segment: 'BFO-OPT',
    instrumentType: 'CE',
    expiry: '2026-10-30',
    strike: 82000,
    tickSize: 0.05,
    lotSize: 10,
  },
  // 9. NSE Equity (RELIANCE)
  {
    instrumentToken: 140001,
    exchange: 'NSE',
    tradingsymbol: 'RELIANCE',
    name: 'RELIANCE INDUSTRIES LTD',
    segment: 'NSE-EQ',
    instrumentType: 'EQ',
    expiry: null,
    strike: null,
    tickSize: 0.05,
    lotSize: 1,
  },
  // 10. BSE Equity (TCS)
  {
    instrumentToken: 150001,
    exchange: 'BSE',
    tradingsymbol: 'TCS',
    name: 'TATA CONSULTANCY SERVICES LTD',
    segment: 'BSE-EQ',
    instrumentType: 'EQ',
    expiry: null,
    strike: null,
    tickSize: 0.05,
    lotSize: 1,
  },
];

export const MOCK_INSTRUMENT_MAP = new Map<number, BrokerInstrument>(
  MOCK_INSTRUMENT_MASTER.map((inst) => [inst.instrumentToken, inst])
);
