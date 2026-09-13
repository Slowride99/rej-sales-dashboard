/* eslint-env node */
// api/draft-email.js
// Writes a sponsorship outreach email grounded in one company's actual
// history with REJournals. No invented facts — the model only gets the row
// from company_signals plus the event being sold.
//
//   POST /api/draft-email
//   body: { company: {...}, event: {...}, sender: {...}, tone?: "warm"|"direct" }
//   ->   { subject, body }
//
// Env: ANTHROPIC_API_KEY (workspace-scoped, never VITE_ prefixed)

const MODEL = 'claude-sonnet-4-6';

function historyLines(c) {
  const out = [];
  if (c.times_sponsored > 0) {
    out.push(`Has sponsored ${c.times_sponsored} REJournals event${c.times_sponsored === 1 ? '' : 's'}, most recently in ${c.last_sponsored_year}.`);
  } else {
    out.push('Has never sponsored a REJournals event.');
  }
  if (c.attendee_count > 0) {
    out.push(`Has sent ${c.attendee_count} attendee${c.attendee_count === 1 ? '' : 's'} across ${c.events_attended} event${c.events_attended === 1 ? '' : 's'}.`);
  }
  if (c.times_spoken > 0) {
    out.push(`People from this company have spoken at ${c.times_spoken} of our events.`);
  }
  if (c.award_entries > 0) {
    out.push(`Has submitted ${c.award_entries} award entr${c.award_entries === 1 ? 'y' : 'ies'}${c.award_finalists > 0 ? `, ${c.award_finalists} of which were finalists or winners` : ''}.`);
  }
  if (c.active_years) {
    out.push(`Active with us in ${c.active_years} of the last five years; last contact ${c.last_touch_year}.`);
  }
  return out;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    return res.status(500).json({
      error: 'ANTHROPIC_API_KEY not set — add it in Vercel Settings → Environment Variables',
    });
  }

  const { company = {}, event = {}, sender = {}, tone = 'warm' } = req.body || {};
  if (!company.display_name) return res.status(400).json({ error: 'company.display_name is required' });

  const facts = historyLines(company);

  const system = `You write sponsorship outreach emails for REJournals, a commercial real estate publisher that runs industry events and awards programs across the Midwest and Texas.

Rules:
- Use ONLY the history facts provided. Never invent a meeting, a conversation, a dollar figure, a contact name, or a detail that is not in the facts.
- Reference one or two specific facts from the history. Specificity is the entire point of the email; generic outreach is a failure.
- Keep the body to 120 words or less. Short paragraphs, no bullet lists.
- Sentence case subject line, under 60 characters, no colons-and-reveal constructions.
- Plain, direct language. No "I hope this finds you well", no "excited to", no "circling back", no em-dash asides.
- One clear ask at the end: a short call, or the sponsorship deck.
- Sign off with the sender's name only. Do not add a title block or contact details.
- If the company has lapsed, acknowledge the gap plainly rather than pretending it didn't happen.

Return ONLY valid JSON, no markdown fences, in this exact shape:
{"subject": "...", "body": "..."}`;

  const user = `Company: ${company.display_name}

History with REJournals:
${facts.map((f) => `- ${f}`).join('\n')}

Event being sold:
- ${event.name || 'upcoming REJournals event'}${event.date ? `\n- Date: ${event.date}` : ''}${event.location ? `\n- Location: ${event.location}` : ''}

Sender: ${sender.name || 'the REJournals events team'}${sender.title ? `, ${sender.title}` : ''}

Tone: ${tone === 'direct' ? 'direct and brief, straight to the ask' : 'warm but efficient, peer to peer'}`;

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
        messages: [{ role: 'user', content: user }],
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

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      // Model returned prose instead of JSON. Don't fail the demo over it.
      parsed = { subject: `${event.name || 'REJournals'} sponsorship`, body: text };
    }

    return res.status(200).json({
      subject: parsed.subject || '',
      body: parsed.body || '',
      facts, // shown under the draft so the rep can see what it was built from
    });
  } catch (err) {
    console.error('draft-email error:', err);
    return res.status(500).json({ error: err.message || 'Draft failed' });
  }
}
