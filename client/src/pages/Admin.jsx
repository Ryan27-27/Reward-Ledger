import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, post } from '../api.js';
import { useAuth } from '../auth.jsx';
import { Empty, ErrorBox, Field, Modal, Spinner, fmt, inr, titleCase, useToast, when } from '../ui.jsx';
import { rs } from './Wallet.jsx';

const useInvalidate = () => { const qc = useQueryClient(); return (...k) => k.forEach((x) => qc.invalidateQueries({ queryKey: ['admin', x] })); };

function Overview() {
  const { data: s } = useQuery({ queryKey: ['admin', 'stats'], queryFn: () => api('/admin/stats') });
  const verify = useMutation({ mutationFn: () => api('/admin/ledger/verify') });
  if (!s) return <Spinner />;
  const cards = [['Members', fmt(s.users)], ['Points in circulation', fmt(s.pointsOutstanding)], ['Points issued', fmt(s.pointsIssued)], ['Points redeemed', fmt(s.pointsRedeemed)],
    ['Points expired', fmt(s.pointsExpired)], ['Points converted to cash', fmt(s.pointsConverted)], ['Treasury balance', rs(s.treasuryPaise)], ['Payment volume', inr(s.paymentVolumePaise)], ['Pending approvals', s.pendingApprovals], ['Email queue', `${s.emailQueue.pending} pending · ${s.emailQueue.dead} failed`]];
  return (
    <div className="stack">
      <div className="grid g4">{cards.map(([l, v]) => <div key={l} className="card stat"><div className="v" style={{ fontSize: 20 }}>{v}</div><div className="l">{l}</div></div>)}</div>
      <div className="card stack">
        <h2>Ledger integrity</h2>
        <p className="muted" style={{ margin: 0 }}>Replays every wallet's full history: hash chain, running balances, double-entry balance of every journal, and point-lot totals.</p>
        <div><button className="primary" onClick={() => verify.mutate()} disabled={verify.isPending}>{verify.isPending ? 'Verifying…' : 'Run full verification'}</button></div>
        <ErrorBox error={verify.error} />
        {verify.data && (verify.data.ok
          ? <div className="alert ok">✔ All {verify.data.wallets} wallets verified. No tampering, no imbalance.</div>
          : <div className="alert error"><b>{verify.data.walletsFailing} wallet(s) failing</b><ul>{verify.data.problems.map((p) => <li key={p}>{p}</li>)}</ul></div>)}
      </div>
    </div>
  );
}

function ReasonModal({ title, label = 'Reason', cta, danger, onSubmit, onClose, children }) {
  const [reason, setReason] = useState('');
  const m = useMutation({ mutationFn: () => onSubmit(reason), onSuccess: onClose });
  return (
    <Modal title={title} onClose={onClose}>
      <form className="stack" onSubmit={(e) => { e.preventDefault(); m.mutate(); }}>
        <ErrorBox error={m.error} />{children}
        <Field label={`${label} (shown in the audit log and sent to the member)`}><textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} minLength={10} required /></Field>
        <button className={danger ? 'danger' : 'primary'} disabled={m.isPending || reason.trim().length < 10}>{cta}</button>
      </form>
    </Modal>
  );
}

