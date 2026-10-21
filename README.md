# Sponsors screen — drop-in

Built against the live `/api/board-series?series=REDnews DFW Industrial Real Estate Summit`
response, so every field name is the real one.

## Where the files go

| File here | Goes to |
|---|---|
| `SponsorsBoard.jsx` | `src/components/SponsorsBoard.jsx` |
| `sponsors-board.css` | `src/components/sponsors-board.css` |
| `api-board-series.js` | `api/board-series.js` — **replaces** the current one |
| `api-notes.js` | `api/notes.js` |
| `notes.sql` | `db/notes.sql` |
| `company_key_canon.sql` | `db/company_key_canon.sql` |
| `preview-dark.html` | nowhere — open it in a browser to see the screen with real data, no build |

## Order

1. **`db/notes.sql`** in Supabase. Creates `event_notes`. Nothing in the ETL writes
   to it, so a view refresh can never wipe Jeff's typing.
2. **`api/notes.js`** and **`api/board-series.js`**, then push. No new env vars —
   both use `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`, which are already set.
3. **Component**, wherever the Sponsors tab renders:
   ```jsx
   import SponsorsBoard from './components/SponsorsBoard';
   ...
   <SponsorsBoard />
   ```
4. **`db/company_key_canon.sql`** — read section 0 first, it asks you to check a
   column name before the updates run.

## What changed in `api/board-series.js`

One addition: a `totals` block computed over **all** rows in the series.

The three groups on screen (`sponsored` + `gap` + `engaged`) are 116 of the 244
companies — `engaged` only takes rows with 2+ years attended or a speaking slot.
Summing emails from those three on the client was therefore undercounting by
about half. `totals` sums the full row set server-side. The component prefers it
and falls back to the on-screen rows only if you haven't deployed the API yet —
in which case the card's subtitle says "listed companies only" rather than
quietly showing a smaller number as a total.

## Two data shapes that will bite

- **`ever_replied` is `true` or `null`, never `false`.** Render "replied" only on
  `=== true`.
- **`emails` and `domains` are `null` when the email index couldn't match the
  company's domain** — 66 of the 244 here. Null means *not known*. Rendering it
  as `0` would claim we never emailed someone we may well have emailed, which is
  the kind of thing that gets the whole screen distrusted. The component shows
  "no email match" and the Outreach card counts them separately.

## The notes contract

```
GET  /api/notes?series=<name>        -> { notes: { <key>: { body, updated_at } } }
POST /api/notes {series, key, body}  -> { ok: true, updated_at }
```

Saves 800ms after the last keystroke and again on blur. A note with a body gets a
green tint so a filled field is visible without opening it. Clearing a field
deletes the row rather than storing a blank.

Keyed by `(series, company_key)` as plain text with **no foreign key** into
`company_facts` — deliberately. The board is a materialised view, company keys
change when the match pipeline re-runs, and notes are the one thing on this screen
that can't be regenerated from source. A note pointing at a key that no longer
exists is harmless; a cascading delete would not be.
