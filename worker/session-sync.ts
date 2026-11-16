import { Env } from './types';
import { getVerifiedNxlinkToken } from './nxlink-auth';
import { extractSummaryMetadata, resolveChannel } from './summary';

// Session-lead pipeline: NxLink AI Conversations -> D1 -> Lark.
//   1. A session gets a Cold lead in Lark (webhook 1) once the customer sends their first message.
//   2. When NxLink closes it with a verdict, or the customer goes quiet past the cutoff, Lark is updated (webhook 2).
//   3. Abandoned sessions stay watched for a while: if the customer comes back, Lark is told the session is Open again,
//      and updated once more when it ends or goes quiet again.
// NxLink only tags a session when the flow closes it; its 24h inactivity auto-close carries no tags or summary.
// Free-plan budgets: <= 50 outbound fetches and <= 50 D1 queries per run, ~10 ms CPU.

const NXLINK_BASE = 'https://app.nxlink.ai';
const PAGE_SIZE = 50;
const MAX_LIST_PAGES = 3;
const MAX_TRANSCRIPTS_PER_RUN = 6; // transcripts are large JSON; keeps CPU time inside the free limit
const MAX_WEBHOOKS_PER_RUN = 15;
const MAX_LARK_ATTEMPTS = 20;
const D1_MAX_PARAMS = 100;
const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;
const FIRST_REPLY_FAST_MS = 15 * 60 * 1000;
const FIRST_REPLY_RECHECK_MS = 10 * 60 * 1000;

const NXLINK_CLOSED = 2;

// NxLink tag -> Lark "Lead Status"; first match wins. The demo tenant prefixes tags with "DH - ",
// tenant 4600 doesn't, so the prefix is stripped before matching
const LEAD_TAGS: [string, string][] = [
  ['emergency', 'Emergency'],
  ['hot lead', 'Hot'],
  ['warm lead', 'Warm'],
  ['cold lead', 'Cold']
];

// Lark's "Preferred Branch" dropdown options and the ways customers and the bot refer to each branch.
// Lark adds any unknown text as a new option, so only these exact names (or blank) are ever sent.
const BRANCHES: [string, RegExp][] = [
  ['Rio Bandar Puteri Puchong', /\brio\b|bandar puteri/],
  ['Bukit Jalil Link 2', /\blink ?2\b|bukit jalil link/],
  ['16 Sierra Puchong', /\bsierra\b/],
  ['KLGCC Mall Mont Kiara', /\bklgcc\b|mont ?kiara|\bkiara\b/],
  ['Pavilion 2 Bukit Jalil', /\bpavilion\b/]
];

type SessionStatus = 'open' | 'ended' | 'abandoned';

interface SessionRow {
  session_id: string;
  flow_name: string | null;
  channel: string | null;
  nxlink_status: number | null;
  session_status: SessionStatus;
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
  transcript_checked_at: string | null;
  lark_created_at: string | null;
  lark_updated_at: string | null;
  lark_attempts: number;
  lark_error: string | null;
}

const COLUMNS: (keyof SessionRow)[] = [
  'session_id', 'flow_name', 'channel', 'nxlink_status', 'session_status', 'lead_status', 'started_at',
  'first_customer_msg_at', 'first_message', 'last_customer_msg_at', 'ended_at', 'reopened_at', 'customer_name', 'phone_number',
  'preferred_branch', 'preferred_date', 'preferred_treatment', 'summary', 'sentiment', 'next_steps', 'tags',
  'transcript_checked_at', 'lark_created_at', 'lark_updated_at', 'lark_attempts', 'lark_error'
];

const UPSERT_SQL =
  `INSERT INTO sessions (${COLUMNS.join(', ')}) VALUES (${COLUMNS.map(() => '?').join(', ')}) ` +
  `ON CONFLICT(session_id) DO UPDATE SET ${COLUMNS.slice(1).map((c) => `${c} = excluded.${c}`).join(', ')}, ` +
  `updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`;

function toIso(ts: any): string | null {
  if (ts === null || ts === undefined || ts === '') return null;
  const ms = typeof ts === 'number' ? (ts > 10000000000 ? ts : ts * 1000) : new Date(ts).getTime();
  return isNaN(ms) ? null : new Date(ms).toISOString();
}

function msOf(iso: string | null, fallback: number): number {
  return iso ? new Date(iso).getTime() : fallback;
}

