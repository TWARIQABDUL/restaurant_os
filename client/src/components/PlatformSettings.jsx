import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { Plus, X, Info, Save } from 'lucide-react';
import api from '../services/api';
import { formatMoney } from '../config/money';

const CODE = /^[A-Za-z]{3}$/;

/**
 * Platform-wide settings, super admin only.
 *
 * The currency list here is the source of truth for what every store can price
 * in: a seller picks from this list and cannot type anything else, and the same
 * list is re-checked when an order is placed and when a payout is requested.
 */
export default function PlatformSettings() {
  const [settings, setSettings] = useState(null);
  const [payments, setPayments] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [newCode, setNewCode] = useState('');

  useEffect(() => { load(); }, []);

  async function load() {
    setLoading(true);
    try {
      const { data } = await api.get('/platform/settings');
      setSettings(data.settings);
      setPayments(data.payments);
    } catch {
      toast.error('Could not load platform settings');
    } finally {
      setLoading(false);
    }
  }

  function addCurrency() {
    const code = newCode.trim().toUpperCase();
    if (!CODE.test(code)) {
      toast.error('Use a 3-letter currency code, e.g. KES');
      return;
    }
    if (settings.allowedCurrencies.includes(code)) {
      toast.error(`${code} is already allowed`);
      return;
    }
    setSettings((s) => ({ ...s, allowedCurrencies: [...s.allowedCurrencies, code].sort() }));
    setNewCode('');
  }

  function removeCurrency(code) {
    if (code === payments.settlementCurrency) {
      toast.error(`${code} is the settlement currency and cannot be removed`);
      return;
    }
    setSettings((s) => ({ ...s, allowedCurrencies: s.allowedCurrencies.filter((c) => c !== code) }));
  }

  async function save() {
    setSaving(true);
    try {
      const { data } = await api.patch('/platform/settings', {
        allowedCurrencies: settings.allowedCurrencies,
        defaultSettlementMode: settings.defaultSettlementMode,
        defaultHoldMinutes: settings.defaultHoldMinutes,
      });
      setSettings(data.settings);
      toast.success('Platform settings saved');
    } catch (err) {
      const res = err.response?.data;
      if (res?.code === 'CURRENCY_IN_USE') {
        // Naming the stores beats a generic failure: the super admin has to go
        // change those stores before this save can succeed.
        toast.error(
          `${res.error} ${res.stores.map((s) => `${s.name} (${s.currency})`).join(', ')}`,
          { duration: 8000 }
        );
      } else {
        toast.error(res?.error || 'Could not save settings');
      }
      load();
    } finally {
      setSaving(false);
    }
  }

  if (loading || !settings) {
    return <div className="h-64 animate-pulse rounded-xl border border-[#e2e8f0] bg-white" />;
  }

  return (
    <div className="flex flex-col gap-5">
      {/* How the platform collects money — facts, not settings */}
      <div className="rounded-xl border border-[#e2e8f0] bg-white p-5 shadow-[0_1px_2px_rgba(15,23,42,0.04)]">
        <h3 className="mb-1 text-[15px] font-semibold">Payment account</h3>
        <p className="mb-4 text-xs text-[#94a3b8]">
          How this platform actually collects and pays out. Set by the server environment, not here —
          changing a value on this page would not change what MTN does with your account.
        </p>
        <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          {[
            ['Settlement currency', payments.settlementCurrency],
            ['MoMo environment', payments.momoEnvironment],
            ['Collections', payments.collectionConfigured ? 'Configured' : 'Not configured'],
            ['Disbursements', payments.disbursementConfigured ? 'Configured' : 'Not configured'],
          ].map(([label, value]) => (
            <div key={label}>
              <dt className="text-[11px] uppercase tracking-wide text-[#94a3b8]">{label}</dt>
              <dd className="mt-1 text-sm font-semibold text-[#0f172a]">{value}</dd>
            </div>
          ))}
        </dl>
        {payments.momoEnvironment === 'sandbox' && (
          <p className="mt-4 rounded-md border border-[#fde68a] bg-[#fffbeb] px-3 py-2 text-xs text-[#92400e]">
            This platform is pointed at the MoMo <strong>sandbox</strong>, which settles only in EUR and
            confirms payments without moving real money. Stores can take orders, but nothing is collected.
          </p>
        )}
      </div>

      {/* Allowed currencies */}
      <div className="rounded-xl border border-[#e2e8f0] bg-white p-5 shadow-[0_1px_2px_rgba(15,23,42,0.04)]">
        <h3 className="mb-1 text-[15px] font-semibold">Allowed currencies</h3>
        <p className="mb-4 text-xs text-[#94a3b8]">
          Stores choose from this list and cannot enter anything else. It is re-checked when an order is
          placed and when a payout is requested, so removing a currency here stops it being used everywhere —
          not just on the settings form.
        </p>

        <div className="mb-4 flex flex-wrap gap-2">
          {settings.allowedCurrencies.map((code) => {
            const isSettlement = code === payments.settlementCurrency;
            return (
              <span
                key={code}
                className={`inline-flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-sm font-medium ${
                  isSettlement
                    ? 'border-[#bbf7d0] bg-[#f0fdf4] text-[#166534]'
                    : 'border-[#e2e8f0] bg-[#f8fafc] text-[#0f172a]'
                }`}
              >
                {code}
                <span className="text-[11px] font-normal text-[#64748b]">{formatMoney(1500, code)}</span>
                {isSettlement ? (
                  <span className="text-[10px] uppercase tracking-wide text-[#16a34a]">settles</span>
                ) : (
                  <button
                    onClick={() => removeCurrency(code)}
                    className="text-[#94a3b8] transition-colors hover:text-[#dc2626]"
                    title={`Remove ${code}`}
                  >
                    <X size={13} />
                  </button>
                )}
              </span>
            );
          })}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <input
            className="form-input w-32"
            placeholder="e.g. KES"
            maxLength={3}
            value={newCode}
            onChange={(e) => setNewCode(e.target.value.toUpperCase())}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addCurrency(); } }}
          />
          <button className="btn btn-secondary btn-sm" onClick={addCurrency} type="button">
            <Plus size={14} /> Add currency
          </button>
        </div>

        <p className="mt-4 flex items-start gap-2 rounded-md border border-[#e2e8f0] bg-[#f8fafc] px-3 py-2 text-xs text-[#475569]">
          <Info size={14} className="mt-px flex-none text-[#94a3b8]" />
          <span>
            Only <strong>{payments.settlementCurrency}</strong> can take mobile money, because that is what
            your MoMo account settles in. A store priced in any other currency can still accept cash on
            delivery and bank transfer — mobile money is hidden from its checkout automatically.
          </span>
        </p>
      </div>

      {/* Defaults for new stores */}
      <div className="rounded-xl border border-[#e2e8f0] bg-white p-5 shadow-[0_1px_2px_rgba(15,23,42,0.04)]">
        <h3 className="mb-4 text-[15px] font-semibold">Defaults for new stores</h3>
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className="form-label">Settlement mode</label>
            <select
              className="form-input"
              value={settings.defaultSettlementMode}
              onChange={(e) => setSettings((s) => ({ ...s, defaultSettlementMode: e.target.value }))}
            >
              <option value="manual">Manual — the seller clicks withdraw</option>
              <option value="auto">Automatic — pay out as soon as funds clear</option>
            </select>
          </div>
          <div>
            <label className="form-label">Escrow hold window (minutes)</label>
            <input
              type="number"
              min="0"
              max="43200"
              className="form-input"
              value={settings.defaultHoldMinutes}
              onChange={(e) => setSettings((s) => ({ ...s, defaultHoldMinutes: e.target.value }))}
            />
            <p className="mt-1 text-xs text-[#94a3b8]">
              How long a paid order is held before the seller can withdraw it. Longer gives more room to
              catch a refund before the money leaves.
            </p>
          </div>
        </div>
      </div>

      <div className="flex justify-end">
        <button className="btn btn-primary" onClick={save} disabled={saving}>
          <Save size={15} /> {saving ? 'Saving…' : 'Save platform settings'}
        </button>
      </div>
    </div>
  );
}
