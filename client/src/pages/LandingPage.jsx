import { Link } from 'react-router-dom';
import {
  Package, ClipboardList, Bike, BarChart3,
  ArrowRight, Crown, Target, Boxes, Wallet,
} from 'lucide-react';
import Logo from '../components/Logo';
import { BRAND } from '../config/brand';

const steps = [
  { number: 1, title: 'Add your products', description: 'Name, price, photo, options and stock. Takes minutes, not days.' },
  { number: 2, title: 'Share your store link', description: 'You get your own ordering page — no app download, no marketplace cut.' },
  { number: 3, title: 'Get paid and ship it', description: 'Money lands in your wallet, stock updates itself, and the customer tracks delivery live.' },
];

const features = [
  { icon: Package, title: 'Your product catalogue', description: "Add products, prices, photos and options — customers browse and buy from a page that's all yours." },
  { icon: Wallet, title: 'Payments that clear', description: 'Mobile Money, bank transfer or cash on delivery. Funds settle into a wallet you can withdraw from.' },
  { icon: Boxes, title: 'Stock that keeps itself', description: 'Every sale draws stock down automatically, and sold-out products stop taking orders.' },
  { icon: ClipboardList, title: 'Live order board', description: "Every order lands on one screen the second it's placed, ready to accept and pack." },
  { icon: Bike, title: 'Delivery dispatch', description: "Send orders out with your own drivers or an external rider, and know exactly who's carrying what." },
  { icon: BarChart3, title: 'Real-time analytics', description: "See what's selling, what's slow, and how the day is going without exporting a spreadsheet." },
];

const roles = [
  { icon: Crown, title: 'Owners & admins', description: 'Full control over products, pricing, stock, staff and payouts.' },
  { icon: Target, title: 'Managers', description: 'Accept orders, run the fulfilment queue, and dispatch drivers in real time.' },
  { icon: Bike, title: 'Delivery drivers', description: 'See assigned orders and delivery details on a screen built for the road.' },
];