// Lark and the clinic work in Malaysia time
function formatMyt(iso: string | null): string {
  if (!iso) return 'N/A';
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kuala_Lumpur', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  }).formatToParts(new Date(iso));
  const get = (type: string) => parts.find((p) => p.type === type)?.value || '00';
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour') === '24' ? '00' : get('hour')}:${get('minute')}:${get('second')}`;
}

// Ways the summary model says "unknown"; none of these should land in Lark
const PLACEHOLDERS = /^(n\/?a|none|nil|null|unknown|not (specified|provided|mentioned|stated|available|given)|-+)\.?$/i;

function naToNull(val: string | null | undefined): string | null {
  return !val || PLACEHOLDERS.test(val.trim()) ? null : val;
}

// Same rule as the "Phone Key" formula in Lark's Customer table: digits only, leading 0 -> 60
export function normalizePhone(raw: string | null | undefined): string | null {
  if (!raw || /[a-z]/i.test(raw)) return null; // e.g. NxLink web visitor ids
  let digits = raw.replace(/\D/g, '');
  if (digits.startsWith('0')) digits = `6${digits}`;
  return digits.length >= 9 && digits.length <= 15 ? digits : null;
}

// Exactly one branch must match; "Bukit Jalil" or "Puchong" alone is ambiguous and stays blank
export function normalizeBranch(raw: string | null | undefined): string {
  if (!raw) return '';
  const text = raw.toLowerCase().replace(/[^a-z0-9]+/g, ' ');
  const matches = BRANCHES.filter(([, pattern]) => pattern.test(text));
  return matches.length === 1 ? matches[0][0] : '';
}

function tagNames(conv: any): string[] {
  if (!Array.isArray(conv?.tags)) return [];
  return conv.tags.map((t: any) => (typeof t === 'string' ? t : t?.name)).filter(Boolean);
}

function parseTags(json: string | null): string[] {
  try {
    return json ? JSON.parse(json) : [];
  } catch (e) {
    return [];
  }
}

function leadFromTags(tags: string[]): string {
  const lower = tags.map((t) => t.trim().toLowerCase().replace(/^dh\s*-\s*/, ''));
  for (const [tag, lead] of LEAD_TAGS) if (lower.includes(tag)) return lead;
  return 'Cold';
}

function parseMsgInfo(m: any): any {
  try {
    return typeof m?.msgInfo === 'string' ? JSON.parse(m.msgInfo) : m?.msgInfo;
  } catch (e) {
    return null;
  }
}

// What a transcript tells us beyond the conversation list: customer activity and the flow's own close/verdict
function readTranscript(messages: any[]) {
  const result = {
    firstAt: null as string | null,
    firstText: null as string | null,
    lastCustomerAt: null as string | null,
    tags: [] as string[],
    summary: null as string | null,
    closedByFlow: false,
    botBranch: '' // branch named in Lisa's latest booking recap ("Branch: …")
  };
  for (const m of messages) {
    if (m?.direction === 1) {
      const at = toIso(Number(m.createTs));
      if (!result.firstAt) {
        result.firstAt = at;
        result.firstText = parseMsgInfo(m)?.message?.text?.trim() || null;
      }
      if (at && (!result.lastCustomerAt || at > result.lastCustomerAt)) result.lastCustomerAt = at;
    } else if (m?.msgType === 63) {
      const tag = parseMsgInfo(m)?.tag;
      try {
        const list = typeof tag === 'string' ? JSON.parse(tag) : tag;
        if (Array.isArray(list)) result.tags.push(...list.filter((t: any) => typeof t === 'string'));
      } catch (e) {}
    } else if (m?.msgType === 64) {
      result.summary = parseMsgInfo(m)?.summarize?.trim() || result.summary;
    } else if (m?.msgType === 223) {
      result.closedByFlow = true;
    } else if (m?.msgType === 35) {
      const recap = /Branch\s*:\s*([^\n]+)/i.exec(parseMsgInfo(m)?.message?.text || '');
      if (recap) result.botBranch = normalizeBranch(recap[1]) || result.botBranch;
    }
  }
  return result;
}

