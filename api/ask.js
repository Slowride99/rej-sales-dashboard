/* eslint-env node */
// api/ask.js
// Natural-language filtering over the prospect list.
//
//   POST /api/ask   body: { question: "who sponsored in 2023 but not since?" }
//   ->              { filter: {...}, label: "Lapsed since 2023" }
//
// The model returns a FILTER OBJECT, never SQL. The front end applies it to
// rows it already has. Bounded, instant, and it cannot produce a broken query
// in front of an audience — which matters more than flexibility here.
//
// Env: ANTHROPIC_API_KEY

const MODEL = 'claude-sonnet-4-6';

// Anything not in here is ignored when the filter is applied.
const SCHEMA = `{
  "never_sponsored": boolean | null,   // true = only companies that have never sponsored
  "lapsed": boolean | null,            // true = has sponsored before but not for the target year
  "last_sponsored_before": number | null,  // e.g. 2024 -> last sponsorship was before 2024
  "min_attendees": number | null,
  "min_events": number | null,
  "min_award_entries": number | null,
  "has_spoken": boolean | null,
  "active_since": number | null,       // last contact in or after this year
  "sort": "score" | "attendees" | "events" | "last_sponsored" | "name",
  "limit": number | null
}`;

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set' });

  const { question, year = 2026 } = req.body || {};
  if (!question) return res.status(400).json({ error: 'question is required' });

  const system = `You translate questions about a commercial real estate event sponsorship prospect list into a filter object.

The list contains companies with their history at REJournals events: how many people they have sent, how many events, whether they have sponsored and when, whether they have spoken, and how many award entries they have submitted. The target year is ${year}.

Return ONLY valid JSON, no markdown fences, matching this schema exactly:
${SCHEMA}

Also include a "label" string: a short human-readable name for the filter, under 40 characters, sentence case.

Set fields to null when the question does not constrain them. Do not invent fields. If the question is unclear or asks for something the schema cannot express, return all nulls with sort "score" and a label saying what you could not do.

Examples:
"who sponsored in 2023 but hasn't since" -> {"never_sponsored":null,"lapsed":true,"last_sponsored_before":2024,"min_attendees":null,"min_events":null,"min_award_entries":null,"has_spoken":null,"active_since":null,"sort":"last_sponsored","limit":null,"label":"Lapsed since 2023"}
"big attendance, never paid us" -> {"never_sponsored":true,"lapsed":null,"last_sponsored_before":null,"min_attendees":10,"min_events":null,"min_award_entries":null,"has_spoken":null,"active_since":null,"sort":"attendees","limit":null,"label":"High attendance, never sponsored"}
"companies that speak at our events but don't sponsor" -> {"never_sponsored":true,"lapsed":null,"last_sponsored_before":null,"min_attendees":null,"min_events":null,"min_award_entries":null,"has_spoken":true,"active_since":null,"sort":"score","limit":null,"label":"Speakers who never sponsored"}`;

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1000,
        system,
        messages: [{ role: 'user', content: question }],
      }),
    });

    const data = await r.json();
    if (!r.ok) throw new Error(data?.error?.message || `Anthropic ${r.status}`);

    const text = (data.content || [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .replace(/```json|```/g, '')
      .trim();

    const parsed = JSON.parse(text);
    const { label, ...filter } = parsed;

    return res.status(200).json({ filter, label: label || 'Filtered' });
  } catch (err) {
    console.error('ask error:', err);
    return res.status(500).json({ error: err.message || 'Could not read that question' });
  }
}
