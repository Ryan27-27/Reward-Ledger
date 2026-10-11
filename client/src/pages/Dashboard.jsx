import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { Empty, Spinner, TierBadge, day, fmt, inr, useToast, when } from '../ui.jsx';
import { rs } from './Wallet.jsx';

export function LedgerSeal() {
  const { data, isLoading } = useQuery({ queryKey: ['audit'], queryFn: () => api('/wallet/audit'), staleTime: 60_000 });
  if (isLoading) return <span className="verified muted">Verifying ledger…</span>;
  return data?.ok
    ? <span className="verified ok" title={`${data.entries} entries replayed, hash chain intact`}>✔ Ledger verified · {data.entries} entries</span>
    : <span className="verified bad">⚠ Ledger check failed — contact support</span>;
}

export default function Dashboard() {
  const { user } = useAuth(); const toast = useToast();
  const { data: w, isLoading } = useQuery({ queryKey: ['wallet'], queryFn: () => api('/wallet') });
  const { data: mw } = useQuery({ queryKey: ['money', 'wallet'], queryFn: () => api('/money/wallet') });
  const { data: st } = useQuery({ queryKey: ['statement', 'recent'], queryFn: () => api('/wallet/statement?limit=5') });
  if (isLoading || !mw) return <Spinner />;
  const link = `${location.origin}/register?ref=${w.referral.code}`;
  return (
    <div className="stack">
      <div><h1>Hi {user.name.split(' ')[0]} 👋</h1><LedgerSeal /></div>
      {w.status === 'FROZEN' && <div className="alert warn">Your account is frozen, so redemptions are paused. Contact support if you think this is a mistake.</div>}
      <div className="grid g2">
      <div className="card hero">
        <div className="row between"><small>Wallet balance</small></div>
        <div className="big">{rs(mw.balance)}</div>
        <div className="row" style={{ marginTop: 14 }}>
          <Link to="/wallet" className="btn" style={{ background: '#fff', color: '#4f46e5' }}>Add money</Link>
          <Link to="/wallet" className="btn" style={{ background: '#ffffff26', color: '#fff', border: 0 }}>Send</Link>
        </div>
      </div>
      <div className="card hero">
        <div className="row between"><small>Points balance</small><span className="tier"><TierBadge tier={w.tier.current} /></span></div>
        <div className="big">{fmt(w.balance)}</div>
        {w.tier.next ? <>
          <div className="bar"><i style={{ width: `${w.tier.pct}%` }} /></div>
          <small>Spend {inr(w.tier.remainingPaise)} more to reach {w.tier.next[0] + w.tier.next.slice(1).toLowerCase()}</small>
        </> : <small>You're at the top tier 🎉</small>}
        <div style={{ marginTop: 10 }}><small>Worth {rs(w.balance * mw.conversion.paisePerPoint)} · <Link to="/wallet" style={{ color: '#fff', textDecoration: 'underline' }}>convert to cash</Link></small></div>
      </div>
      </div>
      {w.expiringSoon && <div className="alert warn">⏳ {fmt(w.expiringSoon.points)} points expire by {day(w.expiringSoon.firstExpiry)} — <Link to="/rewards">use them</Link></div>}
      <div className="grid g3">
        <div className="card stat"><div className="v">{fmt(w.lifetimeEarned)}</div><div className="l">Lifetime points earned</div></div>
        <div className="card stat"><div className="v">{inr(w.lifetimeSpendPaise)}</div><div className="l">Lifetime spend</div></div>
        <div className="card stat"><div className="v">{w.referral.referred}</div><div className="l">Friends referred</div></div>
      </div>
      <div className="grid g2">
        <div className="card">
          <div className="row between"><h2>Recent activity</h2><Link to="/activity">View all</Link></div>
          {!st?.items.length ? <Empty>No activity yet. <Link to="/pay">Make your first payment</Link> to earn points.</Empty> :
            <table><tbody>{st.items.map((e) => (
              <tr key={e.seq}><td>{e.description}<br /><small>{when(e.created_at)}</small></td>
                <td className={`num ${e.direction === 'CREDIT' ? 'credit' : 'debit'}`}>{e.direction === 'CREDIT' ? '+' : '−'}{fmt(e.amount)}</td></tr>
            ))}</tbody></table>}
        </div>
        <div className="card stack">
          <h2>Invite friends, earn {w.referral.bonusPoints} points</h2>
          <p className="muted" style={{ margin: 0 }}>You get {w.referral.bonusPoints} points when a friend you invite makes their first payment.</p>
          <div className="voucher" style={{ fontSize: 18 }}>{w.referral.code}</div>
          <button onClick={() => { navigator.clipboard?.writeText(link); toast('Invite link copied', 'ok'); }}>Copy invite link</button>
        </div>
      </div>
    </div>
  );
}
