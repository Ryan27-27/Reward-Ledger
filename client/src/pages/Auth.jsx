import { useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { post } from '../api.js';
import { useAuth } from '../auth.jsx';
import { ErrorBox, Field, useToast } from '../ui.jsx';

const Frame = ({ title, sub, children }) => (
  <div className="auth"><div className="card stack">
    <div className="brand"><i /> Pointwise</div>
    <div style={{ textAlign: 'center' }}><h2>{title}</h2>{sub && <p className="muted" style={{ margin: '6px 0 0' }}>{sub}</p>}</div>
    {children}
  </div></div>
);

function useSubmit(fn) {
  const [busy, setBusy] = useState(false), [error, setError] = useState(null);
  const run = async (e) => {
    e?.preventDefault(); setBusy(true); setError(null);
    try { await fn(); } catch (err) { setError(err); } finally { setBusy(false); }
  };
  return { busy, error, run };
}

export function Login() {
  const { login } = useAuth(); const nav = useNavigate();
  const [email, setEmail] = useState(''), [password, setPassword] = useState('');
  const { busy, error, run } = useSubmit(async () => {
    try { await login(email, password); }
    catch (e) { if (e.code === 'EMAIL_NOT_VERIFIED') { await post('/auth/resend-verification', { email }); nav('/verify', { state: { email } }); return; } throw e; }
  });
  return (
    <Frame title="Welcome back" sub="Sign in to your rewards wallet">
      <form className="stack" onSubmit={run}>
        <ErrorBox error={error} />
        <Field label="Email"><input type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus /></Field>
        <Field label="Password"><input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required /></Field>
        <button className="primary" disabled={busy} style={{ width: '100%' }}>{busy ? 'Signing in…' : 'Sign in'}</button>
        <div className="row between"><Link to="/forgot">Forgot password?</Link><Link to="/register">Create account</Link></div>
      </form>
    </Frame>
  );
}

export function Register() {
  const nav = useNavigate(); const loc = useLocation();
  const [f, setF] = useState({ name: '', email: '', password: '', referralCode: new URLSearchParams(loc.search).get('ref') || '' });
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const { busy, error, run } = useSubmit(async () => {
    await post('/auth/register', { ...f, referralCode: f.referralCode || undefined });
    nav('/verify', { state: { email: f.email } });
  });
  return (
    <Frame title="Create your account" sub="Earn points on every payment">
      <form className="stack" onSubmit={run}>
        <ErrorBox error={error && !error.fields ? error : null} />
        <Field label="Full name" error={error?.fields?.name}><input value={f.name} onChange={set('name')} required autoFocus /></Field>
        <Field label="Email" error={error?.fields?.email}><input type="email" autoComplete="email" value={f.email} onChange={set('email')} required /></Field>
        <Field label="Password (10+ characters)" error={error?.fields?.password}><input type="password" autoComplete="new-password" value={f.password} onChange={set('password')} required minLength={10} /></Field>
        <Field label="Referral code (optional)"><input value={f.referralCode} onChange={set('referralCode')} placeholder="e.g. K7MQ2XPA" style={{ textTransform: 'uppercase' }} /></Field>
        <button className="primary" disabled={busy} style={{ width: '100%' }}>{busy ? 'Creating…' : 'Create account'}</button>
        <p className="muted" style={{ textAlign: 'center', margin: 0 }}>Already registered? <Link to="/login">Sign in</Link></p>
      </form>
    </Frame>
  );
}

export function Verify() {
  const { verifyEmail } = useAuth(); const loc = useLocation(); const toast = useToast();
  const [email, setEmail] = useState(loc.state?.email || ''), [code, setCode] = useState('');
  const { busy, error, run } = useSubmit(() => verifyEmail(email, code));
  const resend = async () => { await post('/auth/resend-verification', { email }); toast('A new code is on its way', 'ok'); };
  return (
    <Frame title="Check your email" sub={`We sent a 6-digit code${email ? ` to ${email}` : ''}`}>
      <form className="stack" onSubmit={run}>
        <ErrorBox error={error} />
        {!loc.state?.email && <Field label="Email"><input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required /></Field>}
        <input className="otp-input" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} placeholder="••••••" autoFocus />
        <button className="primary" disabled={busy || code.length !== 6} style={{ width: '100%' }}>{busy ? 'Verifying…' : 'Verify & continue'}</button>
        <button type="button" className="ghost" onClick={resend} disabled={!email}>Resend code</button>
      </form>
    </Frame>
  );
}

export function Forgot() {
  const nav = useNavigate(); const toast = useToast();
  const [step, setStep] = useState(1), [email, setEmail] = useState(''), [code, setCode] = useState(''), [pw, setPw] = useState('');
  const { busy, error, run } = useSubmit(async () => {
    if (step === 1) { await post('/auth/forgot-password', { email }); setStep(2); }
    else { await post('/auth/reset-password', { email, code, newPassword: pw }); toast('Password updated — please sign in', 'ok'); nav('/login'); }
  });
  return (
    <Frame title="Reset your password" sub={step === 1 ? "We'll email you a code" : `Enter the code sent to ${email}`}>
      <form className="stack" onSubmit={run}>
        <ErrorBox error={error && !error.fields ? error : null} />
        {step === 1 ? <Field label="Email"><input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus /></Field> : <>
          <input className="otp-input" inputMode="numeric" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} placeholder="••••••" autoFocus />
          <Field label="New password (10+ characters)" error={error?.fields?.newPassword}><input type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} required minLength={10} /></Field>
        </>}
        <button className="primary" disabled={busy} style={{ width: '100%' }}>{step === 1 ? 'Send code' : 'Update password'}</button>
        <p style={{ textAlign: 'center', margin: 0 }}><Link to="/login">Back to sign in</Link></p>
      </form>
    </Frame>
  );
}
