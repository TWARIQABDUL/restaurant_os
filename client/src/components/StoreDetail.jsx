import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { X, KeyRound, ExternalLink } from 'lucide-react';
import api from '../services/api';
import { formatMoney } from '../config/money';

/**
 * One store, in detail — everything a super admin needs to answer "how is this
 * store doing, and is anything stuck?" without signing in as them.
 */
export default function StoreDetail({ tenantId, onClose, onChanged }) {
  const [overview, setOverview] = useState(null);
  const [loading, setLoading] = useState(true);
  const [resetting, setResetting] = useState(null);

  useEffect(() => {
    if (!tenantId) return;
    let cancelled = false;
    setLoading(true);
    api.get(`/tenants/${tenantId}/overview`)
      .then(({ data }) => { if (!cancelled) setOverview(data.overview); })
      .catch(() => { if (!cancelled) toast.error('Could not load this store'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [tenantId]);

  // Close on Escape, matching the rest of the dashboard's modals.
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  async function resetPassword(member) {
    const password = window.prompt(
      `New password for ${member.name} (${member.email}).\n\n`
      + 'They are not emailed — you will need to pass this on yourself.\n'
      + 'Minimum 8 characters.'
    );
    if (!password) return;
    if (password.length < 8) {
      toast.error('Password must be at least 8 characters');
      return;
    }
    setResetting(member.id);
    try {
      await api.post(`/tenants/${tenantId}/staff/${member.id}/reset-password`, { password });
      toast.success(`Password reset for ${member.name}. Pass it on securely.`, { duration: 6000 });
      onChanged?.();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Could not reset password');
    } finally {
      setResetting(null);
    }
  }

  if (!tenantId) return null;

  const t = overview?.tenant;
  const money = (v) => formatMoney(v, overview?.wallet?.currency || t?.currency || 'EUR');

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-[rgba(15,23,42,0.4)]" onClick={onClose}>
      <div
        className="h-full w-full max-w-2xl overflow-y-auto bg-[#f8fafc] shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sticky top-0 z-10 flex items-start justify-between gap-4 border-b border-[#e2e8f0] bg-white px-6 py-4">
          <div className="min-w-0">
            <h2 className="truncate text-lg font-bold">{loading ? 'Loading…' : t?.name}</h2>
            {t && (
              <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-[#94a3b8]">
                <span>/{t.slug}</span>
                <span className={`badge ${t.active ? 'badge-ready' : 'badge-rejected'}`}>
                  {t.active ? 'Active' : 'Suspended'}
                </span>
                <a
                  href={`${window.location.origin}/${t.slug}`}
                  target="_blank" rel="noreferrer"
                  className="inline-flex items-center gap-1 text-[#2563eb] hover:underline"
                >
                  <ExternalLink size={11} /> storefront
                </a>
              </div>
            )}
          </div>
          <button onClick={onClose} className="rounded-md p-1 text-[#64748b] hover:bg-[#f1f5f9]" title="Close">
            <X size={18} />
          </button>
        </div>

        {loading || !overview ? (
          <div className="p-6">
            <div className="h-64 animate-pulse rounded-xl border border-[#e2e8f0] bg-white" />
          </div>
        ) : (
          <div className="flex flex-col gap-5 p-6">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {[
                ['Orders', overview.orders.total, `${overview.orders.paid} paid`],
                ['Revenue', money(overview.orders.revenue), 'paid, excl. rejected'],
                ['Available', money(overview.wallet.available_balance), 'ready to withdraw'],
                ['Held', money(overview.wallet.pending_balance), 'still in escrow'],
              ].map(([label, value, sub]) => (
                <div key={label} className="rounded-xl border border-[#e2e8f0] bg-white p-4">
                  <div className="text-[12.5px] font-medium text-[#475569]">{label}</div>
                  <div className="font-heading mt-2 text-[19px] font-bold leading-none">{value}</div>
                  <div className="mt-2 text-[11px] text-[#94a3b8]">{sub}</div>
                </div>
              ))}
            </div>

            {overview.pendingRefunds > 0 && (
              <div className="rounded-xl border border-[#fed7aa] bg-[#fff7ed] px-4 py-3 text-sm text-[#c2410c]">
                {overview.pendingRefunds} refund{overview.pendingRefunds === 1 ? '' : 's'} awaiting this
                store’s review. Those orders cannot settle until they are handled.
              </div>
            )}

            <div className="rounded-xl border border-[#e2e8f0] bg-white p-5">
              <h3 className="mb-4 text-[15px] font-semibold">Configuration</h3>
              <dl className="grid grid-cols-2 gap-4">
                {[
                  ['Currency', t.currency],
                  ['Settlement', t.settlementMode === 'auto' ? 'Automatic' : 'Manual'],
                  ['Payout number', t.payoutPhone || 'Not set'],
                  ['Products', overview.productCount],
                  ['Payment methods', t.acceptedPaymentMethods.map((m) => m.replace(/_/g, ' ')).join(', ')],
                  ['Last order', overview.orders.lastOrderAt ? new Date(overview.orders.lastOrderAt).toLocaleString() : 'Never'],
                ].map(([label, value]) => (
                  <div key={label}>
                    <dt className="text-[11px] uppercase tracking-wide text-[#94a3b8]">{label}</dt>
                    <dd className="mt-1 text-sm font-medium text-[#0f172a]">{value}</dd>
                  </div>
                ))}
              </dl>
              {t.storedCurrency && t.storedCurrency !== t.currency && (
                <p className="mt-4 rounded-md border border-[#fde68a] bg-[#fffbeb] px-3 py-2 text-xs text-[#92400e]">
                  This store has <strong>{t.storedCurrency}</strong> saved, which the platform no longer
                  allows. Prices fall back to {t.currency}. Add {t.storedCurrency} back, or have the store
                  choose a supported currency.
                </p>
              )}
            </div>

            <div className="rounded-xl border border-[#e2e8f0] bg-white">
              <div className="border-b border-[#f1f5f9] px-5 py-4">
                <h3 className="text-[15px] font-semibold">Staff ({overview.staff.length})</h3>
                <p className="mt-0.5 text-xs text-[#94a3b8]">
                  Resetting a password does not email anyone — you will be shown it once to pass on.
                </p>
              </div>
              {overview.staff.length === 0 ? (
                <p className="px-5 py-6 text-sm text-[#94a3b8]">No staff accounts yet.</p>
              ) : (
                <table className="w-full border-collapse">
                  <tbody>
                    {overview.staff.map((m) => (
                      <tr key={m.id} className="border-b border-[#f1f5f9] last:border-b-0">
                        <td className="px-5 py-3">
                          <div className="text-sm font-medium text-[#0f172a]">{m.name}</div>
                          <div className="text-xs text-[#94a3b8]">{m.email}</div>
                        </td>
                        <td className="px-5 py-3">
                          <span className="badge badge-preparing">{m.role}</span>
                        </td>
                        <td className="px-5 py-3 text-right">
                          <button
                            className="btn btn-secondary btn-sm"
                            onClick={() => resetPassword(m)}
                            disabled={resetting === m.id}
                          >
                            <KeyRound size={13} />
                            {resetting === m.id ? '…' : 'Reset password'}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            <div className="rounded-xl border border-[#e2e8f0] bg-white p-5">
              <h3 className="mb-3 text-[15px] font-semibold">Orders by status</h3>
              <div className="flex flex-wrap gap-2">
                {Object.entries(overview.orders.byStatus).length === 0 && (
                  <span className="text-sm text-[#94a3b8]">No orders yet.</span>
                )}
                {Object.entries(overview.orders.byStatus).map(([status, n]) => (
                  <span key={status} className="inline-flex items-center gap-1.5 rounded-md border border-[#e2e8f0] bg-[#f8fafc] px-2.5 py-1 text-xs">
                    <span className="font-medium text-[#0f172a]">{status}</span>
                    <span className="tabular-nums text-[#64748b]">{n}</span>
                  </span>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
