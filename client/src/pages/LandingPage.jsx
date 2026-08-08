import { Link } from 'react-router-dom';
import { UtensilsCrossed, ClipboardList, Bike, MapPin, Users, BarChart3, ArrowRight } from 'lucide-react';

const steps = [
  {
    number: 1,
    title: 'Set up your menu',
    description: 'Add your dishes, categories, prices, and add-ons. Takes minutes, not days.',
  },
  {
    number: 2,
    title: 'Customers order online',
    description: "Each restaurant gets its own ordering page — no app download, no marketplace cut.",
  },
  {
    number: 3,
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
    title: 'Owners & Admins',
    description: 'Full control over menus, pricing, staff, and performance for your restaurant.',
  },
  {
    title: 'Managers',
    description: 'Approve orders, run the kitchen queue, and dispatch drivers in real time.',
  },
  {
    title: 'Delivery Drivers',
    description: 'See assigned orders and delivery details on a screen built for the road.',
  },
];

function HeroIllustration() {
  return (
    <svg viewBox="0 0 460 420" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Preview of a restaurant menu with an order-ready ticket">
      <defs>
        <filter id="ticketShadow" x="-30%" y="-30%" width="160%" height="160%">
          <feDropShadow dx="0" dy="4" stdDeviation="6" floodColor="#1a1a2e" floodOpacity="0.15" />
        </filter>
      </defs>

      {/* search bar + avatar */}
      <rect x="32" y="28" width="280" height="32" rx="16" fill="var(--color-bg-alt)" />
      <circle cx="396" cy="44" r="20" fill="var(--color-accent)" />

      {/* category pills */}
      <rect x="32" y="80" width="64" height="28" rx="14" fill="var(--color-accent)" />
      <text x="64" y="99" textAnchor="middle" fill="#ffffff" fontSize="12" fontWeight="600" fontFamily="Inter, sans-serif">All</text>

      <rect x="104" y="80" width="76" height="28" rx="14" fill="none" stroke="var(--color-border)" />
      <text x="142" y="99" textAnchor="middle" fill="var(--color-text-secondary)" fontSize="12" fontWeight="600" fontFamily="Inter, sans-serif">Mains</text>

      <rect x="188" y="80" width="76" height="28" rx="14" fill="none" stroke="var(--color-border)" />
      <text x="226" y="99" textAnchor="middle" fill="var(--color-text-secondary)" fontSize="12" fontWeight="600" fontFamily="Inter, sans-serif">Drinks</text>

      {/* menu row 1 */}
      <rect x="32" y="136" width="64" height="64" rx="12" fill="var(--color-bg-alt)" />
      <text x="112" y="158" fill="var(--color-text)" fontSize="15" fontWeight="600" fontFamily="Inter, sans-serif">Grilled Salmon</text>
      <rect x="112" y="170" width="140" height="6" rx="3" fill="var(--color-border-subtle)" />
      <text x="416" y="174" textAnchor="end" fill="var(--color-accent)" fontSize="16" fontWeight="700" fontFamily="Inter, sans-serif">$18</text>

      {/* menu row 2 */}
      <rect x="32" y="216" width="64" height="64" rx="12" fill="var(--color-bg-alt)" />
      <text x="112" y="238" fill="var(--color-text)" fontSize="15" fontWeight="600" fontFamily="Inter, sans-serif">Margherita Pizza</text>
      <rect x="112" y="250" width="150" height="6" rx="3" fill="var(--color-border-subtle)" />
      <text x="416" y="254" textAnchor="end" fill="var(--color-accent)" fontSize="16" fontWeight="700" fontFamily="Inter, sans-serif">$14</text>

      {/* floating order-ready ticket */}
      <g filter="url(#ticketShadow)">
        <rect x="228" y="310" width="200" height="88" rx="16" fill="var(--color-surface)" stroke="var(--color-border)" strokeWidth="1.5" />
      </g>
      <circle cx="264" cy="354" r="18" fill="var(--color-success-light)" />
      <path d="M256 354 L262 360 L273 346" stroke="var(--color-success)" strokeWidth="2.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
      <text x="296" y="349" fill="var(--color-text)" fontSize="14" fontWeight="600" fontFamily="Inter, sans-serif">Order Ready</text>
      <text x="296" y="369" fill="var(--color-text-muted)" fontSize="11" fontFamily="Inter, sans-serif">#RX48120</text>
    </svg>
  );
}

