import React, { useState, useEffect } from 'react';
import { Shield, Clock, LogOut, LogIn, Activity, Settings, Database, Sun, Moon } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { useTheme } from '../context/ThemeContext';
import { getISTTimestamp } from '../utils/formatters';

interface HeaderProps {
  activeTab: 'dashboard' | 'settings' | 'health';
  setActiveTab: (tab: 'dashboard' | 'settings' | 'health') => void;
}

export const Header: React.FC<HeaderProps> = ({ activeTab, setActiveTab }) => {
  const { user, profile, logout, signInWithGoogle, firestoreStatus } = useAuth();
  const { theme, toggleTheme } = useTheme();
  const [istTime, setIstTime] = useState<string>(getISTTimestamp());

  useEffect(() => {
    const timer = setInterval(() => {
      setIstTime(getISTTimestamp());
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  return (
    <header className="bg-white/95 dark:bg-[#293241]/95 backdrop-blur-md border-b border-[#98C1D9]/40 dark:border-[#3D4A5E] text-[#293241] dark:text-[#E0FBFC] sticky top-0 z-50 transition-colors duration-200">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between h-16">
          {/* Logo & Branding */}
          <div className="flex items-center space-x-3.5">
            <div className="bg-[#3D5A80] dark:bg-[#1F2633] p-2.5 rounded-xl border border-[#98C1D9]/40 dark:border-[#3D4A5E] shadow-xs flex items-center justify-center text-white dark:text-[#98C1D9]">
              <Shield className="w-5 h-5 font-bold" />
            </div>
            <div>
              <div className="flex items-center space-x-2.5">
                <span className="font-bold text-base tracking-widest text-[#293241] dark:text-[#E0FBFC] uppercase font-sans">
                  Trading Firewall
                </span>
              </div>
              <p className="text-[11px] text-[#3D5A80] dark:text-[#98C1D9] hidden sm:block font-sans">
                Zerodha F&O Real-Time Risk Control & Loss Protection
              </p>
            </div>
          </div>

          {/* Navigation Tabs (if signed in) */}
          {user && (
            <nav className="hidden md:flex space-x-1 bg-[#E0FBFC]/50 dark:bg-[#1F2633] p-1 rounded-xl border border-[#98C1D9]/40 dark:border-[#3D4A5E]">
              <button
                onClick={() => setActiveTab('dashboard')}
                className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-all flex items-center space-x-1.5 cursor-pointer ${
                  activeTab === 'dashboard'
                    ? 'bg-white dark:bg-[#283244] text-[#3D5A80] dark:text-[#E0FBFC] shadow-xs border border-[#98C1D9]/60 dark:border-[#3D4A5E] font-semibold'
                    : 'text-[#5C6B7E] dark:text-[#98C1D9] hover:text-[#293241] dark:hover:text-[#E0FBFC]'
                }`}
              >
                <Activity className="w-3.5 h-3.5" />
                <span>Dashboard</span>
              </button>
              <button
                onClick={() => setActiveTab('settings')}
                className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-all flex items-center space-x-1.5 cursor-pointer ${
                  activeTab === 'settings'
                    ? 'bg-white dark:bg-[#283244] text-[#3D5A80] dark:text-[#E0FBFC] shadow-xs border border-[#98C1D9]/60 dark:border-[#3D4A5E] font-semibold'
                    : 'text-[#5C6B7E] dark:text-[#98C1D9] hover:text-[#293241] dark:hover:text-[#E0FBFC]'
                }`}
              >
                <Settings className="w-3.5 h-3.5" />
                <span>Risk Config</span>
              </button>
              <button
                onClick={() => setActiveTab('health')}
                className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-all flex items-center space-x-1.5 cursor-pointer ${
                  activeTab === 'health'
                    ? 'bg-white dark:bg-[#283244] text-[#3D5A80] dark:text-[#E0FBFC] shadow-xs border border-[#98C1D9]/60 dark:border-[#3D4A5E] font-semibold'
                    : 'text-[#5C6B7E] dark:text-[#98C1D9] hover:text-[#293241] dark:hover:text-[#E0FBFC]'
                }`}
              >
                <Database className="w-3.5 h-3.5" />
                <span>System & Security</span>
              </button>
            </nav>
          )}

          {/* Right Section: IST Clock, Theme Toggle & User Profile */}
          <div className="flex items-center space-x-3">
            {/* IST Clock */}
            <div className="hidden sm:flex items-center space-x-1.5 bg-white dark:bg-[#1F2633] px-2.5 py-1 rounded-lg border border-[#98C1D9]/40 dark:border-[#3D4A5E] text-xs font-mono text-[#293241] dark:text-[#E0FBFC]">
              <Clock className="w-3.5 h-3.5 text-[#3D5A80] dark:text-[#98C1D9]" />
              <span>{istTime} IST</span>
            </div>

            {/* Firestore Status indicator */}
            <div
              className={`flex items-center space-x-1 px-2 py-0.5 rounded-md text-[11px] font-mono border ${
                firestoreStatus === 'connected'
                  ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/20'
                  : firestoreStatus === 'checking'
                  ? 'bg-[#E0FBFC] text-[#3D5A80] dark:text-[#98C1D9] border-[#98C1D9]/40'
                  : 'bg-rose-500/10 text-rose-700 dark:text-rose-400 border-rose-500/20'
              }`}
              title={`Firestore status: ${firestoreStatus}`}
            >
              <span
                className={`w-1.5 h-1.5 rounded-full ${
                  firestoreStatus === 'connected'
                    ? 'bg-emerald-500 animate-pulse'
                    : firestoreStatus === 'checking'
                    ? 'bg-[#EE6C4D]'
                    : 'bg-rose-500'
                }`}
              />
              <span className="hidden lg:inline font-semibold">DB</span>
            </div>

            {/* Theme Toggle (Light / Dark) */}
            <button
              onClick={toggleTheme}
              className="p-1.5 rounded-lg text-[#5C6B7E] hover:text-[#293241] dark:text-[#98C1D9] dark:hover:text-[#E0FBFC] bg-white dark:bg-[#1F2633] border border-[#98C1D9]/40 dark:border-[#3D4A5E] hover:border-[#3D5A80] transition-all cursor-pointer"
              title={theme === 'dark' ? 'Switch to Light Theme' : 'Switch to Dark Theme'}
              aria-label="Toggle theme"
            >
              {theme === 'dark' ? (
                <Sun className="w-4 h-4 text-[#EE6C4D]" />
              ) : (
                <Moon className="w-4 h-4 text-[#3D5A80]" />
              )}
            </button>

            {/* Auth Action */}
            {user ? (
              <div className="flex items-center space-x-3">
                <div className="flex items-center space-x-2">
                  {user.photoURL ? (
                    <img
                      src={user.photoURL}
                      alt={user.displayName || 'User'}
                      className="w-8 h-8 rounded-full border border-[#98C1D9]/50 dark:border-[#3D4A5E] object-cover"
                    />
                  ) : (
                    <div className="w-8 h-8 rounded-full bg-[#3D5A80]/10 border border-[#3D5A80]/30 flex items-center justify-center text-xs font-bold text-[#3D5A80] dark:text-[#98C1D9]">
                      {user.email ? user.email.charAt(0).toUpperCase() : 'U'}
                    </div>
                  )}
                  <div className="hidden md:block text-left">
                    <p className="text-xs font-medium text-[#293241] dark:text-[#E0FBFC] truncate max-w-[130px]">
                      {user.displayName || user.email?.split('@')[0]}
                    </p>
                    <p className="text-[10px] text-[#3D5A80] dark:text-[#98C1D9] font-mono">
                      {user.isSandbox ? (
                        <span className="text-[#EE6C4D] font-medium">Sandbox Mode</span>
                      ) : (
                        'Verified'
                      )}
                    </p>
                  </div>
                </div>

                <button
                  onClick={() => logout()}
                  className="p-1.5 rounded-lg text-[#5C6B7E] hover:text-[#EE6C4D] dark:hover:text-[#EE6C4D] hover:bg-[#EE6C4D]/10 transition-colors cursor-pointer"
                  title="Sign Out"
                >
                  <LogOut className="w-4 h-4" />
                </button>
              </div>
            ) : (
              <button
                onClick={() => signInWithGoogle()}
                className="flex items-center space-x-2 bg-[#EE6C4D] hover:bg-[#D95333] text-white font-semibold text-xs px-3.5 py-1.5 rounded-lg transition-colors shadow-xs cursor-pointer"
              >
                <LogIn className="w-3.5 h-3.5" />
                <span>Sign In</span>
              </button>
            )}
          </div>
        </div>

        {/* Mobile Sub-Navigation */}
        {user && (
          <div className="flex md:hidden space-x-2 py-2 border-t border-[#98C1D9]/40 dark:border-[#3D4A5E] overflow-x-auto">
            <button
              onClick={() => setActiveTab('dashboard')}
              className={`px-3 py-1 text-xs rounded-lg font-medium cursor-pointer ${
                activeTab === 'dashboard'
                  ? 'bg-white dark:bg-[#283244] text-[#3D5A80] dark:text-[#E0FBFC]'
                  : 'text-[#5C6B7E] dark:text-[#98C1D9]'
              }`}
            >
              Dashboard
            </button>
            <button
              onClick={() => setActiveTab('settings')}
              className={`px-3 py-1 text-xs rounded-lg font-medium cursor-pointer ${
                activeTab === 'settings'
                  ? 'bg-white dark:bg-[#283244] text-[#3D5A80] dark:text-[#E0FBFC]'
                  : 'text-[#5C6B7E] dark:text-[#98C1D9]'
              }`}
            >
              Risk Config
            </button>
            <button
              onClick={() => setActiveTab('health')}
              className={`px-3 py-1 text-xs rounded-lg font-medium cursor-pointer ${
                activeTab === 'health'
                  ? 'bg-white dark:bg-[#283244] text-[#3D5A80] dark:text-[#E0FBFC]'
                  : 'text-[#5C6B7E] dark:text-[#98C1D9]'
              }`}
            >
              System & Security
            </button>
          </div>
        )}
      </div>
    </header>
  );
};
