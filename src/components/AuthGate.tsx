import React, { useState } from 'react';
import { Shield, KeyRound, CheckCircle2, PlayCircle, RefreshCw, AlertTriangle } from 'lucide-react';
import { useAuth } from '../context/AuthContext';

export const AuthGate: React.FC = () => {
  const { signInWithGoogle, enterSandboxMode, error, clearError } = useAuth();
  const [signingIn, setSigningIn] = useState(false);

  const handleSignIn = async () => {
    try {
      setSigningIn(true);
      clearError();
      await signInWithGoogle();
    } catch {
      // Error handled within AuthContext
    } finally {
      setSigningIn(false);
    }
  };

  return (
    <div className="max-w-md mx-auto my-12">
      <div className="bg-white dark:bg-[#1F2633] border border-[#98C1D9]/50 dark:border-[#3D4A5E] rounded-2xl p-6 sm:p-8 shadow-sm relative overflow-hidden transition-colors duration-200">
        {/* Top Luxury Accent Line */}
        <div className="absolute top-0 left-0 right-0 h-0.5 bg-gradient-to-r from-transparent via-[#EE6C4D] to-transparent" />

        {/* Brand Header */}
        <div className="text-center mb-6">
          <div className="inline-flex p-3 rounded-xl bg-[#3D5A80]/15 dark:bg-[#283244] border border-[#3D5A80]/30 dark:border-[#98C1D9]/30 text-[#3D5A80] dark:text-[#98C1D9] mb-3.5 shadow-2xs">
            <Shield className="w-8 h-8" />
          </div>
          <h1 className="text-xl sm:text-2xl font-bold tracking-widest text-[#293241] dark:text-[#E0FBFC] uppercase font-sans mb-1.5">
            Trading Firewall
          </h1>
          <p className="text-xs text-[#3D5A80] dark:text-[#98C1D9]">
            Personal risk-management circuit breaker for Zerodha F&O traders.
          </p>
        </div>

        {/* Error Banner */}
        {error && (
          <div className="mb-5 p-3 rounded-xl bg-rose-50 dark:bg-rose-950/30 border border-rose-200 dark:border-rose-900/50 text-rose-800 dark:text-rose-300 text-xs flex items-center justify-between">
            <div className="flex items-center space-x-2">
              <AlertTriangle className="w-4 h-4 flex-shrink-0 text-rose-600 dark:text-rose-400" />
              <span>{error}</span>
            </div>
            <button
              onClick={clearError}
              className="text-rose-700 dark:text-rose-400 hover:underline text-xs font-semibold ml-2 cursor-pointer"
            >
              Dismiss
            </button>
          </div>
        )}

        {/* Core Principles */}
        <div className="space-y-3.5 mb-6 bg-[#F3F8FA] dark:bg-[#19202B] p-4 sm:p-5 rounded-xl border border-[#98C1D9]/40 dark:border-[#3D4A5E]">
          <h3 className="text-[11px] font-semibold text-[#3D5A80] dark:text-[#98C1D9] uppercase tracking-widest font-mono">
            Authoritative Risk Principles
          </h3>
          <ul className="space-y-2.5 text-xs text-[#5C6B7E] dark:text-[#98C1D9]">
            <li className="flex items-start space-x-2.5">
              <CheckCircle2 className="w-4 h-4 text-[#3D5A80] dark:text-[#98C1D9] flex-shrink-0 mt-0.5" />
              <span>
                <strong className="text-[#293241] dark:text-[#E0FBFC] font-semibold">Server-Authoritative State:</strong> The backend is the authoritative source of risk evaluation and lock enforcement.
              </span>
            </li>
            <li className="flex items-start space-x-2.5">
              <CheckCircle2 className="w-4 h-4 text-[#3D5A80] dark:text-[#98C1D9] flex-shrink-0 mt-0.5" />
              <span>
                <strong className="text-[#293241] dark:text-[#E0FBFC] font-semibold">Zero Execution Risk:</strong> Pure non-intrusive monitoring. Does not place, modify, or cancel trades.
              </span>
            </li>
            <li className="flex items-start space-x-2.5">
              <CheckCircle2 className="w-4 h-4 text-[#3D5A80] dark:text-[#98C1D9] flex-shrink-0 mt-0.5" />
              <span>
                <strong className="text-[#293241] dark:text-[#E0FBFC] font-semibold">Zero Secret Exposure:</strong> Broker credentials remain strictly isolated on the backend server runtime.
              </span>
            </li>
            <li className="flex items-start space-x-2.5">
              <KeyRound className="w-4 h-4 text-[#EE6C4D] flex-shrink-0 mt-0.5" />
              <span>
                <strong className="text-[#293241] dark:text-[#E0FBFC] font-semibold">Private & Scoped:</strong> User data strictly segregated via Firebase Authentication and rules.
              </span>
            </li>
          </ul>
        </div>

        {/* Actions */}
        <div className="space-y-3">
          <button
            onClick={handleSignIn}
            disabled={signingIn}
            className="w-full flex items-center justify-center space-x-2.5 bg-[#EE6C4D] hover:bg-[#D95333] text-white font-semibold py-2.5 px-4 rounded-xl transition-all shadow-xs active:scale-[0.99] cursor-pointer disabled:opacity-60 text-xs tracking-wide"
          >
            {signingIn ? (
              <>
                <RefreshCw className="w-4 h-4 animate-spin" />
                <span>Signing in...</span>
              </>
            ) : (
              <>
                <svg className="w-4 h-4" viewBox="0 0 24 24">
                  <path
                    fill="currentColor"
                    d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
                  />
                  <path
                    fill="currentColor"
                    d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                  />
                  <path
                    fill="currentColor"
                    d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z"
                  />
                  <path
                    fill="currentColor"
                    d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z"
                  />
                </svg>
                <span>Continue with Google</span>
              </>
            )}
          </button>

          <div className="relative flex py-1.5 items-center">
            <div className="flex-grow border-t border-[#98C1D9]/40 dark:border-[#3D4A5E]"></div>
            <span className="flex-shrink mx-3 text-[10px] text-[#3D5A80] dark:text-[#98C1D9] uppercase tracking-widest font-mono">
              or sandbox
            </span>
            <div className="flex-grow border-t border-[#98C1D9]/40 dark:border-[#3D4A5E]"></div>
          </div>

          <button
            onClick={() => enterSandboxMode()}
            className="w-full flex items-center justify-center space-x-2 bg-white dark:bg-[#283244] hover:bg-[#E0FBFC]/30 dark:hover:bg-[#3D4A5E]/40 text-[#293241] dark:text-[#E0FBFC] border border-[#98C1D9]/50 dark:border-[#3D4A5E] font-medium py-2.5 px-4 rounded-xl transition-colors text-xs cursor-pointer shadow-2xs"
          >
            <PlayCircle className="w-4 h-4 text-[#EE6C4D]" />
            <span>Enter Sandbox Demo Mode</span>
          </button>

          <p className="text-center text-[10px] text-[#5C6B7E] dark:text-[#98C1D9] font-sans pt-1">
            Personal risk rules persist to your private Firestore instance.
          </p>
        </div>
      </div>
    </div>
  );
};
