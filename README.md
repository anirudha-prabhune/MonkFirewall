# Trading Firewall — Phase 1 Documentation

Trading Firewall is a personal risk-management circuit breaker application for Indian stock market F&O derivatives traders (Zerodha).

---

## 1. Server-Authoritative Risk State
The backend server runtime is the authoritative source for:
- Normalized derivative positions
- Gross Trading P&L calculations
- Authoritative risk state (`ALLOW`, `WARNING`, `LOCKED`)
- Lock lifecycle timestamps (`lockedAt`, `lockUntil`)
- Audit events

The browser is strictly a consumer of authoritative state. Future browser/device enforcement clients will consume this server state to restrict access. The Phase 1 dashboard is a monitoring and configuration control UI; it does not implement local device or browser blocking.

---

## 2. Phase 1 Scope Baseline
Phase 1 delivers the foundational application architecture:
- Application shell and responsive dark-mode dashboard
- Google Authentication via Firebase Auth (with graceful fallback for pending Google Cloud Identity Toolkit API propagation)
- User-scoped Cloud Firestore configuration and security rules
- Server-side foundational modules (P&L Engine, Risk Engine, F&O Classification Master, Zerodha Adapter interface)
- Backend HTTP API (`/api/health`, `/api/account/status`, `/api/risk/config`, `/api/lock/status`)
- Diagnostic System Health & Security Audit screen

---

## 3. Firestore Ownership & Security Model
All application data is isolated under the user's authenticated path:
- `/users/{userId}`: User profile document (readable/writable only by `request.auth.uid == userId`)
- `/users/{userId}/riskConfig/{configId}`: User's configurable risk parameters
- `/users/{userId}/brokerConnections/{connectionId}`: Broker status metadata (broker secrets strictly forbidden)
- `/users/{userId}/riskSessions/{tradingDate}`: Server-authoritative daily session (client writes denied)
- `/users/{userId}/positions/{positionId}`: Server-authoritative positions (client writes denied)
- `/users/{userId}/riskEvents/{eventId}`: Immutable audit trail (client creation restricted to `CONFIG_UPDATED`)
- Global catch-all rule: `match /{document=**} { allow read, write: if false; }`

---

## 4. Client / Server Authority Boundary
- The browser **NEVER** executes, modifies, or cancels orders.
- The browser **NEVER** accesses Zerodha Kite API keys, secrets, or access tokens.
- The browser **NEVER** determines authoritative risk state or manufactures a `LOCKED` state.
- The client cannot write to `riskSessions/*` or `positions/*`.

---

## 5. Trading Date vs Lock Expiry
Trading date and lock duration are distinct concepts:
- **`tradingDate`:** Calendar session identifier calculated in timezone `Asia/Kolkata` (e.g. `2026-10-02`).
- **`lockUntil`:** Explicit lifecycle timestamp calculated as `lockedAt + lockDurationMinutes` (default: 720 minutes / 12 hours).
- **No Competing Midnight Reset:** The lock does NOT automatically reset at midnight or market open (09:00 / 09:15 IST). It expires strictly when `evaluationTime >= lockUntil`.

---

## 6. LOCKED Persistence & Idempotency
- When daily loss reaches or exceeds `dailyLossLimit`, the state transitions to `LOCKED` (`isBreached: true`).
- **Persistence:** Once `LOCKED`, the state remains `LOCKED` until `lockUntil` has elapsed. Any intraday P&L improvement (e.g. recovering from -₹10,000 to -₹8,000, -₹3,000, ₹0, or positive) **DOES NOT UNLOCK** the session.
- **Idempotency:** Repeated evaluations of an already breached session preserve existing `lockedAt` and `lockUntil` timestamps without creating contradictory states.

---

## 7. Gross P&L Terminology
In Phase 1, P&L is explicitly labeled and calculated as:
**Gross Trading P&L = Realised P&L + Unrealised P&L (MTM)**
It is NOT labeled "Net P&L After Charges" because statutory taxes and transaction costs (STT, GST, exchange fees, SEBI turnover fees, stamp duty, brokerage) are not calculated in Phase 1.

---

## 8. Features Intentionally Deferred to Later Phases
The following features are NOT part of Phase 1 and will be introduced in subsequent phases:
- Live Zerodha OAuth authentication and credential storage (Phase 7–8)
- Live positions polling and square-off detection (Phase 8)
- Real-time Kite WebSocket market feed streaming (Phase 9–10)
- Net charges / taxes calculation engine (Phase 4 / 11)
- Browser extension / OS-level website blocking (Phase 12)
- Push notifications / alert delivery systems (Phase 6)
