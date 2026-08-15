import { Link } from 'react-router-dom';
import { UtensilsCrossed, ClipboardList, Bike, MapPin, Users, BarChart3, ArrowRight, Sparkles, Zap, Shield } from 'lucide-react';

const steps = [
  {
    number: 1,
    emoji: '📋',
    title: 'Set up your menu',
    description: 'Add your dishes, categories, prices, and add-ons. Takes minutes, not days.',
  },
  {
    number: 2,
    emoji: '📱',
    title: 'Customers order online',
    description: "Each restaurant gets its own ordering page — no app download, no marketplace cut.",
  },
  {
    number: 3,
    emoji: '🚀',
    title: 'Track it to the door',
    description: 'Your kitchen approves and preps, a driver gets dispatched, and the customer watches it happen live.',
  },
];

const features = [
  {
    icon: UtensilsCrossed,
    title: 'Digital Menu',
    description: "Add dishes, prices, photos, and add-ons — customers browse and order from a page that's all yours.",
  },
  {
    icon: ClipboardList,
    title: 'Live Order Board',
    description: "Every order lands on one screen the second it's placed, ready to approve and prep.",
  },
  {
    icon: Bike,
    title: 'Delivery Dispatch',
    description: "Send orders out with your own drivers or an external rider, and know exactly who's carrying what.",
  },
  {
    icon: MapPin,
    title: 'Order Tracking',
    description: 'Customers watch their order move from kitchen to doorstep without calling to ask.',
  },
  {
    icon: Users,
    title: 'Built-in Team Roles',
    description: 'Owners, managers, kitchen staff, and drivers each get exactly the screen they need — nothing more.',
  },
  {
    icon: BarChart3,
    title: 'Real-Time Analytics',
    description: "See what's selling, what's slow, and how the day is going without exporting a spreadsheet.",
  },
];

const roles = [
  {
    emoji: '👑',
    title: 'Owners & Admins',
    description: 'Full control over menus, pricing, staff, and performance for your restaurant.',
  },
  {
    emoji: '🎯',
    title: 'Managers',
    description: 'Approve orders, run the kitchen queue, and dispatch drivers in real time.',
  },
  {
    emoji: '🛵',
    title: 'Delivery Drivers',
    description: 'See assigned orders and delivery details on a screen built for the road.',
  },
];

function FloatingCards() {
  return (
    <div style={{ position: 'relative', width: '100%', maxWidth: '440px', height: '380px' }}>
      {/* Main card — menu preview */}
      <div style={{
        position: 'absolute', top: 0, left: 0, right: '20px',
        background: 'var(--color-surface)', borderRadius: 'var(--radius-xl)',
        boxShadow: 'var(--shadow-xl)', padding: 'var(--space-5)',
        border: '1px solid var(--color-border)',
        animation: 'floatSlow 6s ease-in-out infinite'
      }}>
        <div style={{ display: 'flex', gap: 'var(--space-2)', marginBottom: 'var(--space-4)' }}>
          <span style={{ background: 'var(--gradient-accent)', color: 'white', padding: '4px 14px', borderRadius: '999px', fontSize: '12px', fontWeight: 600 }}>All</span>
          <span style={{ border: '1px solid var(--color-border)', padding: '4px 14px', borderRadius: '999px', fontSize: '12px', fontWeight: 500, color: 'var(--color-text-secondary)' }}>Mains</span>
          <span style={{ border: '1px solid var(--color-border)', padding: '4px 14px', borderRadius: '999px', fontSize: '12px', fontWeight: 500, color: 'var(--color-text-secondary)' }}>Drinks</span>
        </div>

        {[{ name: 'Grilled Salmon', price: '$18', color: '#fef3e2' }, { name: 'Margherita Pizza', price: '$14', color: '#e8f5ee' }].map((item, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)', padding: 'var(--space-3) 0', borderTop: i > 0 ? '1px solid var(--color-border-subtle)' : 'none' }}>
            <div style={{ width: '48px', height: '48px', borderRadius: 'var(--radius-md)', background: item.color, flexShrink: 0 }} />
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 600, fontSize: '14px' }}>{item.name}</div>
              <div style={{ width: '60%', height: '4px', borderRadius: '2px', background: 'var(--color-border-subtle)', marginTop: '6px' }} />
            </div>
            <span style={{ fontWeight: 700, color: 'var(--color-accent)', fontSize: '15px' }}>{item.price}</span>
          </div>
        ))}
      </div>

      {/* Floating notification card */}
      <div style={{
        position: 'absolute', bottom: '40px', right: 0,
        background: 'var(--color-surface)', borderRadius: 'var(--radius-lg)',
        boxShadow: 'var(--shadow-lg)', padding: 'var(--space-4) var(--space-5)',
        border: '1px solid var(--color-border)',
        display: 'flex', alignItems: 'center', gap: 'var(--space-3)',
        animation: 'floatFast 4s ease-in-out infinite 1s'
      }}>
        <div style={{
          width: '36px', height: '36px', borderRadius: '50%',
          background: 'var(--color-success-light)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '16px'
        }}>✓</div>
        <div>
          <div style={{ fontWeight: 600, fontSize: '13px' }}>Order Ready</div>
          <div style={{ fontSize: '11px', color: 'var(--color-text-muted)' }}>#RX48120</div>
        </div>
      </div>

      {/* Stats pill */}
      <div style={{
        position: 'absolute', bottom: 0, left: '20px',
        background: 'var(--gradient-dark)', color: 'white',
        borderRadius: '999px', padding: '8px 18px',
        display: 'flex', alignItems: 'center', gap: '8px',
        fontSize: '13px', fontWeight: 600,
        boxShadow: 'var(--shadow-lg)',
        animation: 'floatFast 5s ease-in-out infinite 0.5s'
      }}>
        <Zap size={14} /> 120 orders today
      </div>
    </div>
  );
}

