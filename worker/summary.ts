// Reads NxLink's labelled summary ("Customer Sentiment: … Preferred Treatment: …") into fields

function parseMsgInfo(m: any): any {
  if (!m || !m.msgInfo) return null;
  if (typeof m.msgInfo === 'object') return m.msgInfo;
  try {
    return String(m.msgInfo).trim().startsWith('{') ? JSON.parse(m.msgInfo) : null;
  } catch (e) {
    return null;
  }
}

// V3 flows have no labelled summary; read answers from the bot's question/customer reply pairs
export function extractTranscriptAnswers(messages: any[]) {
  const answers: { name: string | null; phone: string | null; firstMessage: string | null } = {
    name: null,
    phone: null,
    firstMessage: null
  };
  if (!Array.isArray(messages)) return answers;

  let lastBotText = '';
  for (const m of messages) {
    const text = parseMsgInfo(m)?.message?.text;
    if (typeof text !== 'string' || !text.trim()) continue;

    if (m.msgType === 35) {
      lastBotText = text.toLowerCase();
    } else if (m.msgType === 25) {
      const reply = text.trim();
      if (!answers.firstMessage && reply.toLowerCase() !== 'hi') answers.firstMessage = reply;
      if (!answers.name && /your name/.test(lastBotText)) answers.name = reply;
      if (!answers.phone && /phone|contact number|mobile/.test(lastBotText) && /\d{6,}/.test(reply.replace(/[\s-]/g, ''))) {
        answers.phone = reply;
      }
      lastBotText = '';
    }
  }
  return answers;
}

export function extractSummaryMetadata(messages: any[], conv: any) {
  let sentiment: string | null = null;
  let summary: string | null = null;
  let nextSteps: string | null = null;
  let extractedName: string | null = null;
  let extractedPhone: string | null = null;
  let extractedBranch: string | null = null;
  let extractedDate: string | null = null;
  let extractedTreatment: string | null = null;

  // Labels can come in any order (prompt versions differ, e.g. production adds "Preferred Dentist"),
  // so each value runs from its label to whichever known label comes next
  const SUMMARY_LABELS = [
    'Customer Sentiment', 'Conversation Summary', 'Next Steps', 'Customer Name', 'Phone Number',
    'Preferred Branch', 'Preferred Date', 'Preferred Dentist', 'Preferred Treatment'
  ];
  const parseSummaryText = (text: string) => {
    if (!text) return;
    const found: { label: string; start: number; end: number }[] = [];
    for (const label of SUMMARY_LABELS) {
      const m = new RegExp(`${label}\\s*:`, 'i').exec(text);
      if (m) found.push({ label, start: m.index, end: m.index + m[0].length });
    }
    found.sort((a, b) => a.start - b.start);
    const values: Record<string, string> = {};
    found.forEach((f, i) => {
      const raw = text.slice(f.end, i + 1 < found.length ? found[i + 1].start : text.length);
      values[f.label] = raw.trim().replace(/[.;,]+$/, '').trim();
    });
    const usable = (v?: string) => (v && v.toLowerCase() !== 'n/a' ? v : null);

    if (values['Customer Sentiment'] && !sentiment) sentiment = values['Customer Sentiment'];
    if (values['Conversation Summary'] && !summary) summary = values['Conversation Summary'];
    if (values['Next Steps'] && !nextSteps) nextSteps = values['Next Steps'];
    if (!extractedName) extractedName = usable(values['Customer Name']);
    if (!extractedPhone) extractedPhone = usable(values['Phone Number']);
    if (!extractedBranch) extractedBranch = usable(values['Preferred Branch']);
    if (!extractedDate) extractedDate = usable(values['Preferred Date']);
    if (!extractedTreatment) extractedTreatment = usable(values['Preferred Treatment']);
  };

  if (Array.isArray(messages)) {
    for (const m of messages) {
      if (m && m.msgType === 64 && m.msgInfo) {
        const parsed = parseMsgInfo(m);
        if (parsed && parsed.summarize) parseSummaryText(parsed.summarize);
      }

      if (m && m.msgType === 308 && m.msgInfo) {
        const parsed = parseMsgInfo(m);
        if (parsed && Array.isArray(parsed.branches)) {
          for (const b of parsed.branches) {
            const key = (b.key || b.name || '').toLowerCase();
            const val = b.value ? String(b.value).trim() : '';
            if (val && val.toLowerCase() !== 'n/a') {
              if (key.includes('treatment') && !extractedTreatment) extractedTreatment = val;
              if (key.includes('branch') && !extractedBranch) extractedBranch = val;
              if (key.includes('date') && !extractedDate) extractedDate = val;
              if (key.includes('name') && !extractedName) extractedName = val;
              if (key.includes('phone') && !extractedPhone) extractedPhone = val;
            }
          }
        }
      }
    }
  }

  if (conv.conv_summary) parseSummaryText(conv.conv_summary);
  if (conv.summary) parseSummaryText(conv.summary);

  const cleanField = (val: string | null) => {
    if (!val) return null;
    let s = val.split(/\[nxlink_id:/i)[0].trim();
    s = s
      .replace(/(?:Customer Name|Phone Number|Preferred Branch|Preferred Date|Preferred Dentist|Preferred Treatment):.*$/is, '')
      .replace(/["}'\\\}\],]+$/g, '')
      .trim();
    return s.length > 0 ? s : null;
  };

  const cleanShortField = (val: string | null) => {
    const s = cleanField(val);
    if (!s) return null;
    return s.replace(/\.+$/, '').trim() || null;
  };

  const answers = extractTranscriptAnswers(messages);
  const finalName = extractedName || conv.customer_name || conv.customerName || answers.name || null;
  const finalPhone = extractedPhone || conv.customer_phone || conv.phone || answers.phone || null;
  const finalBranch = extractedBranch || conv.preferred_branch || conv.preferredBranch || null;
  const finalDate = extractedDate || conv.preferred_date || conv.preferredDate || null;
  const finalTreatment = extractedTreatment || conv.preferred_treatment || conv.preferredTreatment || null;

  return {
    customer_sentiment: cleanField(sentiment) || 'N/A',
    conversation_summary: cleanField(summary) || 'N/A',
    next_steps: cleanField(nextSteps) || 'N/A',
    customer_name: cleanShortField(finalName) || 'N/A',
    phone_number: cleanShortField(finalPhone) || 'N/A',
    preferred_branch: cleanShortField(finalBranch) || 'N/A',
    preferred_date: cleanShortField(finalDate) || 'N/A',
    preferred_treatment: cleanShortField(finalTreatment) || 'N/A'
  };
}

// NxLink source_channel -> Lark "Source"
export function resolveChannel(conv: any): string {
  const sourceChannel = conv.source_channel || conv.sourceChannel;
  const instance = (conv.channel_instance || conv.channelInstance || '').toLowerCase();

  if (sourceChannel === 11 || sourceChannel === 18 || instance.includes('whatsapp') || instance.includes('wa')) {
    return 'WA';
  }
  if (sourceChannel === 19 || instance.includes('messenger') || instance.includes('fb') || instance.includes('facebook')) {
    return 'FB';
  }
  if (sourceChannel === 20 || instance.includes('instagram') || instance.includes('ig')) {
    return 'IG';
  }

  // All other Flow Manager bot sessions (Dental Home web widget, demo, etc.) are Website
  return 'Website';
}
