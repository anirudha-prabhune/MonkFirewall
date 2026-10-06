import React, { useState, useEffect } from 'react';
import {
  ShieldCheck,
  AlertTriangle,
  Lock,
  Sliders,
  RefreshCw,
  LogIn,
  LogOut,
  Key,
  CheckCircle2,
  AlertCircle,
  Clock,
  Calendar,
  Layers,
  FlaskConical,
  ChevronDown,
  Eye,
  EyeOff,
  Radio,
} from 'lucide-react';
import { RiskConfig, RiskSession } from '../types/risk';
import { formatINR, getISTReadableDate, getISTTimestamp } from '../utils/formatters';
import { useAuth } from '../context/AuthContext';
import { subscribeRiskSession } from '../services/riskSessionService';
import { fetchFnoPositions, fetchBrokerStatus } from '../services/brokerPositionService';
import { fetchGrossPnl } from '../services/pnlService';
import {
  NormalizedPosition,
  BrokerConnectionStatus,
  LiveBrokerStatusResponse,
} from '../../server/brokers/types';
import { PnlResult } from '../../server/pnl/types';
import {
  fetchLiveBrokerStatus,
  fetchKiteLoginUrl,
  disconnectZerodhaSession,
} from '../services/liveBrokerService';

interface DashboardOverviewProps {
  riskConfig: RiskConfig;
  onOpenSettings: () => void;
}

