import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { api, downloadCsv } from '../api.js';
import { Empty, Spinner, fmt, titleCase, useToast, when } from '../ui.jsx';
import { LedgerSeal } from './Dashboard.jsx';

export default function Activity() {
  const toast = useToast();
  const q = useInfiniteQuery({
    queryKey: ['statement', 'all'], initialPageParam: null,
    queryFn: ({ pageParam }) => api(`/wallet/statement?limit=25${pageParam ? `&before=${pageParam}` : ''}`),
    getNextPageParam: (last) => last.nextBefore,
  });
  const { data: audit, refetch, isFetching } = useQuery({ queryKey: ['audit'], queryFn: () => api('/wallet/audit') });
  const items = q.data?.pages.flatMap((p) => p.items) ?? [];
  return (
    <div className="stack">
      <div className="row between"><div><h1>Activity</h1><LedgerSeal /></div>
        <div className="row">
          <button onClick={() => refetch()} disabled={isFetching}>{isFetching ? 'Checking…' : 'Re-verify ledger'}</button>
          <button onClick={() => downloadCsv().catch((e) => toast(e.message, 'error'))}>⬇ Export CSV</button>
        </div></div>
      <p className="muted" style={{ margin: 0 }}>Your history is append-only: entries are never edited or deleted — mistakes are fixed with a visible reversing entry. Each entry is cryptographically chained to the one before it{audit && ` (${audit.entries} checked just now)`}.</p>
      <div className="card">
        {q.isLoading ? <Spinner /> : !items.length ? <Empty>Nothing here yet</Empty> : <div className="table-wrap"><table>
          <thead><tr><th>#</th><th>Date</th><th>Description</th><th className="num">Points</th><th className="num">Balance</th></tr></thead>
          <tbody>{items.map((e) => (
            <tr key={e.seq}><td className="muted">{e.seq}</td><td>{when(e.created_at)}</td>
              <td>{e.description} <span className="badge">{titleCase(e.kind)}</span>{e.reversed && <> <span className="badge warn">Reversed</span></>}</td>
              <td className={`num ${e.direction === 'CREDIT' ? 'credit' : 'debit'}`}>{e.direction === 'CREDIT' ? '+' : '−'}{fmt(e.amount)}</td>
              <td className="num">{fmt(e.balance_after)}</td></tr>))}</tbody></table></div>}
        {q.hasNextPage && <div style={{ textAlign: 'center', marginTop: 12 }}><button onClick={() => q.fetchNextPage()} disabled={q.isFetchingNextPage}>Load older</button></div>}
      </div>
    </div>
  );
}
