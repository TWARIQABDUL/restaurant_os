import { useState, useEffect, useRef } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useCart } from '../context/CartContext';
import { getSocket } from '../services/socket';
import api from '../services/api';
import { Bell, ShoppingBag, UtensilsCrossed, CheckCircle, XCircle, Bike, PartyPopper } from 'lucide-react';

const getIcon = (iconName) => {
  switch (iconName) {
    case 'ShoppingBag': return <ShoppingBag size={20} style={{ color: 'var(--color-info)' }} />;
    case 'UtensilsCrossed': return <UtensilsCrossed size={20} style={{ color: 'var(--color-accent)' }} />;
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

  return (
    <nav className="navbar">
      <div className="navbar-inner">
        <Link to={basePath} className="navbar-brand">
          Restaurant<span>OS</span>
        </Link>

        <button
          className="navbar-toggle"
          onClick={() => setMenuOpen(!menuOpen)}
          aria-label="Toggle menu"
        >
          {menuOpen ? '✕' : '☰'}
        </button>

        <ul className={`navbar-links ${menuOpen ? 'open' : ''}`}>
          {currentSlug && (
            <>
              <li><Link to={basePath} className={isActive(basePath)} onClick={() => setMenuOpen(false)}>Menu</Link></li>

              <li>
                <Link to={getPath('/cart')} className={isActive(getPath('/cart'))} onClick={() => setMenuOpen(false)}>
                  Cart{itemCount > 0 && ` (${itemCount})`}
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
                  <Bell size={24} />
                  {unreadCount > 0 && (
                    <span style={{
                      position: 'absolute',
                      top: '-6px',
                      right: '-8px',
                      backgroundColor: '#ef4444',
                      color: 'white',
                      borderRadius: '9999px',
                      minWidth: '20px',
                      height: '20px',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      fontSize: '11px',
                      fontWeight: 'bold',
                      zIndex: 50,
                      border: '2px solid var(--color-surface)'
                    }}>
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
              <li><Link to="/register" className={`btn btn-primary btn-sm`} onClick={() => setMenuOpen(false)}>Sign up</Link></li>
            </>
          )}
        </ul>
      </div>
    </nav>
  );
}