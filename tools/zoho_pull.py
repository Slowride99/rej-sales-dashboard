#!/usr/bin/env python3
"""
Pull only the Zoho CRM Accounts and Contacts that have a sale behind them.

Reads   account_ids.txt, contact_ids.txt   (one record id per line, same folder)
Writes  accounts.csv, contacts.csv         (same folder)

Read-only: it only sends GET requests to Zoho CRM. Nothing in Zoho is changed.
Uses only the Python standard library.

Run:  python3 zoho_pull.py
"""
import csv, json, os, sys, time, getpass
import urllib.request, urllib.parse, urllib.error

HERE = os.path.dirname(os.path.abspath(__file__))
ACCOUNTS_URL = os.environ.get("ZOHO_ACCOUNTS_URL", "https://accounts.zoho.com")
API_VERSION = "v8"
BATCH = 100          # ids per request; halves automatically if Zoho refuses
MAX_FIELDS = 50      # Zoho's limit per request

# Field labels we want, as they appear in Zoho. Anything not found is skipped.
WANT = {
    "Accounts": [
        "Account Name", "Website", "Phone", "Office", "Account Type", "Industry",
        "Billing Street", "Billing Street 2", "Billing City", "Billing State",
        "Billing Code", "Billing Email", "Parent Account", "Account Owner",
        "Created Time", "Modified Time", "Last Activity Time", "Created By",
        "Employees", "Description", "LinkedIn", "Tag",
    ],
    "Contacts": [
        "First Name", "Last Name", "Full Name", "Email", "Secondary Email",
        "Title", "Phone", "Mobile", "Account Name", "Contact Type",
        "Mailing City", "Mailing State", "Mailing Zip", "Email Opt Out",
        "Lead Source", "LinkedIn", "Contact Owner", "Office", "ZB_Status",
        "Created Time", "Modified Time", "Last Activity Time", "Tag",
    ],
}


def http(method, url, headers=None, data=None):
    req = urllib.request.Request(url, method=method, headers=headers or {}, data=data)
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            body = r.read().decode("utf-8")
            return r.status, (json.loads(body) if body.strip() else {})
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", "replace")
        try:
            return e.code, json.loads(body)
        except ValueError:
            return e.code, {"raw": body[:500]}


def get_token():
    print("\nFrom the Zoho API console (Self Client):")
    cid = input("  Client ID: ").strip()
    secret = getpass.getpass("  Client Secret (hidden as you paste): ").strip()
    code = input("  Generated code: ").strip()
    q = urllib.parse.urlencode({
        "client_id": cid, "client_secret": secret,
        "grant_type": "authorization_code", "code": code,
    })
    status, js = http("POST", f"{ACCOUNTS_URL}/oauth/v2/token?{q}")
    if "access_token" not in js:
        sys.exit(f"\nZoho did not return a token (HTTP {status}): {js}\n"
                 "The code expires quickly and works once. Generate a new one and run again.")
    return js["access_token"], js.get("api_domain", "https://www.zohoapis.com")


def field_names(api, hdr, module):
    """Map the labels we want to this Zoho's real API field names."""
    status, js = http("GET", f"{api}/crm/{API_VERSION}/settings/fields?module={module}", hdr)
    fields = js.get("fields") or []
    if not fields:
        sys.exit(f"Could not read the field list for {module} (HTTP {status}): {js}")
    by_label = {}
    for f in fields:
        for label in (f.get("field_label"), f.get("display_label")):
            if label:
                by_label.setdefault(label.strip().lower(), f["api_name"])
    chosen, missing = [], []
    for label in WANT[module]:
        api_name = by_label.get(label.lower())
        if api_name and api_name not in chosen:
            chosen.append(api_name)
        elif not api_name:
            missing.append(label)
    if missing:
        print(f"  {module}: not found in this Zoho, skipped: {', '.join(missing)}")
    return chosen[:MAX_FIELDS]


def flat(v):
    if v is None:
        return ""
    if isinstance(v, dict):
        return str(v.get("name") or v.get("id") or "")
    if isinstance(v, list):
        return "; ".join(flat(x) for x in v)
    return str(v)


def fetch(api, hdr, module, ids, fields):
    rows, not_found, i, size = [], 0, 0, BATCH
    while i < len(ids):
        chunk = ids[i:i + size]
        q = urllib.parse.urlencode({"ids": ",".join(chunk), "fields": ",".join(fields),
                                    "per_page": 200})
        status, js = http("GET", f"{api}/crm/{API_VERSION}/{module}?{q}", hdr)
        if status == 429:
            print("  Zoho asked us to slow down; waiting 30 seconds...")
            time.sleep(30)
            continue
        if status == 401:
            sys.exit("Zoho says the token is no longer valid. Generate a new code and run again; "
                     "finished files are kept.")
        if status >= 400:
            if size > 1:
                size = max(1, size // 2)
                print(f"  Zoho refused a batch (HTTP {status}); retrying with {size} at a time")
                continue
            not_found += 1
            i += 1
            continue
        data = js.get("data") or []
        for rec in data:
            row = {"Record Id": rec.get("id", "")}
            for f in fields:
                v = rec.get(f)
                row[f] = flat(v)
                if isinstance(v, dict) and v.get("id"):
                    row[f + ".id"] = v["id"]
            rows.append(row)
        not_found += len(chunk) - len(data)
        i += len(chunk)
        print(f"  {module}: {min(i, len(ids))} of {len(ids)}", end="\r")
        time.sleep(0.2)
    print()
    return rows, not_found


def write_csv(path, rows):
    cols = []
    for r in rows:
        for k in r:
            if k not in cols:
                cols.append(k)
    with open(path, "w", newline="", encoding="utf-8-sig") as fh:
        w = csv.DictWriter(fh, fieldnames=cols)
        w.writeheader()
        w.writerows(rows)


def read_ids(name):
    path = os.path.join(HERE, name)
    if not os.path.exists(path):
        sys.exit(f"Missing {name}. Keep it in the same folder as this script.")
    with open(path) as fh:
        return [ln.strip().replace("zcrm_", "") for ln in fh if ln.strip()]


def main():
    jobs = [("Accounts", read_ids("account_ids.txt"), "accounts.csv"),
            ("Contacts", read_ids("contact_ids.txt"), "contacts.csv")]
    token, api = get_token()
    hdr = {"Authorization": f"Zoho-oauthtoken {token}"}
    print(f"\nConnected. Using {api}\n")
    for module, ids, out in jobs:
        fields = field_names(api, hdr, module)
        print(f"  {module}: asking for {len(ids)} records, {len(fields)} fields")
        rows, missing = fetch(api, hdr, module, ids, fields)
        write_csv(os.path.join(HERE, out), rows)
        print(f"  Saved {len(rows)} rows to {out}"
              + (f" ({missing} ids no longer exist in Zoho)" if missing else ""))
    print("\nDone. Send accounts.csv and contacts.csv back.")


if __name__ == "__main__":
    main()