function UserDrawer({ id, canWrite, onClose }) {
  const inv = useInvalidate(); const toast = useToast();
  const { data: u } = useQuery({ queryKey: ['admin', 'user', id], queryFn: () => api(`/admin/users/${id}`) });
  const [dlg, setDlg] = useState(null), [amount, setAmount] = useState('');
  const refresh = () => { inv('user', 'users'); };
  if (!u) return <Modal title="Member" onClose={onClose}><Spinner /></Modal>;
  const frozen = u.account_status === 'FROZEN', suspended = u.status === 'SUSPENDED';
  return (
    <Modal title={u.name} onClose={onClose}>
      <div className="stack">
        <div className="row between"><span>{u.email}</span><span>{suspended && <span className="badge bad">Suspended</span>} {frozen && <span className="badge warn">Frozen</span>}</span></div>
        <div className="grid g3"><div className="stat"><div className="v">{fmt(u.balance)}</div><div className="l">Points</div></div>
          <div className="stat"><div className="v">{rs(u.wallet_paise ?? 0)}</div><div className="l">Wallet</div></div><div className="stat"><div className="v">{inr(u.lifetime_spend_paise)}</div><div className="l">Spend</div></div></div>
        {canWrite && <div className="row">
          <button className="small" onClick={() => setDlg('grant')}>Request grant…</button>
          <button className="small" onClick={() => setDlg(frozen ? 'unfreeze' : 'freeze')}>{frozen ? 'Unfreeze' : 'Freeze'} account</button>
          {u.role === 'USER' && <button className="small danger" onClick={() => setDlg(suspended ? 'reinstate' : 'suspend')}>{suspended ? 'Reinstate' : 'Suspend'} user</button>}
        </div>}
        <small className="muted">Admins can't spend or debit a member's points. Grants and reversals need a second admin's approval.</small>
        <h3>Recent ledger entries</h3>
        {!u.statement.length ? <Empty>No entries</Empty> : <table><tbody>{u.statement.map((e) => (
          <tr key={e.seq}><td>{e.description}<br /><small>{when(e.created_at)} · <span className="mono">{e.journal_id.slice(0, 8)}</span></small></td>
            <td className={`num ${e.direction === 'CREDIT' ? 'credit' : 'debit'}`}>{e.direction === 'CREDIT' ? '+' : '−'}{fmt(e.amount)}</td>
            <td className="num">{canWrite && e.kind === 'GRANT' && e.direction === 'CREDIT' && !e.reversed && <button className="small danger" onClick={() => setDlg({ reverse: e })}>Request reversal</button>}</td></tr>))}</tbody></table>}
      </div>
      {dlg === 'grant' && <ReasonModal title="Request a points grant" cta="Submit for approval" onClose={() => setDlg(null)}
        onSubmit={async (reason) => { await post('/admin/approvals', { kind: 'GRANT', accountId: u.account_id, amount: Number(amount), reason }); inv('approvals', 'stats'); toast('Sent for a second admin to approve', 'ok'); }}>
        <Field label="Points"><input type="number" min="1" value={amount} onChange={(e) => setAmount(e.target.value)} required /></Field></ReasonModal>}
      {dlg?.reverse && <ReasonModal title={`Request reversal of +${fmt(dlg.reverse.amount)}`} danger cta="Submit for approval" onClose={() => setDlg(null)}
        onSubmit={async (reason) => { await post('/admin/approvals', { kind: 'REVERSAL', accountId: u.account_id, targetJournalId: dlg.reverse.journal_id, reason }); inv('approvals', 'stats'); toast('Sent for a second admin to approve', 'ok'); }} />}
      {['freeze', 'unfreeze'].includes(dlg) && <ReasonModal title={`${titleCase(dlg)} account`} cta={titleCase(dlg)} onClose={() => setDlg(null)}
        onSubmit={async (reason) => { await post(`/admin/accounts/${u.account_id}/${dlg}`, { reason }); refresh(); }} />}
      {['suspend', 'reinstate'].includes(dlg) && <ReasonModal title={`${titleCase(dlg)} user`} danger cta={titleCase(dlg)} onClose={() => setDlg(null)}
        onSubmit={async (reason) => { await post(`/admin/users/${u.id}/${dlg}`, { reason }); refresh(); }} />}
    </Modal>
  );
}

function Users({ canWrite }) {
  const [q, setQ] = useState(''), [open, setOpen] = useState(null);
  const { data } = useQuery({ queryKey: ['admin', 'users', q], queryFn: () => api(`/admin/users?q=${encodeURIComponent(q)}`) });
  return (
    <div className="card stack">
      <input placeholder="Search by name, email or payment address…" value={q} onChange={(e) => setQ(e.target.value)} />
      {!data ? <Spinner /> : !data.users.length ? <Empty>No members found</Empty> : <div className="table-wrap"><table>
        <thead><tr><th>Member</th><th>Role</th><th className="num">Balance</th><th>Status</th><th /></tr></thead>
        <tbody>{data.users.map((u) => <tr key={u.id}><td>{u.name}<br /><small>{u.email}</small>{u.vpa && <><br /><small className="mono">{u.vpa}</small></>}</td><td>{titleCase(u.role)}</td><td className="num">{fmt(u.balance)}</td>
          <td>{u.status === 'SUSPENDED' ? <span className="badge bad">Suspended</span> : u.account_status === 'FROZEN' ? <span className="badge warn">Frozen</span> : <span className="badge ok">Active</span>}</td>
          <td><button className="small" onClick={() => setOpen(u.id)}>Open</button></td></tr>)}</tbody></table></div>}
      {open && <UserDrawer id={open} canWrite={canWrite} onClose={() => setOpen(null)} />}
    </div>
  );
}

