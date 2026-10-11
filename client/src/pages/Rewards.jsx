import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, newKey, post } from '../api.js';
import { Empty, ErrorBox, Modal, Spinner, fmt, useToast, when } from '../ui.jsx';

function RedeemModal({ item, wallet, onClose }) {
  const qc = useQueryClient(); const toast = useToast();
  const key = useRef(newKey());
  const stepUp = item.points_cost >= wallet.stepUpThreshold;
  const [sent, setSent] = useState(false), [otp, setOtp] = useState('');
  const challenge = useMutation({ mutationFn: () => post('/redemptions/challenge', { itemId: item.id }), onSuccess: () => { setSent(true); toast('Code sent to your email', 'ok'); } });
  const redeem = useMutation({
    mutationFn: () => post('/redemptions', { itemId: item.id, ...(stepUp ? { otp } : {}) }, key.current),
    onSuccess: () => ['wallet', 'statement', 'catalog', 'redemptions', 'audit'].forEach((k) => qc.invalidateQueries({ queryKey: [k] })),
  });
  const done = redeem.data;
  return (
    <Modal title={done ? 'Redeemed 🎉' : `Redeem ${item.name}`} onClose={onClose}>
      {done ? <div className="stack">
        <p style={{ margin: 0 }}>Here's your voucher for <b>{done.item.name}</b>. It's also saved under "My vouchers".</p>
        <div className="voucher">{done.redemption.voucher_code}</div>
        <button className="primary" onClick={onClose}>Done</button>
      </div> : <div className="stack">
        <ErrorBox error={redeem.error || challenge.error} />
        <div className="row between"><span>Cost</span><b>{fmt(item.points_cost)} points</b></div>
        <div className="row between"><span>Balance after</span><b>{fmt(wallet.balance - item.points_cost)}</b></div>
        {stepUp && <div className="stack">
          <div className="alert warn">For your security, large redemptions need a one-time code sent to your email.</div>
          {!sent ? <button onClick={() => challenge.mutate()} disabled={challenge.isPending}>Email me a code</button> :
            <input className="otp-input" inputMode="numeric" maxLength={6} value={otp} onChange={(e) => setOtp(e.target.value.replace(/\D/g, ''))} placeholder="••••••" autoFocus />}
        </div>}
        <button className="primary" onClick={() => redeem.mutate()} disabled={redeem.isPending || (stepUp && otp.length !== 6)}>{redeem.isPending ? 'Redeeming…' : 'Confirm redemption'}</button>
      </div>}
    </Modal>
  );
}

export default function Rewards() {
  const [item, setItem] = useState(null);
  const { data: cat, isLoading } = useQuery({ queryKey: ['catalog'], queryFn: () => api('/catalog') });
  const { data: w } = useQuery({ queryKey: ['wallet'], queryFn: () => api('/wallet') });
  const { data: mine } = useQuery({ queryKey: ['redemptions'], queryFn: () => api('/redemptions') });
  if (isLoading || !w) return <Spinner />;
  return (
    <div className="stack">
      <div className="row between"><h1>Rewards</h1><span className="badge" style={{ fontSize: 14 }}>{fmt(w.balance)} points</span></div>
      {w.status === 'FROZEN' && <div className="alert warn">Redemptions are paused while your account is frozen.</div>}
      <div className="grid g3">
        {cat.items.map((i) => {
          const short = i.points_cost - w.balance;
          return (
            <div key={i.id} className="card reward">
              <div className="emoji">{i.emoji}</div><b>{i.name}</b><small>{i.description}</small>
              <div className="cost">{fmt(i.points_cost)} pts</div>
              {i.stock !== null && <small>{i.soldOut ? 'Sold out' : `${i.stock} left`}</small>}
              <button className="primary" disabled={i.soldOut || short > 0 || w.status === 'FROZEN'} onClick={() => setItem(i)}>
                {i.soldOut ? 'Sold out' : short > 0 ? `${fmt(short)} more points` : 'Redeem'}</button>
            </div>);
        })}
      </div>
      <div className="card"><h2>My vouchers</h2>
        {!mine?.redemptions.length ? <Empty>Nothing redeemed yet</Empty> : <table><tbody>{mine.redemptions.map((r) => (
          <tr key={r.id}><td>{r.emoji} {r.name}<br /><small>{when(r.created_at)}</small></td><td className="mono">{r.voucher_code}</td><td className="num debit">−{fmt(r.points_spent)}</td></tr>))}</tbody></table>}
      </div>
      {item && <RedeemModal item={item} wallet={w} onClose={() => setItem(null)} />}
    </div>
  );
}
