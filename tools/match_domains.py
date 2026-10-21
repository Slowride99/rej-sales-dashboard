#!/usr/bin/env python3
"""
match_domains.py — map email domains from the mail index onto company records.

The mail index knows domains (cushwake.com). The dashboard knows companies
("Cushman & Wakefield"). Nothing joins them. This builds that join.

Inputs
  --companies  CSV of the company table: needs a name column, id optional
  --index      companies.csv or prospects.csv from index_mbox (domain, messages, ...)
  --seed       optional CSV with an email column and a company-name column.
               Real address + real company name = ground truth, highest
               confidence tier. The Zoho advertiser export works for this.
  --aliases    optional CSV of company_aliases (from_key,to_key)

Output (into --out, default ./match-out)
  domain_company_map.csv   accepted matches, with tier and evidence
  review_queue.csv         unmatched domains, ranked by email volume so the
                           50 worth doing by hand are at the top
  unmatched_companies.csv  company records no domain mapped to

Tiers, most to least trustworthy:
  seed    a known address at that domain belongs to a known company
  exact   normalised domain label == normalised company key
  prefix  one is a prefix of the other, >= 6 chars, unambiguous
  token   every significant word of the domain appears in the company name
Anything else goes to review. Nothing below 'token' is ever auto-accepted,
and any tier that produces more than one candidate company is sent to review
rather than guessed.
"""

import sys, os, re, csv, argparse
from collections import defaultdict

# Legal-form suffixes only. Deliberately NOT stripping Group / Partners /
# Construction / National / Realty / Properties — those distinguish real,
# separate companies and stripping them merges records that must stay apart.
LEGAL_SUFFIXES = ['inc', 'llc', 'ltd', 'lp', 'llp', 'plc', 'pllc',
                  'corp', 'corporation', 'co', 'company', 'holdings', 'holding']

FREEMAIL = {
    'gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'aol.com',
    'icloud.com', 'me.com', 'comcast.net', 'sbcglobal.net', 'att.net',
    'verizon.net', 'msn.com', 'live.com', 'mac.com', 'protonmail.com',
    'ymail.com', 'bellsouth.net', 'cox.net', 'charter.net', 'earthlink.net',
}

# Domains that are never a prospect company
NOISE = {
    'linkedin.com', 'amazon.com', 'google.com', 'microsoft.com', 'apple.com',
    'zoom.us', 'docusign.net', 'dropbox.com', 'eventbrite.com', 'mailchimp.com',
    'constantcontact.com', 'salesforce.com', 'calendly.com', 'adobe.com',
}
NOISE_PARTS = ('mail.', 'email.', 'news.', 'e.', 't.', 'click.', 'send.',
               'marketing.', 'notify.', 'reply.', 'bounce.', 'info.')

STOPWORDS = {'the', 'and', 'of', 'at', 'for', 'real', 'estate'}


def company_key(name):
    """Normalise a company name: lowercase, alnum only, legal suffixes off
    the END, three passes (handles 'Acme Holdings LLC')."""
    s = re.sub(r'[^a-z0-9 ]+', ' ', (name or '').lower())
    s = re.sub(r'\s+', ' ', s).strip()
    for _ in range(3):
        parts = s.split()
        if len(parts) > 1 and parts[-1] in LEGAL_SUFFIXES:
            s = ' '.join(parts[:-1])
        else:
            break
    return s.replace(' ', '')


def company_tokens(name):
    s = re.sub(r'[^a-z0-9 ]+', ' ', (name or '').lower())
    toks = [t for t in s.split() if t not in LEGAL_SUFFIXES and t not in STOPWORDS]
    return [t for t in toks if len(t) > 2]


def domain_label(domain):
    """cushwake.com -> cushwake ; am.jll.com -> jll ; co.uk handled crudely."""
    d = domain.lower().strip()
    for p in NOISE_PARTS:
        if d.startswith(p):
            d = d[len(p):]
    parts = d.split('.')
    if len(parts) >= 3 and parts[-2] in ('co', 'com', 'org', 'net', 'gov', 'ac'):
        core = parts[-3]
    elif len(parts) >= 2:
        core = parts[-2]
    else:
        core = parts[0]
    return re.sub(r'[^a-z0-9]+', '', core)


def site_domain(url):
    """https://www.colliers.com/en-us/texas -> colliers.com"""
    u = (url or '').strip().lower()
    if not u:
        return ''
    u = re.sub(r'^[a-z]+://', '', u)
    u = u.split('/')[0].split('?')[0].split('@')[-1]
    if u.startswith('www.'):
        u = u[4:]
    u = u.strip('.')
    return u if ('.' in u and ' ' not in u) else ''


def is_noise(domain):
    d = domain.lower()
    if d in NOISE or d in FREEMAIL:
        return True
    return any(d.startswith(p) for p in NOISE_PARTS)


