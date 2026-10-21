#!/usr/bin/env python3
"""
index_mbox.py — metadata-only indexer for readpst mbox output.

Two modes so a long run can be done in bounded chunks and resumed:

  scan  <parts-dir> <file.mbox> [...]   one CSV part per mbox file
  merge <parts-dir> <out-dir>           dedupe + roll up into the real output

Writes, from merge:
  messages.csv   one row per message per counterparty
  contacts.csv   one row per counterparty email address
  companies.csv  one row per counterparty domain

No message bodies are read or stored. Headers only.

Direction is decided by the sender: readpst renders the archive owner's own
Exchange address as MAILER-DAEMON, so From: ... <MAILER-DAEMON> means the
owner sent it (outbound, counterparty is in To:/Cc:). Anything else is
inbound and the counterparty is the From: address.
"""

import sys, os, re, csv, email.utils
from email.header import decode_header, make_header
from collections import defaultdict

OWNER_DOMAIN = 'rejournals.com'

FREEMAIL = {
    'gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'aol.com',
    'icloud.com', 'me.com', 'comcast.net', 'sbcglobal.net', 'att.net',
    'verizon.net', 'msn.com', 'live.com', 'mac.com', 'protonmail.com',
    'ymail.com', 'bellsouth.net', 'cox.net', 'charter.net', 'earthlink.net',
}

WANTED = ('from', 'to', 'cc', 'date', 'subject', 'message-id')
COLS = ['folder', 'direction', 'date', 'subject', 'name', 'email',
        'domain', 'is_company', 'message_id']
MAX_HDR_LINES = 400          # guard against a pathological message


def decode_hdr(raw):
    if not raw:
        return ''
    try:
        return str(make_header(decode_header(raw))).strip()
    except Exception:
        return raw.strip()


def parse_headers(lines):
    out, name, buf = {}, None, []

    def flush():
        if name and name in WANTED:
            out[name] = decode_hdr(b' '.join(buf).decode('utf8', 'replace'))

    for raw in lines:
        if raw[:1] in (b' ', b'\t') and name is not None:
            buf.append(raw.strip())
            continue
        flush()
        if b':' not in raw:
            name, buf = None, []
            continue
        k, _, v = raw.partition(b':')
        name = k.decode('ascii', 'replace').strip().lower()
        buf = [v.strip()]
    flush()
    return out


def iter_messages(path):
    """Stream an mbox, yielding the decoded header dict of each message."""
    with open(path, 'rb') as fh:
        hdr, in_headers, prev_blank = [], False, True
        for line in fh:
            if prev_blank and line.startswith(b'From '):
                if hdr:
                    yield parse_headers(hdr)
                hdr, in_headers, prev_blank = [], True, False
                continue
            stripped = line.strip()
            if in_headers:
                if not stripped or len(hdr) >= MAX_HDR_LINES:
                    in_headers = False
                else:
                    hdr.append(line)
            prev_blank = not stripped
        if hdr:
            yield parse_headers(hdr)


def addresses(value):
    out = []
    for nm, addr in email.utils.getaddresses([value or '']):
        addr = (addr or '').strip().strip("'\"").lower()
        nm = (nm or '').strip().strip("'\"")
        if addr == 'mailer-daemon' or '@' not in addr:
            addr = ''
        if addr or nm:
            out.append((nm, addr))
    return out


def rows_for(path, folder):
    for h in iter_messages(path):
        frm = h.get('from', '')
        outbound = 'mailer-daemon' in frm.lower()
        parties = (addresses(h.get('to', '')) + addresses(h.get('cc', ''))
                   if outbound else addresses(frm))
        parties = [(nm, a) for nm, a in parties
                   if not a.endswith('@' + OWNER_DOMAIN)]
        if not parties:
            continue
        try:
            dt = email.utils.parsedate_to_datetime(h.get('date', ''))
            when = dt.date().isoformat() if dt else ''
        except Exception:
            when = ''
        subject = h.get('subject', '').replace('\r', ' ').replace('\n', ' ')
        mid = (h.get('message-id') or '').strip()
        for nm, addr in parties:
            dom = addr.split('@', 1)[1] if addr else ''
            yield {
                'folder': folder, 'direction': 'out' if outbound else 'in',
                'date': when, 'subject': subject, 'name': nm, 'email': addr,
                'domain': dom,
                'is_company': '' if (not dom or dom in FREEMAIL) else 'y',
                'message_id': mid,
            }


