import { Routes, Route } from 'react-router-dom';
import Navbar from './components/Navbar';
import ProtectedRoute from './components/ProtectedRoute';
import TenantThemeInjector from './components/TenantThemeInjector';

// Pages
import LandingPage from './pages/LandingPage';
import Home from './pages/Home';
import MenuDetail from './pages/MenuDetail';
import Cart from './pages/Cart';
import Checkout from './pages/Checkout';
import OrderTracking from './pages/OrderTracking';
import TrackOrder from './pages/TrackOrder';
import Login from './pages/Login';
import Register from './pages/Register';

// Dashboards
import ManagerDashboard from './pages/ManagerDashboard';
import AdminDashboard from './pages/AdminDashboard';
import DeliveryDashboard from './pages/DeliveryDashboard';
import SuperAdminDashboard from './pages/SuperAdminDashboard';

function App() {
  return (
    <>
      <TenantThemeInjector />
      <Navbar />
      <div className="container">
        <Routes>
          {/* Global SaaS Routes */}
          <Route path="/" element={<LandingPage />} />
          <Route path="/login" element={<Login />} />
          <Route path="/register" element={<Register />} />

          {/* Tenant Storefront Routes */}
          <Route path="/:tenantSlug" element={<Home />} />
          <Route path="/:tenantSlug/menu/:id" element={<MenuDetail />} />
          <Route path="/:tenantSlug/cart" element={<Cart />} />
          <Route path="/:tenantSlug/checkout" element={<Checkout />} />
          <Route path="/:tenantSlug/track" element={<TrackOrder />} />

          {/* Customer Protected Routes */}
          <Route 
            path="/:tenantSlug/orders" 
            element={
              <ProtectedRoute>
                <OrderTracking />
              </ProtectedRoute>
            } 
          />

          {/* Staff Dashboards */}
          <Route 
            path="/manager" 
            element={
              <ProtectedRoute roles={['manager', 'admin']}>
                <ManagerDashboard />
              </ProtectedRoute>
            } 
          />
          <Route 
            path="/admin" 
            element={
              <ProtectedRoute roles={['admin']}>
                <AdminDashboard />
              </ProtectedRoute>
            } 
          />
          <Route 
            path="/delivery" 
            element={
              <ProtectedRoute roles={['delivery']}>
                <DeliveryDashboard />
              </ProtectedRoute>
            } 
          />
          <Route 
            path="/super-admin" 
            element={
              <ProtectedRoute roles={['super_admin']}>
                <SuperAdminDashboard />
              </ProtectedRoute>
            } 
          />
        </Routes>
      </div>
    </>
  );
}

export default App;
