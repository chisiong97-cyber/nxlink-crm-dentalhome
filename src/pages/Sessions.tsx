import { useEffect, useState } from 'react';
import { Loader2, RefreshCw, Radio, X, CheckCircle2, AlertCircle, Clock } from 'lucide-react';

interface Session {
  session_id: string;
  flow_name: string | null;
  channel: string | null;
  nxlink_status: number | null;
  session_status: 'open' | 'ended' | 'abandoned';
  lead_status: string;
  started_at: string | null;
  first_customer_msg_at: string | null;
  first_message: string | null;
  last_customer_msg_at: string | null;
  ended_at: string | null;
  reopened_at: string | null;
  customer_name: string | null;
  phone_number: string | null;
  preferred_branch: string | null;
  preferred_date: string | null;
  preferred_treatment: string | null;
  summary: string | null;
  sentiment: string | null;
  next_steps: string | null;
  tags: string | null;
  lark_created_at: string | null;
  lark_updated_at: string | null;
  lark_attempts: number;
  lark_error: string | null;
}

const REFRESH_MS = 15000;

function formatMyt(iso: string | null) {
  if (!iso) return '—';
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kuala_Lumpur', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false
  }).format(new Date(iso));
}

function parseTags(json: string | null): string[] {
  try {
    return json ? JSON.parse(json) : [];
  } catch {
    return [];
  }
}

const statusStyles: Record<string, string> = {
  open: 'bg-sky-100 text-sky-800',
  ended: 'bg-slate-100 text-slate-700',
  abandoned: 'bg-amber-100 text-amber-800'
};

const leadStyles: Record<string, string> = {
  Emergency: 'bg-purple-100 text-purple-800',
  Hot: 'bg-red-100 text-red-700',
  Warm: 'bg-orange-100 text-orange-700',
  Cold: 'bg-blue-50 text-blue-700'
};

function LarkCell({ s }: { s: Session }) {
  if (!s.first_customer_msg_at) return <span className="text-slate-400">Not sent (no reply)</span>;
  if (s.lark_error && (!s.lark_created_at || !s.lark_updated_at)) {
    return (
      <span className="flex items-center text-red-700" title={s.lark_error}>
        <AlertCircle size={13} className="mr-1" /> Failed ×{s.lark_attempts}
      </span>
    );
  }
  if (s.lark_updated_at) return <span className="flex items-center text-emerald-700"><CheckCircle2 size={13} className="mr-1" /> Created + Updated</span>;
  if (s.lark_created_at) return <span className="flex items-center text-emerald-700"><CheckCircle2 size={13} className="mr-1" /> Created</span>;
  return <span className="flex items-center text-slate-500"><Clock size={13} className="mr-1" /> Pending</span>;
}