def read_csv(path):
    with open(path, encoding='utf8', errors='replace') as f:
        return list(csv.DictReader(f))


def pick(row, *names):
    """First matching column, case/space insensitive."""
    norm = {re.sub(r'[^a-z]', '', k.lower()): k for k in row if k}
    for n in names:
        k = norm.get(re.sub(r'[^a-z]', '', n.lower()))
        if k and (row.get(k) or '').strip():
            return row[k].strip()
    return ''


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--companies', required=True)
    ap.add_argument('--index', required=True)
    ap.add_argument('--seed')
    ap.add_argument('--aliases')
    ap.add_argument('--out', default='./match-out')
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)

    # ---- company records -------------------------------------------------
    comps = []
    for r in read_csv(a.companies):
        name = pick(r, 'name', 'display_name', 'company', 'company_name', 'raw_name', 'account')
        if not name:
            continue
        site = site_domain(pick(r, 'website', 'url', 'domain', 'site'))
        comps.append({'id': pick(r, 'id', 'company_id', 'uuid', 'key'), 'name': name,
                      'site': site, 'market': pick(r, 'market'),
                      'db_key': pick(r, 'key'),
                      'key': company_key(pick(r, 'key') or name),
                      'tokens': set(company_tokens(name))})
    # company_signals is keyed by company x market, so one company appears
    # once per market. Same key = same company: collapse to one record,
    # keeping the longest display name and any website that was filled in.
    merged = {}
    for c in comps:
        k = c['key']
        if not k:
            continue
        m = merged.get(k)
        if m is None:
            c['markets'] = set()
            merged[k] = m = c
        if len(c['name']) > len(m['name']):
            m['name'] = c['name']
        if c['site'] and not m['site']:
            m['site'] = c['site']
        if c['id'] and not m['id']:
            m['id'] = c['id']
        if c.get('db_key') and not m.get('db_key'):
            m['db_key'] = c['db_key']
        if c.get('market'):
            m['markets'].add(c['market'])
    if len(merged) < len(comps):
        print(f'   collapsed to      {len(merged)} distinct companies')
    comps = list(merged.values())
    for c in comps:
        c['tokens'] = set(company_tokens(c['name']))

    by_key, by_site = defaultdict(list), defaultdict(list)
    for c in comps:
        if c['key']:
            by_key[c['key']].append(c)
        if c['site']:
            by_site[c['site']].append(c)
    print(f'company records      {len(comps)}  ({len(by_key)} distinct keys)')
    print(f'   with a website    {sum(1 for c in comps if c["site"])}')

    # ---- aliases ---------------------------------------------------------
    alias = {}
    if a.aliases and os.path.exists(a.aliases):
        for r in read_csv(a.aliases):
            f, t = pick(r, 'from_key', 'from'), pick(r, 'to_key', 'to')
            if f and t:
                alias[company_key(f)] = company_key(t)
        print(f'aliases              {len(alias)}')

    def resolve(key):
        return alias.get(key, key)

    # ---- seed pairs: address at domain -> company name -------------------
    seed = defaultdict(lambda: defaultdict(int))
    if a.seed and os.path.exists(a.seed):
        for r in read_csv(a.seed):
            em = pick(r, 'email', 'email_address', 'contact_email').lower()
            nm = pick(r, 'company', 'company_name', 'account')
            if '@' not in em or not nm:
                continue
            dom = em.split('@', 1)[1]
            if is_noise(dom):
                continue
            seed[dom][nm] += 1
        print(f'seed domains         {len(seed)}')

    # ---- index domains ---------------------------------------------------
    idx = []
    for r in read_csv(a.index):
        dom = pick(r, 'domain').lower()
        if not dom or is_noise(dom):
            continue
        try:
            vol = int(pick(r, 'messages', 'sent_to') or 0)
        except ValueError:
            vol = 0
        idx.append({'domain': dom, 'volume': vol, 'label': domain_label(dom),
                    'last': pick(r, 'last_date'), 'sent': pick(r, 'sent_to'),
                    'replied': pick(r, 'replied')})
    idx.sort(key=lambda d: -d['volume'])
    print(f'index domains         {len(idx)}  (noise and freemail removed)')

    matched, review = [], []
    used = set()

    # seed: a domain can carry several company names (people change firms,
    # data entry noise). Take the modal name and only trust a clear majority.
    seed_best = {}
    for dom, names in seed.items():
        tot = sum(names.values())
        nm, n = max(names.items(), key=lambda kv: kv[1])
        if n >= 2 and n / tot >= 0.6:
            seed_best[dom] = (nm, n, tot)
        elif tot == 1:
            seed_best[dom] = (nm, 1, 1)

    def first_token_len(c):
        toks = company_tokens(c['name'])
        return len(toks[0]) if toks else len(c['key'])

    for d in idx:
        label, cands, tier, why = d['label'], [], '', ''

        # tier 0 - the company record's own website. Their data, not a guess.
        hits = by_site.get(d['domain'], [])
        if not hits:
            # mail from a subdomain: am.jll.com against a site of jll.com
            parent = '.'.join(d['domain'].split('.')[-2:])
            if parent != d['domain']:
                hits = by_site.get(parent, [])
        if len(hits) == 1:
            cands, tier = hits, 'website'
            why = f'company website is {hits[0]["site"]}'
        elif len(hits) > 1:
            why = f'website shared by: {", ".join(h["name"] for h in hits[:3])}'

        # tier 1 - seed, majority agreement only
        if not cands and d['domain'] in seed_best:
            nm, n, tot = seed_best[d['domain']]
            hits = by_key.get(resolve(company_key(nm)), [])
            if len(hits) == 1:
                cands, tier = hits, 'seed'
                why = f'{n}/{tot} known contacts at {d["domain"]} -> "{nm}"'
            elif d['domain'] in seed:
                why = f'seed names disagree: {", ".join(list(seed[d["domain"]])[:3])}'

        # tier 2 - exact key
        if not cands and label:
            hits = by_key.get(resolve(label), [])
            if len(hits) == 1:
                cands, tier, why = hits, 'exact', f'{label} == company key'
            elif len(hits) > 1:
                why = f'exact but ambiguous: {", ".join(h["name"] for h in hits[:3])}'

        # tier 3 - prefix, but only when the domain reaches PAST the company's
        # first word. "mccorddev" -> "McCord Development" is real; "jacobs" ->
        # "Jacobs Properties" is a coin flip, because any number of companies
        # start with the same word.
        if not cands and len(label) >= 6 and not why:
            hits = []
            for c in comps:
                k = c['key']
                if not k:
                    continue
                if k.startswith(label) and len(label) > first_token_len(c):
                    hits.append(c)
                elif label.startswith(k) and 0 < len(label) - len(k) <= 2:
                    hits.append(c)
            hits = {c['name']: c for c in hits}.values()
            hits = list(hits)
            if len(hits) == 1:
                cands, tier = hits, 'prefix'
                why = f'{label} ~ {hits[0]["key"]}'
            elif len(hits) > 1:
                why = f'ambiguous: {", ".join(h["name"] for h in hits[:3])}'

        if cands and len(cands) == 1:
            c = cands[0]
            used.add(c['name'])
            matched.append({'domain': d['domain'], 'company_id': c['id'],
                            'company_name': c['name'], 'company_key': c['key'],
                            'db_key': c.get('db_key') or '',
                            'tier': tier, 'evidence': why, 'messages': d['volume'],
                            'markets': '; '.join(sorted(c.get('markets') or [])),
                            'sent_to': d['sent'], 'replied': d['replied'],
                            'last_date': d['last']})
        else:
            review.append({'domain': d['domain'], 'label': label,
                           'messages': d['volume'], 'sent_to': d['sent'],
                           'replied': d['replied'], 'last_date': d['last'],
                           'note': why or 'no candidate', 'company_name': ''})

    with open(os.path.join(a.out, 'domain_company_map.csv'), 'w', newline='',
              encoding='utf8') as f:
        w = csv.DictWriter(f, fieldnames=['domain', 'company_id', 'company_name',
                                          'company_key', 'db_key', 'tier', 'evidence', 'markets',
                                          'messages', 'sent_to', 'replied', 'last_date'])
        w.writeheader(); w.writerows(matched)

    with open(os.path.join(a.out, 'review_queue.csv'), 'w', newline='',
              encoding='utf8') as f:
        w = csv.DictWriter(f, fieldnames=['domain', 'label', 'messages', 'sent_to',
                                          'replied', 'last_date', 'note', 'company_name'])
        w.writeheader(); w.writerows(review)

    with open(os.path.join(a.out, 'unmatched_companies.csv'), 'w', newline='',
              encoding='utf8') as f:
        w = csv.writer(f); w.writerow(['company_id', 'company_name'])
        for c in comps:
            if c['name'] not in used:
                w.writerow([c['id'], c['name']])

    tiers = defaultdict(int)
    for m in matched:
        tiers[m['tier']] += 1
    vol_m = sum(m['messages'] for m in matched)
    vol_r = sum(r['messages'] for r in review)

    print()
    print(f'matched domains      {len(matched)}')
    for t in ('website', 'seed', 'exact', 'prefix'):
        if tiers[t]:
            print(f'   {t:8}          {tiers[t]}')
    print(f'to review            {len(review)}')
    print(f'companies matched    {len(used)} of {len(comps)}')
    if vol_m + vol_r:
        print(f'message volume covered  {100*vol_m//(vol_m+vol_r)}%')
    print(f'-> {a.out}')


if __name__ == '__main__':
    main()
