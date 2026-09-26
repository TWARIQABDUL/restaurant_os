import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

// The ONLY stylesheet this entry loads. Nothing here imports ../index.css.
import '../styles/tokens.css';

import { AuthPage } from '../auth/AuthPage.tsx';

const host = document.getElementById('root');
if (host === null) throw new Error('#root is missing from app.html');

createRoot(host).render(
  <StrictMode>
    <AuthPage />
  </StrictMode>,
);
