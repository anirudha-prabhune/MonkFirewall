import React, { useState } from 'react';
import {
  Sliders,
  Save,
  CheckCircle,
  AlertCircle,
  RefreshCw,
  AlertTriangle,
  ShieldCheck,
  Clock,
  TrendingDown,
  Bell,
  Calculator,
} from 'lucide-react';
import { RiskConfig } from '../types/risk';
import { saveRiskConfig } from '../services/riskConfigService';
import { useAuth } from '../context/AuthContext';
import { formatINR } from '../utils/formatters';
import { validateRiskConfig } from '../../server/risk/validation';

interface RiskConfigEditorProps {
  initialConfig: RiskConfig;
  onSaved: (newConfig: RiskConfig) => void;
  isLocked?: boolean;
}

export const RiskConfigEditor: React.FC<RiskConfigEditorProps> = ({
  initialConfig,
  onSaved,
  isLocked = false,
}) => {
  const { user } = useAuth();
  const [formData, setFormData] = useState<RiskConfig>({ ...initialConfig });
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ text: string; type: 'success' | 'error' } | null>(null);
  const [validationErrors, setValidationErrors] = useState<string[]>([]);

  const handleChange = (field: keyof RiskConfig, value: any) => {
    setFormData((prev) => ({
      ...prev,
      [field]: value,
    }));
    setMessage(null);
    setValidationErrors([]);
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user) return;

    // Validate parameters
    const validation = validateRiskConfig(formData);
    if (!validation.valid) {
      setValidationErrors(validation.errors);
      setMessage({
        text: 'Please correct the validation errors below before saving.',
        type: 'error',
      });
      return;
    }

    setSaving(true);
    setValidationErrors([]);
    try {
      const saved = await saveRiskConfig(user.uid, formData);
      onSaved(saved);
      setMessage({
        text: 'Risk parameters saved and activated successfully.',
        type: 'success',
      });
    } catch (err) {
      setMessage({
        text: err instanceof Error ? err.message : 'Failed to update risk parameters',
        type: 'error',
      });
    } finally {
      setSaving(false);
    }
  };

  // Convert minutes to hours for the UI
  const lockHours = Math.max(1, Math.round((formData.lockDurationMinutes || 60) / 60));

  const handleHoursChange = (hours: number) => {
    const safeHours = Math.max(1, Math.round(hours));
    handleChange('lockDurationMinutes', safeHours * 60);
  };

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      {/* Information Header */}
      <div className="bg-white dark:bg-[#1F2633] border border-[#98C1D9]/40 dark:border-[#3D4A5E] rounded-2xl p-5 text-xs text-[#293241] dark:text-[#E0FBFC] shadow-xs transition-colors duration-200">
        <div className="flex items-start space-x-3.5">
          <div className="p-2.5 rounded-xl bg-slate-100 dark:bg-[#283244] text-[#3D5A80] dark:text-[#98C1D9] border border-[#98C1D9]/40 dark:border-[#3D4A5E] shrink-0 mt-0.5">
            <ShieldCheck className="w-5 h-5" />
          </div>
          <div>
            <h3 className="font-bold text-[#293241] dark:text-[#E0FBFC] text-sm">
              Trading Firewall Configuration
            </h3>
            <p className="text-[#5C6B7E] dark:text-[#98C1D9] mt-1 leading-relaxed">
              Define your daily maximum loss thresholds and automated lockout rules. The Trading Firewall evaluates your positions in real time and enforces these limits to protect trading capital.
            </p>
          </div>
        </div>
      </div>

      {isLocked && (
        <div className="p-4 rounded-xl bg-amber-50 dark:bg-amber-950/20 border border-amber-200 dark:border-amber-900/40 text-amber-900 dark:text-amber-300 text-xs flex items-start space-x-2.5 shadow-xs">
          <AlertTriangle className="w-5 h-5 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
          <div>
            <span className="font-bold text-amber-900 dark:text-amber-200">Circuit Breaker Locked:</span>
            <p className="text-amber-800 dark:text-amber-300 mt-0.5">
              Trading Firewall is currently LOCKED. Daily Loss Limit and Lockout Schedule cannot be modified during an active lock to preserve risk protection integrity.
            </p>
          </div>
        </div>
      )}

      <div className="bg-white dark:bg-[#1F2633] border border-[#98C1D9]/40 dark:border-[#3D4A5E] rounded-2xl p-6 sm:p-8 shadow-xs transition-colors duration-200">
        <div className="flex items-center justify-between pb-5 border-b border-[#98C1D9]/30 dark:border-[#3D4A5E]">
          <div className="flex items-center space-x-3">
            <div className="p-2.5 rounded-xl bg-slate-100 dark:bg-[#283244] text-[#3D5A80] dark:text-[#98C1D9] border border-[#98C1D9]/40 dark:border-[#3D4A5E]">
              <Sliders className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-base font-bold text-slate-900 dark:text-[#E0FBFC]">Risk Parameters</h2>
              <p className="text-xs text-[#5C6B7E] dark:text-[#98C1D9]">
                Configured rules enforced across derivative positions
              </p>
            </div>
          </div>
        </div>

        {message && (
          <div
            className={`mt-4 p-3.5 rounded-xl text-xs flex items-center space-x-2 font-medium ${
              message.type === 'success'
                ? 'bg-emerald-50 dark:bg-emerald-950/20 border border-emerald-200 dark:border-emerald-800/40 text-emerald-800 dark:text-emerald-300'
                : 'bg-rose-50 dark:bg-rose-950/20 border border-rose-200 dark:border-rose-800/40 text-rose-800 dark:text-rose-300'
            }`}
          >
            {message.type === 'success' ? (
              <CheckCircle className="w-4 h-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
            ) : (
              <AlertCircle className="w-4 h-4 shrink-0 text-rose-600 dark:text-rose-400" />
            )}
            <span>{message.text}</span>
          </div>
        )}

        {validationErrors.length > 0 && (
          <div className="mt-4 p-4 rounded-xl bg-rose-50 dark:bg-rose-950/20 border border-rose-200 dark:border-rose-800/40 text-rose-900 dark:text-rose-300 text-xs space-y-1">
            <p className="font-bold text-rose-900 dark:text-rose-200">Validation Notice:</p>
            <ul className="list-disc list-inside space-y-0.5">
              {validationErrors.map((err, i) => (
                <li key={i}>{err}</li>
              ))}
            </ul>
          </div>
        )}

        <form onSubmit={handleSave} className="mt-6 space-y-8">
          {/* SECTION 1: LOSS PROTECTION */}
          <div className="space-y-4">
            <div className="flex items-center space-x-2 border-b border-slate-100 dark:border-[#3D4A5E] pb-2">
              <TrendingDown className="w-4 h-4 text-[#EE6C4D] dark:text-[#98C1D9]" />
              <h3 className="text-xs font-bold uppercase tracking-wider text-slate-900 dark:text-[#E0FBFC]">
                1. Loss Protection
              </h3>
            </div>

            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label className="text-xs font-semibold text-slate-800 dark:text-[#E0FBFC]">
                  Daily Loss Limit
                </label>
                <span className="text-sm font-mono text-[#EE6C4D] dark:text-[#98C1D9] font-bold">
                  {formatINR(formData.dailyLossLimit || 0)}
                </span>
              </div>
              <input
                type="number"
                min="500"
                step="500"
                value={formData.dailyLossLimit}
                onChange={(e) => handleChange('dailyLossLimit', Number(e.target.value))}
                disabled={isLocked}
                className="w-full bg-[#F3F8FA] dark:bg-[#283244] border border-[#98C1D9]/50 dark:border-[#3D4A5E] rounded-xl px-4 py-2.5 text-sm text-[#293241] dark:text-[#E0FBFC] font-mono focus:outline-hidden focus:border-[#3D5A80] dark:focus:border-[#98C1D9] transition-all disabled:opacity-60 disabled:cursor-not-allowed"
                required
              />
              {isLocked ? (
                <p className="text-[11px] text-amber-700 dark:text-amber-400 font-semibold mt-1.5">
                  Locked while Trading Firewall circuit breaker is active.
                </p>
              ) : (
                <p className="text-[11px] text-[#5C6B7E] dark:text-[#98C1D9] mt-1.5">
                  Minimum ₹500 in increments of ₹500. When cumulative daily loss reaches this limit, trading is automatically locked.
                </p>
              )}
            </div>

            {/* Master Toggle */}
            <div className="flex items-center justify-between p-4 rounded-xl bg-slate-50 dark:bg-[#19202B]/60 border border-[#98C1D9]/40 dark:border-[#3D4A5E]">
              <div>
                <span className="text-xs font-semibold text-slate-900 dark:text-[#E0FBFC] block">
                  Firewall Protection Active
                </span>
                <span className="text-[11px] text-[#5C6B7E] dark:text-[#98C1D9]">
                  Master switch for automated trading risk monitoring and circuit breaker lockout
                </span>
              </div>
              <input
                type="checkbox"
                checked={formData.enabled}
                onChange={(e) => handleChange('enabled', e.target.checked)}
                className="w-4 h-4 accent-[#3D5A80] rounded cursor-pointer"
              />
            </div>
          </div>

          {/* SECTION 2: LOCK BEHAVIOR */}
          <div className="space-y-4">
            <div className="flex items-center space-x-2 border-b border-slate-100 dark:border-[#3D4A5E] pb-2">
              <Clock className="w-4 h-4 text-[#3D5A80] dark:text-[#98C1D9]" />
              <h3 className="text-xs font-bold uppercase tracking-wider text-slate-900 dark:text-[#E0FBFC]">
                2. Lock Behavior
              </h3>
            </div>

            <div>
              <label className="text-xs font-semibold text-slate-800 dark:text-[#E0FBFC] block mb-2">
                Lockout Schedule
              </label>

              {/* Mode Selector */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <button
                  type="button"
                  disabled={isLocked}
                  onClick={() => {
                    if (isLocked) return;
                    handleChange('lockDurationType', 'FIXED');
                    if (!formData.lockDurationMinutes || formData.lockDurationMinutes < 60) {
                      handleChange('lockDurationMinutes', 60);
                    }
                  }}
                  className={`p-3.5 rounded-xl border text-left cursor-pointer transition-all disabled:opacity-60 disabled:cursor-not-allowed ${
                    (formData.lockDurationType ?? 'FIXED') === 'FIXED'
                      ? 'bg-white dark:bg-[#283244] border-[#3D5A80] dark:border-[#98C1D9] shadow-xs'
                      : 'bg-slate-50/80 dark:bg-[#19202B] border-[#98C1D9]/40 dark:border-[#3D4A5E] opacity-75 hover:opacity-100'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-bold text-slate-900 dark:text-[#E0FBFC]">Fixed Duration</span>
                    <span
                      className={`w-3.5 h-3.5 rounded-full border-2 flex items-center justify-center ${
                        (formData.lockDurationType ?? 'FIXED') === 'FIXED'
                          ? 'border-[#3D5A80] dark:border-[#98C1D9]'
                          : 'border-slate-400'
                      }`}
                    >
                      {(formData.lockDurationType ?? 'FIXED') === 'FIXED' && (
                        <span className="w-1.5 h-1.5 rounded-full bg-[#3D5A80] dark:bg-[#98C1D9]" />
                      )}
                    </span>
                  </div>
                  <p className="text-[11px] text-[#5C6B7E] dark:text-[#98C1D9] mt-1">
                    Lockout runs for a fixed number of hours after breach.
                  </p>
                </button>

                <button
                  type="button"
                  disabled={isLocked}
                  onClick={() => {
                    if (isLocked) return;
                    handleChange('lockDurationType', 'UNTIL_4PM');
                  }}
                  className={`p-3.5 rounded-xl border text-left cursor-pointer transition-all disabled:opacity-60 disabled:cursor-not-allowed ${
                    formData.lockDurationType === 'UNTIL_4PM'
                      ? 'bg-white dark:bg-[#283244] border-[#3D5A80] dark:border-[#98C1D9] shadow-xs'
                      : 'bg-slate-50/80 dark:bg-[#19202B] border-[#98C1D9]/40 dark:border-[#3D4A5E] opacity-75 hover:opacity-100'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-bold text-slate-900 dark:text-[#E0FBFC]">Until 4:00 PM</span>
                    <span
                      className={`w-3.5 h-3.5 rounded-full border-2 flex items-center justify-center ${
                        formData.lockDurationType === 'UNTIL_4PM'
                          ? 'border-[#3D5A80] dark:border-[#98C1D9]'
                          : 'border-slate-400'
                      }`}
                    >
                      {formData.lockDurationType === 'UNTIL_4PM' && (
                        <span className="w-1.5 h-1.5 rounded-full bg-[#3D5A80] dark:bg-[#98C1D9]" />
                      )}
                    </span>
                  </div>
                  <p className="text-[11px] text-[#5C6B7E] dark:text-[#98C1D9] mt-1">
                    Lockout remains in effect until 4:00 PM IST on the trading day.
                  </p>
                </button>
              </div>

              {/* Mode-specific input or confirmation */}
              {(formData.lockDurationType ?? 'FIXED') === 'FIXED' ? (
                <div className="mt-3">
                  <div className="flex items-center justify-between mb-1.5">
                    <label className="text-xs text-slate-700 dark:text-slate-300">
                      Lock Duration (Hours)
                    </label>
                    <span className="text-xs font-mono font-semibold text-[#3D5A80] dark:text-[#98C1D9]">
                      {lockHours} {lockHours === 1 ? 'Hour' : 'Hours'} ({formData.lockDurationMinutes || 60}m)
                    </span>
                  </div>
                  <input
                    type="number"
                    min="1"
                    max="48"
                    step="1"
                    value={lockHours}
                    onChange={(e) => handleHoursChange(Number(e.target.value))}
                    disabled={isLocked}
                    className="w-full bg-[#F3F8FA] dark:bg-[#283244] border border-[#98C1D9]/50 dark:border-[#3D4A5E] rounded-xl px-4 py-2.5 text-sm text-[#293241] dark:text-[#E0FBFC] font-mono focus:outline-hidden focus:border-[#3D5A80] dark:focus:border-[#98C1D9] transition-all disabled:opacity-60 disabled:cursor-not-allowed"
                    required
                  />
                  {isLocked ? (
                    <p className="text-[11px] text-amber-700 dark:text-amber-400 font-semibold mt-1.5">
                      Lockout schedule cannot be modified during an active lock.
                    </p>
                  ) : (
                    <p className="text-[11px] text-[#5C6B7E] dark:text-[#98C1D9] mt-1.5">
                      Minimum 1 hour, in increments of 1 hour.
                    </p>
                  )}
                </div>
              ) : (
                <div className="mt-3 p-3.5 rounded-xl bg-amber-500/10 border border-amber-500/30 text-amber-900 dark:text-amber-200 text-xs flex items-center space-x-2.5">
                  <Clock className="w-4 h-4 text-amber-600 dark:text-amber-400 shrink-0" />
                  <span>
                    Trading lockout will strictly hold until <strong>4:00 PM IST (Asia/Kolkata)</strong> on the current trading date.
                  </span>
                </div>
              )}
            </div>
          </div>

          {/* SECTION 3: WARNING LEVELS */}
          <div className="space-y-4">
            <div className="flex items-center space-x-2 border-b border-slate-100 dark:border-[#3D4A5E] pb-2">
              <Bell className="w-4 h-4 text-amber-500 dark:text-amber-400" />
              <h3 className="text-xs font-bold uppercase tracking-wider text-slate-900 dark:text-[#E0FBFC]">
                3. Warning Levels
              </h3>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label className="text-xs font-semibold text-slate-800 dark:text-[#E0FBFC]">
                    Warning Level 1 (%)
                  </label>
                  <span className="text-xs font-mono text-[#EE6C4D] dark:text-[#98C1D9] font-bold">
                    {formData.warningThreshold1}% ({formatINR(((formData.dailyLossLimit || 0) * (formData.warningThreshold1 || 0)) / 100)})
                  </span>
                </div>
                <input
                  type="number"
                  min="1"
                  max="99"
                  step="1"
                  value={formData.warningThreshold1}
                  onChange={(e) => handleChange('warningThreshold1', Number(e.target.value))}
                  className="w-full bg-[#F3F8FA] dark:bg-[#283244] border border-[#98C1D9]/50 dark:border-[#3D4A5E] rounded-xl px-4 py-2.5 text-sm text-[#293241] dark:text-[#E0FBFC] font-mono focus:outline-hidden focus:border-[#3D5A80] dark:focus:border-[#98C1D9] transition-all"
                  required
                />
                <p className="text-[11px] text-[#5C6B7E] dark:text-[#98C1D9] mt-1.5">
                  Initial alert threshold. Status transitions to Warning state.
                </p>
              </div>

              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label className="text-xs font-semibold text-slate-800 dark:text-[#E0FBFC]">
                    Warning Level 2 (%)
                  </label>
                  <span className="text-xs font-mono text-[#EE6C4D] dark:text-[#98C1D9] font-bold">
                    {formData.warningThreshold2}% ({formatINR(((formData.dailyLossLimit || 0) * (formData.warningThreshold2 || 0)) / 100)})
                  </span>
                </div>
                <input
                  type="number"
                  min="2"
                  max="100"
                  step="1"
                  value={formData.warningThreshold2}
                  onChange={(e) => handleChange('warningThreshold2', Number(e.target.value))}
                  className="w-full bg-[#F3F8FA] dark:bg-[#283244] border border-[#98C1D9]/50 dark:border-[#3D4A5E] rounded-xl px-4 py-2.5 text-sm text-[#293241] dark:text-[#E0FBFC] font-mono focus:outline-hidden focus:border-[#3D5A80] dark:focus:border-[#98C1D9] transition-all"
                  required
                />
                <p className="text-[11px] text-[#5C6B7E] dark:text-[#98C1D9] mt-1.5">
                  Critical warning threshold approaching maximum allowable loss.
                </p>
              </div>
            </div>
          </div>

          {/* SECTION 4: P&L CALCULATION */}
          <div className="space-y-4">
            <div className="flex items-center space-x-2 border-b border-slate-100 dark:border-[#3D4A5E] pb-2">
              <Calculator className="w-4 h-4 text-[#3D5A80] dark:text-[#98C1D9]" />
              <h3 className="text-xs font-bold uppercase tracking-wider text-slate-900 dark:text-[#E0FBFC]">
                4. P&L Calculation
              </h3>
            </div>

            <div className="bg-slate-50/80 dark:bg-[#19202B]/60 p-5 rounded-xl border border-[#98C1D9]/40 dark:border-[#3D4A5E] space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <span className="text-xs font-medium text-slate-900 dark:text-[#E0FBFC] block">
                    Include Realised P&L
                  </span>
                  <span className="text-[11px] text-[#5C6B7E] dark:text-[#98C1D9]">
                    Include closed trade profits and losses in the daily loss evaluation
                  </span>
                </div>
                <input
                  type="checkbox"
                  checked={formData.includeRealisedPnl}
                  onChange={(e) => handleChange('includeRealisedPnl', e.target.checked)}
                  className="w-4 h-4 accent-[#3D5A80] rounded cursor-pointer"
                />
              </div>

              <div className="flex items-center justify-between pt-3 border-t border-slate-200/60 dark:border-[#3D4A5E]">
                <div>
                  <span className="text-xs font-medium text-slate-900 dark:text-[#E0FBFC] block">
                    Include Unrealised P&L (MTM)
                  </span>
                  <span className="text-[11px] text-[#5C6B7E] dark:text-[#98C1D9]">
                    Include open position mark-to-market valuations in the daily loss evaluation
                  </span>
                </div>
                <input
                  type="checkbox"
                  checked={formData.includeUnrealisedPnl}
                  onChange={(e) => handleChange('includeUnrealisedPnl', e.target.checked)}
                  className="w-4 h-4 accent-[#3D5A80] rounded cursor-pointer"
                />
              </div>
            </div>
          </div>

          {/* Action Buttons */}
          <div className="flex justify-end space-x-3 pt-4 border-t border-slate-100 dark:border-[#3D4A5E]">
            <button
              type="submit"
              disabled={saving}
              className="flex items-center space-x-2 bg-[#3D5A80] hover:bg-[#2B3E58] dark:bg-[#98C1D9] dark:hover:bg-[#E0FBFC] text-white dark:text-[#293241] font-semibold px-6 py-2.5 rounded-xl transition-all shadow-xs disabled:opacity-50 cursor-pointer text-xs tracking-wide"
            >
              {saving ? (
                <>
                  <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                  <span>Saving Configuration...</span>
                </>
              ) : (
                <>
                  <Save className="w-3.5 h-3.5" />
                  <span>Save Risk Configuration</span>
                </>
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
