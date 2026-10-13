# Custom domains on Cloudflare for SaaS

The recommended edge for running custom domains at global scale
(`EDGE_PROVIDER=cloudflare`). Cloudflare terminates TLS for every store's
domain in 300+ cities, issues and renews each domain's certificate, absorbs
attacks, and forwards requests to the platform's origin. The platform tells it
which hostnames to serve through the Custom Hostnames API
(`src/platform/domains/edge/edgeProvider.ts`).

## One-time setup

1. **A zone for the platform domain** (e.g. `myveylog.com`) on a plan with
   Cloudflare for SaaS enabled (SSL/TLS → Custom Hostnames).
2. **Fallback origin**: create `origin.myveylog.com` (proxied) pointing at the
   API's load balancers, and set it as the fallback origin. Every custom
   hostname's traffic goes there with the shopper's `Host` header intact —
   which is how the API finds the store.
3. **Targets merchants point at**:
   * `shops.myveylog.com` → CNAME to `origin.myveylog.com` (proxied) — the
     shared target (`PLATFORM_EDGE_HOSTNAME`).
   * `*.shops.myveylog.com` → CNAME to `shops.myveylog.com` (proxied) — every
     domain's own target `d-<token>.shops.myveylog.com` resolves through this
     wildcard (`PLATFORM_EDGE_TARGET_ZONE=shops.myveylog.com`).
4. **Root domains** (`example.com`) cannot hold a CNAME at most providers.
   Either enable *apex proxying* (Cloudflare assigns anycast IPs for the
   account; put them in `PLATFORM_EDGE_IPS` / `PLATFORM_EDGE_IPV6`) or leave
   `PLATFORM_EDGE_IPS` empty so the admin tells merchants to use CNAME
   flattening / ALIAS at their provider.
5. **An API token** with *Zone → SSL and Certificates → Edit* for the zone.

## Environment

```
EDGE_PROVIDER=cloudflare
CLOUDFLARE_API_TOKEN=…
CLOUDFLARE_ZONE_ID=…
PLATFORM_EDGE_HOSTNAME=shops.myveylog.com
PLATFORM_EDGE_TARGET_ZONE=shops.myveylog.com
PLATFORM_EDGE_IPS=…            # only with apex proxying
EDGE_CERTIFICATE_AUTHORITIES=pki.goog,letsencrypt.org,ssl.com
DNS_RESOLVERS=cloudflare,google
```

`EDGE_CERTIFICATE_AUTHORITIES` lists the CAs Cloudflare may use, so the
platform can tell a merchant when their CAA records would block issuance.

## What happens to a domain

1. The merchant connects `shop.example.com`; the platform shows
   `CNAME shop.example.com → d-<token>.shops.myveylog.com`.
2. The sweep sees the CNAME (via DoH, from Cloudflare's and Google's
   resolvers), which proves ownership, and creates the custom hostname with
   **HTTP validation** — Cloudflare validates it itself because traffic
   already reaches it.
3. The sweep polls the hostname until `ssl.status` is `active`, then marks
   the domain live and notifies the merchant.
4. Removing the domain deletes the custom hostname.

## The edge worker: redirects and page caching at the edge

`deploy/edge/worker/storefront.ts` is a Cloudflare Worker for the zone's
`*/*` route, so it runs for every custom hostname in every location
(`wrangler.toml.example` has the setup). Per request it:

1. looks up the hostname's route from `GET /internal/edge/route?host=` —
   shop, pod, primary domain, HTTPS, lock state and the shop's **content
   version** — kept in the location's cache for `ROUTE_TTL` seconds (10);
2. answers redirects itself: non-primary domains to the primary (301, path
   and query kept) and HTTP to HTTPS, without a trip to the origin;
3. serves anonymous catalogue and content pages (no cart, no signed-in
   customer, no preview, no locked store) from the location's cache, keyed by
   URL (tracking parameters dropped), the shopper's `localization` country
   and the content version. Only responses the origin marks
   `X-Veylog-Cacheable` are kept;
4. forwards everything else to the shop's regional origin (`POD_ORIGINS`) with
   `X-Forwarded-Host` / `X-Forwarded-Proto`, which the API trusts the same way
   it trusts its load balancer (`trust proxy`).

Every change to a store bumps its content version
(`src/platform/cache/storefrontVersions.ts`), so within `ROUTE_TTL` seconds
the edge asks for new keys and the old copies simply expire — **there are no
purge API calls**, whatever the number of stores. `X-Veylog-Edge-Cache`
(HIT / MISS / BYPASS) on a response says what the edge did; the origin adds
`X-Veylog-Cache` for its own in-memory cache.

Set `PAGE_CACHE_MAX_MB=0` on the API to switch caching off everywhere: the
route then reports `cache_ttl: 0` and the edge stops keeping pages.

## Limits to know

* Custom hostnames per zone are a plan quota; request an increase before
  onboarding large numbers of stores.
* The API allows about 1,200 requests per 5 minutes per user. The platform
  only asks Cloudflare about a hostname while its certificate is being issued,
  or within three weeks of its expiry; a live domain's regular health check is
  DNS only (public DoH resolvers). Steady state is therefore a trickle of API
  calls however many domains there are; the burst to plan for is onboarding
  (one create and a few polls per new domain). Shard stores across several
  zones and tokens before onboarding tens of thousands of domains a day.
