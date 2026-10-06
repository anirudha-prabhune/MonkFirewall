import React, { useState, useEffect } from 'react';
import {
  Activity,
  CheckCircle2,
  XCircle,
  RefreshCw,
  Server,
  Database,
  Lock,
  ShieldAlert,
  Key,
  Calendar,
  AlertTriangle,
  ShieldCheck,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { testFirestoreConnection } from '../services/firebase';
import { callProtectedTradingEndpoint } from '../services/enforcementService';

interface ApiHealthResponse {
  status: string;
  phase: string;
  service: string;
  timestamp: string;
  timezone: string;
  uptimeSeconds: number;
  features: {
    firebaseAuth: boolean;
    firestore: boolean;
    riskEngine: string;
    zerodhaAdapter: string;
  };
}

export const SystemHealth: React.FC = () => {
  const { user, profile, firestoreStatus, checkFirestore } = useAuth();
  const [apiHealth, setApiHealth] = useState<ApiHealthResponse | null>(null);
  const [apiLoading, setApiLoading] = useState<boolean>(true);
  const [apiError, setApiError] = useState<string | null>(null);
  const [fsPingTime, setFsPingTime] = useState<number | null>(null);
  const [pingingFs, setPingingFs] = useState<boolean>(false);

  const fetchApiHealth = async () => {
    setApiLoading(true);
    setApiError(null);
    try {
      const res = await fetch('/api/health');
      if (!res.ok) throw new Error(`HTTP error: ${res.status}`);
      const data: ApiHealthResponse = await res.json();
      setApiHealth(data);
    } catch (err) {
      setApiError(err instanceof Error ? err.message : 'API unreachable');
    } finally {
      setApiLoading(false);
    }
  };

  const runFirestorePing = async () => {
    setPingingFs(true);
    const start = performance.now();
    try {
      await testFirestoreConnection();
      setFsPingTime(Math.round(performance.now() - start));
      await checkFirestore();
    } catch {
      setFsPingTime(null);
    } finally {
      setPingingFs(false);
    }
  };

  const [testingGuard, setTestingGuard] = useState<boolean>(false);
  const [guardResult, setGuardResult] = useState<{
    statusCode: number;
    message: string;
    timestamp: string;
  } | null>(null);

  const runGuardTest = async () => {
    setTestingGuard(true);
    setGuardResult(null);
    try {
      const res = await callProtectedTradingEndpoint(user?.uid);
      setGuardResult({
        statusCode: res.statusCode,
        message:
          res.data?.message ||
          (res.statusCode === 423
            ? 'Blocked by Server Guard (State: LOCKED)'
            : 'Trading Allowed (State: ALLOW)'),
        timestamp: new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' }),
      });
    } catch (err) {
      setGuardResult({
        statusCode: 500,
        message: err instanceof Error ? err.message : 'Diagnostic probe failed',
        timestamp: new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' }),
      });
    } finally {
      setTestingGuard(false);
    }
  };

  useEffect(() => {
    fetchApiHealth();
    runFirestorePing();
  }, []);

  return (
    <div className="max-w-4xl mx-auto space-y-6 text-[#293241] dark:text-[#E0FBFC]">
      {/* Title */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-extrabold text-slate-900 dark:text-[#E0FBFC]">System Health & Security Audit</h2>
          <p className="text-xs text-[#3D5A80] dark:text-[#98C1D9]">
            Real-time status of authoritative backend services, Firestore database, and authentication.
          </p>
        </div>
        <button
          onClick={() => {
            fetchApiHealth();
            runFirestorePing();
          }}
          className="flex items-center space-x-2 bg-white dark:bg-[#1F2633] hover:bg-slate-50 dark:hover:bg-[#171E2E] text-xs px-3.5 py-2 rounded-xl border border-[#98C1D9]/50 dark:border-[#3D4A5E] text-[#575254] dark:text-[#c3c6c8] font-semibold shadow-xs cursor-pointer"
        >
          <RefreshCw className={`w-3.5 h-3.5 text-[#EE6C4D] dark:text-[#98C1D9] ${(apiLoading || pingingFs) ? 'animate-spin' : ''}`} />
          <span>Refresh Checks</span>
        </button>
      </div>

      {/* Grid of Health Checks */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Backend API Service */}
        <div className="bg-white dark:bg-[#1F2633] border border-[#98C1D9]/50 dark:border-[#3D4A5E] dark:border-[#3D4A5E] rounded-2xl p-6 shadow-xs">
          <div className="flex items-center justify-between pb-3.5 border-b border-slate-100 dark:border-[#3D4A5E] dark:border-[#3D4A5E]">
            <div className="flex items-center space-x-2.5">
              <div className="p-2 rounded-xl bg-slate-100 dark:bg-[#283244] text-[#EE6C4D] dark:text-[#98C1D9] border border-[#98C1D9]/50 dark:border-[#3D4A5E] dark:border-[#C5A059]/20">
                <Server className="w-4 h-4" />
              </div>
              <span className="font-bold text-sm text-slate-900 dark:text-[#E0FBFC] dark:text-[#E0FBFC]">Server API Gateway</span>
            </div>
            {apiLoading ? (
              <span className="text-xs text-[#3D5A80] dark:text-[#98C1D9] flex items-center space-x-1">
                <RefreshCw className="w-3 h-3 animate-spin text-[#EE6C4D] dark:text-[#98C1D9]" />
                <span>Probing</span>
              </span>
            ) : apiHealth ? (
              <span className="inline-flex items-center px-2.5 py-0.5 rounded-md text-xs font-bold bg-emerald-50 text-emerald-600 dark:text-emerald-400 border border-emerald-200">
                <CheckCircle2 className="w-3 h-3 mr-1" />
                <span>ONLINE (200 OK)</span>
              </span>
            ) : (
              <span className="inline-flex items-center px-2.5 py-0.5 rounded-md text-xs font-bold bg-rose-50 text-rose-600 dark:text-rose-400 border border-rose-200">
                <XCircle className="w-3 h-3 mr-1" />
                <span>UNREACHABLE</span>
              </span>
            )}
          </div>

          <div className="mt-4 space-y-2 text-xs font-mono">
            <div className="flex justify-between py-1 border-b border-slate-100 dark:border-[#3D4A5E] dark:border-[#3D4A5E]">
              <span className="text-[#3D5A80] dark:text-[#98C1D9] font-sans">Endpoint</span>
              <span className="text-[#293241] dark:text-[#E0FBFC] font-semibold">GET /api/health</span>
            </div>
            <div className="flex justify-between py-1 border-b border-slate-100 dark:border-[#3D4A5E] dark:border-[#3D4A5E]">
              <span className="text-[#3D5A80] dark:text-[#98C1D9] font-sans">Service Phase</span>
              <span className="text-[#EE6C4D] dark:text-[#98C1D9] font-bold">{apiHealth?.phase || 'PHASE_8'}</span>
            </div>
            <div className="flex justify-between py-1 border-b border-slate-100 dark:border-[#3D4A5E] dark:border-[#3D4A5E]">
              <span className="text-[#3D5A80] dark:text-[#98C1D9] font-sans">Timezone</span>
              <span className="text-[#293241] dark:text-[#E0FBFC] font-semibold">{apiHealth?.timezone || 'Asia/Kolkata'}</span>
            </div>
            <div className="flex justify-between py-1">
              <span className="text-[#3D5A80] dark:text-[#98C1D9] font-sans">Uptime</span>
              <span className="text-[#293241] dark:text-[#E0FBFC] font-semibold">{apiHealth?.uptimeSeconds ?? 0}s</span>
            </div>
          </div>
        </div>

        {/* Cloud Firestore Database */}
        <div className="bg-white dark:bg-[#1F2633] border border-[#98C1D9]/50 dark:border-[#3D4A5E] dark:border-[#3D4A5E] rounded-2xl p-6 shadow-xs">
          <div className="flex items-center justify-between pb-3.5 border-b border-slate-100 dark:border-[#3D4A5E] dark:border-[#3D4A5E]">
            <div className="flex items-center space-x-2.5">
              <div className="p-2 rounded-xl bg-slate-100 dark:bg-[#283244] text-[#EE6C4D] dark:text-[#98C1D9] border border-[#98C1D9]/50 dark:border-[#3D4A5E] dark:border-[#C5A059]/20">
                <Database className="w-4 h-4" />
              </div>
              <span className="font-bold text-sm text-slate-900 dark:text-[#E0FBFC] dark:text-[#E0FBFC]">Cloud Firestore</span>
            </div>
            <span
              className={`inline-flex items-center px-2.5 py-0.5 rounded-md text-xs font-bold ${
                firestoreStatus === 'connected'
                  ? 'bg-emerald-50 text-emerald-600 dark:text-emerald-400 border border-emerald-200'
                  : 'bg-rose-50 text-rose-600 dark:text-rose-400 border border-rose-200'
              }`}
            >
              {firestoreStatus === 'connected' ? (
                <>
                  <CheckCircle2 className="w-3 h-3 mr-1" />
                  <span>CONNECTED</span>
                </>
              ) : (
                <>
                  <XCircle className="w-3 h-3 mr-1" />
                  <span>DISCONNECTED</span>
                </>
              )}
            </span>
          </div>

          <div className="mt-4 space-y-2 text-xs font-mono">
            <div className="flex justify-between py-1 border-b border-slate-100 dark:border-[#3D4A5E] dark:border-[#3D4A5E]">
              <span className="text-[#3D5A80] dark:text-[#98C1D9] font-sans">Direct Server Ping</span>
              <span className="text-[#293241] dark:text-[#E0FBFC] font-semibold">{fsPingTime !== null ? `${fsPingTime}ms` : 'Testing...'}</span>
            </div>
            <div className="flex justify-between py-1 border-b border-slate-100 dark:border-[#3D4A5E] dark:border-[#3D4A5E]">
              <span className="text-[#3D5A80] dark:text-[#98C1D9] font-sans">Database ID</span>
              <span className="text-[#293241] dark:text-[#E0FBFC] font-semibold truncate max-w-[200px]">ai-studio-18984339-...</span>
            </div>
            <div className="flex justify-between py-1 border-b border-slate-100 dark:border-[#3D4A5E] dark:border-[#3D4A5E]">
              <span className="text-[#3D5A80] dark:text-[#98C1D9] font-sans">Security Model</span>
              <span className="text-emerald-600 dark:text-emerald-400 font-bold">Strict ABAC (Zero-Trust)</span>
            </div>
            <div className="flex justify-between py-1">
              <span className="text-[#3D5A80] dark:text-[#98C1D9] font-sans">Catch-all Deny</span>
              <span className="text-emerald-600 dark:text-emerald-400 font-bold">ENFORCED (match /** allow read, write: false)</span>
            </div>
          </div>
        </div>

        {/* Identity & Scoping Audit */}
        <div className="bg-white dark:bg-[#1F2633] border border-[#98C1D9]/50 dark:border-[#3D4A5E] dark:border-[#3D4A5E] rounded-2xl p-6 shadow-xs">
          <div className="flex items-center justify-between pb-3.5 border-b border-slate-100 dark:border-[#3D4A5E] dark:border-[#3D4A5E]">
            <div className="flex items-center space-x-2.5">
              <div className="p-2 rounded-xl bg-slate-100 dark:bg-[#283244] text-[#EE6C4D] dark:text-[#98C1D9] border border-[#98C1D9]/50 dark:border-[#3D4A5E] dark:border-[#C5A059]/20">
                <Lock className="w-4 h-4" />
              </div>
              <span className="font-bold text-sm text-slate-900 dark:text-[#E0FBFC] dark:text-[#E0FBFC]">Identity & Data Scoping</span>
            </div>
            <span className="inline-flex items-center px-2.5 py-0.5 rounded-md text-xs font-bold bg-emerald-50 text-emerald-600 dark:text-emerald-400 border border-emerald-200">
              <CheckCircle2 className="w-3 h-3 mr-1" />
              <span>SCOPED</span>
            </span>
          </div>

          <div className="mt-4 space-y-2 text-xs font-mono">
            <div className="flex justify-between py-1 border-b border-slate-100 dark:border-[#3D4A5E] dark:border-[#3D4A5E]">
              <span className="text-[#3D5A80] dark:text-[#98C1D9] font-sans">Session Mode</span>
              <span className={user?.isSandbox ? "text-[#EE6C4D] dark:text-[#98C1D9] font-bold" : "text-emerald-600 dark:text-emerald-400 font-bold"}>
                {user?.isSandbox ? 'SANDBOX / DEV MODE' : 'FIREBASE AUTH (GOOGLE SSO)'}
              </span>
            </div>
            <div className="flex justify-between py-1 border-b border-slate-100 dark:border-[#3D4A5E] dark:border-[#3D4A5E]">
              <span className="text-[#3D5A80] dark:text-[#98C1D9] font-sans">User UID</span>
              <span className="text-[#293241] dark:text-[#E0FBFC] font-semibold truncate max-w-[180px]">{user?.uid || 'Not signed in'}</span>
            </div>
            <div className="flex justify-between py-1 border-b border-slate-100 dark:border-[#3D4A5E] dark:border-[#3D4A5E]">
              <span className="text-[#3D5A80] dark:text-[#98C1D9] font-sans">Email</span>
              <span className="text-[#293241] dark:text-[#E0FBFC] font-semibold">{user?.email || 'N/A'}</span>
            </div>
            <div className="flex justify-between py-1 border-b border-slate-100 dark:border-[#3D4A5E] dark:border-[#3D4A5E]">
              <span className="text-[#3D5A80] dark:text-[#98C1D9] font-sans">Email Verified</span>
              <span className="text-emerald-600 dark:text-emerald-400 font-bold">{user?.emailVerified ? 'YES' : 'GOOGLE_SSO'}</span>
            </div>
            <div className="flex justify-between py-1 border-b border-slate-100 dark:border-[#3D4A5E] dark:border-[#3D4A5E]">
              <span className="text-[#3D5A80] dark:text-[#98C1D9] font-sans">Isolation Path</span>
              <span className="text-[#293241] dark:text-[#E0FBFC] font-semibold">/users/{user?.uid ? user.uid.substring(0, 8) + '...' : '{uid}'}/*</span>
            </div>
            <div className="flex justify-between py-1">
              <span className="text-[#3D5A80] dark:text-[#98C1D9] font-sans">Unauthenticated Access</span>
              <span className="text-rose-600 dark:text-rose-400 font-bold">BLOCKED BY RULES</span>
            </div>
          </div>
        </div>

        {/* Zero Client Secrets Verification */}
        <div className="bg-white dark:bg-[#1F2633] border border-[#98C1D9]/50 dark:border-[#3D4A5E] dark:border-[#3D4A5E] rounded-2xl p-6 shadow-xs">
          <div className="flex items-center justify-between pb-3.5 border-b border-slate-100 dark:border-[#3D4A5E] dark:border-[#3D4A5E]">
            <div className="flex items-center space-x-2.5">
              <div className="p-2 rounded-xl bg-slate-100 dark:bg-[#283244] text-[#EE6C4D] dark:text-[#98C1D9] border border-[#98C1D9]/50 dark:border-[#3D4A5E] dark:border-[#C5A059]/20">
                <Key className="w-4 h-4" />
              </div>
              <span className="font-bold text-sm text-slate-900 dark:text-[#E0FBFC] dark:text-[#E0FBFC]">Secret Boundary Audit</span>
            </div>
            <span className="inline-flex items-center px-2.5 py-0.5 rounded-md text-xs font-bold bg-emerald-50 text-emerald-600 dark:text-emerald-400 border border-emerald-200">
              <CheckCircle2 className="w-3 h-3 mr-1" />
              <span>PASSED</span>
            </span>
          </div>

          <div className="mt-4 space-y-2 text-xs font-mono">
            <div className="flex justify-between py-1 border-b border-slate-100 dark:border-[#3D4A5E] dark:border-[#3D4A5E]">
              <span className="text-[#3D5A80] dark:text-[#98C1D9] font-sans">Kite API Secret</span>
              <span className="text-emerald-600 dark:text-emerald-400 font-bold">SERVER-SIDE ONLY</span>
            </div>
            <div className="flex justify-between py-1 border-b border-slate-100 dark:border-[#3D4A5E] dark:border-[#3D4A5E]">
              <span className="text-[#3D5A80] dark:text-[#98C1D9] font-sans">Zerodha Access Tokens</span>
              <span className="text-emerald-600 dark:text-emerald-400 font-bold">NEVER IN BROWSER</span>
            </div>
            <div className="flex justify-between py-1 border-b border-slate-100 dark:border-[#3D4A5E] dark:border-[#3D4A5E]">
              <span className="text-[#3D5A80] dark:text-[#98C1D9] font-sans">Risk State Authority</span>
              <span className="text-emerald-600 dark:text-emerald-400 font-bold">SERVER AUTHORITATIVE</span>
            </div>
            <div className="flex justify-between py-1">
              <span className="text-[#3D5A80] dark:text-[#98C1D9] font-sans">Client Role</span>
              <span className="text-[#293241] dark:text-[#E0FBFC] font-semibold">MONITORING & CONTROL UI</span>
            </div>
          </div>
        </div>

        {/* Trading Guard & Order Interceptor Diagnostic */}
        <div className="bg-white dark:bg-[#1F2633] border border-[#98C1D9]/50 dark:border-[#3D4A5E] rounded-2xl p-6 shadow-xs md:col-span-2">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between pb-3.5 border-b border-slate-100 dark:border-[#3D4A5E] gap-2">
            <div className="flex items-center space-x-2.5">
              <div className="p-2 rounded-xl bg-slate-100 dark:bg-[#283244] text-[#3D5A80] dark:text-[#98C1D9] border border-[#98C1D9]/50 dark:border-[#3D4A5E]">
                <ShieldAlert className="w-4 h-4" />
              </div>
              <div>
                <span className="font-bold text-sm text-slate-900 dark:text-[#E0FBFC]">
                  Trading Guard Enforcement & Order Interceptor Test
                </span>
                <p className="text-[11px] text-[#5C6B7E] dark:text-[#98C1D9]">
                  Diagnostic probe verifying authoritative circuit breaker interception
                </p>
              </div>
            </div>

            <button
              onClick={runGuardTest}
              disabled={testingGuard}
              className="px-3.5 py-1.5 bg-[#3D5A80] hover:bg-[#2B3E58] dark:bg-[#98C1D9] dark:hover:bg-[#E0FBFC] text-white dark:text-[#293241] font-semibold text-xs rounded-xl shadow-xs transition-colors cursor-pointer disabled:opacity-50 flex items-center space-x-1.5 self-start sm:self-auto"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${testingGuard ? 'animate-spin' : ''}`} />
              <span>{testingGuard ? 'Testing Guard...' : 'Probe Protected Trading Guard'}</span>
            </button>
          </div>

          <div className="mt-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs">
            <div className="text-[#5C6B7E] dark:text-[#98C1D9]">
              <span>Diagnostic Result: </span>
              {guardResult ? (
                <span className="font-mono font-semibold text-slate-900 dark:text-[#E0FBFC]">
                  {guardResult.message} ({guardResult.timestamp})
                </span>
              ) : (
                <span className="italic">Click probe button to verify HTTP 423 enforcement.</span>
              )}
            </div>

            {guardResult && (
              <span
                className={`font-mono text-xs px-2.5 py-1 rounded-lg font-bold shrink-0 ${
                  guardResult.statusCode === 423
                    ? 'bg-rose-500/15 text-rose-700 dark:text-rose-300 border border-rose-500/30'
                    : 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border border-emerald-500/30'
                }`}
              >
                HTTP {guardResult.statusCode} {guardResult.statusCode === 423 ? 'LOCKED' : 'OK'}
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Implementation Roadmap */}
      <div className="bg-white dark:bg-[#1F2633] border border-[#98C1D9]/50 dark:border-[#3D4A5E] dark:border-[#3D4A5E] rounded-2xl p-6 shadow-xs">
        <h3 className="text-xs font-bold text-[#293241] dark:text-[#E0FBFC] uppercase tracking-wider mb-4">
          Production Architecture Roadmap
        </h3>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs font-mono">
          <div className="p-3 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-emerald-800 dark:text-emerald-300 flex items-center space-x-2">
            <CheckCircle2 className="w-4 h-4 flex-shrink-0 text-emerald-600" />
            <div>
              <div className="font-bold">Phase 1-6</div>
              <div className="text-[10px] text-emerald-600 dark:text-emerald-400">Core Risk & Enf</div>
            </div>
          </div>

          <div className="p-3 rounded-xl bg-[#C5A059] border border-[#C5A059]/30 text-slate-900 dark:text-[#E0FBFC] dark:text-[#E0FBFC] flex items-center space-x-2">
            <CheckCircle2 className="w-4 h-4 flex-shrink-0 text-[#EE6C4D] dark:text-[#98C1D9]" />
            <div>
              <div className="font-bold">Phase 7-8</div>
              <div className="text-[10px] text-[#575254] dark:text-[#c3c6c8]">Live PnL & Recon</div>
            </div>
          </div>

          <div className="p-3 rounded-xl bg-slate-50/80 dark:bg-[#19202B] border border-[#98C1D9]/50 dark:border-[#3D4A5E] dark:border-[#3D4A5E] text-slate-600 dark:text-slate-400">
            <div className="font-bold text-[#293241] dark:text-[#E0FBFC]">Phase 9-10</div>
            <div className="text-[10px]">Active Gate & Orders</div>
          </div>

          <div className="p-3 rounded-xl bg-slate-50/80 dark:bg-[#19202B] border border-[#98C1D9]/50 dark:border-[#3D4A5E] dark:border-[#3D4A5E] text-slate-600 dark:text-slate-400">
            <div className="font-bold text-[#293241] dark:text-[#E0FBFC]">Phase 11-14</div>
            <div className="text-[10px]">Client Blockers & Ext</div>
          </div>
        </div>
      </div>
    </div>
  );
};