export default function Sessions() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [selected, setSelected] = useState<Session | null>(null);

  const fetchSessions = async () => {
    try {
      const resp = await fetch('/api/sessions');
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
      setSessions(data.sessions || []);
    } catch (e: any) {
      setNotice(`❌ Could not load sessions: ${e.message}`);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchSessions();
    const timer = setInterval(fetchSessions, REFRESH_MS);
    return () => clearInterval(timer);
  }, []);

  const triggerSync = async () => {
    setSyncing(true);
    setNotice(null);
    try {
      const resp = await fetch('/api/sync-sessions');
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
      const w = data.webhooks || {};
      setNotice(
        `✅ Sync done: ${data.listed} session(s) checked, ${data.transcriptsFetched} transcript(s) read, ` +
        `Lark created ${w.created || 0} / updated ${w.updated || 0} / failed ${w.failed || 0}` +
        (data.larkConfigured ? '' : ' (Lark webhooks not configured)') +
        (data.dryRun ? ' — DRY RUN, nothing saved' : '')
      );
      await fetchSessions();
    } catch (e: any) {
      setNotice(`❌ Sync failed: ${e.message}`);
    } finally {
      setSyncing(false);
    }
  };

  return (
    <div className="space-y-6 pb-16 md:pb-6">
      {notice && (
        <div className="p-3 bg-slate-900 text-white rounded-xl text-xs font-heading font-bold shadow-lg flex items-center justify-between">
          <span>{notice}</span>
          <button onClick={() => setNotice(null)} className="text-white hover:text-slate-300 cursor-pointer"><X size={16} /></button>
        </div>
      )}

      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold font-heading text-slate-900 tracking-tight flex items-center">
            <Radio size={24} className="mr-2 text-emerald-600" />
            Sessions
          </h1>
          <p className="text-xs text-slate-500 mt-1">NxLink sessions tracked by the new D1 sync. Refreshes every 15s; the server cron syncs every 2 min.</p>
        </div>
        <button
          disabled={syncing}
          onClick={triggerSync}
          className="py-2 px-3.5 bg-transparent border border-emerald-600 hover:bg-emerald-50/60 text-emerald-700 font-heading text-xs font-bold rounded-lg transition-colors flex items-center justify-center space-x-1.5 shadow-2xs cursor-pointer disabled:opacity-50 self-start"
        >
          {syncing ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
          <span>Sync now</span>
        </button>
      </div>

      <div className="bg-white border border-slate-200 rounded-xl shadow-2xs overflow-hidden">
        {loading ? (
          <div className="py-20 text-center"><Loader2 className="w-8 h-8 text-emerald-600 animate-spin mx-auto" /></div>
        ) : sessions.length === 0 ? (
          <div className="py-16 text-center text-slate-500 text-xs">No sessions yet. Start a chat, then press Sync now.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-50 text-slate-600 font-heading border-b border-slate-200">
                <tr>
                  <th className="px-3 py-2.5">Customer</th>
                  <th className="px-3 py-2.5">Session</th>
                  <th className="px-3 py-2.5">Status</th>
                  <th className="px-3 py-2.5">Lead</th>
                  <th className="px-3 py-2.5">Started</th>
                  <th className="px-3 py-2.5">First Message</th>
                  <th className="px-3 py-2.5">Tags</th>
                  <th className="px-3 py-2.5">Lark</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {sessions.map((s) => (
                  <tr key={s.session_id} onClick={() => setSelected(s)} className="hover:bg-slate-50 cursor-pointer">
                    <td className="px-3 py-2.5">
                      <div className="font-bold text-slate-900">{s.customer_name || '—'}</div>
                      <div className="font-mono text-slate-500">{s.phone_number || ''}</div>
                    </td>
                    <td className="px-3 py-2.5 font-mono text-slate-600">{s.session_id}<div className="text-slate-400">{s.channel}</div></td>
                    <td className="px-3 py-2.5"><span className={`px-1.5 py-0.5 rounded font-bold capitalize ${statusStyles[s.session_status] || ''}`}>{s.session_status}</span></td>
                    <td className="px-3 py-2.5"><span className={`px-1.5 py-0.5 rounded font-bold ${leadStyles[s.lead_status] || ''}`}>{s.lead_status}</span></td>
                    <td className="px-3 py-2.5 font-mono text-slate-600 whitespace-nowrap">{formatMyt(s.started_at)}</td>
                    <td className="px-3 py-2.5 text-slate-700 max-w-xs truncate" title={s.first_message || ''}>{s.first_message || '—'}</td>
                    <td className="px-3 py-2.5 text-slate-700">{parseTags(s.tags).join(', ') || '—'}</td>
                    <td className="px-3 py-2.5 whitespace-nowrap"><LarkCell s={s} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {selected && (
        <div className="fixed inset-0 bg-slate-900/40 z-50 flex justify-end" onClick={() => setSelected(null)}>
          <div className="bg-white w-full max-w-md h-full overflow-y-auto p-5 space-y-4 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <h2 className="font-heading font-bold text-slate-900">Session {selected.session_id}</h2>
              <button onClick={() => setSelected(null)} className="text-slate-500 hover:text-slate-900 cursor-pointer"><X size={18} /></button>
            </div>
            <dl className="text-xs space-y-2">
              {([
                ['Customer', selected.customer_name],
                ['Phone', selected.phone_number],
                ['Status', `${selected.session_status} (NxLink status ${selected.nxlink_status ?? '—'})`],
                ['Lead', selected.lead_status],
                ['Flow / Channel', `${selected.flow_name || '—'} / ${selected.channel || '—'}`],
                ['Started', formatMyt(selected.started_at)],
                ['First reply', formatMyt(selected.first_customer_msg_at)],
                ['Last reply', formatMyt(selected.last_customer_msg_at)],
                ['Ended', formatMyt(selected.ended_at)],
                ['Reopened', formatMyt(selected.reopened_at)],
                ['First message', selected.first_message],
                ['Tags', parseTags(selected.tags).join(', ')],
                ['Summary', selected.summary],
                ['Branch', selected.preferred_branch],
                ['Preferred date', selected.preferred_date],
                ['Treatment', selected.preferred_treatment],
                ['Sentiment', selected.sentiment],
                ['Next steps', selected.next_steps],
                ['Lark created', formatMyt(selected.lark_created_at)],
                ['Lark updated', formatMyt(selected.lark_updated_at)],
                ['Lark error', selected.lark_error]
              ] as [string, string | null][]).map(([label, value]) => (
                <div key={label} className="grid grid-cols-3 gap-2">
                  <dt className="text-slate-500 font-semibold">{label}</dt>
                  <dd className="col-span-2 text-slate-900 break-words">{value || '—'}</dd>
                </div>
              ))}
            </dl>
          </div>
        </div>
      )}
    </div>
  );
}
