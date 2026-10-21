# tools/

Scripts that build the email index. They run on a developer machine, not on
Vercel, and they are not part of the app.

**No mail data lives in this repo.** The scripts read from and write to a
working directory outside it (`~/pst-out` on Alan's machine). Only the
rolled-up result ever reaches Supabase, and only the scripts are versioned
here. See `.gitignore`.

---

## The pipeline

```
Jeff's Outlook archive (.pst, ~28GB, backed up in Dropbox)
        │
        │  readpst -o ~/pst-out -te <file>.pst          ← libpst, brew install libpst
        ▼
   47 .mbox files, one per Outlook folder
        │
        │  index_mbox.py                                 ← headers only, no bodies
        ▼
   contacts.csv · companies.csv · prospects.csv · messages.csv
        │
        │  match_domains.py                              ← joins domains to companies
        ▼
   domain_company_map.csv  ──────────────►  Supabase: company_domains
   review_queue.csv            (import)
```

---

## index_mbox.py

Pulls message metadata out of the mbox files. **Headers only — message
bodies are never read or stored.**

```bash
# scan in chunks (resumable; skips parts already done)
python3 index_mbox.py scan ./parts *.mbox

# then roll the parts up
python3 index_mbox.py merge ./parts ./index-out
```

Outputs `messages.csv`, `contacts.csv`, `companies.csv`.

**Direction detection.** `readpst` renders the archive owner's own Exchange
address as `MAILER-DAEMON`, so `From: ... <MAILER-DAEMON>` means Jeff sent
it and the counterparty is in `To:`/`Cc:`. Anything else is inbound.

Dedupe is on `Message-ID`.

---

## match_domains.py

Maps email domains onto company records. This is what lets the dashboard
connect `colliers.com` to the Colliers record that holds the sponsorship
history.

```bash
python3 match_domains.py \
  --companies companies_db.csv \   # select key, display_name, website from company_signals
  --index     index-out/prospects.csv \
  --aliases   aliases_db.csv \     # select from_key, to_key from company_aliases
  --out       match-out
```

Match tiers, most trustworthy first. Nothing below `prefix` is ever
auto-accepted, and any tier producing more than one candidate goes to review
rather than guessing:

| Tier | Rule |
|---|---|
| `website` | the company record's own `website` column matches the domain |
| `seed` | a known address at that domain, by majority vote across contacts |
| `exact` | normalised domain label equals the company key |
| `prefix` | one is a prefix of the other **and reaches past the company's first word** |

That last condition matters. `mccorddev` → McCord Development is real;
`jacobs` → Jacobs Properties is a coin flip, because any number of companies
start with the same word. An earlier fuzzy token tier was removed outright —
it produced 187 matches and nearly all were wrong (`morganstanley.com` →
The Morgan Group).

### Two gotchas, both of which silently produced wrong answers

1. **`company_signals` is keyed by company × market.** One company appears
   once per market, so Colliers shows up eleven times. Un-collapsed, those
   look like eleven rival candidates and get rejected as ambiguous. The
   script collapses by key.

2. **Database keys contain spaces** (`abel design group architects`) while
   domain labels don't (`abeldesign`). The CSV carries **both**: `company_key`
   (normalised, used for matching) and `db_key` (verbatim, used to join
   `company_facts.key`). **Join on `db_key`.**

### review_queue.csv

Unmatched domains, sorted by email volume, so the forty that matter are at
the top and the 2,500-item tail can be ignored. Fill in `company_name` on a
row and re-run to pick it up.

---

## Loading into Supabase

```sql
drop table if exists company_domains;
-- then: Table Editor → New table → Import data from CSV
--       domain as primary key, RLS off (matches company_signals)
```

Then `db/event_series.sql` and `db/v_event_board.sql`.

---

## Refresh cadence

| What | How | When |
|---|---|---|
| New mail | Graph change notifications → `messages` | on arrival *(not built yet)* |
| Backstop | Graph `/delta` poll | every 15 min *(not built yet)* |
| Archive | fresh `.pst` copy, re-run both scripts | quarterly |
| Matching | re-run `match_domains.py` | whenever aliases or websites improve |

Every company given a `website` in `company_signals` is a free future match —
the `website` tier produced 343 of the first 1,025 matches with no fuzzy
logic at all. Filling those in is the cheapest way to improve coverage.
