import { RawBrokerPosition } from '../types';

/**
 * Deterministic Mock Zerodha Raw Positions (Phase 3 Fixtures).
 *
 * Covers:
 * 1. NFO Future (NIFTY26OCTFUT)
 * 2. NFO Call Option (NIFTY26O2925500CE)
 * 3. NFO Put Option (NIFTY26O2924500PE)
 * 4. BFO Future (SENSEX26OCTFUT)
 * 5. NSE Equity (RELIANCE)
 * 6. BSE Equity (TCS)
 * 7. Zero-Quantity Position (BANKNIFTY26OCTFUT - closed intraday trade)
 *
 * Labeled explicitly as MOCK DATA.
 */
export const MOCK_RAW_ZERODHA_POSITIONS: RawBrokerPosition[] = [
  // 1. NFO Future (Long 50 qty)
  {
    instrument_token: 110001,
    exchange: 'NFO',
    tradingsymbol: 'NIFTY26OCTFUT',
    product: 'NRML',
    quantity: 50,
    average_price: 25120.5,
    last_price: 25160.0,
    pnl: 1975.0,
    realised: 0,
    unrealised: 1975.0,
    day_buy_quantity: 50,
    day_buy_value: 1256025.0,
    day_sell_quantity: 0,
    day_sell_value: 0,
    m2m: 1975.0,
    multiplier: 1,
    close_price: 25100.0,
  },
  // 2. NFO Call Option (Short -50 qty)
  {
    instrument_token: 110002,
    exchange: 'NFO',
    tradingsymbol: 'NIFTY26O2925500CE',
    product: 'MIS',
    quantity: -50,
    average_price: 185.0,
    last_price: 142.5,
    pnl: 2125.0,
    realised: 0,
    unrealised: 2125.0,
    day_buy_quantity: 0,
    day_buy_value: 0,
    day_sell_quantity: 50,
    day_sell_value: 9250.0,
    m2m: 2125.0,
    multiplier: 1,
    close_price: 180.0,
  },
  // 3. NFO Put Option (Long 25 qty)
  {
    instrument_token: 110003,
    exchange: 'NFO',
    tradingsymbol: 'NIFTY26O2924500PE',
    product: 'NRML',
    quantity: 25,
    average_price: 92.0,
    last_price: 74.0,
    pnl: -450.0,
    realised: 0,
    unrealised: -450.0,
    day_buy_quantity: 25,
    day_buy_value: 2300.0,
    day_sell_quantity: 0,
    day_sell_value: 0,
    m2m: -450.0,
    multiplier: 1,
    close_price: 90.0,
  },
  // 4. BFO Future (Long 10 qty)
  {
    instrument_token: 130001,
    exchange: 'BFO',
    tradingsymbol: 'SENSEX26OCTFUT',
    product: 'NRML',
    quantity: 10,
    average_price: 82150.0,
    last_price: 82300.0,
    pnl: 1500.0,
    realised: 0,
    unrealised: 1500.0,
    day_buy_quantity: 10,
    day_buy_value: 821500.0,
    day_sell_quantity: 0,
    day_sell_value: 0,
    m2m: 1500.0,
    multiplier: 1,
    close_price: 82100.0,
  },
  // 5. NSE Equity (Long 100 shares of RELIANCE - should be rejected from F&O filter)
  {
    instrument_token: 140001,
    exchange: 'NSE',
    tradingsymbol: 'RELIANCE',
    product: 'CNC',
    quantity: 100,
    average_price: 2950.0,
    last_price: 2985.0,
    pnl: 3500.0,
    realised: 0,
    unrealised: 3500.0,
    day_buy_quantity: 100,
    day_buy_value: 295000.0,
    day_sell_quantity: 0,
    day_sell_value: 0,
    m2m: 3500.0,
    multiplier: 1,
    close_price: 2940.0,
  },
  // 6. BSE Equity (Long 50 shares of TCS - should be rejected from F&O filter)
  {
    instrument_token: 150001,
    exchange: 'BSE',
    tradingsymbol: 'TCS',
    product: 'CNC',
    quantity: 50,
    average_price: 4200.0,
    last_price: 4180.0,
    pnl: -1000.0,
    realised: 0,
    unrealised: -1000.0,
    day_buy_quantity: 50,
    day_buy_value: 210000.0,
    day_sell_quantity: 0,
    day_sell_value: 0,
    m2m: -1000.0,
    multiplier: 1,
    close_price: 4210.0,
  },
  // 7. Zero-Quantity Position (BANKNIFTY intra-day square-off: bought 30, sold 30, net 0, realised pnl +1200)
  {
    instrument_token: 120001,
    exchange: 'NFO',
    tradingsymbol: 'BANKNIFTY26OCTFUT',
    product: 'MIS',
    quantity: 0,
    average_price: 52100.0,
    last_price: 52180.0,
    pnl: 1200.0,
    realised: 1200.0,
    unrealised: 0,
    day_buy_quantity: 30,
    day_buy_value: 1563000.0,
    day_sell_quantity: 30,
    day_sell_value: 1564200.0,
    m2m: 1200.0,
    multiplier: 1,
    close_price: 52050.0,
  },
];
