import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App.jsx';
import { AuthProvider } from './context/AuthContext.jsx';
import { CartProvider } from './context/CartContext.jsx';
import { TenantProvider } from './context/TenantContext.jsx';
import { Toaster } from 'react-hot-toast';
import './index.css';

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter>
      <AuthProvider>
        {/* Inside AuthProvider: on dashboard routes there is no slug in the URL,
            so the store is resolved from the signed-in user. Outside Cart, since
            nothing in the cart depends on it. */}
        <TenantProvider>
        <CartProvider>
          <Toaster position="top-right" />
          <App />
        </CartProvider>
        </TenantProvider>
      </AuthProvider>
    </BrowserRouter>
  </React.StrictMode>
);