function newRow(id: string): SessionRow {
  return {
    session_id: id, flow_name: null, channel: null, nxlink_status: null, session_status: 'open', lead_status: 'Cold',
    started_at: null, first_customer_msg_at: null, first_message: null, last_customer_msg_at: null, ended_at: null, reopened_at: null,
    customer_name: null, phone_number: null, preferred_branch: null, preferred_date: null, preferred_treatment: null,
    summary: null, sentiment: null, next_steps: null, tags: null, transcript_checked_at: null,
    lark_created_at: null, lark_updated_at: null, lark_attempts: 0, lark_error: null
  };
}

async function fetchConversationPage(token: string, page: number): Promise<any[]> {
  const resp = await fetch(`${NXLINK_BASE}/admin/nx_flow_manager/conversation`, {
    method: 'POST',
    headers: { authorization: token, 'content-type': 'application/json' },
    body: JSON.stringify({ phone: null, tags: [], page_number: page, page_size: PAGE_SIZE, timeZone: 'UTC+08:00' })
  });
  if (!resp.ok) throw new Error(`Failed to fetch conversations from NXLINK (HTTP ${resp.status})`);
  const data: any = await resp.json();
  const list = data.list || data.data?.list || data.data || [];
  return Array.isArray(list) ? list : [];
}

async function fetchMessages(token: string, convId: string): Promise<any[] | null> {
  const resp = await fetch(
    `${NXLINK_BASE}/admin/nx_flow_manager/conversation/messages?pageSize=9999&pageNumber=1&conversationId=${convId}`,
    { headers: { authorization: token } }
  );
  if (!resp.ok) return null;
  const data: any = await resp.json().catch(() => null);
  const list = data?.data || data?.list;
  return Array.isArray(list) ? list : null;
}

// Older summaries only name the branch in the prose; a single unambiguous mention is good enough
function branchFor(row: SessionRow): string {
  return normalizeBranch(row.preferred_branch) || normalizeBranch(row.summary);
}

function createdPayload(row: SessionRow) {
  return {
    'Session ID': row.session_id,
    Event: 'created',
    'Lead Status': 'Cold',
    'Session Status': 'Open',
    Source: row.channel || 'Webchat',
    Flow: row.flow_name || 'N/A',
    'Started At': formatMyt(row.started_at),
    'First Message': row.first_message || '',
    // Usually unknown this early (WhatsApp gives the phone); sent blank so Lark shows an empty cell, not "N/A"
    'Patient Name': row.customer_name || '',
    'Phone Number': row.phone_number || '',
    'Preferred Branch': branchFor(row),
    'Preferred Date': row.preferred_date || '',
    'Preferred Treatment': row.preferred_treatment || ''
  };
}

// Lark overwrites a column with whatever the webhook sends, so unknown values are left out
// rather than sent blank (or N/A) on top of something staff typed in
function withoutBlanks(payload: Record<string, string>) {
  return Object.fromEntries(Object.entries(payload).filter(([, v]) => v && v !== 'N/A'));
}

function updatedPayload(row: SessionRow) {
  return withoutBlanks({
    'Session ID': row.session_id,
    Event: row.session_status === 'open' ? 'reopened' : row.session_status,
    'Lead Status': row.lead_status,
    'Session Status': row.session_status === 'abandoned' ? 'Abandoned' : row.session_status === 'open' ? 'Open' : 'Ended',
    'Ended At': formatMyt(row.ended_at),
    'Last Customer Message At': formatMyt(row.last_customer_msg_at),
    'Patient Name': row.customer_name || 'N/A',
    'Phone Number': row.phone_number || 'N/A',
    'Preferred Branch': branchFor(row),
    'Preferred Date': row.preferred_date || 'N/A',
    'Preferred Treatment': row.preferred_treatment || 'N/A',
    'Full Summary': row.summary || 'N/A',
    Sentiment: row.sentiment || 'N/A',
    'Next Steps': row.next_steps || 'N/A',
    Tags: parseTags(row.tags).join(', ')
  });
}