def cmd_scan(parts_dir, paths):
    os.makedirs(parts_dir, exist_ok=True)
    for p in paths:
        folder = os.path.basename(p)[:-5].strip()
        safe = re.sub(r'[^A-Za-z0-9._-]+', '_', folder) or 'unnamed'
        dest = os.path.join(parts_dir, safe + '.csv')
        if os.path.exists(dest):
            print(f'  skip (done)  {folder}', flush=True)
            continue
        tmp = dest + '.tmp'
        n = 0
        with open(tmp, 'w', newline='', encoding='utf8') as f:
            w = csv.DictWriter(f, fieldnames=COLS)
            w.writeheader()
            for r in rows_for(p, folder):
                w.writerow(r)
                n += 1
        os.rename(tmp, dest)
        print(f'  {folder}: {n} rows', flush=True)


def company_from_domain(domain):
    label = domain.rsplit('.', 2)[0] if domain.count('.') > 1 else domain.split('.')[0]
    return re.sub(r'[-_]+', ' ', label).title()


def cmd_merge(parts_dir, out_dir):
    os.makedirs(out_dir, exist_ok=True)
    seen, dupes, total = set(), 0, 0
    contacts = defaultdict(lambda: {'name': '', 'out': 0, 'in': 0,
                                    'first': '', 'last': '', 'folders': set()})
    comps = defaultdict(lambda: {'out': 0, 'in': 0, 'first': '', 'last': '',
                                 'contacts': set(), 'folders': set()})

    with open(os.path.join(out_dir, 'messages.csv'), 'w', newline='',
              encoding='utf8') as fout:
        w = csv.DictWriter(fout, fieldnames=COLS)
        w.writeheader()
        for part in sorted(os.listdir(parts_dir)):
            if not part.endswith('.csv'):
                continue
            with open(os.path.join(parts_dir, part), encoding='utf8') as f:
                for r in csv.DictReader(f):
                    total += 1
                    key = (r['message_id'], r['email']) if r['message_id'] else None
                    if key:
                        if key in seen:
                            dupes += 1
                            continue
                        seen.add(key)
                    w.writerow(r)

                    d, dom, em = r['date'], r['domain'], r['email']
                    if em:
                        c = contacts[em]
                        if r['name'] and len(r['name']) > len(c['name']):
                            c['name'] = r['name']
                        c['out' if r['direction'] == 'out' else 'in'] += 1
                        if d:
                            if not c['first'] or d < c['first']: c['first'] = d
                            if not c['last'] or d > c['last']: c['last'] = d
                        c['folders'].add(r['folder'])
                    if dom and dom not in FREEMAIL:
                        c = comps[dom]
                        c['out' if r['direction'] == 'out' else 'in'] += 1
                        if d:
                            if not c['first'] or d < c['first']: c['first'] = d
                            if not c['last'] or d > c['last']: c['last'] = d
                        c['contacts'].add(em)
                        c['folders'].add(r['folder'])

    with open(os.path.join(out_dir, 'contacts.csv'), 'w', newline='',
              encoding='utf8') as f:
        w = csv.writer(f)
        w.writerow(['email', 'name', 'domain', 'messages', 'sent_to',
                    'received_from', 'two_way', 'first_date', 'last_date', 'folders'])
        for em, c in sorted(contacts.items(), key=lambda kv: -(kv[1]['out'] + kv[1]['in'])):
            w.writerow([em, c['name'], em.split('@', 1)[1], c['out'] + c['in'],
                        c['out'], c['in'], 'y' if (c['out'] and c['in']) else '',
                        c['first'], c['last'], '; '.join(sorted(c['folders']))])

    with open(os.path.join(out_dir, 'companies.csv'), 'w', newline='',
              encoding='utf8') as f:
        w = csv.writer(f)
        w.writerow(['domain', 'company_guess', 'messages', 'sent_to',
                    'received_from', 'replied', 'contacts', 'first_date',
                    'last_date', 'folders'])
        for dom, c in sorted(comps.items(), key=lambda kv: -(kv[1]['out'] + kv[1]['in'])):
            w.writerow([dom, company_from_domain(dom), c['out'] + c['in'],
                        c['out'], c['in'], 'y' if c['in'] else '',
                        len(c['contacts']), c['first'], c['last'],
                        '; '.join(sorted(c['folders']))])

    print(f'rows in parts      {total}')
    print(f'  duplicates cut   {dupes}')
    print(f'rows written       {total - dupes}')
    print(f'contacts           {len(contacts)}')
    print(f'companies          {len(comps)}')
    print(f'-> {out_dir}')


if __name__ == '__main__':
    if len(sys.argv) < 3:
        print(__doc__); sys.exit(1)
    mode = sys.argv[1]
    if mode == 'scan':
        cmd_scan(sys.argv[2], sys.argv[3:])
    elif mode == 'merge':
        cmd_merge(sys.argv[2], sys.argv[3])
    else:
        print(__doc__); sys.exit(1)
