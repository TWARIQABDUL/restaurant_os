import { useState, useEffect, useRef } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useCart } from '../context/CartContext';
import { getSocket } from '../services/socket';
import api from '../services/api';
import { Bell, ShoppingBag, ShoppingCart, Package, CheckCircle, XCircle, Bike, PartyPopper, Menu, X } from 'lucide-react';
import { BRAND } from '../config/brand';

const getIcon = (iconName) => {
  switch (iconName) {
    case 'ShoppingBag': return <ShoppingBag size={20} style={{ color: 'var(--color-info)' }} />;
    case 'UtensilsCrossed': return <Package size={20} style={{ color: 'var(--color-accent)' }} />;
    case 'CheckCircle': return <CheckCircle size={20} style={{ color: 'var(--color-success)' }} />;
    case 'XCircle': return <XCircle size={20} style={{ color: 'var(--color-error)' }} />;
    case 'Bike': return <Bike size={20} style={{ color: 'var(--color-info)' }} />;
    case 'PartyPopper': return <PartyPopper size={20} style={{ color: '#eab308' }} />;
    default: return <Bell size={20} />;
  }
};

export default function Navbar() {
  const { user, logout } = useAuth();
  const { getItemCount } = useCart();
  const location = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);
  const [notifications, setNotifications] = useState([]);
  const [showNotifications, setShowNotifications] = useState(false);
  const notifRef = useRef(null);

  useEffect(() => {
    const handleClickOutside = (event) => {
      if (notifRef.current && !notifRef.current.contains(event.target)) {
        setShowNotifications(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  useEffect(() => {
    const socket = getSocket();
    if (!socket || !user) return;

    const fetchNotifications = async () => {
      try {
        const { data } = await api.get('/notifications');
        setNotifications(data.notifications || []);
      } catch (err) {
        console.error('Failed to fetch notifications', err);
      }
    };

    fetchNotifications();

    const handlers = {
      newOrder: fetchNotifications,
      orderReady: fetchNotifications,
      orderApproved: fetchNotifications,
      orderRejected: fetchNotifications,
      deliveryAssigned: fetchNotifications,
      newDelivery: fetchNotifications,
      orderDelivered: fetchNotifications,
    };

    Object.entries(handlers).forEach(([event, handler]) => {
      socket.on(event, handler);
    });

    return () => {
      Object.entries(handlers).forEach(([event, handler]) => {
        socket.off(event, handler);
      });
    };
  }, [user]);

  const unreadCount = notifications.filter(n => !n.is_read).length;

  const markAllAsRead = async () => {
    try {
      await api.patch('/notifications/read-all');
      setNotifications(prev => prev.map(n => ({ ...n, is_read: true })));
    } catch (err) {
      console.error('Failed to mark read', err);
    }
  };

  const isActive = (path) => location.pathname === path ? 'active' : '';
  const itemCount = getItemCount();

  function getDashboardLink() {
    if (!user) return null;
    switch (user.role) {
      case 'manager': return { path: '/manager', label: 'Dashboard' };
      case 'admin': return { path: '/admin', label: 'Dashboard' };
      case 'delivery': return { path: '/delivery', label: 'Deliveries' };
      case 'super_admin': return { path: '/super-admin', label: 'Platform' };
      default: return null;
    }
  }

  const dashLink = getDashboardLink();

  // Extract tenant slug from URL to determine if we are in a storefront
  const pathParts = location.pathname.split('/').filter(Boolean);
  const globalRoutes = ['login', 'register', 'manager', 'admin', 'delivery', 'super-admin'];
  
  let currentSlug = null;
  if (pathParts.length > 0 && !globalRoutes.includes(pathParts[0])) {
    currentSlug = pathParts[0];
  }

  // Helper to resolve paths relative to current storefront
  const getPath = (path) => currentSlug ? `/${currentSlug}${path}` : path;
  const basePath = currentSlug ? `/${currentSlug}` : '/';

  // Helper to format slug into a readable brand name
  const formatBrandName = (slug) => {
    // If they are visiting a specific storefront, format its slug
    if (slug) {
      return slug.split('-').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
    }
    // If they are on a global route (like /admin or /manager) but belong to a store, format their tenant slug
    if (user && user.tenants && user.tenants.slug) {
      return user.tenants.slug.split('-').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
    }
    // Otherwise fallback to the SaaS brand
    return BRAND.name;
  };

  return (
    <>
    <nav className="navbar">
      <div className="navbar-inner">
        <Link to={basePath} className="navbar-brand" style={{ color: 'var(--color-accent)' }}>
          {formatBrandName(currentSlug)}
        </Link>

        <button
          className="navbar-toggle"
          onClick={() => setMenuOpen(!menuOpen)}
          aria-label="Toggle menu"
          style={{ color: 'var(--color-text)' }}
        >
          {menuOpen ? <X size={22} /> : <Menu size={22} />}
        </button>

        <ul className={`navbar-links ${menuOpen ? 'open' : ''}`}>
          {currentSlug && (
            <>
              <li><Link to={basePath} className={isActive(basePath)} onClick={() => setMenuOpen(false)}>Shop</Link></li>

              <li>
                <Link to={getPath('/cart')} className={isActive(getPath('/cart'))} onClick={() => setMenuOpen(false)} style={{ position: 'relative', display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
                  <ShoppingCart size={16} />
                  Cart
                  {itemCount > 0 && (
                    <span className="ml-0.5 inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-[#dc2626] px-1 text-[10px] font-bold text-white">
                      {itemCount}
                    </span>
                  )}
                </Link>
              </li>

              <li><Link to={getPath('/track')} className={isActive(getPath('/track'))} onClick={() => setMenuOpen(false)}>Track Order</Link></li>

              {user && user.role === 'customer' && (
                <li><Link to={getPath('/orders')} className={isActive(getPath('/orders'))} onClick={() => setMenuOpen(false)}>My Orders</Link></li>
              )}
            </>
          )}

          {dashLink && (
            <li><Link to={dashLink.path} className={isActive(dashLink.path)} onClick={() => setMenuOpen(false)}>{dashLink.label}</Link></li>
          )}

          {user ? (
            <>
              <li className="notification-container" ref={notifRef}>
                <button 
                  className="notification-bell" 
                  onClick={() => setShowNotifications(!showNotifications)}
                  aria-label="Notifications"
                  style={{ position: 'relative', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}
                >
                  <Bell size={22} />
                  {unreadCount > 0 && (
                    <span className="absolute -right-2 -top-1.5 z-50 flex h-5 min-w-[20px] items-center justify-center rounded-full border-2 border-white bg-[#dc2626] px-1 text-[11px] font-bold text-white">
                      {unreadCount}
                    </span>
                  )}
                </button>
                
                {showNotifications && (
                  <div className="notification-dropdown">
                    <div className="notification-header">
                      <h4>Notifications ({notifications.length})</h4>
                      {unreadCount > 0 && <button onClick={markAllAsRead}>Mark all read</button>}
                    </div>
                    <div className="notification-list">
                      {notifications.length === 0 ? (
                        <div className="notification-empty">No new notifications</div>
                      ) : (
                        notifications.map(n => {
                          const ItemWrapper = n.action_url ? Link : 'div';
                          return (
                            <ItemWrapper 
                              to={n.action_url || '#'}
                              key={n.id} 
                              className={`notification-item ${n.is_read ? 'read' : 'unread'}`}
                              onClick={() => {
                                if (n.action_url) setShowNotifications(false);
                              }}
                              style={{ textDecoration: 'none', color: 'inherit', display: 'flex' }}
                            >
                              <span className="notification-icon">{getIcon(n.icon)}</span>
                              <div className="notification-content">
                                <p>{n.message}</p>
                                <small>{new Date(n.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</small>
                              </div>
                            </ItemWrapper>
                          );
                        })
                      )}
                    </div>
                  </div>
                )}
              </li>
              <li style={{ padding: '8px 12px', fontSize: '0.8125rem', color: 'var(--color-text-muted)' }}>
                {user.name}
              </li>
              <li>
                <button onClick={() => { logout(); setMenuOpen(false); }}>
                  Log out
                </button>
              </li>
            </>
          ) : (
            <>
              <li><Link to="/login" className={isActive('/login')} onClick={() => setMenuOpen(false)}>Log in</Link></li>
            </>
          )}
        </ul>
      </div>
    </nav>

    {/* Mobile backdrop overlay */}
    {menuOpen && (
      <div
        onClick={() => setMenuOpen(false)}
        className="fixed inset-x-0 bottom-0 top-[3.75rem] z-[99] bg-[#0f172a]/25"
      />
    )}
    </>
  );
}