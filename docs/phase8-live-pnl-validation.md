# Phase 8 — Live Zerodha P&L Validation & Shadow Mode Architecture

## 1. Purpose & Critical Safety Boundary
The purpose of Phase 8 is to validate and reconcile whether the Trading Firewall's authoritative P&L Engine can correctly calculate live F&O gross trading P&L from real Zerodha position data and live market prices, operating **exclusively in shadow mode**.

**CRITICAL SAFETY INVARIANT:**
> **Phase 8 live P&L does not control the Trading Firewall.**
> Live P&L values produced in Phase 8 do NOT drive `RiskEngine`, `RiskSession`, `riskEvents`, trading lock creation, `EnforcementState`, or `HTTP 423` blocking.

---

## 2. Root Cause: Why Average-Price-Only Calculation Was Insufficient

The initial P&L engine calculated unrealized P&L universally as:
$$\text{unrealisedPnl} = (\text{lastPrice} - \text{averagePrice}) \times \text{quantity}$$

While valid for position inception/lifetime P&L, this is mathematically incorrect for a **Daily Loss Limit Trading Firewall**, particularly for **carried-forward (overnight)** positions:
1. **Historical P&L Bleed-Through:** For positions carried forward across days, `averagePrice` reflects historical entry cost days or weeks in the past. If an overnight long had gained ₹50,000 in preceding days and drops ₹10,000 today, the lifetime calculation still reports a large positive gain (+₹40,000), completely blinding the Trading Firewall to today's catastrophic -₹10,000 intra-day loss.
2. **Yesterday's Settled Gain/Loss:** Conversely, if an overnight position was in a deep lifetime drawdown (-₹50,000) and rallies +₹15,000 today, the firewall would believe the trader lost ₹35,000 today and prematurely trigger a daily trading lock, even though today was highly profitable.
3. **Daily Mark-to-Market Accounting:** Exchanges (NSE/BSE) settle derivatives daily against the previous day's official closing price (`close_price`). The daily loss firewall must benchmark overnight positions against `close_price`, not historical acquisition `averagePrice`.

---

## 3. Authoritative Daily P&L Definitions & Formulas

