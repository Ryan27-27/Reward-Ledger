import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider } from './auth.jsx';
import { ToastProvider } from './ui.jsx';
import App from './App.jsx';
import './styles.css';

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: (n, e) => n < 2 && !(e?.status >= 400 && e?.status < 500), staleTime: 15_000, refetchOnWindowFocus: true } },
});

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <AuthProvider>
          <BrowserRouter><App /></BrowserRouter>
        </AuthProvider>
      </ToastProvider>
    </QueryClientProvider>
  </React.StrictMode>,
);
