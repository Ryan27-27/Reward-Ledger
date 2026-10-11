import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, newKey, post } from '../api.js';
import { Link } from 'react-router-dom';
import { Empty, ErrorBox, Field, Spinner, fmt, inr, titleCase, useToast, when } from '../ui.jsx';

export default function Pay() {
  const qc = useQueryClient(); const toast = useToast();
  const { data: rules } = useQuery({ queryKey: ['rules'], queryFn: () => api('/rewards/rules'), staleTime: Infinity });
  const { data: past } = useQuery({ queryKey: ['payments'], queryFn: () => api('/payments') });
  const { data: mw } = useQuery({ queryKey: ['money', 'wallet'], queryFn: () => api('/money/wallet') });
  const [method, setMethod] = useState('WALLET');
  const [category, setCategory] = useState('SHOPPING'), [amount, setAmount] = useState(''), [desc, setDesc] = useState('');
  const key = useRef(newKey()); // one key per *intent*: retries of the same submit can never double-pay
  const paise = Math.round(parseFloat(amount || '0') * 100);
  const valid = paise >= 100;

  const [preview, setPreview] = useState(null);
  useEffect(() => {
    if (!valid) { setPreview(null); return; }
    const t = setTimeout(() => api('/payments/preview', { method: 'POST', body: { category, amountPaise: paise } }).then(setPreview).catch(() => setPreview(null)), 250);
    return () => clearTimeout(t);
  }, [category, paise, valid]);

  const m = useMutation({
    mutationFn: () => post('/payments', { category, amountPaise: paise, method, description: desc || undefined }, key.current),
    onSuccess: (r) => {
      toast(`Payment successful — you earned ${fmt(r.payment.points_awarded)} points 🎉`, 'ok');
      key.current = newKey(); setAmount(''); setDesc('');
      ['wallet', 'money', 'statement', 'payments', 'audit'].forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
    },
  });
  if (!rules || !mw) return <Spinner />;
  const short = method === 'WALLET' && valid && paise > mw.balance;
  return (
    <div className="stack">
      <h1>Make a payment</h1>
      <p className="muted" style={{ margin: 0 }}>Paying from your wallet debits your rupee balance and credits your reward points in one step. Card/UPI is a demo; in production the payment gateway calls our signed webhook and the same reward engine runs.</p>
      <div className="grid g2">
        <form className="card stack" onSubmit={(e) => { e.preventDefault(); m.mutate(); }}>
          <ErrorBox error={m.error} />
          <Field label="Category"><select value={category} onChange={(e) => setCategory(e.target.value)}>{rules.categories.map((c) => <option key={c.key} value={c.key}>{c.label} — {c.rate} pts/₹100</option>)}</select></Field>
          <Field label="Amount (₹)"><input type="number" min="1" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="1,000" required /></Field>
          <Field label="Pay with">
            <select value={method} onChange={(e) => setMethod(e.target.value)}>
              <option value="WALLET">Wallet balance — ₹{(mw.balance / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</option>
              {mw.simulatedPayments && <option value="EXTERNAL">Card / UPI (demo, simulated)</option>}
            </select>
          </Field>
          {short && <div className="alert warn">Not enough in your wallet. <Link to="/wallet">Add money</Link></div>}
          <Field label="Note (optional)"><input value={desc} maxLength={120} onChange={(e) => setDesc(e.target.value)} /></Field>
          {preview && <div className="alert ok"><b>You'll earn {fmt(preview.points)} points</b><br /><small>{preview.explanation}</small></div>}
          <button className="primary" disabled={!valid || m.isPending || short}>{m.isPending ? 'Processing…' : `Pay ${valid ? inr(paise) : ''}`}</button>
        </form>
        <div className="card">
          <h2>How rewards work</h2>
          <table><tbody>
            {rules.tiers.map((t) => <tr key={t.name}><td>{titleCase(t.name)}</td><td className="muted">from {inr(t.minSpendPaise)}</td><td className="num"><b>{t.multiplier}×</b></td></tr>)}
          </tbody></table>
          <p className="muted">+{rules.firstPaymentBonus} bonus on your first payment of {inr(rules.firstPaymentBonusMinPaise)} or more · max {fmt(rules.maxPointsPerPayment)} points per payment · points are calculated on the server and can't be altered by the app.</p>
        </div>
      </div>
      <div className="card">
        <h2>Payment history</h2>
        {!past?.payments.length ? <Empty>No payments yet</Empty> : <div className="table-wrap"><table>
          <thead><tr><th>Date</th><th>Category</th><th className="num">Amount</th><th className="num">Points</th><th>Status</th></tr></thead>
          <tbody>{past.payments.map((p) => <tr key={p.id}><td>{when(p.created_at)}</td><td>{titleCase(p.category)} <span className="badge">{p.method === 'WALLET' ? 'Wallet' : 'Card/UPI'}</span><br /><small>{p.rule_applied}</small></td>
            <td className="num">{inr(p.amount_paise)}</td><td className="num credit">+{fmt(p.points_awarded)}</td>
            <td><span className={`badge ${p.status === 'COMPLETED' ? 'ok' : 'warn'}`}>{titleCase(p.status)}</span></td></tr>)}</tbody></table></div>}
      </div>
    </div>
  );
}
