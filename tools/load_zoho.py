#!/usr/bin/env python3
"""
Load the four Zoho CSVs into Supabase.

    python3 tools/load_zoho.py            # loads everything
    python3 tools/load_zoho.py --dry      # reads and counts, sends nothing

Run db/zoho_accounts.sql SECTION 1 first (it creates the tables).

Why a script and not the Table Editor's CSV import: the import can turn an
empty cell in a text column into an empty string, and an empty string in
account_id is a foreign-key violation, not a NULL. This sends real NULLs.

Safe to run twice: rows are upserted on id, so a re-run updates in place.

Needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY, from the environment or from
a .env / .env.local file in the repo root. Standard library only.
"""
import csv, json, os, sys, urllib.request, urllib.error

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LOAD = os.path.join(ROOT, "load")
ORDER = ["zoho_accounts", "zoho_contacts", "zoho_opportunities", "zoho_sales"]  # FK order
BOOL = {"email_opt_out"}
BATCH = 500


def env(name):
    if os.environ.get(name):
        return os.environ[name]
    for fn in (".env.local", ".env"):
        p = os.path.join(ROOT, fn)
        if os.path.exists(p):
            for line in open(p):
                k, _, v = line.strip().partition("=")
                if k.strip() == name and v:
                    return v.strip().strip('"').strip("'")
    sys.exit(f"{name} is not set (environment, .env.local or .env)")


def rows(table):
    with open(os.path.join(LOAD, table + ".csv"), newline="", encoding="utf-8") as fh:
        for r in csv.DictReader(fh):
            out = {}
            for k, v in r.items():
                if v is None or v == "":
                    out[k] = False if k in BOOL else None
                elif k in BOOL:
                    out[k] = v.strip().lower() == "true"
                else:
                    out[k] = v
            yield out


def post(url, key, table, batch):
    req = urllib.request.Request(
        f"{url}/rest/v1/{table}?on_conflict=id",
        data=json.dumps(batch).encode("utf-8"), method="POST",
        headers={"apikey": key, "Authorization": f"Bearer {key}",
                 "Content-Type": "application/json",
                 "Prefer": "resolution=merge-duplicates,return=minimal"})
    try:
        urllib.request.urlopen(req, timeout=120).read()
    except urllib.error.HTTPError as e:
        sys.exit(f"\n{table}: Supabase said {e.code}: {e.read().decode('utf-8', 'replace')[:600]}")


def main():
    dry = "--dry" in sys.argv
    url = key = None
    if not dry:
        url, key = env("SUPABASE_URL").rstrip("/"), env("SUPABASE_SERVICE_ROLE_KEY")
    for table in ORDER:
        batch, n = [], 0
        for r in rows(table):
            batch.append(r); n += 1
            if len(batch) == BATCH:
                if not dry: post(url, key, table, batch)
                batch = []
                print(f"  {table}: {n}", end="\r")
        if batch and not dry:
            post(url, key, table, batch)
        print(f"  {table}: {n} rows {'read' if dry else 'loaded'}      ")
    print("Done. Now run SECTION 2 and SECTION 3 of db/zoho_accounts.sql.")


if __name__ == "__main__":
    main()