function ProductMock() {
  const columns = [
    { label: 'New', border: 'border-[#fcd34d]', cards: [['#1048', '4 items · $74'], ['#1047', '4 items · $61']] },
    { label: 'Packing', border: 'border-[#e2e8f0]', cards: [['#1046', '4 items · $80'], ['#1045', '2 items · $30']] },
    { label: 'Ready', border: 'border-[#86efac]', cards: [['#1043', '2 items · $35']] },
  ];
  return (
    <div className="overflow-hidden rounded-2xl border border-[#e2e8f0] bg-white shadow-[0_20px_50px_rgba(15,23,42,0.12)]">
      <div className="flex items-center gap-1.5 border-b border-[#f1f5f9] px-3.5 py-3">
        <span className="h-2.5 w-2.5 rounded-full bg-[#e2e8f0]" />
        <span className="h-2.5 w-2.5 rounded-full bg-[#e2e8f0]" />
        <span className="h-2.5 w-2.5 rounded-full bg-[#e2e8f0]" />
        <span className="ml-2.5 text-[11px] text-[#94a3b8]">yourstore.vendly.app</span>
      </div>
      <div className="bg-[#f8fafc] p-4">
        <div className="mb-3 flex items-center justify-between">
          <span className="font-heading text-xs font-bold">Order board</span>
          <span className="rounded-full bg-[#dcfce7] px-2 py-0.5 text-[10px] font-semibold text-[#16a34a]">Live · 8</span>
        </div>
        <div className="grid grid-cols-3 gap-2.5">
          {columns.map(col => (
            <div key={col.label} className="flex flex-col gap-2">
              <span className="text-[9.5px] font-semibold uppercase text-[#94a3b8]">{col.label}</span>
              {col.cards.map(([id, meta]) => (
                <div key={id} className={`rounded-lg border bg-white p-2.5 ${col.border}`}>
                  <div className="text-[10px] font-bold">{id}</div>
                  <div className="mt-0.5 text-[9px] text-[#94a3b8]">{meta}</div>
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export default function LandingPage() {
  return (
    <div>
      {/* ── HERO ── */}
      <section className="bg-gradient-to-b from-white to-[#f8fafc]">
        <div className="mx-auto grid max-w-6xl items-center gap-12 px-6 py-16 lg:grid-cols-[minmax(0,1fr)_minmax(0,480px)] lg:py-20">
          <div>
            <span className="kicker">Built for independent sellers</span>
            <h1 className="font-heading text-4xl font-extrabold leading-[1.08] sm:text-5xl">
              Sell anything.<br />Get paid.<br />Track your stock.
            </h1>
            <p className="mt-5 max-w-[460px] text-base leading-relaxed text-[#475569]">
              {BRAND.description}
            </p>
            <div className="mt-7 flex flex-wrap gap-3">
              <Link to="/login" className="btn btn-primary btn-lg">
                Log in to dashboard <ArrowRight size={16} />
              </Link>
              <a href="#how-it-works" className="btn btn-secondary btn-lg">See how it works</a>
            </div>
            <p className="mt-4 text-xs text-[#94a3b8]">Live in under an hour · no marketplace cut</p>
          </div>
          <ProductMock />
        </div>
      </section>

      {/* ── STAT BAND ── */}
      <section className="bg-[#0f172a] text-white">
        <div className="mx-auto grid max-w-6xl grid-cols-2 gap-6 px-6 py-10 md:grid-cols-4">
          {[
            ['[300+]', 'Stores selling daily'],
            ['[1.2M]', 'Orders fulfilled'],
            ['0%', 'Commission taken'],
            ['< 1 hr', 'To go live'],
          ].map(([stat, label]) => (
            <div key={label}>
              <div className="font-heading text-[26px] font-bold">{stat}</div>
              <div className="mt-1 text-[12.5px] text-[#94a3b8]">{label}</div>
            </div>
          ))}
        </div>
      </section>

      {/* ── HOW IT WORKS ── */}
      <section id="how-it-works" className="mx-auto max-w-6xl px-6 py-20">
        <div className="section-header">
          <h2 className="text-[32px] font-bold">Live in three steps</h2>
          <p className="mt-3 text-[15px] text-[#475569]">From an empty catalogue to a paid, delivered order.</p>
        </div>
        <div className="grid gap-6 md:grid-cols-3">
          {steps.map(step => (
            <div key={step.number} className="rounded-2xl border border-[#e2e8f0] p-6">
              <span className="step-number">{String(step.number).padStart(2, '0')}</span>
              <h3 className="mt-2.5 text-[17px] font-semibold">{step.title}</h3>
              <p className="mt-2 text-[13.5px] leading-relaxed text-[#475569]">{step.description}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ── FEATURES ── */}
      <section id="features" className="mx-auto max-w-6xl px-6 pb-4">
        <h2 className="text-[32px] font-bold">Everything selling actually needs</h2>
        <div className="mt-10 grid gap-x-6 gap-y-7 md:grid-cols-3">
          {features.map(feature => {
            const Icon = feature.icon;
            return (
              <div key={feature.title}>
                <span className="feature-icon"><Icon size={20} /></span>
                <h3 className="mt-4 mb-1.5 text-base font-semibold">{feature.title}</h3>
                <p className="text-[13.5px] leading-relaxed text-[#475569]">{feature.description}</p>
              </div>
            );
          })}
        </div>
      </section>

      {/* ── ROLES ── */}
      <section className="mt-16 bg-[#f8fafc]">
        <div className="mx-auto max-w-6xl px-6 py-16">
          <h2 className="text-center text-[28px] font-bold">A screen for every role</h2>
          <div className="mt-9 grid gap-6 md:grid-cols-3">
            {roles.map(role => {
              const Icon = role.icon;
              return (
                <div key={role.title} className="rounded-2xl border border-[#e2e8f0] bg-white p-6">
                  <span className="text-[#dc2626]"><Icon size={22} /></span>
                  <h3 className="mt-3 text-base font-semibold">{role.title}</h3>
                  <p className="mt-2 text-[13.5px] leading-relaxed text-[#475569]">{role.description}</p>
                </div>
              );
            })}
          </div>
        </div>
      </section>

      {/* ── CTA ── */}
      <section className="mx-auto max-w-6xl px-6 py-20">
        <div className="rounded-[18px] bg-[#dc2626] px-8 py-14 text-center text-white">
          <h2 className="text-[30px] font-bold">Ready to sell?</h2>
          <p className="mx-auto mt-3 max-w-[480px] text-[15px] text-white/90">
            Add your products, share your link, and take your first paid order today.
          </p>
          <Link
            to="/login"
            className="mt-6 inline-flex items-center gap-2 rounded-[9px] bg-white px-6 py-3.5 text-sm font-semibold text-[#dc2626]"
          >
            Log in to dashboard <ArrowRight size={16} />
          </Link>
        </div>
      </section>

      {/* ── FOOTER ── */}
      <footer className="border-t border-[#f1f5f9]">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-4 px-6 py-7 text-sm text-[#475569] sm:flex-row">
          <Logo size={26} nameClassName="text-sm" className="text-[#0f172a]" />
          <span>© {new Date().getFullYear()} {BRAND.name}. All rights reserved.</span>
        </div>
      </footer>
    </div>
  );
}
