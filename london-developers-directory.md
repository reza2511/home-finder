# London New-Build Developers — Aggregator Directory (2026, expanded)

A working directory of housebuilders actively selling new homes **to buy** in London, for feeding into per-developer scraper adapters. This is the sources list for the Home Finder tool — **only these developers' own sites are valid sources. Never Rightmove/Zoopla, and never rental sites like SpareRoom.**

**How to use:** Build one adapter per developer — each site's HTML differs, so there's no universal scraper. Start with "Priority 1", get the pipeline working, then expand. URLs marked *(verify)* are my best guess at the current listings path — confirm before coding each adapter.

**The golden rule:** if an adapter can't fetch or parse data, it returns **empty** and logs the failure to the status monitor. It must **never** substitute placeholder, stock, or invented listings. An empty result is correct; fake data is not.

**Portal presence:** most large developers syndicate to Rightmove New Homes / Zoopla / WhatHouse. Your edge — stock that skips the portals — clusters in (a) early off-plan phase releases from London specialists, (b) small developers, and (c) shared-ownership homes, which mostly live on the provider's own site plus Share to Buy / Homes for Londoners.

**Compliance:** check each site's `robots.txt` and terms, keep request rates polite, cache, set a clear User-Agent.

---

## Tier 1 — National builders with London arms

| Developer | Listings site | Tenures | On portals? | Off-portal value | Priority |
|---|---|---|---|---|---|
| Barratt London (Barratt Redrow) | barratthomes.co.uk/new-homes/london | Freehold, leasehold | Yes | Low–Med | 1 |
| Taylor Wimpey London | taylorwimpey.co.uk/new-homes/london | Freehold, leasehold | Yes | Low–Med | 1 |
| Bellway London | bellway.co.uk *(verify)* | Freehold, leasehold | Yes | Low–Med | 2 |
| Vistry / Countryside Partnerships | countryside-properties.com *(verify)* | Freehold, leasehold, SO | Yes | Med | 2 |
| Crest Nicholson | crestnicholson.com/developments *(verify)* | Freehold, leasehold | Yes | Low–Med | 3 |

---

## Tier 2 — London-specialist private-sale developers (highest-value targets)

| Developer | Listings site | Tenures | On portals? | Off-portal value | Priority |
|---|---|---|---|---|---|
| Berkeley Group (unified brand) | berkeleygroup.co.uk/developments/london | Leasehold, freehold | Yes | Med | 1 |
| Galliard Homes | galliardhomes.com/property/new-developments-london | Leasehold, freehold | Partly | High | 1 |
| Ballymore | ballymoregroup.com | Leasehold | Partly | High | 1 |
| Mount Anvil | mountanvil.com | Leasehold | Partly | High | 1 |
| Related Argent | relatedargent.co.uk (+ kingscross.co.uk, brentcrosstown.co.uk) | Leasehold | Partly | High | 2 |
| Lendlease | elephantpark.co.uk/live-here (+ Stratford Cross) | Leasehold | Partly | High | 2 |
| Telford Homes | telfordhomes.london | Leasehold | Partly | High | 2 |
| Canary Wharf Group | canarywharf.com *(verify)* | Leasehold | Partly | High | 2 |
| Battersea Power Station Dev. Co. | batterseapowerstation.co.uk *(verify)* | Leasehold | Partly | Med | 2 |
| EcoWorld London | ecoworld-london.com *(verify)* | Leasehold | Partly | High | 3 |
| Regal London | regal-london.co.uk *(verify)* | Leasehold | Partly | High | 3 |
| Native Land | nativeland.com *(verify)* | Leasehold | Rarely | High | 3 |
| London Square | londonsquare.co.uk *(verify)* | Leasehold, freehold | Partly | Med | 3 |
| Fairview New Homes | fairview.co.uk *(verify)* | Freehold, leasehold | Yes | Med | 3 |
| Hill Group | hill.co.uk *(verify)* | Freehold, leasehold | Yes | Med | 3 |
| Weston Homes | weston-homes.com *(verify)* | Leasehold, freehold | Yes | Med | 3 |
| Pocket Living | pocketliving.com | Discount market sale (FTBs) | Rarely | High | 3 |
| Higgins Homes | higginshomes.co.uk *(verify)* | Leasehold, freehold | Partly | Med | 4 |
| Fruition Properties | fruitionproperties.co.uk *(verify)* | Leasehold | Rarely | High | 4 |
| Anthology (LaSalle) | anthology.london *(verify)* | Leasehold | Partly | High | 4 |
| Londonewcastle | londonewcastle.co.uk *(verify)* | Leasehold | Rarely | High | 4 |
| City & Docklands | cityanddocklands.com *(verify)* | Leasehold | Rarely | High | 4 |
| Places for People | placesforpeople.co.uk *(verify)* | Freehold, leasehold, SO | Partly | Med | 4 |
| Quintain (Wembley Park) | wembleypark.com *(verify)* | Leasehold | Rarely | **Low** | 4 |

