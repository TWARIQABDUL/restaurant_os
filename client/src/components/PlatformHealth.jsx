import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { RefreshCw, AlertTriangle, CheckCircle2 } from 'lucide-react';
import api from '../services/api';
import { formatMoney } from '../config/money';

/**
 * Where money is stuck, across every store.
 *
 * Deliberately not a general analytics page — it shows only the states that
 * mean something needs a human: a refund nobody has reviewed, a payout that
 * failed, an order past its hold window that settlement has not released.
 * A quiet board here should mean nothing is wrong.
 */
export default function PlatformHealth({ settlementCurrency = 'EUR' }) {
  const [health, setHealth] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => { load(); }, []);

  async function load() {
    setLoading(true);
    try {
      const { data } = await api.get('/platform/health');
      setHealth(data.health);
    } catch {
      toast.error('Could not load platform health');
    } finally {
      setLoading(false);
    }
  }

  if (loading || !health) {
    return <div className="h-64 animate-pulse rounded-xl border border-[#e2e8f0] bg-white" />;
  }

  const money = (v) => formatMoney(v, settlementCurrency);

  const signals = [
    {
      key: 'pendingRefunds',
      label: 'Refunds awaiting review',
      count: health.pendingRefunds.count,
      // A pending refund also blocks that order's funds from settling, so it is
      // holding up the seller as well as the customer.
      note: 'Blocks the order’s funds from settling until reviewed',
      rows: health.pendingRefunds.items.map((r) => ({
        id: r.id,
        title: r.order?.tracking_code || r.order_id,
        sub: r.order?.tenant?.name || '—',
        amount: r.order?.total_amount,
        when: r.created_at,
      })),
    },
    {
      key: 'stuckEscrow',
      label: 'Orders past their hold window',
      count: health.stuckEscrow.count,
      note: `Paid over ${health.holdMinutes} min ago and still not released — settlement may be wedged`,
      rows: health.stuckEscrow.items.map((o) => ({
        id: o.id,
        title: o.tracking_code,
        sub: o.tenant?.name || '—',
        amount: o.total_amount,
        when: o.paid_at,
      })),
    },
    {
      key: 'failedWithdrawals',
      label: 'Failed payouts',
      count: health.failedWithdrawals.count,
      note: 'Funds were returned to the seller’s balance, but nobody was told',
      rows: health.failedWithdrawals.items.map((w) => ({
        id: w.id,
        title: w.phone_number,
        sub: w.failure_reason || 'No reason recorded',
        amount: w.amount,
        when: w.requested_at,
      })),
    },
    {
      key: 'failedMomo',
      label: 'Failed MoMo transactions',
      count: health.failedMomo.count,
      note: 'Collections or payouts MTN rejected',
      rows: health.failedMomo.items.map((t) => ({
        id: t.id,
        title: `${t.type} · ${t.purpose}`,
        sub: t.failure_reason || 'No reason recorded',
        amount: t.amount,
        when: t.created_at,
      })),
    },
    {
      key: 'pendingWithdrawals',
      label: 'Payouts in flight',
      count: health.pendingWithdrawals.count,
      note: 'Reserved from the seller’s balance, awaiting MTN',
      rows: health.pendingWithdrawals.items.map((w) => ({
        id: w.id,
        title: w.id.slice(0, 8),
        sub: '—',
        amount: w.amount,
        when: w.requested_at,
      })),
    },
  ];

  const attention = signals.filter((s) => s.count > 0);

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-[15px] font-semibold">Platform health</h3>
          <p className="mt-0.5 text-xs text-[#94a3b8]">
            {attention.length === 0
              ? 'Nothing needs attention.'
              : `${attention.length} area${attention.length === 1 ? '' : 's'} need attention.`}
          </p>
        </div>
        <button className="btn btn-secondary btn-sm" onClick={load}>
          <RefreshCw size={14} /> Refresh
        </button>
      </div>

      {health.stalePendingTransactions > 0 && (
        <div className="flex items-start gap-2 rounded-xl border border-[#fecaca] bg-[#fef2f2] px-4 py-3 text-sm text-[#991b1b]">
          <AlertTriangle size={16} className="mt-0.5 flex-none" />
          <span>
            <strong>{health.stalePendingTransactions}</strong> MoMo transaction
            {health.stalePendingTransactions === 1 ? ' has' : 's have'} been pending for over 10 minutes.
            The reconciliation sweep normally resolves these within a tick — a backlog means the settlement
            scheduler is not running, or MTN is not answering.
          </span>
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        {signals.map((s) => (
          <div
            key={s.key}
            className={`rounded-xl border p-4 ${
              s.count > 0 ? 'border-[#fed7aa] bg-[#fff7ed]' : 'border-[#e2e8f0] bg-white'
            }`}
          >
            <div className="text-[12.5px] font-medium text-[#475569]">{s.label}</div>
            <div className={`font-heading mt-2 text-[22px] font-bold leading-none ${s.count > 0 ? 'text-[#c2410c]' : 'text-[#0f172a]'}`}>
              {s.count}
            </div>
          </div>
        ))}
      </div>

      {attention.length === 0 ? (
        <div className="flex items-center gap-2 rounded-xl border border-[#bbf7d0] bg-[#f0fdf4] px-4 py-6 text-sm text-[#166534]">
          <CheckCircle2 size={18} />
          No stuck refunds, payouts or escrow. Settlement is keeping up.
        </div>
      ) : (
        attention.map((s) => (
          <div key={s.key} className="rounded-xl border border-[#e2e8f0] bg-white shadow-[0_1px_2px_rgba(15,23,42,0.04)]">
            <div className="border-b border-[#f1f5f9] px-5 py-4">
              <h4 className="text-sm font-semibold">{s.label} ({s.count})</h4>
              <p className="mt-0.5 text-xs text-[#94a3b8]">{s.note}</p>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full border-collapse">
                <tbody>
                  {s.rows.map((r) => (
                    <tr key={r.id} className="border-b border-[#f1f5f9] last:border-b-0">
                      <td className="px-5 py-2.5 text-sm font-medium text-[#0f172a]">{r.title}</td>
                      <td className="px-5 py-2.5 text-xs text-[#64748b]">{r.sub}</td>
                      <td className="px-5 py-2.5 text-right text-sm font-semibold tabular-nums">
                        {r.amount != null ? money(r.amount) : '—'}
                      </td>
                      <td className="px-5 py-2.5 text-right text-xs text-[#94a3b8]">
                        {r.when ? new Date(r.when).toLocaleString() : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {s.count > s.rows.length && (
              <div className="border-t border-[#f1f5f9] px-5 py-2.5 text-xs text-[#94a3b8]">
                Showing the {s.rows.length} oldest of {s.count}.
              </div>
            )}
          </div>
        ))
      )}
    </div>
  );
}