function Approvals({ canWrite }) {
  const { user } = useAuth(); const inv = useInvalidate(); const toast = useToast();
  const { data } = useQuery({ queryKey: ['admin', 'approvals'], queryFn: () => api('/admin/approvals') });
  const decide = useMutation({
    mutationFn: ({ id, action }) => post(`/admin/approvals/${id}/${action}`, {}),
    onSuccess: (_r, v) => { toast(v.action === 'approve' ? 'Approved and posted to the ledger' : 'Rejected', 'ok'); inv('approvals', 'stats', 'users', 'user'); },
  });
  if (!data) return <Spinner />;
  return (
    <div className="card stack">
      <ErrorBox error={decide.error} />
      {!data.approvals.length ? <Empty>No requests yet</Empty> : <div className="table-wrap"><table>
        <thead><tr><th>Request</th><th>Member</th><th>Requested by</th><th>Status</th><th /></tr></thead>
        <tbody>{data.approvals.map((a) => (
          <tr key={a.id}><td><b>{titleCase(a.kind)}</b>{a.amount ? (a.kind === 'TREASURY_FUND' ? ` · ${rs(a.amount)}` : ` · ${fmt(a.amount)} pts`) : ''}<br /><small>{a.reason}</small></td>
            <td>{a.user_name ?? 'Treasury'}<br /><small>{a.user_email}</small></td><td>{a.requested_by_email}<br /><small>{when(a.created_at)}</small></td>
            <td><span className={`badge ${a.status === 'EXECUTED' ? 'ok' : a.status === 'REJECTED' ? 'bad' : 'warn'}`}>{titleCase(a.status)}</span>{a.decided_by_email && <><br /><small>by {a.decided_by_email}</small></>}</td>
            <td>{a.status === 'PENDING' && canWrite && (a.requested_by === user.id
              ? <small className="muted">Awaiting another admin</small>
              : <div className="row"><button className="small primary" disabled={decide.isPending} onClick={() => decide.mutate({ id: a.id, action: 'approve' })}>Approve</button>
                <button className="small" disabled={decide.isPending} onClick={() => decide.mutate({ id: a.id, action: 'reject' })}>Reject</button></div>)}</td></tr>))}</tbody></table></div>}
    </div>
  );
}

function Treasury({ canWrite }) {
  const inv = useInvalidate(); const toast = useToast();
  const { data: t } = useQuery({ queryKey: ['admin', 'treasury'], queryFn: () => api('/admin/treasury') });
  const [amt, setAmt] = useState(''); const [reason, setReason] = useState('');
  const fund = useMutation({
    mutationFn: () => post('/admin/approvals', { kind: 'TREASURY_FUND', amountPaise: Math.round(parseFloat(amt) * 100), reason }),
    onSuccess: () => { toast('Funding request sent for a second admin to approve', 'ok'); setAmt(''); setReason(''); inv('approvals', 'stats'); },
  });
  if (!t) return <Spinner />;
  const cards = [['Treasury (reward pool)', rs(t.treasuryPaise)], ['Owed if all points converted', rs(t.pointsLiabilityPaise)], ['Coverage', t.coverage === null ? '—' : t.coverage >= 10 ? '10×+' : `${Math.round(t.coverage * 100)}%`],
    ['Member wallets', rs(t.memberWalletsPaise)], ['Paid out so far', rs(t.convertedPaise)], ['Rate', `100 pts = ${rs(t.paisePerPoint * 100)}`]];
  return (
    <div className="stack">
      {t.lowFunds && <div className="alert warn">⚠ The reward pool covers less than 20% of the cash value of members' outstanding points. Request funding before members start converting.</div>}
      <div className="grid g3">{cards.map(([l, v]) => <div key={l} className="card stat"><div className="v" style={{ fontSize: 20 }}>{v}</div><div className="l">{l}</div></div>)}</div>
      <p className={`verified ${t.reconciled ? 'ok' : 'bad'}`}>{t.reconciled ? '✔ Treasury balance matches the replayed ledger' : '⚠ Treasury balance does NOT match the ledger — investigate immediately'}</p>
      <p className="muted" style={{ margin: 0 }}>Conversions are paid from this pool and can never overdraw it. Nobody can withdraw from or edit it — the only way money moves in is an approved funding request.</p>
      {canWrite && <form className="card stack" onSubmit={(e) => { e.preventDefault(); fund.mutate(); }}>
        <h2>Request treasury funding</h2><ErrorBox error={fund.error} />
        <Field label="Amount (₹)"><input type="number" min="1" step="0.01" value={amt} onChange={(e) => setAmt(e.target.value)} required /></Field>
        <Field label="Reason (10+ characters; record the bank transfer reference)"><textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} minLength={10} required /></Field>
        <div><button className="primary" disabled={fund.isPending || reason.trim().length < 10}>Submit for approval</button></div>
      </form>}
    </div>
  );
}

