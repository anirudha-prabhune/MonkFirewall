import React, { useState, useEffect } from 'react';
import { AuthProvider, useAuth } from './context/AuthContext';
import { ThemeProvider } from './context/ThemeContext';
import { Header } from './components/Header';
import { AuthGate } from './components/AuthGate';
import { DashboardOverview } from './components/DashboardOverview';
import { RiskConfigEditor } from './components/RiskConfigEditor';
import { SystemHealth } from './components/SystemHealth';
import { RiskConfig, DEFAULT_RISK_CONFIG } from './types/risk';
import { subscribeRiskConfig, getRiskConfig } from './services/riskConfigService';
import { Shield, RefreshCw } from 'lucide-react';

function MainApp() {
  const { user, loading: authLoading, notice, clearNotice } = useAuth();
  const [activeTab, setActiveTab] = useState<'dashboard' | 'settings' | 'health'>('dashboard');
  const [riskConfig, setRiskConfig] = useState<RiskConfig>(DEFAULT_RISK_CONFIG);
  const [configLoading, setConfigLoading] = useState(false);

  useEffect(() => {
    if (!user) {
      setRiskConfig(DEFAULT_RISK_CONFIG);
      return;
    }

    setConfigLoading(true);
    // Initial fetch
    getRiskConfig(user.uid)
      .then((cfg) => {
        setRiskConfig(cfg);
        setConfigLoading(false);
      })
      .catch((err) => {
        console.error('Failed to load risk configuration:', err);
        setConfigLoading(false);
      });

    // Real-time listener
    const unsubscribe = subscribeRiskConfig(
      user.uid,
      (updatedConfig) => {
        setRiskConfig(updatedConfig);
      },
      (err) => {
        console.error('Risk config subscription error:', err);
      }
    );

    return () => unsubscribe();
  }, [user]);

  if (authLoading) {
    return (
      <div className="min-h-screen bg-[#F3F8FA] dark:bg-[#293241] flex flex-col items-center justify-center text-[#293241] dark:text-[#E0FBFC] p-4 transition-colors duration-200">
        <div className="p-4 rounded-2xl bg-[#3D5A80]/10 border border-[#3D5A80]/30 text-[#3D5A80] dark:text-[#98C1D9] mb-4 shadow-sm animate-pulse">
          <Shield className="w-10 h-10" />
        </div>
        <h2 className="text-sm font-semibold tracking-widest uppercase text-[#293241] dark:text-[#E0FBFC]">
          Trading Firewall
        </h2>
        <p className="text-xs text-[#3D5A80] dark:text-[#98C1D9] mt-2 flex items-center space-x-2 font-mono">
          <RefreshCw className="w-3.5 h-3.5 animate-spin text-[#EE6C4D]" />
          <span>INITIALIZING SECURE RISK SESSION...</span>
        </p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#F3F8FA] dark:bg-[#293241] text-[#293241] dark:text-[#E0FBFC] flex flex-col font-sans selection:bg-[#98C1D9]/30 selection:text-[#293241] transition-colors duration-200">
      <Header activeTab={activeTab} setActiveTab={setActiveTab} />

      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-6">
        {notice && (
          <div className="mb-5 p-3.5 rounded-xl bg-white dark:bg-[#1F2633] border border-[#98C1D9]/60 dark:border-[#3D4A5E] text-xs flex items-center justify-between shadow-xs">
            <div className="flex items-center space-x-2.5">
              <span className="w-2 h-2 rounded-full bg-[#EE6C4D] animate-pulse flex-shrink-0" />
              <span className="font-medium text-[#293241] dark:text-[#E0FBFC]">{notice}</span>
            </div>
            <button
              onClick={clearNotice}
              className="text-[#EE6C4D] hover:text-[#D95333] text-xs font-semibold uppercase tracking-wider ml-3 flex-shrink-0 cursor-pointer"
            >
              Dismiss
            </button>
          </div>
        )}

        {!user ? (
          <AuthGate />
        ) : (
          <>
            {activeTab === 'dashboard' && (
              <DashboardOverview
                riskConfig={riskConfig}
                onOpenSettings={() => setActiveTab('settings')}
              />
            )}

            {activeTab === 'settings' && (
              <RiskConfigEditor
                initialConfig={riskConfig}
                onSaved={(updated) => setRiskConfig(updated)}
              />
            )}

            {activeTab === 'health' && <SystemHealth />}
          </>
        )}
      </main>

      {/* Footer */}
      <footer className="border-t border-[#98C1D9]/50 dark:border-[#3D4A5E] bg-white dark:bg-[#1A202C] text-[#3D5A80] dark:text-[#98C1D9] text-xs py-4 px-4 transition-colors duration-200">
        <div className="max-w-7xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-2 text-[11px]">
          <div>
            <span className="font-bold tracking-wider text-[#293241] dark:text-[#E0FBFC]">TRADING FIREWALL</span> · Zerodha F&O Risk Control System
          </div>
          <div className="flex items-center space-x-3 text-[#3D5A80] dark:text-[#98C1D9] font-mono text-[10px]">
            <span>Asia/Kolkata</span>
            <span>·</span>
            <span>Firebase SSO</span>
            <span>·</span>
            <span>Cloud Firestore</span>
          </div>
        </div>
      </footer>
    </div>
  );
}

export default function App() {
  return (
    <ThemeProvider>
      <AuthProvider>
        <MainApp />
      </AuthProvider>
    </ThemeProvider>
  );
}