export const DashboardOverview: React.FC<DashboardOverviewProps> = ({
  riskConfig,
  onOpenSettings,
}) => {
  const { user } = useAuth();
  const [istTime, setIstTime] = useState(getISTTimestamp());
  const tradingDate = getISTReadableDate();

  // Authoritative Risk Session
  const [session, setSession] = useState<RiskSession>({
    tradingDate: new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Kolkata',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date()),
    userId: user?.uid || 'default_trader',
    state: 'ALLOW',
    isBreached: false,
    lockedAt: null,
    lockUntil: null,
    currentPnl: 0,
    realisedPnl: 0,
    unrealisedPnl: 0,
    lossLimit: riskConfig.dailyLossLimit,
    warningThreshold1: riskConfig.warningThreshold1,
    warningThreshold2: riskConfig.warningThreshold2,
    lastEvaluatedAt: new Date().toISOString(),
    reason: null,
  });

  // Normalized Positions & Gross P&L
  const [fnoPositions, setFnoPositions] = useState<NormalizedPosition[]>([]);
  const [brokerStatus, setBrokerStatus] = useState<BrokerConnectionStatus>({
    broker: 'mock',
    status: 'CONNECTED',
    isMock: true,
    message: 'Simulation Data',
    timestamp: new Date().toISOString(),
  });
  const [pnlResult, setPnlResult] = useState<PnlResult | null>(null);
  const [loadingPositions, setLoadingPositions] = useState<boolean>(true);

  // Live Zerodha Broker Status
  const [liveBrokerStatus, setLiveBrokerStatus] = useState<LiveBrokerStatusResponse | null>(null);
  const [authenticatingKite, setAuthenticatingKite] = useState<boolean>(false);
  const [disconnectingKite, setDisconnectingKite] = useState<boolean>(false);
  const [kiteAuthMessage, setKiteAuthMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [showTokenInput, setShowTokenInput] = useState<boolean>(false);
  const [manualToken, setManualToken] = useState<string>('');
  const [submittingToken, setSubmittingToken] = useState<boolean>(false);

  // Demo / Simulation Controls State
  const [isDemoControlsOpen, setIsDemoControlsOpen] = useState<boolean>(false);
  const [evaluatingDemo, setEvaluatingDemo] = useState<boolean>(false);
  const [demoMessage, setDemoMessage] = useState<string | null>(null);

  // Positions display filter: hide zero-quantity closed positions by default
  const [showClosedPositions, setShowClosedPositions] = useState<boolean>(false);

  // IST Clock update loop
  useEffect(() => {
    const timer = setInterval(() => {
      setIstTime(getISTTimestamp());
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  // Subscribe to real-time Risk Session
  useEffect(() => {
    if (!user) return;
    const unsubscribe = subscribeRiskSession(
      user.uid,
      (updatedSession) => {
        setSession(updatedSession);
      }
    );
    return () => unsubscribe();
  }, [user]);

  // Load Positions and P&L
  const loadPositionsAndPnl = async () => {
    setLoadingPositions(true);
    try {
      const [pos, status, pnl] = await Promise.all([
        fetchFnoPositions(user?.uid),
        fetchBrokerStatus(),
        fetchGrossPnl(user?.uid),
      ]);
      setFnoPositions(pos);
      setBrokerStatus(status);
      setPnlResult(pnl);
      if (pnl && (pnl.riskSession || pnl.shadowSession)) {
        setSession(pnl.riskSession || pnl.shadowSession);
      }
    } catch (err) {
      console.error('Failed to load positions & PnL:', err);
    } finally {
      setLoadingPositions(false);
    }
  };

  // Load Live Diagnostics
  const loadLiveDiagnostics = async () => {
    if (!user) return;
    try {
      const res = await fetchLiveBrokerStatus(user.uid);
      setLiveBrokerStatus(res);
    } catch (err) {
      console.error('Failed to fetch live broker status:', err);
    }
  };

  useEffect(() => {
    loadPositionsAndPnl();
    loadLiveDiagnostics();
    const interval = setInterval(() => {
      loadPositionsAndPnl();
      loadLiveDiagnostics();
    }, 30000);
    return () => clearInterval(interval);
  }, [user]);

  // Handle Kite Login
  const handleKiteLogin = async () => {
    if (!user) return;
    setAuthenticatingKite(true);
    setKiteAuthMessage(null);
    try {
      const loginUrl = await fetchKiteLoginUrl(undefined, user.uid);
      if (loginUrl) {
        window.location.href = loginUrl;
      } else {
        setKiteAuthMessage({
          type: 'error',
          text: 'Unable to retrieve Kite login URL. Please verify server configuration.',
        });
      }
    } catch (err) {
      setKiteAuthMessage({
        type: 'error',
        text: err instanceof Error ? err.message : 'Kite login failed',
      });
    } finally {
      setAuthenticatingKite(false);
    }
  };

  // Handle Manual Token Submission
  const handleManualTokenSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user || !manualToken.trim()) return;
    setSubmittingToken(true);
    setKiteAuthMessage(null);
    try {
      let token = manualToken.trim();
      let state: string | undefined;
      if (token.includes('request_token=') || token.includes('state=')) {
        try {
          const url = new URL(token.startsWith('http') ? token : `http://dummy.com${token.startsWith('?') ? '' : '?'}${token}`);
          const extractedToken = url.searchParams.get('request_token');
          if (extractedToken) token = extractedToken;
          state = url.searchParams.get('state') || undefined;
        } catch {}
      }

      if (!state) {
        try {
          const stateRes = await fetch('/api/broker/live/auth/login', {
            headers: { 'x-user-id': user.uid },
          });
          if (stateRes.ok) {
            const data = await stateRes.json();
            state = data.state;
          }
        } catch {}
      }

      const res = await fetch('/api/brokers/zerodha/callback', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-user-id': user.uid,
        },
        body: JSON.stringify({ request_token: token, state, status: 'success' }),
      });

      const data = await res.json();
      if (res.ok && data.success) {
        setKiteAuthMessage({
          type: 'success',
          text: 'Zerodha session established successfully.',
        });
        setShowTokenInput(false);
        setManualToken('');
        loadLiveDiagnostics();
        loadPositionsAndPnl();
      } else {
        setKiteAuthMessage({
          type: 'error',
          text: data.error || 'Failed to exchange request token',
        });
      }
    } catch (err) {
      setKiteAuthMessage({
        type: 'error',
        text: err instanceof Error ? err.message : 'Token exchange failed',
      });
    } finally {
      setSubmittingToken(false);
    }
  };

  // Handle Kite Disconnect
  const handleKiteDisconnect = async () => {
    if (!user) return;
    setDisconnectingKite(true);
    setKiteAuthMessage(null);
    try {
      const success = await disconnectZerodhaSession(user.uid);
      if (success) {
        setKiteAuthMessage({
          type: 'success',
          text: 'Zerodha session disconnected. Switched to simulation mode.',
        });
        await Promise.all([loadLiveDiagnostics(), loadPositionsAndPnl()]);
      } else {
        setKiteAuthMessage({
          type: 'error',
          text: 'Failed to disconnect Zerodha session.',
        });
      }
    } catch (err) {
      setKiteAuthMessage({
        type: 'error',
        text: err instanceof Error ? err.message : 'Disconnect failed',
      });
    } finally {
      setDisconnectingKite(false);
    }
  };

  // Demo / Simulation P&L Handlers
  const handleSimulatePnl = async (targetPnl: number, label: string) => {
    setEvaluatingDemo(true);
    setDemoMessage(null);
    try {
      const res = await fetch('/api/risk/evaluate', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-user-id': user?.uid || 'default_trader',
        },
        body: JSON.stringify({ pnl: targetPnl }),
      });
      const data = await res.json();
      if (res.ok && data.session) {
        setSession(data.session);
        setDemoMessage(`SIMULATION: Applied ${label} (${formatINR(targetPnl)}). Risk State: ${data.session.state}`);
      } else {
        setDemoMessage(data.error || 'Simulation evaluation failed');
      }
    } catch (err) {
      setDemoMessage(err instanceof Error ? err.message : 'Simulation failed');
    } finally {
      setEvaluatingDemo(false);
    }
  };

  const handleResetDemo = async () => {
    setEvaluatingDemo(true);
    setDemoMessage(null);
    try {
      const res = await fetch('/api/risk/evaluate', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-user-id': user?.uid || 'default_trader',
        },
        body: JSON.stringify({ reset: true }),
      });
      const data = await res.json();
      if (res.ok && data.session) {
        setSession(data.session);
        setDemoMessage('SIMULATION: Reset to baseline demo state.');
        loadPositionsAndPnl();
      } else {
        setDemoMessage(data.error || 'Failed to reset demo state');
      }
    } catch (err) {
      setDemoMessage(err instanceof Error ? err.message : 'Reset failed');
    } finally {
      setEvaluatingDemo(false);
    }
  };

  // Remaining Lock Duration calculation strictly from authoritative session.lockUntil
  const getRemainingLockText = (): string => {
    if (session.state !== 'LOCKED') return 'N/A';
    if (!session.lockUntil) return 'N/A (Missing lock timestamp)';
    const now = new Date().getTime();
    const expiry = new Date(session.lockUntil).getTime();
    const diffMs = expiry - now;
    if (diffMs <= 0) return 'Expiring momentarily';
    const minutes = Math.floor(diffMs / (1000 * 60));
    const seconds = Math.floor((diffMs % (1000 * 60)) / 1000);
    if (minutes >= 60) {
      const hours = Math.floor(minutes / 60);
      const remMin = minutes % 60;
      return `${hours}h ${remMin}m`;
    }
    return `${minutes}m ${seconds}s`;
  };

  // 1. Broker Connection state (independent of displayed P&L data source)
  const isZerodhaConnected = liveBrokerStatus?.authenticated === true && liveBrokerStatus?.status === 'CONNECTED';

  // 2. Displayed Data-Source identification (Rules 1, 2, 6, 7)
  // LIVE MODE only when displayed P&L AND positions are actually sourced from live Zerodha pipeline
  const isPnlLiveSourced = pnlResult?.source === 'ZERODHA_LIVE' || pnlResult?.dataSource === 'ZERODHA_LIVE';
  const isPositionsLiveSourced =
    fnoPositions.length > 0
      ? fnoPositions.every((pos) => pos.dataSource === 'ZERODHA_LIVE')
      : isPnlLiveSourced;

  const isLiveMode = isPnlLiveSourced && isPositionsLiveSourced;
  const isSimulationMode = !isLiveMode;

  // 3. Authoritative P&L Values
  // In LIVE MODE: Must display the validated live values from the frozen Phase 8 pipeline:
  // grossTradingPnl, dailyRealisedPnl, dailyUnrealisedPnl, and lossAmount = max(0, -grossTradingPnl)
  // Never derive live values from demo/simulation fixtures.
  const effectivePnl = isLiveMode
    ? (pnlResult?.grossTradingPnl ?? pnlResult?.totalPnl ?? 0)
    : (session.currentPnl ?? (pnlResult?.totalPnl ?? 0));
  const effectiveRealised = isLiveMode
    ? (pnlResult?.dailyRealisedPnl ?? pnlResult?.realisedPnl ?? 0)
    : (session.realisedPnl ?? (pnlResult?.realisedPnl ?? 0));
  const effectiveUnrealised = isLiveMode
    ? (pnlResult?.dailyUnrealisedPnl ?? pnlResult?.unrealisedPnl ?? 0)
    : (session.unrealisedPnl ?? (pnlResult?.unrealisedPnl ?? 0));

  const lossAmount = effectivePnl < 0 ? Math.abs(effectivePnl) : 0;
  const lossUtilizedPercent = riskConfig.dailyLossLimit > 0
    ? Math.min(100, Math.round((lossAmount / riskConfig.dailyLossLimit) * 100))
    : 0;
  const remainingBuffer = Math.max(0, riskConfig.dailyLossLimit - lossAmount);

  // Filter zero-quantity closed positions by default, but show them if all positions are closed (squared-off)
  const openPositions = fnoPositions.filter((pos) => pos.quantity !== 0);
  const closedCount = fnoPositions.length - openPositions.length;
  const displayedPositions = showClosedPositions || openPositions.length === 0 ? fnoPositions : openPositions;

  return (
    <div className="space-y-6">
      {/* Auth / Operational Notification Banner */}
      {kiteAuthMessage && (
        <div
          className={`p-4 rounded-xl border flex items-center justify-between text-xs transition-colors ${
            kiteAuthMessage.type === 'success'
              ? 'bg-emerald-500/10 text-emerald-800 dark:text-emerald-300 border-emerald-500/30'
              : 'bg-rose-500/10 text-rose-800 dark:text-rose-300 border-rose-500/30'
          }`}
        >
          <div className="flex items-center space-x-2.5">
            {kiteAuthMessage.type === 'success' ? (
              <CheckCircle2 className="w-4 h-4 text-emerald-600 dark:text-emerald-400 shrink-0" />
            ) : (
              <AlertCircle className="w-4 h-4 text-rose-600 dark:text-rose-400 shrink-0" />
            )}
            <span className="font-medium">{kiteAuthMessage.text}</span>
          </div>
          <button
            onClick={() => setKiteAuthMessage(null)}
            className="text-xs font-semibold uppercase tracking-wider opacity-75 hover:opacity-100 ml-4 cursor-pointer"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Interactive Token Input Form (if toggled) */}
      {showTokenInput && (
        <form
          onSubmit={handleManualTokenSubmit}
          className="bg-white dark:bg-[#1F2633] p-4 rounded-xl border border-[#98C1D9]/40 dark:border-[#3D4A5E] shadow-xs flex flex-col sm:flex-row items-center gap-3"
        >
          <div className="flex-1 w-full">
            <label className="block text-[11px] font-semibold text-[#5C6B7E] dark:text-[#98C1D9] uppercase tracking-wider mb-1">
              Manual Request Token or Redirect URL
            </label>
            <input
              type="text"
              value={manualToken}
              onChange={(e) => setManualToken(e.target.value)}
              placeholder="Paste request_token or full redirect URL from Zerodha..."
              className="w-full text-xs font-mono px-3 py-2 rounded-lg bg-slate-50 dark:bg-[#19202B] border border-[#98C1D9]/40 dark:border-[#3D4A5E] focus:outline-hidden focus:border-[#3D5A80]"
            />
          </div>
          <div className="flex items-center space-x-2 shrink-0 pt-2 sm:pt-4 w-full sm:w-auto">
            <button
              type="submit"
              disabled={submittingToken || !manualToken.trim()}
              className="flex-1 sm:flex-initial px-4 py-2 bg-[#3D5A80] hover:bg-[#2B3E58] text-white text-xs font-semibold rounded-lg disabled:opacity-50 transition-colors cursor-pointer"
            >
              {submittingToken ? 'Submitting...' : 'Submit Token'}
            </button>
            <button
              type="button"
              onClick={() => setShowTokenInput(false)}
              className="px-3 py-2 bg-slate-100 dark:bg-[#283244] text-[#5C6B7E] dark:text-[#98C1D9] text-xs font-semibold rounded-lg hover:bg-slate-200 transition-colors cursor-pointer"
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      {/* LOCKED Risk Lockout Banner */}
      {session.state === 'LOCKED' && (
        <div className="bg-rose-500/10 border-2 border-rose-500/40 rounded-2xl p-6 text-rose-950 dark:text-rose-100 shadow-sm space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-rose-500/20 pb-4">
            <div className="flex items-center space-x-3.5">
              <div className="p-3 rounded-xl bg-rose-500/20 text-rose-600 dark:text-rose-400 border border-rose-500/30">
                <Lock className="w-7 h-7" />
              </div>
              <div>
                <span className="text-[11px] uppercase tracking-widest font-mono text-rose-700 dark:text-rose-300 font-bold block">
                  Trading Locked
                </span>
                <h2 className="text-xl sm:text-2xl font-black tracking-tight text-rose-900 dark:text-rose-100 mt-0.5">
                  DAILY LOSS LIMIT REACHED · FIREWALL LOCKED
                </h2>
              </div>
            </div>

            <div className="text-left sm:text-right">
              <span className="text-xs text-rose-700 dark:text-rose-300 block font-medium">
                Remaining Lock Duration
              </span>
              <span className="text-xl font-mono font-extrabold text-rose-900 dark:text-rose-100">
                {getRemainingLockText()}
              </span>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs">
            <div className="bg-white/80 dark:bg-[#1F2633] p-3 rounded-xl border border-rose-500/20">
              <span className="text-[#5C6B7E] dark:text-[#98C1D9] block text-[11px]">Reason</span>
              <span className="font-bold text-rose-900 dark:text-rose-100 mt-0.5 block">
                {session.reason || `Daily loss limit of ${formatINR(riskConfig.dailyLossLimit)} reached`}
              </span>
            </div>
            <div className="bg-white/80 dark:bg-[#1F2633] p-3 rounded-xl border border-rose-500/20">
              <span className="text-[#5C6B7E] dark:text-[#98C1D9] block text-[11px]">Locked At (IST)</span>
              <span className="font-mono font-bold text-slate-800 dark:text-slate-200 mt-0.5 block">
                {session.lockedAt ? new Date(session.lockedAt).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true }) : 'N/A (Data Error)'}
              </span>
            </div>
            <div className="bg-white/80 dark:bg-[#1F2633] p-3 rounded-xl border border-rose-500/20">
              <span className="text-[#5C6B7E] dark:text-[#98C1D9] block text-[11px]">Lock Until (IST)</span>
              <span className="font-mono font-bold text-slate-800 dark:text-slate-200 mt-0.5 block">
                {session.lockUntil ? new Date(session.lockUntil).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true }) : 'N/A (Data Error)'}
              </span>
            </div>
          </div>

          <p className="text-xs text-rose-800 dark:text-rose-200 leading-relaxed pt-1">
            Trading Firewall is locked. Broker orders are not modified or cancelled. Lockout will automatically release at the scheduled lock expiry time.
          </p>
        </div>
      )}

      {/* 1. PRIMARY RISK SUMMARY (3-Column Layout, Risk State Dominant) */}
      <div className="bg-white dark:bg-[#1F2633] rounded-2xl border border-[#98C1D9]/40 dark:border-[#3D4A5E] p-6 shadow-xs transition-colors">
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 lg:divide-x divide-slate-100 dark:divide-[#3D4A5E]">
          
          {/* Pillar 1: Current Risk State (Visually Dominant) */}
          {(() => {
            const isSyncStale =
              isLiveMode &&
              pnlResult !== null &&
              session.currentPnl !== undefined &&
              Math.abs(session.currentPnl - effectivePnl) > 0.01;

            const displayState = isSyncStale ? 'EVALUATING' : session.state;

            return (
              <div className="flex flex-col justify-between pr-0 lg:pr-6">
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs font-bold text-[#5C6B7E] dark:text-[#98C1D9] uppercase tracking-wider">
                      Firewall Status
                    </span>
                    <span
                      className={`text-[10px] font-mono px-2 py-0.5 rounded font-bold uppercase tracking-wider ${
                        displayState === 'EVALUATING'
                          ? 'bg-amber-500/20 text-amber-700 dark:text-amber-300 border border-amber-500/40 animate-pulse'
                          : displayState === 'LOCKED'
                          ? 'bg-rose-500/20 text-rose-700 dark:text-rose-300 border border-rose-500/40'
                          : displayState === 'WARNING'
                          ? 'bg-amber-500/20 text-amber-700 dark:text-amber-300 border border-amber-500/40'
                          : 'bg-emerald-500/20 text-emerald-700 dark:text-emerald-300 border border-emerald-500/40'
                      }`}
                    >
                      {displayState}
                    </span>
                  </div>

                  {/* Visually Dominant State Card */}
                  <div
                    className={`p-4 rounded-xl border-2 flex items-center space-x-4 mt-2 transition-all ${
                      displayState === 'EVALUATING'
                        ? 'bg-amber-500/10 border-amber-500/40 text-amber-700 dark:text-amber-300'
                        : displayState === 'LOCKED'
                        ? 'bg-rose-500/10 border-rose-500/40 text-rose-700 dark:text-rose-300'
                        : displayState === 'WARNING'
                        ? 'bg-amber-500/10 border-amber-500/40 text-amber-700 dark:text-amber-300'
                        : 'bg-emerald-500/10 border-emerald-500/40 text-emerald-700 dark:text-emerald-300'
                    }`}
                  >
                    <div
                      className={`p-3.5 rounded-xl border flex items-center justify-center shrink-0 ${
                        displayState === 'EVALUATING'
                          ? 'bg-amber-500/20 border-amber-500/40 text-amber-600 dark:text-amber-400'
                          : displayState === 'LOCKED'
                          ? 'bg-rose-500/20 border-rose-500/40 text-rose-600 dark:text-rose-400'
                          : displayState === 'WARNING'
                          ? 'bg-amber-500/20 border-amber-500/40 text-amber-600 dark:text-amber-400'
                          : 'bg-emerald-500/20 border-emerald-500/40 text-emerald-600 dark:text-emerald-400'
                      }`}
                    >
                      {displayState === 'EVALUATING' ? (
                        <RefreshCw className="w-9 h-9 animate-spin" />
                      ) : displayState === 'LOCKED' ? (
                        <Lock className="w-9 h-9" />
                      ) : displayState === 'WARNING' ? (
                        <AlertTriangle className="w-9 h-9" />
                      ) : (
                        <ShieldCheck className="w-9 h-9" />
                      )}
                    </div>

                    <div>
                      <div className="text-4xl font-black font-mono tracking-wider">
                        {displayState}
                      </div>
                      <div className="text-xs font-semibold mt-1">
                        {displayState === 'EVALUATING'
                          ? 'Syncing Risk State... Evaluating Current P&L'
                          : displayState === 'LOCKED'
                          ? 'Trading Locked · Circuit Breaker Engaged'
                          : displayState === 'WARNING'
                          ? 'Warning Active · Loss Nearing Limit'
                          : 'Trading Authorized · Limits Normal'}
                      </div>
                    </div>
                  </div>
                </div>

                <div className="mt-4 pt-3 border-t border-slate-100 dark:border-[#3D4A5E] text-[11px] text-[#5C6B7E] dark:text-[#98C1D9] flex items-center justify-between">
                  <span>
                    Protection:{' '}
                    {!riskConfig.enabled
                      ? 'Disabled'
                      : pnlResult?.liveRiskStateRecordingEnabled === true
                      ? 'Active'
                      : 'Shadow Mode'}
                  </span>
                  <span className="font-mono">
                    {session.lastEvaluatedAt
                      ? new Date(session.lastEvaluatedAt).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' })
                      : istTime}{' '}
                    IST
                  </span>
                </div>
              </div>
            );
          })()}

          {/* Pillar 2: F&O P&L (Clearly distinguishing LIVE vs SIMULATION mode) */}
          <div className="flex flex-col justify-between px-0 lg:px-6">
            <div>
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-bold text-[#5C6B7E] dark:text-[#98C1D9] uppercase tracking-wider">
                  {isLiveMode ? "Today's F&O P&L" : 'Simulated F&O P&L'}
                </span>

                {/* Mode Tag */}
                {isLiveMode ? (
                  <div className="flex items-center space-x-1.5">
                    <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border border-emerald-500/30 font-bold flex items-center space-x-1">
                      <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
                      <span>Zerodha Live Account</span>
                    </span>
                    {(pnlResult as any)?.marketDataStatus && (pnlResult as any)?.marketDataStatus !== 'FRESH' && (
                      <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-amber-500/10 text-amber-700 dark:text-amber-300 border border-amber-500/40 font-bold uppercase tracking-wider">
                        Data: {(pnlResult as any)?.marketDataStatus}
                      </span>
                    )}
                  </div>
                ) : (
                  <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-amber-500/10 text-amber-700 dark:text-amber-300 border border-dashed border-amber-500/40 font-bold uppercase tracking-wider">
                    SIMULATION
                  </span>
                )}
              </div>

              {/* P&L Display: Demo P&L visually distinguished so it never resembles live broker P&L */}
              <div
                className={`p-4 rounded-xl border transition-all ${
                  isLiveMode
                    ? 'bg-slate-50/50 dark:bg-[#19202B]/40 border-slate-200 dark:border-[#3D4A5E]'
                    : 'bg-amber-50/30 dark:bg-amber-950/10 border-dashed border-amber-500/30'
                }`}
              >
                <div className="flex items-baseline justify-between">
                  <div
                    className={`text-3xl font-extrabold font-mono tracking-tight ${
                      effectivePnl < 0
                        ? 'text-rose-600 dark:text-rose-400'
                        : effectivePnl > 0
                        ? 'text-emerald-600 dark:text-emerald-400'
                        : 'text-slate-900 dark:text-[#E0FBFC]'
                    }`}
                  >
                    {formatINR(effectivePnl)}
                  </div>
                  {isSimulationMode && (
                    <span className="text-[11px] font-mono font-semibold text-amber-700 dark:text-amber-400 uppercase tracking-wider">
                      (Simulated)
                    </span>
                  )}
                </div>

                <div className="grid grid-cols-2 gap-4 mt-3 text-xs">
                  <div>
                    <span className="text-[#5C6B7E] dark:text-[#98C1D9] block text-[11px]">Realized</span>
                    <span className="font-mono font-bold text-slate-800 dark:text-slate-200">
                      {formatINR(effectiveRealised)}
                    </span>
                  </div>
                  <div>
                    <span className="text-[#5C6B7E] dark:text-[#98C1D9] block text-[11px]">Unrealized</span>
                    <span className="font-mono font-bold text-slate-800 dark:text-slate-200">
                      {formatINR(effectiveUnrealised)}
                    </span>
                  </div>
                </div>
              </div>
            </div>

            <div className="mt-4 pt-3 border-t border-slate-100 dark:border-[#3D4A5E] text-[11px] text-[#5C6B7E] dark:text-[#98C1D9]">
              {isLiveMode ? (
                <span className="text-emerald-700 dark:text-emerald-300 font-medium">
                  Zerodha Live Account · Real-time F&O performance
                </span>
              ) : (
                <span className="text-amber-700 dark:text-amber-400 font-medium">
                  Simulated demo data only. Does not represent your Zerodha account.
                </span>
              )}
            </div>
          </div>

          {/* Pillar 3: Daily Loss Limit */}
          <div className="flex flex-col justify-between pl-0 lg:pl-6">
            <div>
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-bold text-[#5C6B7E] dark:text-[#98C1D9] uppercase tracking-wider">
                  Daily Loss Limit
                </span>
                <button
                  onClick={onOpenSettings}
                  className="text-xs text-[#3D5A80] dark:text-[#98C1D9] hover:text-[#293241] dark:hover:text-[#E0FBFC] font-semibold flex items-center space-x-1 cursor-pointer transition-colors"
                >
                  <Sliders className="w-3 h-3" />
                  <span>Configure</span>
                </button>
              </div>

              <div className="text-3xl font-extrabold font-mono tracking-tight text-slate-900 dark:text-[#E0FBFC]">
                {formatINR(riskConfig.dailyLossLimit)}
              </div>

              <div className="mt-2.5">
                <div className="flex items-center justify-between text-xs font-mono mb-1.5">
                  <span
                    className={`font-semibold ${
                      lossUtilizedPercent >= 90
                        ? 'text-rose-600 dark:text-rose-400 font-bold'
                        : lossUtilizedPercent >= 70
                        ? 'text-amber-600 dark:text-amber-400 font-bold'
                        : 'text-slate-700 dark:text-slate-300'
                    }`}
                  >
                    {lossUtilizedPercent}% Used
                  </span>
                  <span className="text-[#5C6B7E] dark:text-[#98C1D9]">
                    Buffer: <span className="font-semibold text-slate-800 dark:text-slate-200">{formatINR(remainingBuffer)}</span>
                  </span>
                </div>

                {/* Clean Progress Bar */}
                <div className="w-full bg-slate-100 dark:bg-[#19202B] h-2 rounded-full overflow-hidden border border-[#98C1D9]/30 dark:border-[#3D4A5E]">
                  <div
                    className={`h-full rounded-full transition-all duration-500 ${
                      lossUtilizedPercent >= 100
                        ? 'bg-rose-500'
                        : lossUtilizedPercent >= 70
                        ? 'bg-amber-500'
                        : 'bg-emerald-500'
                    }`}
                    style={{ width: `${Math.min(lossUtilizedPercent, 100)}%` }}
                  />
                </div>
              </div>
            </div>

            <div className="mt-4 pt-3 border-t border-slate-100 dark:border-[#3D4A5E] text-[11px] text-[#5C6B7E] dark:text-[#98C1D9] flex items-center justify-between font-mono">
              <span>Alert 1: {riskConfig.warningThreshold1}%</span>
              <span>Alert 2: {riskConfig.warningThreshold2}%</span>
              <span>
                Lock:{' '}
                {riskConfig.lockDurationType === 'UNTIL_4PM'
                  ? '4:00 PM'
                  : `${Math.round((riskConfig.lockDurationMinutes || 60) / 60)}h`}
              </span>
            </div>
          </div>

        </div>
      </div>

      {/* 2. OPERATIONAL STATUS BAR */}
      <div className="bg-white dark:bg-[#1F2633] rounded-xl border border-[#98C1D9]/40 dark:border-[#3D4A5E] px-4 py-3 flex flex-wrap items-center justify-between gap-3 text-xs shadow-xs transition-colors">
        <div className="flex flex-wrap items-center gap-4 text-slate-700 dark:text-slate-300">
          {/* Trading Date */}
          <div className="flex items-center space-x-1.5 font-mono">
            <Calendar className="w-3.5 h-3.5 text-[#3D5A80] dark:text-[#98C1D9]" />
            <span className="font-semibold text-slate-900 dark:text-[#E0FBFC]">{session.tradingDate || tradingDate}</span>
            <span className="text-[#5C6B7E] dark:text-[#98C1D9] text-[11px]">· IST</span>
          </div>

          <span className="text-slate-300 dark:text-[#3D4A5E] hidden sm:inline">|</span>

          {/* Mode Indicator (Rules 1, 2, 6, 7) */}
          <div className="flex items-center space-x-1.5 font-mono">
            <span className="text-[#5C6B7E] dark:text-[#98C1D9]">Mode:</span>
            {isLiveMode ? (
              <span className="font-bold text-emerald-600 dark:text-emerald-400 flex items-center space-x-1">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
                <span>LIVE MODE</span>
              </span>
            ) : (
              <span className="font-bold text-amber-700 dark:text-amber-300 px-2 py-0.5 rounded bg-amber-500/10 border border-dashed border-amber-500/30 uppercase tracking-wider text-[11px]">
                SIMULATION MODE
              </span>
            )}
          </div>

          <span className="text-slate-300 dark:text-[#3D4A5E] hidden sm:inline">|</span>

          {/* Broker Connection & Actions (Rule 3) */}
          <div className="flex items-center space-x-2">
            <span
              className={`w-2 h-2 rounded-full ${
                isZerodhaConnected ? 'bg-emerald-500 animate-pulse' : 'bg-slate-400'
              }`}
            />
            <span className="font-semibold text-slate-900 dark:text-[#E0FBFC]">
              {isZerodhaConnected ? 'Zerodha Connected' : 'Zerodha Disconnected'}
            </span>

            {/* Connection Actions */}
            {isZerodhaConnected ? (
              <button
                onClick={handleKiteDisconnect}
                disabled={disconnectingKite}
                className="ml-1 text-[11px] text-[#5C6B7E] hover:text-rose-600 dark:text-[#98C1D9] dark:hover:text-rose-400 font-medium cursor-pointer transition-colors"
                title="Disconnect Zerodha session"
              >
                ({disconnectingKite ? 'Disconnecting...' : 'Disconnect'})
              </button>
            ) : (
              <div className="flex items-center space-x-2 ml-1">
                <button
                  onClick={handleKiteLogin}
                  disabled={authenticatingKite}
                  className="px-2.5 py-1 bg-[#3D5A80] hover:bg-[#2B3E58] text-white text-[11px] font-semibold rounded-lg flex items-center space-x-1 cursor-pointer disabled:opacity-50 transition-colors shadow-2xs"
                  title="Connect live Zerodha Kite account"
                >
                  <LogIn className="w-3 h-3" />
                  <span>{authenticatingKite ? 'Connecting...' : 'Connect Zerodha'}</span>
                </button>
                <button
                  onClick={() => setShowTokenInput(!showTokenInput)}
                  className="p-1 rounded-lg text-[#5C6B7E] hover:text-slate-900 dark:text-[#98C1D9] dark:hover:text-[#E0FBFC] cursor-pointer"
                  title="Enter request token manually"
                >
                  <Key className="w-3.5 h-3.5" />
                </button>
              </div>
            )}
          </div>

          <span className="text-slate-300 dark:text-[#3D4A5E] hidden md:inline">|</span>

          {/* Last Update */}
          <div className="flex items-center space-x-1.5 text-[#5C6B7E] dark:text-[#98C1D9]">
            <Clock className="w-3.5 h-3.5 text-[#3D5A80] dark:text-[#98C1D9]" />
            <span>Updated:</span>
            <span className="font-mono text-slate-800 dark:text-slate-200">
              {session.lastEvaluatedAt
                ? new Date(session.lastEvaluatedAt).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' })
                : istTime}{' '}
              IST
            </span>
          </div>
        </div>

        {/* Refresh Action */}
        <button
          onClick={loadPositionsAndPnl}
          disabled={loadingPositions}
          className="p-1.5 rounded-lg text-[#5C6B7E] hover:text-[#293241] dark:text-[#98C1D9] dark:hover:text-[#E0FBFC] hover:bg-slate-100 dark:hover:bg-[#19202B] transition-colors cursor-pointer disabled:opacity-50"
          title="Refresh positions and risk state"
        >
          <RefreshCw className={`w-4 h-4 ${loadingPositions ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {/* 3. COLLAPSIBLE DEMO / SIMULATION CONTROLS (Only displayed in Simulation Mode) */}
      {isSimulationMode && (
        <div className="bg-slate-50/70 dark:bg-[#19202B]/50 rounded-2xl border border-dashed border-[#98C1D9]/50 dark:border-[#3D4A5E] shadow-2xs transition-colors overflow-hidden">
          <button
            type="button"
            onClick={() => setIsDemoControlsOpen(!isDemoControlsOpen)}
            className="w-full px-5 py-3.5 flex items-center justify-between text-left cursor-pointer hover:bg-slate-100/50 dark:hover:bg-[#283244]/30 transition-colors"
          >
            <div className="flex items-center space-x-3">
              <FlaskConical className="w-4 h-4 text-amber-600 dark:text-amber-400" />
              <div className="flex items-center space-x-2">
                <span className="text-xs font-bold text-slate-800 dark:text-[#E0FBFC]">
                  Demo & Simulation Controls
                </span>
                <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-amber-500/10 text-amber-700 dark:text-amber-300 border border-amber-500/30 uppercase font-semibold">
                  Simulation Pipeline Only
                </span>
              </div>
            </div>
            <div className="flex items-center space-x-2 text-xs text-[#5C6B7E] dark:text-[#98C1D9]">
              <span className="hidden sm:inline text-[11px]">
                {isDemoControlsOpen ? 'Collapse Controls' : 'Expand Simulation Tools'}
              </span>
              <ChevronDown
                className={`w-4 h-4 transform transition-transform duration-200 ${
                  isDemoControlsOpen ? 'rotate-180' : ''
                }`}
              />
            </div>
          </button>

          {isDemoControlsOpen && (
            <div className="px-5 pb-5 pt-1 border-t border-dashed border-slate-200 dark:border-[#3D4A5E] space-y-3">
              <p className="text-[11px] text-[#5C6B7E] dark:text-[#98C1D9]">
                Deterministic mock testing controls. Operates strictly on simulation pipeline and never modifies live broker data.
              </p>

              {demoMessage && (
                <div className="text-[11px] font-mono p-2.5 rounded-lg bg-white dark:bg-[#1F2633] border border-[#98C1D9]/40 dark:border-[#3D4A5E] text-slate-800 dark:text-slate-200">
                  {demoMessage}
                </div>
              )}

              <div className="flex flex-wrap items-center gap-2 pt-1">
                <button
                  onClick={() => handleSimulatePnl(effectivePnl + 2000, '+₹2,000')}
                  disabled={evaluatingDemo}
                  className="px-3 py-1.5 bg-white dark:bg-[#1F2633] hover:bg-emerald-50 dark:hover:bg-emerald-950/20 text-emerald-700 dark:text-emerald-300 border border-emerald-500/30 rounded-xl text-xs font-mono font-bold cursor-pointer disabled:opacity-50 transition-colors shadow-2xs"
                  title="Simulate profit increase of ₹2,000"
                >
                  +₹2,000
                </button>

                <button
                  onClick={() => handleSimulatePnl(effectivePnl - 2000, '-₹2,000')}
                  disabled={evaluatingDemo}
                  className="px-3 py-1.5 bg-white dark:bg-[#1F2633] hover:bg-amber-50 dark:hover:bg-amber-950/20 text-amber-700 dark:text-amber-300 border border-amber-500/30 rounded-xl text-xs font-mono font-bold cursor-pointer disabled:opacity-50 transition-colors shadow-2xs"
                  title="Simulate loss increase of ₹2,000"
                >
                  -₹2,000
                </button>

                <button
                  onClick={() => handleSimulatePnl(effectivePnl - 5000, '-₹5,000')}
                  disabled={evaluatingDemo}
                  className="px-3 py-1.5 bg-white dark:bg-[#1F2633] hover:bg-rose-50 dark:hover:bg-rose-950/20 text-rose-700 dark:text-rose-300 border border-rose-500/30 rounded-xl text-xs font-mono font-bold cursor-pointer disabled:opacity-50 transition-colors shadow-2xs"
                  title="Simulate loss increase of ₹5,000"
                >
                  -₹5,000
                </button>

                <button
                  onClick={() => handleSimulatePnl(-(riskConfig.dailyLossLimit + 500), 'Loss Limit Breach')}
                  disabled={evaluatingDemo}
                  className="px-3.5 py-1.5 bg-rose-600 hover:bg-rose-700 text-white rounded-xl text-xs font-semibold cursor-pointer disabled:opacity-50 transition-colors shadow-2xs"
                  title="Simulate loss exceeding daily limit to trigger lockout"
                >
                  Trigger Loss Limit Breach
                </button>

                <button
                  onClick={handleResetDemo}
                  disabled={evaluatingDemo}
                  className="px-3.5 py-1.5 bg-white dark:bg-[#1F2633] hover:bg-slate-100 dark:hover:bg-[#283244] text-slate-700 dark:text-slate-300 border border-[#98C1D9]/40 dark:border-[#3D4A5E] rounded-xl text-xs font-semibold cursor-pointer disabled:opacity-50 transition-colors shadow-2xs ml-auto"
                  title="Reset simulation to baseline mock data"
                >
                  {evaluatingDemo ? 'Processing...' : 'Reset Demo'}
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* 4. POSITIONS TABLE (Hides zero-quantity positions by default, clear mode context) */}
      <div className="bg-white dark:bg-[#1F2633] rounded-2xl border border-[#98C1D9]/40 dark:border-[#3D4A5E] overflow-hidden shadow-xs transition-colors">
        <div className="px-6 py-4 border-b border-[#98C1D9]/30 dark:border-[#3D4A5E] flex flex-col sm:flex-row sm:items-center justify-between gap-2">
          <div>
            <div className="flex items-center space-x-2">
              <h3 className="text-sm font-bold text-slate-900 dark:text-[#E0FBFC] uppercase tracking-wider">
                {isLiveMode ? 'F&O Positions' : 'Simulated F&O Positions'}
              </h3>
              {isSimulationMode ? (
                <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-amber-500/10 text-amber-700 dark:text-amber-300 border border-amber-500/30 uppercase font-semibold">
                  SIMULATION
                </span>
              ) : (
                <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border border-emerald-500/30 font-bold">
                  Zerodha Live Account
                </span>
              )}
            </div>
            <p className="text-xs text-[#5C6B7E] dark:text-[#98C1D9] mt-0.5">
              {isLiveMode
                ? 'Live derivative contracts from your connected Zerodha account'
                : 'Simulated demo contracts for risk testing. Does not represent your Zerodha account.'}
            </p>
          </div>

          <div className="flex items-center space-x-3 text-xs font-mono">
            {closedCount > 0 && (
              <button
                type="button"
                onClick={() => setShowClosedPositions(!showClosedPositions)}
                className="text-xs text-[#3D5A80] dark:text-[#98C1D9] hover:underline flex items-center space-x-1 cursor-pointer font-sans"
              >
                {showClosedPositions ? (
                  <>
                    <EyeOff className="w-3.5 h-3.5" />
                    <span>Hide Closed (0 Qty)</span>
                  </>
                ) : (
                  <>
                    <Eye className="w-3.5 h-3.5" />
                    <span>Show Closed ({closedCount})</span>
                  </>
                )}
              </button>
            )}

            <span className="font-semibold text-[#5C6B7E] dark:text-[#98C1D9]">
              {displayedPositions.length} {showClosedPositions || openPositions.length === 0 ? 'Total' : 'Open'}
            </span>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs font-mono">
            <thead className="bg-slate-50/75 dark:bg-[#19202B]/60 text-[#5C6B7E] dark:text-[#98C1D9] border-b border-[#98C1D9]/30 dark:border-[#3D4A5E] uppercase tracking-wider text-[11px]">
              <tr>
                <th className="px-5 py-3 font-semibold">Contract</th>
                <th className="px-4 py-3 font-semibold">Type</th>
                <th className="px-4 py-3 text-right font-semibold">Qty</th>
                <th className="px-4 py-3 text-right font-semibold">Avg Price</th>
                <th className="px-4 py-3 text-right font-semibold">LTP</th>
                <th className="px-5 py-3 text-right font-semibold">P&L</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-[#3D4A5E]/60 text-slate-800 dark:text-[#E0FBFC]">
              {displayedPositions.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-5 py-8 text-center text-slate-400 dark:text-slate-500 font-sans">
                    {openPositions.length === 0 && closedCount > 0
                      ? 'No open positions (closed positions hidden).'
                      : 'No derivative positions found.'}
                  </td>
                </tr>
              ) : (
                displayedPositions.map((pos) => {
                  const isLong = pos.quantity > 0;
                  const isShort = pos.quantity < 0;
                  const isClosed = pos.quantity === 0;
                  const pnl = pos.totalPnl;

                  return (
                    <tr
                      key={`${pos.exchange}-${pos.tradingsymbol}-${pos.product}`}
                      className={`transition-colors ${
                        isClosed
                          ? 'opacity-60 bg-slate-50/40 dark:bg-[#19202B]/20'
                          : 'hover:bg-slate-50/80 dark:hover:bg-[#19202B]/40'
                      }`}
                    >
                      {/* Contract */}
                      <td className="px-5 py-3 font-semibold text-slate-900 dark:text-[#E0FBFC]">
                        {pos.tradingsymbol}
                        {isClosed && (
                          <span className="ml-2 text-[10px] font-sans px-1.5 py-0.5 rounded bg-slate-200 dark:bg-[#283244] text-[#5C6B7E] dark:text-[#98C1D9]">
                            Closed
                          </span>
                        )}
                      </td>

                      {/* Type */}
                      <td className="px-4 py-3 text-[#5C6B7E] dark:text-[#98C1D9]">
                        {pos.segment || pos.instrumentType}
                      </td>

                      {/* Qty */}
                      <td className="px-4 py-3 text-right font-semibold">
                        <span
                          className={
                            isLong
                              ? 'text-emerald-600 dark:text-emerald-400'
                              : isShort
                              ? 'text-rose-600 dark:text-rose-400'
                              : 'text-slate-500 dark:text-slate-400'
                          }
                        >
                          {isLong ? `+${pos.quantity}` : pos.quantity}
                        </span>
                      </td>

                      {/* Avg Price */}
                      <td className="px-4 py-3 text-right text-slate-700 dark:text-slate-300">
                        ₹{pos.averagePrice.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                      </td>

                      {/* LTP */}
                      <td className="px-4 py-3 text-right text-slate-700 dark:text-slate-300">
                        <div className="flex flex-col items-end">
                          <span>₹{pos.lastPrice.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                          {isLiveMode && pos.quantity !== 0 && pos.hasValidatedLtp === false && (
                            <span className="text-[9px] font-sans font-semibold text-amber-700 dark:text-amber-400 bg-amber-500/10 px-1.5 py-0.2 rounded border border-amber-500/20 mt-0.5">
                              Broker LTP
                            </span>
                          )}
                          {isLiveMode && pos.quantity !== 0 && pos.hasValidatedLtp === true && (
                            <span className="text-[9px] font-sans font-semibold text-emerald-700 dark:text-emerald-400 bg-emerald-500/10 px-1.5 py-0.2 rounded border border-emerald-500/20 mt-0.5">
                              Validated
                            </span>
                          )}
                        </div>
                      </td>

                      {/* P&L */}
                      <td className="px-5 py-3 text-right font-bold">
                        <span
                          className={
                            pnl > 0
                              ? 'text-emerald-600 dark:text-emerald-400'
                              : pnl < 0
                              ? 'text-rose-600 dark:text-rose-400'
                              : 'text-slate-600 dark:text-slate-400'
                          }
                        >
                          {formatINR(pnl)}
                        </span>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};