function LandingPage() {
  return (
    <div className="page">
      {/* ── HERO ── */}
      <section className="hero-section" style={{ position: 'relative' }}>
        <div>
          <span className="kicker" style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
            <Sparkles size={14} /> Online Ordering &amp; Delivery
          </span>
          <h1 style={{
            fontSize: 'clamp(1.75rem, 4vw, var(--font-size-3xl))',
            lineHeight: 1.1, marginBottom: 'var(--space-5)',
            letterSpacing: '-0.02em'
          }}>
            Take orders.<br />
            Run the kitchen.<br />
            <span className="text-gradient">Get it delivered.</span>
          </h1>
          <p style={{
            fontSize: 'var(--font-size-lg)', color: 'var(--color-text-secondary)',
            marginBottom: 'var(--space-8)', maxWidth: '480px', lineHeight: 1.6
          }}>
            Restaurant OS gives every restaurant a digital menu, a live order board for the kitchen, and delivery dispatch — without stitching together five different tools.
          </p>
          <div className="flex gap-4" style={{ flexWrap: 'wrap' }}>
            <Link to="/register" className="btn btn-primary btn-lg btn-pill">
              Get Started Free <ArrowRight size={18} />
            </Link>
            <a href="#how-it-works" className="btn btn-secondary btn-lg btn-pill">
              See How It Works
            </a>
          </div>
        </div>
        <FloatingCards />
      </section>

      {/* ── TRUSTED BY (social proof strip) ── */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        gap: 'var(--space-8)', padding: 'var(--space-6) 0',
        borderTop: '1px solid var(--color-border)', borderBottom: '1px solid var(--color-border)',
        marginBottom: 'var(--space-16)', flexWrap: 'wrap'
      }}>
        {[
          { icon: <Shield size={18} />, text: 'Bank-level security' },
          { icon: <Zap size={18} />, text: 'Real-time updates' },
          { icon: <Sparkles size={18} />, text: 'No setup fees' },
        ].map((item, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', color: 'var(--color-text-secondary)', fontSize: 'var(--font-size-sm)', fontWeight: 500 }}>
            <span style={{ color: 'var(--color-accent)' }}>{item.icon}</span>
            {item.text}
          </div>
        ))}
      </div>

      {/* ── HOW IT WORKS ── */}
      <section id="how-it-works" style={{ padding: 'var(--space-16) 0' }}>
        <div className="section-header">
          <h2 style={{ fontSize: 'var(--font-size-2xl)', marginBottom: 'var(--space-3)' }}>How it works</h2>
          <p style={{ color: 'var(--color-text-secondary)' }}>From an empty menu to a delivered order, in three steps.</p>
        </div>
        <div className="grid grid-3">
          {steps.map((step) => (
            <div key={step.number} style={{
              textAlign: 'center', padding: 'var(--space-8) var(--space-5)'
            }}>
              <div style={{
                width: '56px', height: '56px', borderRadius: '50%',
                background: 'var(--color-accent-light)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                margin: '0 auto var(--space-4)', fontSize: '24px'
              }}>{step.emoji}</div>
              <div style={{
                fontSize: 'var(--font-size-xs)', fontWeight: 700,
                color: 'var(--color-accent)', textTransform: 'uppercase',
                letterSpacing: '0.08em', marginBottom: 'var(--space-2)'
              }}>Step {step.number}</div>
              <h3 style={{ fontSize: 'var(--font-size-lg)', marginBottom: 'var(--space-2)' }}>{step.title}</h3>
              <p style={{ color: 'var(--color-text-secondary)', lineHeight: 1.6 }}>{step.description}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ── FEATURES ── */}
      <section id="features" style={{ padding: 'var(--space-16) 0' }}>
        <div className="section-header">
          <h2 style={{ fontSize: 'var(--font-size-2xl)', marginBottom: 'var(--space-3)' }}>Everything the day-to-day needs</h2>
          <p style={{ color: 'var(--color-text-secondary)' }}>Built around how a restaurant actually runs, not a generic storefront template.</p>
        </div>
        <div className="grid grid-3">
          {features.map((feature) => {
            const Icon = feature.icon;
            return (
              <div key={feature.title} className="card" style={{ transition: 'all var(--transition-base)' }}>
                <div className="feature-icon" style={{
                  transition: 'transform var(--transition-spring), box-shadow var(--transition-base)'
                }}>
                  <Icon size={22} />
                </div>
                <h3 style={{ fontSize: 'var(--font-size-lg)', marginBottom: 'var(--space-2)' }}>{feature.title}</h3>
                <p style={{ color: 'var(--color-text-secondary)', lineHeight: 1.6 }}>{feature.description}</p>
              </div>
            );
          })}
        </div>
      </section>

      {/* ── ROLES ── */}
      <section style={{ padding: 'var(--space-16) 0' }}>
        <div className="section-header">
          <h2 style={{ fontSize: 'var(--font-size-2xl)', marginBottom: 'var(--space-3)' }}>One platform, every role</h2>
          <p style={{ color: 'var(--color-text-secondary)' }}>Each person on your team gets exactly the screen their job needs.</p>
        </div>
        <div className="grid grid-3">
          {roles.map((role) => (
            <div key={role.title} className="card" style={{
              borderLeft: '3px solid var(--color-accent)',
              display: 'flex', flexDirection: 'column', gap: 'var(--space-2)'
            }}>
              <span style={{ fontSize: '28px' }}>{role.emoji}</span>
              <h3 style={{ fontSize: 'var(--font-size-lg)' }}>{role.title}</h3>
              <p style={{ color: 'var(--color-text-secondary)', lineHeight: 1.6 }}>{role.description}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ── CTA BAND ── */}
      <section style={{
        background: 'var(--gradient-dark)',
        borderRadius: 'var(--radius-2xl)',
        padding: 'var(--space-16) var(--space-8)',
        textAlign: 'center',
        margin: 'var(--space-16) 0',
        position: 'relative', overflow: 'hidden'
      }}>
        <div style={{
          position: 'absolute', inset: 0,
          background: 'radial-gradient(circle at 50% 120%, rgba(232,137,12,0.2) 0%, transparent 60%)',
          pointerEvents: 'none'
        }} />
        <div style={{ position: 'relative' }}>
          <h2 style={{ fontSize: 'var(--font-size-2xl)', marginBottom: 'var(--space-3)', color: 'white' }}>Ready to bring your restaurant online?</h2>
          <p style={{ marginBottom: 'var(--space-6)', color: 'rgba(255,255,255,0.6)', maxWidth: '480px', margin: '0 auto var(--space-6)' }}>
            Set up your menu and give your kitchen one screen to run the whole shift.
          </p>
          <Link to="/register" className="btn btn-lg btn-pill" style={{
            background: 'var(--gradient-accent)', color: 'white', border: 'none'
          }}>
            Get Started Free <ArrowRight size={18} />
          </Link>
        </div>
      </section>

      {/* ── FOOTER ── */}
      <footer className="site-footer">
        <div className="footer-brand">
          <UtensilsCrossed size={20} />
          Restaurant OS
        </div>
        <span>&copy; {new Date().getFullYear()} Restaurant OS. All rights reserved.</span>
      </footer>

      <style>{`
        @keyframes floatSlow {
          0%, 100% { transform: translateY(0); }
          50% { transform: translateY(-10px); }
        }
        @keyframes floatFast {
          0%, 100% { transform: translateY(0); }
          50% { transform: translateY(-6px); }
        }
        .feature-icon:hover {
          transform: scale(1.1) !important;
          box-shadow: 0 4px 16px rgba(232, 137, 12, 0.2) !important;
        }
      `}</style>
    </div>
  );
}

export default LandingPage;