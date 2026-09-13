# Sales Dashboard — Roadmap & Data Source Notes

Working notes on what's built, what's next, and what was learned about
each data source. Written 2026-09-04, ahead of the Sept 14 demo.

---

## Architecture

`company_facts` is a UNION view. Every source normalizes to the same
shape — `key`, `raw_name`, `role`, `market`, `year`, `event_code`,
`event_name`, `tier`, `detail` — and joins on `company_key()`.

**Adding a new source = adding one union branch.** Everything
downstream (`company_signals`, `sponsor_prospects`, the API routes, the
UI) picks it up with no other changes. This is the point of the design
and it's what makes the phases below cheap.

`ck()` does a SINGLE alias lookup and does NOT resolve chains. Every
`company_aliases.from_key` must point DIRECTLY at its final canonical
key. Verify after any alias change:

```sql
select count(*) from company_aliases a
join company_aliases b on b.from_key = a.to_key;   -- must be 0
```

---

## Phase 1 — Sept 14 demo (IN PROGRESS)

Texas only. Sponsors and Speakers tabs, scored recommendations with
plain-English reasons, `.eml` outreach drafting, outreach log.

**Source:** PheedLoop archive in Supabase — 55 TX events, 2022–2026,
290 sponsor rows / ~238 distinct sponsors.

**Done:** market mapping (287 events, 12 test events excluded),
122 curated TX company aliases, `company_facts` / `company_signals`
views, `sponsor_prospects()` / `speaker_prospects()` functions,
`/api/prospects` + `/api/speakers`, deployed on Vercel.

**Remaining:** three-column Sponsors tab, Speakers tab, `.eml`
generator, outreach log, rehearsal.

---

## Phase 2 — AwardForce history

`award_entries` table EXISTS and is EMPTY. The `company_facts` union
branch is already wired to it. Zeros in `award_entries` /
`award_finalists` on `company_signals` are expected, not a bug.

**To load:** export all entrants (NOT just finalists — the 2026
wide-format Excel from the InDesign work is finalists only) per program
per season. Up to 5 markets × 3–4 seasons. Check whether the AwardForce
entries endpoint accepts a season parameter before doing it by hand.

**Two fields must be set at load time**, because the Airtable base has
neither:

- `season_year` — Airtable rows are the current season; each CSV is
  whatever season it was exported from
- `market` — short code derived from `Chapter`:

| Chapter | market |
|---|---|
| Minnesota Real Estate Journal Awards | MN |
| Illinois Real Estate Journal Awards | IL |
| REDNews Houston Awards | TX |
| Indiana Real Estate Awards | IN |
| Michigan Real Estate Journal Awards | MI |

**Airtable awards base:** `app7L7ReFSCrFrfgO`
- `all` — `tblKZIKF1Uc8hOZ2p` — entries (current season only, no year field)
- `Corporate` — `tblRttmu7McapQ0Ye` — appears to DUPLICATE rows from
  `all`; confirm before counting or entries get double-weighted
- `Sponsors` — `tblGlPZwbQz08kVDs` — Name, Website, Event
  ("Texas 2026"), Tier (Title/Gold/Silver/Bronze/Corporate), Logo URL

Note: `Sponsors.Event` embeds the year ("Texas 2026") while
`all.Chapter` does not ("REDNews Houston Awards"). Build a small market
lookup rather than string-matching in several places.

No email field anywhere on entries — company is the only join key from
the awards side.

---

## Phase 3 — Zoho (ad sales cross-sell)

**Key finding: Zoho is the ADVERTISING CRM, not events.**

Every event field is 0% populated — `2019 Event/Summit Name`,
`2020`–`2027 Event/Summit/Channel`, `Event Program /Virtual Lobby Ad`,
`Opportunity Type(s)`. Created, never used. There are NO event
sponsorship dollars in Zoho. That question is closed.

What IS there: `Type` = EMarketing, `Product` = "A23_AD_1/8 Page 1 Year
Color", `Invoice Number` 95% filled, `Eblast Property City/State`,
`Issue Date-Original`, `Section` = "IND/L". Advertising sales, back to
2008.

**Why it's still worth loading:** cross-sell between two revenue lines
that have never been connected.

- spends $X/yr on ads, attends events, never sponsored → has budget,
  already a customer, never pitched
- sponsors events, never bought an ad → upsell for the publication side
- bought ads through 2022, nothing since → lapsed on a different axis

**Mechanics:** `Opportunities.Account Name.id` is a Zoho record ID, not
a name. Join to `Accounts.Record Id` → `Account Name` (100% filled) →
`company_key()`. `Accounts.Billing State` 99% filled, so state filtering
is clean.

