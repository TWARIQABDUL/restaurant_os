import { Link } from 'react-router-dom';

export default function LandingPage() {
  return (
    <div className="landing-page" style={{ minHeight: 'calc(100vh - 80px)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', textAlign: 'center', padding: '2rem' }}>
      <h1 style={{ fontSize: '3rem', marginBottom: '1rem', color: 'var(--color-primary)' }}>
        Restaurant OS
      </h1>
      <p style={{ fontSize: '1.25rem', color: 'var(--color-secondary)', maxWidth: '600px', marginBottom: '2rem' }}>
        The all-in-one platform to manage your restaurant's orders, deliveries, and menu with ease. Built for modern food businesses.
      </p>
      
      <div className="flex gap-4">
        <Link to="/login" className="btn btn-primary btn-lg px-8">
          Login to Dashboard
        </Link>
        <a href="#features" className="btn btn-secondary btn-lg px-8">
          Learn More
        </a>
      </div>

      <div id="features" className="grid grid-3 gap-6" style={{ marginTop: '5rem', maxWidth: '1000px' }}>
        <div className="card p-6 text-center">
          <h3 className="mb-2">Digital Menu</h3>
          <p className="text-secondary">Beautiful, responsive menus that your customers can browse and order from anywhere.</p>
        </div>
        <div className="card p-6 text-center">
          <h3 className="mb-2">Order Management</h3>
          <p className="text-secondary">Real-time order tracking, kitchen prep workflows, and automated customer notifications.</p>
        </div>
        <div className="card p-6 text-center">
          <h3 className="mb-2">Delivery Fleet</h3>
          <p className="text-secondary">Assign orders to internal drivers or external riders, and track everything seamlessly.</p>
        </div>
      </div>
    </div>
  );
}
