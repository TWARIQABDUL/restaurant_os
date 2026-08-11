import { createContext, useContext, useState, useCallback, useEffect } from 'react';
import { useLocation } from 'react-router-dom';

const CartContext = createContext(null);

export function CartProvider({ children }) {
  const location = useLocation();
  
  const getTenantSlug = () => {
    const pathParts = location.pathname.split('/').filter(Boolean);
    const globalRoutes = ['login', 'register', 'manager', 'admin', 'delivery', 'super-admin'];
    
    if (pathParts.length > 0 && !globalRoutes.includes(pathParts[0]) && !pathParts[0].includes('.')) {
      return pathParts[0];
    }
    return localStorage.getItem('tenantSlug') || 'default';
  };

  const getCartKey = () => `restaurant_os_cart_${getTenantSlug()}`;

  const [items, setItems] = useState(() => {
    try {
      const saved = localStorage.getItem(getCartKey());
      return saved ? JSON.parse(saved) : [];
    } catch (e) {
      return [];
    }
  });

  // Track route changes to detect if the user switched to a different restaurant
  useEffect(() => {
    try {
      const saved = localStorage.getItem(getCartKey());
      setItems(saved ? JSON.parse(saved) : []);
    } catch (e) {
      setItems([]);
    }
  }, [location.pathname]);

  // Save to localStorage whenever items change
  useEffect(() => {
    localStorage.setItem(getCartKey(), JSON.stringify(items));
  }, [items]);

  const addItem = useCallback((menuItem, quantity = 1, selectedAddOns = []) => {
    setItems(prev => {
      // Check if same item with same add-ons already exists
      const existingIndex = prev.findIndex(item =>
        item.menuItem.id === menuItem.id &&
        JSON.stringify(item.selectedAddOns.map(a => a.id).sort()) ===
        JSON.stringify(selectedAddOns.map(a => a.id).sort())
      );

      if (existingIndex >= 0) {
        const updated = [...prev];
        updated[existingIndex] = {
          ...updated[existingIndex],
          quantity: updated[existingIndex].quantity + quantity,
        };
        return updated;
      }

      return [...prev, { menuItem, quantity, selectedAddOns }];
    });
  }, []);

  const removeItem = useCallback((index) => {
    setItems(prev => prev.filter((_, i) => i !== index));
  }, []);

  const updateQuantity = useCallback((index, quantity) => {
    if (quantity <= 0) {
      setItems(prev => prev.filter((_, i) => i !== index));
      return;
    }
    setItems(prev => {
      const updated = [...prev];
      updated[index] = { ...updated[index], quantity };
      return updated;
    });
  }, []);

  const clearCart = useCallback(() => {
    setItems([]);
  }, []);

  const getTotal = useCallback(() => {
    return items.reduce((sum, item) => {
      const itemTotal = item.menuItem.price * item.quantity;
      const addOnsTotal = item.selectedAddOns.reduce((aSum, addOn) => aSum + addOn.price, 0) * item.quantity;
      return sum + itemTotal + addOnsTotal;
    }, 0);
  }, [items]);

  const getItemCount = useCallback(() => {
    return items.reduce((sum, item) => sum + item.quantity, 0);
  }, [items]);

  return (
    <CartContext.Provider value={{ items, addItem, removeItem, updateQuantity, clearCart, getTotal, getItemCount }}>
      {children}
    </CartContext.Provider>
  );
}

export function useCart() {
  const context = useContext(CartContext);
  if (!context) {
    throw new Error('useCart must be used within a CartProvider');
  }
  return context;
}