function Catalog({ canWrite }) {
  const inv = useInvalidate();
  const { data } = useQuery({ queryKey: ['admin', 'catalog'], queryFn: () => api('/admin/catalog') });
  const [f, setF] = useState({ sku: '', name: '', emoji: '🎁', pointsCost: '', stock: '' });
  const create = useMutation({
    mutationFn: () => post('/admin/catalog', { sku: f.sku, name: f.name, emoji: f.emoji, pointsCost: Number(f.pointsCost), stock: f.stock === '' ? null : Number(f.stock) }),
    onSuccess: () => { setF({ sku: '', name: '', emoji: '🎁', pointsCost: '', stock: '' }); inv('catalog'); },
  });
  const patch = useMutation({ mutationFn: ({ id, ...b }) => api(`/admin/catalog/${id}`, { method: 'PATCH', body: b }), onSuccess: () => inv('catalog') });
  if (!data) return <Spinner />;
  return (
    <div className="stack">
      {canWrite && <form className="card stack" onSubmit={(e) => { e.preventDefault(); create.mutate(); }}>
        <h2>Add reward</h2><ErrorBox error={create.error} />
        <div className="grid g4">
          <Field label="SKU"><input value={f.sku} onChange={(e) => setF({ ...f, sku: e.target.value })} required /></Field>
          <Field label="Name"><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required /></Field>
          <Field label="Points cost"><input type="number" min="1" value={f.pointsCost} onChange={(e) => setF({ ...f, pointsCost: e.target.value })} required /></Field>
          <Field label="Stock (blank = unlimited)"><input type="number" min="0" value={f.stock} onChange={(e) => setF({ ...f, stock: e.target.value })} /></Field>
        </div><div><button className="primary" disabled={create.isPending}>Add reward</button></div>
      </form>}
      <div className="card table-wrap"><ErrorBox error={patch.error} /><table>
        <thead><tr><th>Reward</th><th className="num">Cost</th><th className="num">Stock</th><th>Status</th><th /></tr></thead>
        <tbody>{data.items.map((i) => <tr key={i.id}><td>{i.emoji} {i.name}<br /><small className="mono">{i.sku}</small></td><td className="num">{fmt(i.points_cost)}</td><td className="num">{i.stock ?? '∞'}</td>
          <td><span className={`badge ${i.active ? 'ok' : 'bad'}`}>{i.active ? 'Live' : 'Hidden'}</span></td>
          <td>{canWrite && <div className="row"><button className="small" onClick={() => patch.mutate({ id: i.id, active: !i.active })}>{i.active ? 'Hide' : 'Show'}</button>
            <button className="small" onClick={() => { const s = prompt('New stock (blank = unlimited)', i.stock ?? ''); if (s !== null) patch.mutate({ id: i.id, stock: s === '' ? null : Number(s) }); }}>Stock</button></div>}</td></tr>)}</tbody></table></div>
    </div>
  );
}

function Audit() {
  const { data } = useQuery({ queryKey: ['admin', 'audit'], queryFn: () => api('/admin/audit-log?limit=100') });
  if (!data) return <Spinner />;
  return (
    <div className="card table-wrap">
      <p className="muted" style={{ marginTop: 0 }}>Immutable: the database rejects any edit or delete of these rows.</p>
      <table><thead><tr><th>When</th><th>Admin</th><th>Action</th><th>Details</th></tr></thead>
        <tbody>{data.entries.map((e) => <tr key={e.id}><td>{when(e.created_at)}</td><td>{e.actor_email}</td><td><span className="badge">{titleCase(e.action)}</span></td>
          <td className="mono">{JSON.stringify(e.details).slice(0, 110)}</td></tr>)}</tbody></table>
    </div>
  );
}

export default function Admin() {
  const { user } = useAuth(); const [tab, setTab] = useState('overview');
  const canWrite = user.role === 'ADMIN';
  const tabs = [['overview', 'Overview'], ['treasury', 'Treasury'], ['users', 'Members'], ['approvals', 'Approvals'], ['catalog', 'Rewards catalog'], ['audit', 'Audit log']];
  return (
    <div className="stack">
      <div className="row between"><h1>Admin console</h1>{!canWrite && <span className="badge warn">Auditor · read-only</span>}</div>
      <div className="tabs">{tabs.map(([k, l]) => <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{l}</button>)}</div>
      {tab === 'overview' && <Overview />}{tab === 'treasury' && <Treasury canWrite={canWrite} />}{tab === 'users' && <Users canWrite={canWrite} />}{tab === 'approvals' && <Approvals canWrite={canWrite} />}
      {tab === 'catalog' && <Catalog canWrite={canWrite} />}{tab === 'audit' && <Audit />}
    </div>
  );
}