export async function runSessionSync(env: Env) {
  const db = env.DB;
  if (!db) throw new Error('D1 binding DB is missing.');

  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const dryRun = env.DRY_RUN === 'true';
  const expectedTenantId = Number(env.NXLINK_TENANT_ID || 4600);
  const flowFilter = (env.NXLINK_FLOW_NAME || '').trim().toLowerCase();
  // Customer silence (since their last message) before an open session is treated as abandoned
  const abandonAfterMs = Number(env.ABANDON_AFTER_MINUTES || 120) * 60 * 1000;
  const verdictWaitMs = Number(env.VERDICT_WAIT_MINUTES || 15) * 60 * 1000;
  // How long after the last customer message an abandoned session is still re-checked, and how often
  const watchMs = Number(env.WATCH_HOURS || 30) * 60 * 60 * 1000;
  const watchRecheckMs = Number(env.WATCH_RECHECK_MINUTES || 60) * 60 * 1000;
  const retentionDays = Number(env.RETENTION_DAYS || 365);
  // Gives Lark's "Add record" automation time to finish before the "Update record" one looks for the row
  const larkUpdateDelayMs = Number(env.LARK_UPDATE_DELAY_SECONDS || 60) * 1000;
  const larkCreatedUrl = env.LARK_CREATED_WEBHOOK_URL || '';
  const larkUpdatedUrl = env.LARK_UPDATED_WEBHOOK_URL || '';
  const watchFrom = new Date(now - watchMs).toISOString();

  const token = await getVerifiedNxlinkToken(env, expectedTenantId);

  // Sync state + sessions that still need work, in one D1 round trip
  const [stateRes, queueRes] = await db.batch([
    db.prepare(`SELECT key, value FROM sync_state WHERE key IN ('last_seen_started_at', 'last_cleanup_at', 'sync_started_at')`),
    db.prepare(
      `SELECT * FROM sessions WHERE session_status = 'open'
       OR (session_status IN ('ended', 'abandoned') AND lark_updated_at IS NULL AND first_customer_msg_at IS NOT NULL)
       OR (session_status = 'abandoned' AND last_customer_msg_at > ?)`
    ).bind(watchFrom)
  ]);
  const state = new Map<string, string>((stateRes.results as any[]).map((r) => [r.key, r.value]));
  const watermark = state.get('last_seen_started_at') || null;
  // Sessions that started before the first run are history: never sent to Lark, so a fresh deploy can't flood it
  const syncStartedAt = env.SYNC_START_AT || state.get('sync_started_at') || nowIso;

  // 1. Newest conversations; page back to the last session seen (catch-up after an outage)
  const listed = new Map<string, any>();
  let newestStarted = watermark;
  for (let page = 1; page <= MAX_LIST_PAGES; page++) {
    const list = await fetchConversationPage(token, page);
    for (const conv of list) {
      const startedAt = toIso(conv.created_at || conv.createdAt);
      if (startedAt && (!newestStarted || startedAt > newestStarted)) newestStarted = startedAt;
      const flow = String(conv.auto_flow_name || conv.autoFlowName || '').toLowerCase();
      if (flowFilter && !flow.includes(flowFilter)) continue;
      if (!startedAt || startedAt < syncStartedAt) continue;
      const id = String(conv.id || conv.conversationId || '');
      if (id && !listed.has(id)) listed.set(id, conv);
    }
    const oldest = toIso(list[list.length - 1]?.created_at);
    if (!watermark || list.length < PAGE_SIZE || (oldest && oldest <= watermark)) break;
  }

  // 2. Load D1 rows for every listed session (chunked under D1's bound-parameter limit)
  const rows = new Map<string, SessionRow>();
  for (const r of queueRes.results as any[]) rows.set(r.session_id, r as SessionRow);
  const missing = [...listed.keys()].filter((id) => !rows.has(id));
  const lookups: D1PreparedStatement[] = [];
  for (let i = 0; i < missing.length; i += D1_MAX_PARAMS) {
    const chunk = missing.slice(i, i + D1_MAX_PARAMS);
    lookups.push(db.prepare(`SELECT * FROM sessions WHERE session_id IN (${chunk.map(() => '?').join(', ')})`).bind(...chunk));
  }
  if (lookups.length) {
    for (const res of await db.batch(lookups)) {
      for (const r of res.results as any[]) rows.set(r.session_id, r as SessionRow);
    }
  }

  const before = new Map<string, string>([...rows].map(([id, r]) => [id, JSON.stringify(r)]));
  const actions: { session_id: string; action: string }[] = [];
  const log = (id: string, action: string) => actions.push({ session_id: id, action });

  // NxLink's verdict (tags + summary) can arrive after the session closes; resend webhook 2 when it changes
  // The summary is one labelled string ("Customer Sentiment: … Conversation Summary: … Preferred Branch: …");
  // split it into fields so "Full Summary" holds only the summary text
  const applyVerdict = (row: SessionRow, tags: string[], rawSummary: string | null) => {
    const tagsJson = tags.length ? JSON.stringify(tags) : row.tags;
    const parsed = rawSummary ? extractSummaryMetadata([], { conv_summary: rawSummary }) : null;
    // Unlabelled summaries (older prompt versions) are kept whole
    const newSummary = parsed ? naToNull(parsed.conversation_summary) || rawSummary : row.summary;
    if (tagsJson === row.tags && newSummary === row.summary) return;
    row.tags = tagsJson;
    row.summary = newSummary;
    row.lead_status = leadFromTags(parseTags(tagsJson));
    if (parsed) {
      row.sentiment = naToNull(parsed.customer_sentiment) || row.sentiment;
      row.next_steps = naToNull(parsed.next_steps) || row.next_steps;
      row.customer_name = naToNull(parsed.customer_name) || row.customer_name;
      row.phone_number = normalizePhone(naToNull(parsed.phone_number)) || row.phone_number;
      row.preferred_branch = naToNull(parsed.preferred_branch) || row.preferred_branch;
      row.preferred_date = naToNull(parsed.preferred_date) || row.preferred_date;
      row.preferred_treatment = naToNull(parsed.preferred_treatment) || row.preferred_treatment;
    }
    // Store the canonical Lark branch name (or nothing) so the portal shows what Lark receives
    row.preferred_branch = branchFor(row) || null;
    if (row.lark_updated_at) {
      row.lark_updated_at = null;
      log(row.session_id, 'verdict changed, Lark update queued again');
    }
  };

  const applyDetails = (row: SessionRow, messages: any[], conv: any) => {
    const meta = extractSummaryMetadata(messages, conv || {});
    row.customer_name = naToNull(meta.customer_name) || row.customer_name;
    row.phone_number = normalizePhone(naToNull(meta.phone_number)) || row.phone_number;
    row.preferred_branch = naToNull(meta.preferred_branch) || row.preferred_branch;
    row.preferred_date = naToNull(meta.preferred_date) || row.preferred_date;
    row.preferred_treatment = naToNull(meta.preferred_treatment) || row.preferred_treatment;
    row.sentiment = naToNull(meta.customer_sentiment) || row.sentiment;
    row.next_steps = naToNull(meta.next_steps) || row.next_steps;
    row.summary = row.summary || naToNull(meta.conversation_summary);
    row.preferred_branch = branchFor(row) || null;
  };

  // 3. Reconcile listed sessions with what NxLink reports now
  const closingIds = new Set<string>(); // listed as closed by NxLink and not yet handled
  for (const [id, conv] of listed) {
    let row = rows.get(id);
    if (!row) {
      row = newRow(id);
      rows.set(id, row);
      log(id, 'new session');
    }
    row.flow_name = conv.auto_flow_name || conv.autoFlowName || row.flow_name;
    // Lark's Source options are WA / FB / IG / Webchat (the legacy route calls the web widget "Website")
    const channel = resolveChannel(conv);
    row.channel = channel === 'Website' ? 'Webchat' : channel;
    row.started_at = toIso(conv.created_at || conv.createdAt) || row.started_at;
    // WhatsApp sessions carry the customer's number from the start
    row.phone_number = row.phone_number || normalizePhone(conv.customer_phone);
    applyVerdict(row, tagNames(conv), conv.conv_summary?.trim() || null);

    // An abandoned session's close is recorded only after its transcript was read for a late verdict
    if (conv.status === NXLINK_CLOSED && row.nxlink_status !== NXLINK_CLOSED && row.session_status !== 'ended') {
      closingIds.add(id);
    } else {
      row.nxlink_status = conv.status ?? row.nxlink_status;
    }
  }

  // 4. Decide which transcripts to read: closing sessions first, then the inactivity check, first replies, watched ones
  type Reason = 'closing' | 'silence' | 'first_message' | 'watch';
  const priority: Record<Reason, number> = { closing: 0, silence: 1, first_message: 2, watch: 3 };
  const needs: { row: SessionRow; reason: Reason }[] = [];
  for (const row of rows.values()) {
    const lastActivityMs = msOf(row.last_customer_msg_at || row.first_customer_msg_at || row.started_at, now);
    if (closingIds.has(row.session_id)) {
      needs.push({ row, reason: 'closing' });
    } else if (row.session_status === 'open' && !row.first_customer_msg_at) {
      // Every run while the chat is new, then less often: most unanswered greetings never get a reply
      const isNew = now - msOf(row.started_at, now) < FIRST_REPLY_FAST_MS;
      if (isNew || now - msOf(row.transcript_checked_at, 0) >= FIRST_REPLY_RECHECK_MS) needs.push({ row, reason: 'first_message' });
    } else if (row.session_status === 'open' && now - lastActivityMs > abandonAfterMs) {
      // Confirm the silence against the transcript: the customer may have written since we last looked
      needs.push({ row, reason: 'silence' });
    } else if (
      row.session_status === 'abandoned' && row.first_customer_msg_at && row.nxlink_status !== NXLINK_CLOSED &&
      now - lastActivityMs < watchMs && now - msOf(row.transcript_checked_at, 0) >= watchRecheckMs
    ) {
      needs.push({ row, reason: 'watch' });
    }
  }
  needs.sort((a, b) =>
    a.reason === b.reason
      ? String(b.row.started_at).localeCompare(String(a.row.started_at))
      : priority[a.reason] - priority[b.reason]
  );

  // 5. Read transcripts and move sessions between open / ended / abandoned
  let transcriptsFetched = 0;
  const deferredIds = new Set<string>();
  for (const { row, reason } of needs) {
    if (transcriptsFetched >= MAX_TRANSCRIPTS_PER_RUN) {
      deferredIds.add(row.session_id);
      continue;
    }
    const messages = await fetchMessages(token, row.session_id);
    transcriptsFetched++;
    if (!messages) {
      deferredIds.add(row.session_id);
      continue;
    }
    const conv = listed.get(row.session_id);
    const t = readTranscript(messages);
    row.transcript_checked_at = nowIso;
    if (t.firstAt && !row.first_customer_msg_at) {
      row.first_customer_msg_at = t.firstAt;
      row.first_message = t.firstText;
      log(row.session_id, 'first customer message');
    }
    const previousLast = row.last_customer_msg_at;
    if (t.lastCustomerAt && (!previousLast || t.lastCustomerAt > previousLast)) row.last_customer_msg_at = t.lastCustomerAt;
    if (t.tags.length || t.summary) applyVerdict(row, t.tags, t.summary);
    // Customers often pick the branch by its list number ("2"), which the summary can't turn into a name;
    // Lisa's booking recap spells it out, so fall back to that
    if (!row.preferred_branch && t.botBranch) {
      row.preferred_branch = t.botBranch;
      if (row.lark_updated_at) {
        row.lark_updated_at = null;
        log(row.session_id, 'branch taken from booking recap, Lark update queued again');
      }
    }

    const hasVerdict = t.tags.length > 0 || Boolean(t.summary) || t.closedByFlow;
    const silentMs = now - msOf(row.last_customer_msg_at || row.started_at, now);

    if (hasVerdict || (reason === 'closing' && row.session_status === 'open')) {
      applyDetails(row, messages, conv);
      if (row.session_status === 'abandoned') log(row.session_id, 'came back and finished');
      row.lark_updated_at = null;
      row.session_status = 'ended';
      row.ended_at = toIso(conv?.updated_at || conv?.updatedAt) || nowIso;
      log(row.session_id, 'ended');
    } else if (row.session_status === 'abandoned' && row.last_customer_msg_at && row.ended_at && row.last_customer_msg_at > row.ended_at) {
      // Customer resumed the same session; Lead Status stays as it was until NxLink gives a verdict
      row.session_status = 'open';
      row.ended_at = null;
      row.reopened_at = nowIso;
      row.lark_updated_at = null;
      log(row.session_id, 'customer came back, reopened');
    } else if (row.session_status === 'open' && row.first_customer_msg_at && silentMs > abandonAfterMs) {
      applyDetails(row, messages, conv);
      row.session_status = 'abandoned';
      row.ended_at = nowIso;
      row.lark_updated_at = null;
      log(row.session_id, 'abandoned (customer silent past cutoff)');
    }
    // NxLink's own close without a verdict (24h auto-close): nothing new to send, stop watching
    if (reason === 'closing') row.nxlink_status = conv?.status ?? row.nxlink_status;
  }

  // Sessions the customer never replied to: abandoned by age, never sent to Lark
  for (const row of rows.values()) {
    if (
      row.session_status === 'open' && !row.first_customer_msg_at && !deferredIds.has(row.session_id) &&
      now - msOf(row.started_at, now) > abandonAfterMs
    ) {
      row.session_status = 'abandoned';
      row.ended_at = nowIso;
      log(row.session_id, 'abandoned (no customer reply)');
    }
  }

  // 6. Lark webhooks: Created once after the first customer message, Updated when the session ends or is reopened
  const webhooks = { created: 0, updated: 0, failed: 0 };
  const larkHeaders = { 'Content-Type': 'application/json' };

  const sendToLark = async (row: SessionRow, url: string, payload: any, kind: 'created' | 'updated') => {
    try {
      const resp = await fetch(url, { method: 'POST', headers: larkHeaders, body: JSON.stringify(payload) });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
      if (kind === 'created') row.lark_created_at = nowIso;
      else row.lark_updated_at = nowIso;
      row.lark_attempts = 0;
      row.lark_error = null;
      webhooks[kind]++;
      log(row.session_id, `Lark ${kind} sent`);
    } catch (err: any) {
      row.lark_attempts = (row.lark_attempts || 0) + 1;
      row.lark_error = `${kind}: ${err.message || err}`.slice(0, 500);
      webhooks.failed++;
      log(row.session_id, `Lark ${kind} failed (attempt ${row.lark_attempts})`);
    }
  };

  let webhookBudget = MAX_WEBHOOKS_PER_RUN;
  for (const row of rows.values()) {
    if (webhookBudget <= 0) break;
    if ((row.lark_attempts || 0) >= MAX_LARK_ATTEMPTS || !row.first_customer_msg_at) continue;

    if (!row.lark_created_at) {
      if (!larkCreatedUrl) continue;
      if (dryRun) log(row.session_id, 'would send Lark created');
      else await sendToLark(row, larkCreatedUrl, createdPayload(row), 'created');
      webhookBudget--;
      continue;
    }

    const finished = row.session_status === 'ended' || row.session_status === 'abandoned';
    const reopened = row.session_status === 'open' && Boolean(row.reopened_at);
    const createdLongEnough = now - new Date(row.lark_created_at).getTime() >= larkUpdateDelayMs;
    const endedMs = msOf(row.ended_at, now);
    const verdictReady = row.session_status === 'abandoned' || parseTags(row.tags).length > 0 || now - endedMs >= verdictWaitMs;
    if ((reopened || (finished && verdictReady)) && !row.lark_updated_at && createdLongEnough && larkUpdatedUrl) {
      if (dryRun) log(row.session_id, 'would send Lark updated');
      else await sendToLark(row, larkUpdatedUrl, updatedPayload(row), 'updated');
      webhookBudget--;
    }
  }

  // 7. Persist only rows that changed, plus sync state and daily retention cleanup, as one batch
  const writes: D1PreparedStatement[] = [];
  for (const [id, row] of rows) {
    if (before.get(id) === JSON.stringify(row)) continue;
    writes.push(db.prepare(UPSERT_SQL).bind(...COLUMNS.map((c) => (row[c] === undefined ? null : row[c]))));
  }
  const upsertState = (key: string, value: string) =>
    db.prepare(
      `INSERT INTO sync_state (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`
    ).bind(key, value);
  if (newestStarted && newestStarted !== watermark) writes.push(upsertState('last_seen_started_at', newestStarted));
  if (!state.has('sync_started_at')) writes.push(upsertState('sync_started_at', syncStartedAt));

  const lastCleanup = state.get('last_cleanup_at');
  if (!lastCleanup || now - new Date(lastCleanup).getTime() > CLEANUP_INTERVAL_MS) {
    const cutoff = new Date(now - retentionDays * 24 * 60 * 60 * 1000).toISOString();
    writes.push(db.prepare(`DELETE FROM sessions WHERE started_at < ?`).bind(cutoff));
    writes.push(upsertState('last_cleanup_at', nowIso));
  }

  const changedRows = writes.length;
  if (!dryRun && writes.length) await db.batch(writes);

  return {
    success: true,
    dryRun,
    larkConfigured: Boolean(larkCreatedUrl && larkUpdatedUrl),
    listed: listed.size,
    transcriptsFetched,
    deferred: deferredIds.size,
    webhooks,
    d1Writes: changedRows,
    actions
  };
}