function LandingPage() {
  return (
    <div className="page">
      <section className="hero-section">
        <div>
          <span className="kicker">Online Ordering &amp; Delivery</span>
          <h1 style={{ fontSize: 'var(--font-size-3xl)', lineHeight: 1.15, marginBottom: 'var(--space-5)', color: 'var(--color-text)' }}>
            Take orders. Run the kitchen. Get it delivered.
          </h1>
          <p style={{ fontSize: 'var(--font-size-lg)', color: 'var(--color-text-secondary)', marginBottom: 'var(--space-8)', maxWidth: '480px' }}>
            Restaurant OS gives every restaurant a digital menu, a live order board for the kitchen, and delivery dispatch — without stitching together five different tools.
          </p>
          <div className="flex gap-4">
            <Link to="/register" className="btn btn-primary btn-lg">
              Get Started <ArrowRight size={18} />
            </Link>
            <a href="#how-it-works" className="btn btn-secondary btn-lg">
              See How It Works
            </a>
          </div>
        </div>
        <div className="hero-visual">
          <HeroIllustration />
        </div>
      </section>

      <section id="how-it-works" style={{ padding: 'var(--space-16) 0' }}>
        <div className="section-header">
          <h2 style={{ fontSize: 'var(--font-size-2xl)', marginBottom: 'var(--space-3)', color: 'var(--color-text)' }}>How it works</h2>
          <p style={{ color: 'var(--color-text-secondary)' }}>From an empty menu to a delivered order, in three steps.</p>
        </div>
        <div className="grid grid-3">
          {steps.map((step) => (
            <div key={step.number} className="step-card">
              <div className="step-number">{step.number}</div>
              <h3 style={{ fontSize: 'var(--font-size-lg)', marginBottom: 'var(--space-2)', color: 'var(--color-text)' }}>{step.title}</h3>
              <p style={{ color: 'var(--color-text-secondary)' }}>{step.description}</p>
            </div>
          ))}
        </div>
      </section>

      <section id="features" style={{ padding: 'var(--space-16) 0' }}>
        <div className="section-header">
          <h2 style={{ fontSize: 'var(--font-size-2xl)', marginBottom: 'var(--space-3)', color: 'var(--color-text)' }}>Everything the day-to-day needs</h2>
          <p style={{ color: 'var(--color-text-secondary)' }}>Built around how a restaurant actually runs, not a generic storefront template.</p>
        </div>
        <div className="grid grid-3">
          {features.map((feature) => {
            const Icon = feature.icon;
            return (
              <div key={feature.title} className="card">
                <div className="feature-icon">
                  <Icon size={22} />
                </div>
                <h3 style={{ fontSize: 'var(--font-size-lg)', marginBottom: 'var(--space-2)', color: 'var(--color-text)' }}>{feature.title}</h3>
                <p style={{ color: 'var(--color-text-secondary)' }}>{feature.description}</p>
              </div>
            );
          })}
        </div>
      </section>

      <section style={{ padding: 'var(--space-16) 0' }}>
        <div className="section-header">
          <h2 style={{ fontSize: 'var(--font-size-2xl)', marginBottom: 'var(--space-3)', color: 'var(--color-text)' }}>One platform, every role</h2>
          <p style={{ color: 'var(--color-text-secondary)' }}>Each person on your team gets exactly the screen their job needs.</p>
        </div>
        <div className="grid grid-3">
          {roles.map((role) => (
            <div key={role.title} className="card role-card">
              <h3 style={{ fontSize: 'var(--font-size-lg)', marginBottom: 'var(--space-2)', color: 'var(--color-text)' }}>{role.title}</h3>
              <p style={{ color: 'var(--color-text-secondary)' }}>{role.description}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="cta-band">
        <h2 style={{ fontSize: 'var(--font-size-2xl)', marginBottom: 'var(--space-3)' }}>Ready to bring your restaurant online?</h2>
        <p style={{ marginBottom: 'var(--space-6)' }}>Set up your menu and give your kitchen one screen to run the whole shift.</p>
        <Link to="/register" className="btn btn-primary btn-lg">
          Get Started <ArrowRight size={18} />
        </Link>
      </section>

      <footer className="site-footer">
        <div className="footer-brand">
          <UtensilsCrossed size={20} />
          Restaurant OS
        </div>
        <span>&copy; {new Date().getFullYear()} Restaurant OS. All rights reserved.</span>
      </footer>
    </div>
  );
}

export default LandingPage;