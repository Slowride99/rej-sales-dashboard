// api/ask-board.js — natural language -> a filter over the board.
//
//   POST /api/ask-board  { question: "who sponsored in 2023 but hasn't since?" }
//   ->  { label, filter, sort, limit }
//
// THE MODEL NEVER PRODUCES NUMBERS, NAMES, OR FACTS.
//
// It only picks which filter to apply. The filter is then run client-side over
// rows that already came from mv_event_board, so every figure on screen is the
// materialised view's, not the model's. If the model returns nonsense the worst
// case is an odd-looking list — never a wrong count presented as fact. That
// property is the whole reason this is safe to put in front of anyone: ask it
// "how many lapsed since 2023" and a hallucinated number would poison trust in
// the entire screen.
//
// Mirrors the shape of the existing /api/ask, which does the same thing for the
// Airtable board.
//
// Env:
//   ANTHROPIC_API_KEY
//   ANTHROPIC_MODEL   — set this to whatever api/ask.js already uses, so both
//                       endpoints stay on one model. Default below is a guess.

const KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5';

// The vocabulary. Everything here maps to a real column on mv_event_board —
// nothing is inferred and nothing is scored.
const SCHEMA = `
{
  "label": string,                         // short human summary of the list, shown on screen
  "group": "all" | "sponsored" | "gap" | "engaged",
  "never_sponsored_here": boolean,         // years_sponsored = 0
  "lapsed": boolean,                       // sponsored before, not in the current year
  "lapsed_since": number,                  // last sponsored here BEFORE this year
  "sponsored_in_year": number,             // sponsored here in exactly this year
  "min_sponsorships_elsewhere": number,    // sponsorships_total
  "min_markets": number,                   // markets_sponsored
  "min_attendees": number,
  "min_years_attended": number,
  "has_spoken": boolean,
  "has_contact_history": boolean,          // emails > 0
  "no_contact_history": boolean,           // emails is null or 0 — NOT KNOWN, not zero
  "replied": boolean,                      // ever_replied = true
  "not_contacted_since": "YYYY-MM-DD",     // last_emailed older than this
  "sort": "sponsorships" | "markets" | "emails" | "attendees" | "last_emailed" | "name",
  "limit": number
}`;

const SYSTEM = `You turn a salesperson's question into a filter over one event's company board for REJournals, a commercial real estate publisher.

Return ONLY a JSON object matching this schema. Omit any key that does not apply — do not include nulls.

${SCHEMA}

What the data means:
- The board is one event series (e.g. "REDnews DFW Industrial Real Estate Summit") across several years.
- "sponsored" = has sponsored THIS event in at least one year.
- "gap" = has never sponsored this event but HAS sponsored other REJournals events in other markets. This is the most valuable group.
- "engaged" = has attended or spoken at this event but never sponsored anywhere.
- sponsorships_total / markets_sponsored count sponsorships across ALL REJournals events, not just this one.
- emails come from a 3-year archive of the CEO's mail. A null means the company's domain was never matched in that archive — it means NOT KNOWN, never "we didn't email them". So "who haven't we contacted" should use no_contact_history, and the label should say "no contact history on file" rather than "never contacted".

Rules:
- "label" is a plain short phrase, 2-6 words, no numbers in it. The count is added on screen from real data.
- Never invent company names, counts, or years. You are choosing a filter, nothing else.
- If the question is vague, choose the broadest sensible filter rather than guessing specifics.
- If the question cannot be expressed in this schema at all, return {"label": "", "unsupported": true}.

Examples:
Q: who sponsored in 2023 but hasn't since?
{"label":"Lapsed since 2023","group":"sponsored","sponsored_in_year":2023,"lapsed":true,"sort":"sponsorships"}

Q: big firms that buy from us everywhere except here
{"label":"Buy elsewhere, not here","group":"gap","min_markets":2,"sort":"sponsorships"}

Q: who came to the event but we have no record of emailing
{"label":"Attended, no contact history","group":"engaged","no_contact_history":true,"sort":"attendees"}

Q: anyone who actually wrote back
{"label":"Have replied to us","group":"all","replied":true,"sort":"emails"}`;

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') return JSON.parse(req.body);
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'POST' });
  }
  if (!KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set' });

  try {
    const { question } = await readBody(req);
    const q = String(question || '').trim();
    if (!q) return res.status(400).json({ error: 'question required' });
    if (q.length > 500) return res.status(400).json({ error: 'question too long' });

    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 400,
        system: SYSTEM,
        messages: [{ role: 'user', content: q }],
      }),
    });

    if (!r.ok) {
      const text = await r.text();
      return res.status(502).json({ error: `model ${r.status}: ${text.slice(0, 200)}` });
    }

    const data = await r.json();
    const raw = (data.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('');

    // The model is told to return bare JSON, but tolerate a fenced block.
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return res.status(502).json({ error: 'model did not return a filter' });

    let parsed;
    try { parsed = JSON.parse(match[0]); }
    catch { return res.status(502).json({ error: 'model returned invalid JSON' }); }

    if (parsed.unsupported || !parsed.label) {
      return res.json({
        unsupported: true,
        label: '',
        message: "I can't turn that into a filter for this board. Try asking about sponsorships, markets, attendance, speaking, or contact history.",
      });
    }

    // Keep only keys in the schema. A stray key can't do damage — the client
    // ignores what it doesn't know — but dropping them here keeps the shape
    // honest and makes the response readable when something goes wrong.
    const ALLOW = new Set([
      'label', 'group', 'never_sponsored_here', 'lapsed', 'lapsed_since',
      'sponsored_in_year', 'min_sponsorships_elsewhere', 'min_markets',
      'min_attendees', 'min_years_attended', 'has_spoken', 'has_contact_history',
      'no_contact_history', 'replied', 'not_contacted_since', 'sort', 'limit',
    ]);
    const filter = {};
    for (const [k, v] of Object.entries(parsed)) if (ALLOW.has(k)) filter[k] = v;

    return res.json({ label: filter.label, filter, question: q });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
}