| File | Rows | Notes |
|---|---:|---|
| Opportunities_001.csv | 41,262 | Amount / Closing Date / Stage all 100% |
| Accounts_001.csv | 100,000 | Account Name 100%, Billing State 99% |

Estimated 2–3 hours: load two CSVs, join, normalize, add a `zoho_deals`
branch to `company_facts`.

**TO VERIFY:** `Accounts_001.csv` is EXACTLY 100,000 rows with no
`Accounts_002`. Export files split at 100,000 (Contacts went to `_004`).
Hitting the boundary exactly with no continuation suggests the export
may have been truncated. Check the real account count in Zoho.

**Also noted:** 19 `Emails_*.csv` files, ~1.9M email records. REJournals
already holds years of email history in a queryable system — no Graph
API, no defederation. Relevant to the RADAR / Outlook discussion.
Not a demo topic.

---

## Phase 4 — Awards ceremony attendance

Source: WordPress Fluent Forms, exportable to spreadsheets.

Enables the honoree-vs-buyer distinction: someone at the 2024 ceremony
whose company was a finalist came to watch their own name called;
someone whose company entered nothing **bought a table** — materially
warmer sponsorship prospect, and invisible in either dataset alone.

**Expect mess.** Plan for it rather than discovering it:

- schema drifts per form and year — needs a per-form column mapping,
  not one loader
- no event identifier in the CSV — add `market`, `event_year`,
  `form_source` at export time
- table purchases hide guests: one submission = one buyer plus N names
  in a repeater or free-text blob. Flag `role` as buyer vs guest or a
  table of ten counts as ten prospects
- company field missing on some forms, free text where present
- comps, staff, judges, press need flagging out
- `.replace('\xa0', ' ')` normalization needed, same as the AwardForce
  finalist data

Land raw first, normalize in a second pass, so a wrong mapping means
re-running a transform rather than re-exporting from WordPress.

---

## Phase 5 — Other markets

MN (109 events), IL (38), MI (14), IN (4), plus OH / NE / IA / TN / ND /
WI / MO. Already mapped and cleaned. `sponsor_prospects()` takes market
as a parameter — this is a config change, not a rebuild.

Run the D1/D2 alias QA per market before switching one on;
`tx_company_aliases.sql` covers Texas only.

---

## Known data issues

**`sponsors.tiers` holds opaque PheedLoop tier IDs**
(`["SPTI7MQ9NGNSCR2LAY"]`), not readable names. The label mapping did
not survive the migration. Deliberately not exposed on
`company_signals` — use `times_sponsored` / `last_sponsored_year`.
Possible fixes: find the tier lookup in the original PheedLoop export,
or take tier from Airtable for 2026+ where the field holds real values.

**`website` picks the shortest sponsor URL per company.** Usually right,
but CBRE resolves to a personal profile URL that happens to be shorter
than the corporate one. Strip the path client-side if it matters.

**CREW Houston shows 6 sponsorships against 2 attendees.** Likely a
reciprocal partner org rather than a paying sponsor. Same question
applies to CCIM chapters. Worth confirming whether they belong in
prospect lists at all.

**Franchise offices are deliberately NOT merged** — Keller Williams, KW,
CCIM chapters, Coldwell Banker, Engel Völkers, Lone Star College. These
are separately owned with separate budgets; merging creates one
enormous prospect nobody can sell to. Revisit only if a rep says they
sell at brand level.

**Bare generic company keys are left split** — `capital`, `edge`, `ecs`,
`stream`, `apex`, `vista`, `us`, `moss`, `ryan` etc. Someone typed the
short form at registration and it can't be resolved from the data. They
sit as low-count rows and are filtered out by the score floor.

---

## Open questions

- Do sponsor counts really decline after 2023? 99 sponsor rows in 2023
  vs ~53 since. Verify against events-per-year before saying it out
  loud — but if it holds, it quantifies the revenue problem from
  REJournals' own data.
- What does "sponsored" mean for partner orgs (CREW, CCIM)?
- Was the Zoho Accounts export truncated at 100,000?

---

## Security debt (post-demo)

The archive lookup app queries Supabase from the BROWSER with the anon
key, and the archive tables carry `Public read` policies with
`qual = true`. RLS is enabled but permits everything — anyone with the
app URL can read five years of attendee records including names,
emails, titles and employers.

Fix: move those queries behind `/api` routes with the service role key,
then drop the `Public read` policies. Roughly half a day. Do NOT drop
the policies before the app is migrated — it breaks the archive app
immediately, and that app is part of the Sept 14 case.

The sales dashboard does not have this problem: it reads through
serverless functions only, and `company_facts` / `company_signals` /
`events_enriched` are revoked from `anon` and `authenticated`.