For each normalized position:
- $Q_{net} = \text{pos.quantity}$ (signed: $>0$ long, $<0$ short, $0$ closed)
- $P_{last} = \text{pos.lastPrice}$ (live LTP from `MarketDataService`)
- $M = \text{pos.multiplier} || 1$ (contract multiplier)
- $B_{day,qty} = \text{pos.dayBuyQuantity}$, $B_{day,val} = \text{pos.dayBuyValue}$
- $S_{day,qty} = \text{pos.daySellQuantity}$, $S_{day,val} = \text{pos.daySellValue}$
- $Q_{overnight} = \text{pos.overnightQuantity}$ (or $Q_{net} - B_{day,qty} + S_{day,qty}$ if $P_{close} > 0$)
- $P_{close} = \text{pos.closePrice}$ (previous trading day's closing price)
- $P_{avg} = \text{pos.averagePrice}$

### A. Pure Intraday Positions ($Q_{overnight} === 0$)
- **Fully Closed ($Q_{net} === 0$):**
  $$\text{dailyRealisedPnl} = (S_{day,val} - B_{day,val}) \times M$$
  $$\text{dailyUnrealisedPnl} = 0$$
- **Open Long ($Q_{net} > 0$):**
  If today had both buys and sells ($B_{day,qty} > 0, S_{day,qty} > 0$):
  $$\text{avgBuy} = B_{day,val} / B_{day,qty},\quad \text{avgSell} = S_{day,val} / S_{day,qty}$$
  $$\text{dailyRealisedPnl} = (\text{avgSell} - \text{avgBuy}) \times S_{day,qty} \times M$$
  $$\text{dailyUnrealisedPnl} = (P_{last} - \text{avgBuy}) \times Q_{net} \times M$$
- **Open Short ($Q_{net} < 0$):**
  If today had both sells and buy covers ($S_{day,qty} > 0, B_{day,qty} > 0$):
  $$\text{dailyRealisedPnl} = (\text{avgSell} - \text{avgBuy}) \times B_{day,qty} \times M$$
  $$\text{dailyUnrealisedPnl} = (P_{last} - \text{avgSell}) \times Q_{net} \times M$$

### B. Pure Carried-Forward Positions ($Q_{overnight} \neq 0$ and no trades today)
- $\text{dailyRealisedPnl} = 0$
- Reference price: $P_{ref} = P_{close} > 0 ? P_{close} : P_{avg}$
- $\text{dailyUnrealisedPnl} = (P_{last} - P_{ref}) \times Q_{net} \times M$

### C. Mixed Positions (Overnight Quantity + Today's Trades)
- Reference price: $P_{ref} = P_{close} > 0 ? P_{close} : P_{avg}$
- Sells or buys close overnight units first:
  - For carried long ($Q_{overnight} > 0$):
    $\text{closedFromOvernight} = \min(Q_{overnight}, S_{day,qty})$
    $\text{realisedOvernight} = (\text{avgSell} - P_{ref}) \times \text{closedFromOvernight} \times M$
    Intraday round-trips beyond $Q_{overnight}$ realize against today's $\text{avgBuy}$.
  - Unrealized is computed on remaining $Q_{net}$ against $P_{ref}$ for overnight units and against today's entry price for new units opened today.
- Avoids all double-counting between yesterday's P&L and today's activity.

### D. Zero-Quantity Closed Positions
- $\text{dailyUnrealisedPnl} = 0$
- Today's realized P&L is strictly retained.

### E. Contract Multiplier Semantics
- In Zerodha Kite Connect, `quantity` is already in contract units (e.g. 50 units for NIFTY, 25 units for BANKNIFTY).
- The `multiplier` field (default 1) scales special contracts without double-multiplying by `lotSize`.

### F. Gross Trading P&L Definition
$$\text{grossTradingPnl} = \text{includedRealisedPnl} + \text{includedUnrealisedPnl}$$
Calculated strictly before deduction of brokerage, STT, GST, exchange charges, stamp duty, or other statutory fees.

---

## 4. Broker-Reported vs. Application-Calculated Reconciliation

| Concept | Zerodha Source Field | Normalized Field | Application Field |
| :--- | :--- | :--- | :--- |
| **Realized P&L** | `raw.realised` | `realisedPnl` | `PositionPnl.dailyRealisedPnl` |
| **Unrealized P&L** | `raw.unrealised` | `unrealisedPnl` | `PositionPnl.dailyUnrealisedPnl` |
| **Day Mark-to-Market**| `raw.m2m` | `m2m` | `PositionPnl.dailyGrossPnl` |
| **Lifetime P&L** | `raw.pnl` | `totalPnl` | Separately retained |
| **Previous Close** | `raw.close_price` | `closePrice` | Daily reference price |
| **Contract Multiplier**| `raw.multiplier` | `multiplier` | Scaling multiplier |

### Semantic Comparability
- **`COMPARABLE`:** When the broker reports `m2m` (day mark-to-market), or when all positions are pure intraday ($Q_{overnight} === 0$). Reconciled against tolerance (₹1.00).
- **`NOT_COMPARABLE`:** When carried-forward positions exist without `m2m`, Zerodha's `raw.pnl` represents lifetime P&L since inception. The application marks `comparisonStatus = 'NOT_COMPARABLE'` and does not generate a false discrepancy.

---

## 5. Market-Data Freshness Policy

- Identifies instruments strictly by canonical integer `instrumentToken`.
- Tracks `lastTickAt` timestamp per instrument.
- **Threshold:** 60 seconds (configurable via `MarketDataService.setStaleThresholdSeconds`).
- **States:**
  - `FRESH`: All open positions have fresh ticks ($age \le 60s$).
  - `STALE`: At least one open position has a tick older than 60 seconds $\to$ `STALE_DATA`.
  - `MISSING`: No tick has been received for an open position $\to$ `MISSING_DATA`.
- Stale or missing prices are never silently replaced with fabricated values.

---

## 6. Unknown Instrument Handling

- F&O classification is strictly driven by authoritative metadata (`NFO-FUT`, `NFO-OPT`, `BFO-FUT`, `BFO-OPT`).
- Zero fallback logic exists: tradingsymbol suffixes (`CE`, `PE`, `FUT`), exchange names, or heuristics can never classify an instrument as F&O.
- Unknown instruments are flagged with `unknownInstrument: true`, `isFno: false`, and `segment: "UNKNOWN"`, and collected into `unknownInstruments[]`.
- If unknown instruments are present, `validationState` is set to `UNKNOWN_INSTRUMENTS` and they are excluded from F&O P&L.

---

## 7. Deterministic Validation States

| State | Condition |
| :--- | :--- |
| `VALID` | All live positions normalized, market data fresh, reconciliation within tolerance (or not comparable). |
| `DISCREPANCY` | Data available and comparable, but difference between calculated and broker P&L exceeds tolerance. |
| `STALE_DATA` | Required market data is older than 60 seconds. |
| `MISSING_DATA` | Required LTP or position data is unavailable. |
| `UNKNOWN_INSTRUMENTS` | Unrecognized instrument tokens present in the live position set. |
| `ERROR` | Upstream failure, authentication error, or network exception. |

---

## 8. Validation Gate & Risk Engine Isolation

- `LIVE_PNL_VALIDATION_GATE = 'CLOSED'` (static compile-time constant).
- `riskIntegrationEnabled = false` (static compile-time constant).
- Cannot be altered by query parameters, request bodies, headers, localStorage, or client state.
- Pure shadow mode: `GET /api/pnl/live-validation` never calls `RiskEngine.evaluate()`, never creates or updates `RiskSession`, never generates risk events, and never sets locks.

---

## 9. API Endpoint

- `GET /api/pnl/live-validation`
  - Requires authenticated request (`x-user-id` or `authorization`).
  - Returns `LivePnlValidationResult` containing `calculated`, `brokerReported`, `reconciliation`, `unknownInstruments`, `validationState`, `validationGate: "CLOSED"`, and `riskIntegrationEnabled: false`.
  - Read-only; does not mutate `RiskSession` or emit audit events.
  - Returns `LivePnlValidationResult` with `riskIntegrationEnabled: false` and `validationGate: "CLOSED"`.

---

## 9. Safety Boundary & Validation Gate

- **Validation Gate Constant:** `LIVE_PNL_VALIDATION_GATE = 'CLOSED'`
- **Gate Semantics:** The gate is closed by default and requires explicit human authorization to open.
- **No Automatic Promotion:** Even if `validationState === 'VALID'`, no code path enables risk integration.
- **No Trading Capabilities:** No order placement, modification, cancellation, or square-off endpoints exist.

---

## 10. Required Evidence Before Future Risk Integration

Before the validation gate can ever be opened in a future phase:
1. **Instrument Classification:** 100% of derivatives classified exclusively through authoritative metadata with zero heuristic fallbacks.
2. **Reconciliation Stability:** Continuous reconciliation within ₹1.00 tolerance across multiple volatile market sessions.
3. **Market Data Reliability:** Proven resilience under WebSocket disconnects, reconnects, and high-frequency tick bursts.
4. **Trading Date Integrity:** Flawless date boundaries governed by `Asia/Kolkata` across day rollover.
5. **Zero Mutation Proof:** Comprehensive test proofs confirming live P&L has never mutated risk state during shadow mode.

---

## 11. Known Limitations

- Real market sessions may exhibit timing differences between broker-reported position snapshots and WebSocket LTP ticks during rapid price spikes.
- Historical intraday tradebooks are not ingested in this phase; only current session positions are reconciled.
- The gate remains permanently closed until explicit Phase 9 specification.
