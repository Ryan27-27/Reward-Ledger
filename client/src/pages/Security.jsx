import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, post } from '../api.js';
import { useAuth } from '../auth.jsx';
import { ErrorBox, Field, Spinner, useToast, when } from '../ui.jsx';

export default function Security() {
  const qc = useQueryClient(); const toast = useToast(); const { logout } = useAuth();
  const { data, isLoading } = useQuery({ queryKey: ['sessions'], queryFn: () => api('/auth/sessions') });
  const [f, setF] = useState({ currentPassword: '', newPassword: '' });
  const revoke = useMutation({ mutationFn: (id) => api(`/auth/sessions/${id}`, { method: 'DELETE' }), onSuccess: () => qc.invalidateQueries({ queryKey: ['sessions'] }) });
  const change = useMutation({ mutationFn: () => post('/auth/change-password', f), onSuccess: () => { toast('Password changed. Other devices were signed out.', 'ok'); setF({ currentPassword: '', newPassword: '' }); qc.invalidateQueries({ queryKey: ['sessions'] }); } });
  const all = useMutation({ mutationFn: () => post('/auth/logout-all'), onSuccess: () => logout() });
  if (isLoading) return <Spinner />;
  return (
    <div className="stack">
      <h1>Security</h1>
      <div className="grid g2">
        <form className="card stack" onSubmit={(e) => { e.preventDefault(); change.mutate(); }}>
          <h2>Change password</h2><ErrorBox error={change.error && !change.error.fields ? change.error : null} />
          <Field label="Current password"><input type="password" autoComplete="current-password" value={f.currentPassword} onChange={(e) => setF({ ...f, currentPassword: e.target.value })} required /></Field>
          <Field label="New password (10+ characters)" error={change.error?.fields?.newPassword}><input type="password" autoComplete="new-password" minLength={10} value={f.newPassword} onChange={(e) => setF({ ...f, newPassword: e.target.value })} required /></Field>
          <button className="primary" disabled={change.isPending}>Update password</button>
        </form>
        <div className="card stack">
          <h2>Where you're signed in</h2>
          {data.sessions.map((s) => (
            <div key={s.id} className="row between">
              <div><b>{s.current ? 'This device' : (s.user_agent || 'Unknown device').slice(0, 44)}</b><br /><small>{s.ip} · active {when(s.last_used_at)}</small></div>
              {!s.current && <button className="small danger" onClick={() => revoke.mutate(s.id)}>Sign out</button>}
            </div>))}
          <button className="danger" onClick={() => all.mutate()}>Sign out everywhere</button>
        </div>
      </div>
    </div>
  );
}
