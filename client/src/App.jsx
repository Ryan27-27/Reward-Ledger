import { useEffect, useRef, useState } from 'react';
import { NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from './auth.jsx';
import { api, post, openNotificationStream } from './api.js';
import { Spinner, useToast, when } from './ui.jsx';
import { Login, Register, Verify, Forgot } from './pages/Auth.jsx';
import Dashboard from './pages/Dashboard.jsx';
import Pay from './pages/Pay.jsx';
import Wallet from './pages/Wallet.jsx';
import Activity from './pages/Activity.jsx';
import Rewards from './pages/Rewards.jsx';
import Security from './pages/Security.jsx';
import Admin from './pages/Admin.jsx';

function Bell() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const ref = useRef();
  const { data } = useQuery({ queryKey: ['notifications'], queryFn: () => api('/notifications') });
  useEffect(() => {
    const h = (e) => ref.current && !ref.current.contains(e.target) && setOpen(false);
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, []);
  const toggle = async () => {
    setOpen((o) => !o);
    if (!open && data?.unread) { await post('/notifications/read-all'); setTimeout(() => qc.invalidateQueries({ queryKey: ['notifications'] }), 1500); }
  };
  return (
    <div className="bell" ref={ref}>
      <button className="ghost" onClick={toggle} aria-label="Notifications">🔔{data?.unread > 0 && <span className="dot">{data.unread}</span>}</button>
      {open && (
        <div className="panel">
          {!data?.notifications.length && <div className="empty">Nothing yet</div>}
          {data?.notifications.map((n) => (
            <div key={n.id} className={`item ${n.read_at ? '' : 'unread'}`}>
              <b>{n.title}</b><span>{n.body}</span><br /><small>{when(n.created_at)}</small>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Shell({ children }) {
  const { user, logout } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const staff = user.role !== 'USER';

  // Every ledger movement is pushed here the moment its transaction commits.
  useEffect(() => openNotificationStream((n) => {
    toast(`${n.title} — ${n.body}`, n.type.endsWith('DEBITED') ? 'info' : 'ok');
    ['notifications', 'wallet', 'money', 'statement', 'audit', 'payments', 'redemptions'].forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
  }), [qc, toast]);

  const links = [['/', '🏠', 'Home'], ['/wallet', '👛', 'Wallet'], ['/pay', '💳', 'Pay'], ['/activity', '📒', 'Activity'], ['/rewards', '🎁', 'Rewards'], ['/security', '🔐', 'Security'], ...(staff ? [['/admin', '🛡️', 'Admin']] : [])];
  return (
    <div className="shell">
      <nav className="side">
        <div className="brand"><i /> Pointwise</div>
        {links.map(([to, icon, label]) => <NavLink key={to} to={to} end={to === '/'} className="nav"><span>{icon}</span>{label}</NavLink>)}
        <div className="grow" />
        <div className="who muted" style={{ padding: '8px 12px', fontSize: 13 }}>{user.name}<br /><small>{user.email}</small></div>
        <button className="ghost" onClick={logout}>Sign out</button>
      </nav>
      <main className="main">
        <div className="topbar"><span /><div className="right"><Bell /></div></div>
        {children}
      </main>
    </div>
  );
}

function Guard({ children, staff = false }) {
  const { user, loading } = useAuth();
  const loc = useLocation();
  if (loading) return <Spinner />;
  if (!user) return <Navigate to="/login" state={{ from: loc.pathname }} replace />;
  if (staff && user.role === 'USER') return <Navigate to="/" replace />;
  return <Shell>{children}</Shell>;
}

export default function App() {
  const { user, loading } = useAuth();
  if (loading) return <Spinner />;
  const home = (el) => (user ? <Navigate to="/" replace /> : el);
  return (
    <Routes>
      <Route path="/login" element={home(<Login />)} />
      <Route path="/register" element={home(<Register />)} />
      <Route path="/verify" element={home(<Verify />)} />
      <Route path="/forgot" element={home(<Forgot />)} />
      <Route path="/" element={<Guard><Dashboard /></Guard>} />
      <Route path="/wallet" element={<Guard><Wallet /></Guard>} />
      <Route path="/pay" element={<Guard><Pay /></Guard>} />
      <Route path="/activity" element={<Guard><Activity /></Guard>} />
      <Route path="/rewards" element={<Guard><Rewards /></Guard>} />
      <Route path="/security" element={<Guard><Security /></Guard>} />
      <Route path="/admin" element={<Guard staff><Admin /></Guard>} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