*Note: Quintain's Wembley Park is now largely build-to-rent — limited for-sale stock, so low priority for a buy-focused site. Telford Homes is also shifting toward BTR; confirm for-sale availability.*

---

## Tier 3 — Housing associations & shared-ownership providers

Shared-ownership stock often bypasses the portals entirely — high off-portal value, but messier data.

| Provider | Listings site | Tenures | On portals? | Off-portal value | Priority |
|---|---|---|---|---|---|
| L&Q | lqhomes.com *(verify)* | SO, private sale | Partly | High | 2 |
| Peabody New Homes | peabodynewhomes.co.uk | SO, private sale | Partly | High | 2 |
| Clarion / Latimer | latimerhomes.com *(verify)* | SO, private sale | Partly | High | 3 |
| Notting Hill Genesis (NHG Homes) | nhghomes.com *(verify)* | SO, private sale | Partly | High | 3 |
| Southern Housing (SO Resi) | soresi.co.uk *(verify)* | SO | Rarely | High | 3 |
| Sovereign Network Group (SNG) | sng.org.uk *(verify)* | SO | Rarely | High | 4 |
| Hyde New Homes | hyde-housing.co.uk *(verify)* | SO | Rarely | High | 4 |
| A2Dominion | a2dominion.co.uk *(verify)* | SO, private sale | Partly | High | 4 |
| Guinness Homes | guinnesshomes.co.uk *(verify)* | SO | Rarely | High | 4 |
| MTVH | mtvh.co.uk *(verify)* | SO | Rarely | High | 4 |
| Sage Homes | sagehomes.co.uk *(verify)* | SO | Rarely | High | 4 |

---

## Aggregators (for discovery + backfill)

- **Share to Buy** — sharetobuy.com — main shared-ownership marketplace.
- **Homes for Londoners** — london.gov.uk/homesforlondoners — Mayor's affordable home-ownership search.
- **WhatHouse** — whathouse.com — new-build-only portal.
- **New Homes for Sale** — newhomesforsale.co.uk — new-build aggregator.
- **1newhomes** — 1newhomes.com — tracks 500+ London developers; use to find ones not yet on this list.

---

## Suggested build order

1. **Prove the pipeline** on Barratt London + Taylor Wimpey (clean, high volume).
2. **Add the off-portal specialists** — your differentiator: Galliard, Ballymore, Mount Anvil, Berkeley, Related Argent, Lendlease, Telford.
3. **Layer in shared ownership** — L&Q, Peabody, Share to Buy — the biggest source of stock that isn't on Rightmove.
4. **Expand down Tiers 2–3** and add aggregators to backfill.

Every adapter feeds the same sync job: filter out auction/retirement, stamp `first_seen` on new listings, mark absent ones as removed, and **log failures instead of faking data.**
