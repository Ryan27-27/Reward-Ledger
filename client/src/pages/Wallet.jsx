import { useRef, useState } from 'react';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, newKey, post } from '../api.js';
import { Empty, ErrorBox, Field, Spinner, fmt, titleCase, useToast, when } from '../ui.jsx';

export const rs = (paise) => `₹${(Number(paise) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const toPaise = (v) => Math.round(parseFloat(v || '0') * 100);
const refresh = (qc) => ['money', 'wallet', 'statement', 'audit', 'payments', 'notifications'].forEach((k) => qc.invalidateQueries({ queryKey: [k] }));

export function MoneySeal() {
  const { data, isLoading } = useQuery({ queryKey: ['audit', 'INR'], queryFn: () => api('/wallet/audit?currency=INR'), staleTime: 60_000 });
  if (isLoading) return <span className="verified muted">Verifying…</span>;
  return data?.ok ? <span className="verified ok">✔ Wallet ledger verified · {data.entries} entries</span> : <span className="verified bad">⚠ Ledger check failed — contact support</span>;
}

/** Emailed one-time code for large amounts. `body` is what the server needs to bind the code to this exact action. */
function StepUp({ body, code, setCode, needed }) {
  const toast = useToast(); const [sent, setSent] = useState(false);
  const ch = useMutation({ mutationFn: () => post('/money/challenge', body), onSuccess: () => { setSent(true); toast('Code sent to your email', 'ok'); } });
  if (!needed) return null;
  return (
    <div className="stack">
      <div className="alert warn">For your security, this amount needs a one-time code from your email.</div>
      <ErrorBox error={ch.error} />
      {!sent ? <button type="button" onClick={() => ch.mutate()} disabled={ch.isPending}>Email me a code</button>
        : <input className="otp-input" inputMode="numeric" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} placeholder="••••••" autoFocus />}
    </div>
  );
}

function AddMoney({ w }) {
  const qc = useQueryClient(); const toast = useToast();
  const [amt, setAmt] = useState(''); const key = useRef(newKey());
  const m = useMutation({
    mutationFn: () => post('/money/topup', { amountPaise: toPaise(amt) }, key.current),
    onSuccess: (r) => { toast(`${rs(toPaise(amt))} added. Balance ${rs(r.balance)}`, 'ok'); key.current = newKey(); setAmt(''); refresh(qc); },
  });
  if (!w.simulatedPayments) return <div className="alert warn">Adding money is handled by the payment gateway in this environment.</div>;
  return (
    <form className="stack" onSubmit={(e) => { e.preventDefault(); m.mutate(); }}>
      <p className="muted" style={{ margin: 0 }}>Demo mode: this simulates a successful UPI/card payment. In production the gateway confirms it by webhook.</p>
      <ErrorBox error={m.error} />
      <Field label="Amount (₹)"><input type="number" min="1" step="0.01" value={amt} onChange={(e) => setAmt(e.target.value)} placeholder="500" required /></Field>
      <div className="row">{[500, 1000, 2000, 5000].map((v) => <button type="button" className="small" key={v} onClick={() => setAmt(String(v))}>+ ₹{fmt(v)}</button>)}</div>
      <small className="muted">Up to {rs(w.limits.maxTopup)} at a time · wallet holds at most {rs(w.limits.maxBalance)}</small>
      <button className="primary" disabled={m.isPending || toPaise(amt) < 100}>{m.isPending ? 'Adding…' : `Add ${toPaise(amt) >= 100 ? rs(toPaise(amt)) : 'money'}`}</button>
    </form>
  );
}

function SendMoney({ w }) {
  const qc = useQueryClient(); const toast = useToast();
  const [f, setF] = useState({ to: '', amt: '', note: '' }); const [otp, setOtp] = useState(''); const key = useRef(newKey());
  const [who, setWho] = useState(null); const [lookupErr, setLookupErr] = useState(null);
  const paise = toPaise(f.amt); const needsOtp = paise >= w.limits.transferStepUp;
  const lookup = async () => {
    setWho(null); setLookupErr(null);
    try { setWho((await api(`/money/recipient?to=${encodeURIComponent(f.to.trim())}`)).name); } catch (e) { setLookupErr(e); }
  };
  const m = useMutation({
    mutationFn: () => post('/money/transfer', { to: f.to.trim(), amountPaise: paise, note: f.note || undefined, ...(needsOtp ? { otp } : {}) }, key.current),
    onSuccess: (r) => { toast(`Sent ${rs(paise)} to ${who}. Balance ${rs(r.balance)}`, 'ok'); key.current = newKey(); setF({ to: '', amt: '', note: '' }); setOtp(''); setWho(null); refresh(qc); },
  });
  return (
    <form className="stack" onSubmit={(e) => { e.preventDefault(); m.mutate(); }}>
      <ErrorBox error={m.error} />
      <Field label="Payment address">
        <div className="row" style={{ flexWrap: 'nowrap' }}><input value={f.to} placeholder={`name@${w.vpa?.split('@')[1] ?? 'pointwise'}`} autoCapitalize="none" autoCorrect="off" onChange={(e) => { setF({ ...f, to: e.target.value }); setWho(null); }} required />
          <button type="button" onClick={lookup} disabled={!f.to}>Find</button></div>
      </Field>
      {who && <div className="alert ok">Sending to <b>{who}</b> — check this is the right person.</div>}
      <ErrorBox error={lookupErr} />
      <Field label="Amount (₹)"><input type="number" min="1" step="0.01" value={f.amt} onChange={(e) => setF({ ...f, amt: e.target.value })} required /></Field>
      <Field label="Note (optional)"><input maxLength={80} value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} /></Field>
      <StepUp needed={needsOtp && !!who && paise >= 100} body={{ action: 'transfer', to: f.to.trim(), amountPaise: paise }} code={otp} setCode={setOtp} />
      <small className="muted">Spent today {rs(w.spentToday)} of {rs(w.limits.dailyOutbound)} daily limit · max {rs(w.limits.maxTransfer)} per transfer</small>
      <button className="primary" disabled={m.isPending || !who || paise < 100 || (needsOtp && otp.length !== 6)}>{m.isPending ? 'Sending…' : `Send ${paise >= 100 ? rs(paise) : ''}`}</button>
    </form>
  );
}

function Convert({ w }) {
  const qc = useQueryClient(); const toast = useToast();
  const { data: pw } = useQuery({ queryKey: ['wallet'], queryFn: () => api('/wallet') });
  const [pts, setPts] = useState(''); const [otp, setOtp] = useState(''); const key = useRef(newKey());
  const c = w.conversion; const points = parseInt(pts || '0', 10);
  const valid = points >= c.blockPoints && points % c.blockPoints === 0;
  const maxPts = pw ? Math.floor(Math.min(pw.balance, c.dailyLimitPoints - c.convertedToday) / c.blockPoints) * c.blockPoints : 0;
  const needsOtp = valid && points >= c.stepUpPoints;
  const m = useMutation({
    mutationFn: () => post('/money/convert', { points, ...(needsOtp ? { otp } : {}) }, key.current),
    onSuccess: (r) => { toast(`${fmt(points)} points → ${rs(points * c.paisePerPoint)} added to your wallet`, 'ok'); key.current = newKey(); setPts(''); setOtp(''); refresh(qc); },
  });
  return (
    <form className="stack" onSubmit={(e) => { e.preventDefault(); m.mutate(); }}>
      <div className="alert ok"><b>{c.blockPoints} points = {rs(c.paisePerBlock)}</b> · convert in blocks of {c.blockPoints}. You have {fmt(pw?.balance ?? 0)} points (worth {rs((pw?.balance ?? 0) * c.paisePerPoint)}).</div>
      <ErrorBox error={m.error} />
      <Field label="Points to convert"><input type="number" step={c.blockPoints} min={c.blockPoints} value={pts} onChange={(e) => setPts(e.target.value)} placeholder={String(c.blockPoints)} required /></Field>
      <div className="row">
        {[100, 500, 1000].map((v) => <button type="button" className="small" key={v} disabled={v > maxPts} onClick={() => setPts(String(v))}>{fmt(v)}</button>)}
        <button type="button" className="small" disabled={maxPts < c.blockPoints} onClick={() => setPts(String(maxPts))}>Max ({fmt(maxPts)})</button>
      </div>
      {valid && <div className="row between"><span>You'll receive</span><b style={{ fontSize: 22 }}>{rs(points * c.paisePerPoint)}</b></div>}
      <StepUp needed={needsOtp} body={{ action: 'convert', points }} code={otp} setCode={setOtp} />
      <small className="muted">Converted today {fmt(c.convertedToday)} of {fmt(c.dailyLimitPoints)} daily limit points. Conversions are final.</small>
      <button className="primary" disabled={m.isPending || !valid || points > (pw?.balance ?? 0) || (needsOtp && otp.length !== 6)}>{m.isPending ? 'Converting…' : 'Convert to wallet cash'}</button>
    </form>
  );
}

export default function Wallet() {
  const toast = useToast();
  const { data: w, isLoading } = useQuery({ queryKey: ['money', 'wallet'], queryFn: () => api('/money/wallet') });
  const [tab, setTab] = useState('add');
  const q = useInfiniteQuery({
    queryKey: ['statement', 'inr'], initialPageParam: null,
    queryFn: ({ pageParam }) => api(`/wallet/statement?currency=INR&limit=15${pageParam ? `&before=${pageParam}` : ''}`),
    getNextPageParam: (l) => l.nextBefore,
  });
  if (isLoading) return <Spinner />;
  const items = q.data?.pages.flatMap((p) => p.items) ?? [];
  const tabs = [['add', 'Add money'], ['send', 'Send money'], ['convert', 'Convert points']];
  return (
    <div className="stack">
      <h1>Wallet</h1>
      {w.status === 'FROZEN' && <div className="alert warn">Your account is frozen, so spending, sending and converting are paused. You can still receive money.</div>}
      <div className="card hero">
        <small>Wallet balance</small><div className="big">{rs(w.balance)}</div>
        <small>Pay for anything in the app, send money to a payment address, or convert your reward points into cash here. Sending money to people never earns points — only paying merchants and bills does.</small>
      </div>
      <MoneySeal />
      {w.vpa && <div className="card row between">
        <div><small className="muted">Your payment address — share it to get paid</small><div className="mono" style={{ fontSize: 18, fontWeight: 700 }}>{w.vpa}</div></div>
        <button onClick={() => { navigator.clipboard?.writeText(w.vpa); toast('Payment address copied', 'ok'); }}>Copy</button>
      </div>}
      <div className="card">
        <div className="tabs">{tabs.map(([k, l]) => <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{l}</button>)}</div>
        {tab === 'add' && <AddMoney w={w} />}{tab === 'send' && <SendMoney w={w} />}{tab === 'convert' && <Convert w={w} />}
      </div>
      <div className="card">
        <h2>Wallet history</h2>
        {q.isLoading ? <Spinner /> : !items.length ? <Empty>No wallet activity yet. Add money to get started.</Empty> : <div className="table-wrap"><table>
          <thead><tr><th>Date</th><th>Description</th><th className="num">Amount</th><th className="num">Balance</th></tr></thead>
          <tbody>{items.map((e) => (
            <tr key={e.seq}><td>{when(e.created_at)}</td><td>{e.description} <span className="badge">{titleCase(e.kind)}</span>{e.reversed && <> <span className="badge warn">Refunded</span></>}</td>
              <td className={`num ${e.direction === 'CREDIT' ? 'credit' : 'debit'}`}>{e.direction === 'CREDIT' ? '+' : '−'}{rs(e.amount)}</td><td className="num">{rs(e.balance_after)}</td></tr>))}</tbody></table></div>}
        {q.hasNextPage && <div style={{ textAlign: 'center', marginTop: 12 }}><button onClick={() => q.fetchNextPage()} disabled={q.isFetchingNextPage}>Load older</button></div>}
      </div>
    </div>
  );
}
