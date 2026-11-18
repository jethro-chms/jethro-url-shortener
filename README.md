# jethro.au URL Shortener

A heavily modified fork of [IAMDevBox/cloudflare-url-shortener](https://github.com/IAMDevBox/cloudflare-url-shortener) deployed at [jethro.au](https://jethro.au), used for shortening URLs in Jethro SMSes. It is also the jethro.au account: it issues the one API key each Jethro installation uses for every jethro.au service, and records the organisation's consent to each service (see [Services and consent](#services-and-consent)).

A production-ready, self-hosted URL shortener built with **Cloudflare Workers** and **KV storage**. Zero cost, global edge performance, and full CRUD admin API. Click counts come from Cloudflare zone analytics.

> 📖 **Upstream tutorial**: [Building a Self-Hosted URL Shortener with Cloudflare Workers](https://www.iamdevbox.com/posts/building-self-hosted-url-shortener-cloudflare-workers/)

## Features

- **Short URL redirects** — `/s/{code}` → full URL, served from edge cache with stale-while-revalidate
- **Path and query passthrough** — `/s/{code}/extra/path?x=1` appends the extra path and merges the query into the target
- **Deterministic short codes** — SHA-256 hash of `(url, campaign, block_bots)` makes creation idempotent: same inputs always produce the same code
- **Click analytics** — per-code redirect counts from Cloudflare zone analytics (includes cache hits; no KV writes on redirect)
- **Full CRUD API** — create, list, update, soft-delete, restore, permanent-delete
- **Multi-key authentication** — admin and create-only API keys with full CRUD management, revocable without rotating the bootstrap key
- **Self-service signup** — anyone can obtain a create-only key via Google, GitHub, or email magic link at `/signup`
- **Per-service consent** — each jethro.au service (this URL shortener, the [SMS shortener](https://github.com/jethro-chms/jethro-sms-shortener)) works for a key only once someone has agreed, on behalf of the organisation, to its data handling; recorded with who, when and which privacy-policy version
- **Privacy page** — `/url-shortener/privacy` describes what this service stores and who can see it
- **Campaign attribution** — keys created via the signup flow are stamped with a campaign id, and every URL shortened with that key inherits it — so you can trace which organisation created which link
- **Privacy-preserving deregistration** — self-service key revocation (`DELETE /api/keys/mine`) scrubs owner identity and campaign from all URLs created by that key, while the shortened URLs themselves keep working
- **Bot protection** — per-URL `block_bots` flag puts a Cloudflare Turnstile check in front of the redirect
- **Campaign tagging** — organize URLs by campaign
- **Notes field** — admin annotations per URL (up to 500 chars)
- **Soft delete + restore** — data is preserved until you permanently remove it
- **Edge caching** — Workers Cache with cache tags and automatic invalidation on mutations
- **PHP library** — typed PHP client with preview capability for offline code prediction
- **CORS support** — works with any frontend admin dashboard
- **Zero cost** — fits within Cloudflare's free tier (100k requests/day)

## Changes from upstream

### Non-enumerable, deterministic short codes

Shortened URLs are of the form https://jethro.au/s/{code}.

Upstream's short URL codes are a simple integer counter.

Our codes are derived from a SHA-256 hash of `(url, campaign, block_bots)`, making creation **idempotent** — posting the same URL + campaign (+ optional `block_bots` flag) always returns the same short code. The campaign acts as a salt: same URL with different campaigns produces different codes. By default the campaign is the first 8 characters of the API key, so each installation produces different codes for the same URL — unguessable across tenants. You can override the campaign to a semantic tag (e.g. `"sms"`, `"email"`) for filtering in listings. Short codes are 6-character alphanumeric, collision-resistant.

Being deterministic allows the client to determine what the code will be, ahead of time. In Jethro, this allows the SMS preview to show a shortened URL calculated locally, and only actually hit the https://jethro.au shortener API when a SMS is actually sent. This makes previewing fast and cheap, which is necessary because it happens on each keypress (debounced).

### Bot protection

Scenario: you have deployed a webapp to https://my-webapp.fly.dev or https://myapp-12345.shellbox.dev, 'scale to zero' hosting providers that only run your app when requests come in, and shut it down after inactivity. You need to post a public URL to your app, but don't want random crawlers triggering wake-ups and using bandwidth. Now you can run:

```
devbox run shorten-protected https://my-webapp.fly.dev/
```

and get a shortened URL that opens to a Cloudflare 'turnstile' page checking the requester is human, before redirecting to the shortened app.

### Path and query passthrough

Anything after the code is carried over to the target. If `https://yourdomain.com/s/33b18c` redirects to `https://my-webapp.fly.dev`, then `https://yourdomain.com/s/33b18c/?view=admin__system_configuration` redirects to `https://my-webapp.fly.dev/?view=admin__system_configuration`.

- **Path:** the extra path is appended to the target path without doubling slashes (`/s/{code}/x` on target `https://h/base/` → `https://h/base/x`).
- **Query:** request parameters are merged into the target's. Where both set the same key, the request wins (`?view=admin` on target `?keep=1&view=home` → `?keep=1&view=admin`); other target parameters keep their original encoding.
- **Fragment:** a `#fragment` on the target is kept.
- Applies to every link. The scheme and host always come from the stored target, so a crafted suffix can reach any path on the target host but never another host.

### No UTM parameter injection

Upstream injects `utm_source`, `utm_medium`, `utm_campaign`, and `utm_content` query parameters on every redirect. This fork has removed all UTM tracking — redirects are clean, adding nothing beyond the original target URL and any path/query the visitor supplied.

### No click counting

Upstream stores click statistics in `stats:{code}` KV keys with per-source breakdowns (twitter, linkedin, direct, etc.). **This fork does not track clicks at all**: redirects write nothing, and there is no stats API endpoint. Use Cloudflare zone analytics instead (see [Click statistics](#click-statistics)). Zone analytics see every edge response, including redirects served from Workers Cache that never reach the Worker, so they are more accurate than an in-Worker counter. They also avoid KV writes, which are capped at 1,000/day on the free tier.

### Multi-key authentication

Three key types stored in KV with full CRUD management:

| Type | Scope |
|------|-------|
| `admin` | Full access — create, list, update, delete URLs; manage API keys |
| `create` | Create-only — can shorten URLs, cannot list/update/delete |
| `provider` | A hosting provider's key — issues and manages its tenants' create keys via `/api/tenants`; cannot shorten URLs or use services itself (see [Hosting providers](#hosting-providers)) |

Keys are revocable without rotating the bootstrap admin key. The bootstrap key is set via `cf workers secrets update API_KEY` and stored as a Cloudflare Workers secret.

### Self-service API keys (OAuth + email signup)

Anyone can obtain a `create`-scoped key by signing in at `/signup`:

1. User visits `https://yourdomain.com/signup` and picks a provider (Google, GitHub, or email magic link).
2. After sign-in, the worker verifies the identity (verified email required) and mints a key, shown once.
3. Each identity holds exactly one key — signing in again revokes the old key and issues a new one (self-service rotation).

All API keys (bootstrap, admin-created, and self-service) are stored hashed: `tok:{sha256}` → `apikey:{id}` lookup, no plaintext tokens in KV. Self-service keys are also stamped with their owner (`google:{sub}` / `github:{id}` / `email:{hash}` plus email) and an optional campaign id passed as `?campaign=` on the signup URL. URLs created with such a key carry `createdBy` and `createdByCampaign` fields, so every short link is attributable to a person and their organisation. Admins see owners via `GET /api/keys` and can revoke with `DELETE /api/keys/{id}`.

Key holders can deregister themselves via `DELETE /api/keys/mine`, which revokes the key and scrubs their `createdBy` / `createdByCampaign` attribution from any URLs they created. The shortened URLs themselves are untouched — they continue to work, just anonymously.

Setup is optional — see [step 5 of the Quick Start](#5-optional-enable-self-service-api-key-signup). Providers with no client ID configured are hidden from `/signup`; with neither configured the page returns 501 and the feature is effectively off.

### Services and consent

One key serves an installation for every jethro.au service, but each service also needs the organisation's **consent** to its data handling, given by a signed-in person and recorded on the key. The services are listed in `SERVICES` in `worker.js`:

| Service id | Privacy page | Checked by |
|------------|--------------|------------|
| `url-shortener` | `/url-shortener/privacy` (`privacy.js`) | `POST /api/shorten` |
| `sms-shortener` | `/sms-shortener/privacy` (served by the SMS shortener Worker) | the SMS shortener, through `GET /api/authorize` over a service binding |

A consent is stored on the key record as `consents[serviceId] = { version, by, byOwner, at }`: the privacy-policy version agreed to, the signer's email and sign-in identity, and when. Each service has a `policyVersion` — the "last updated" date of its privacy page, which must change together with the page — and a `minPolicyVersion`. A consent is **accepted** (the service works) while its version is at least `minPolicyVersion`, and **current** when it equals `policyVersion`. Raise `minPolicyVersion` only for material changes: every organisation must then agree again. Admin keys need no consent.

Consent is given:

- **At signup**, with `?service=<id>` on `/signup`: the page states what the service shares, links its privacy page, and requires an **I agree to this on behalf of …** checkbox. The worker enforces the checkbox for email and OAuth sign-ins, mints the key with that consent, and adds `sh_consented=<id>` to the redirect back.
- **Later**, for an existing key: `POST /api/consents` returns a single-use consent URL (10 minutes) whose page names the service and the organisation the key is registered to, and asks someone to tick **I agree** and sign in. The consent is then recorded with their identity and the browser is redirected back with `sh_consented=<id>`.
- **By an operator**, with `PUT /api/keys/{id}/consents/{service}` (admin only), for agreement given another way, e.g. in writing.
- **By a hosting provider**, for its tenants' keys only, on the word of the tenant's sysadmin (see [Hosting providers](#hosting-providers)).

Consents are kept until withdrawn (`DELETE /api/consents/{service}`) or the key is revoked. Signing in again, which replaces the key, carries its consents over. A service refuses a create key without an accepted consent with 403 `{ "error": "consent_required" | "consent_outdated", "service", "privacyUrl" }`; `GET /api/validate` reports every service's status. See [PHP_INTEGRATION.md](PHP_INTEGRATION.md) for the flow from Jethro's side.

### Hosting providers

A hosting provider running many Jethro installations (tenants) gets one **provider key** from the operator (`POST /api/keys` with `"type": "provider"` and its name as `label`). With it, the provider:

- issues each tenant its own create key (`POST /api/tenants`), keyed by a stable tenant id and named after the tenant's organisation;
- records a tenant's consent to a service on the word of the tenant's sysadmin, whom the provider's own Jethro hosting has authenticated (`PUT /api/tenants/{tenant}/consents/{service}`), so tenants never sign in at jethro.au;
- withdraws consents, lists its tenants, and revokes tenant keys.

Tenant keys are ordinary create keys (`issuedBy`, `tenant`, `owner: "tenant:{providerKeyId}:{tenant}"`, `createdByCampaign` = the organisation name), so each tenant's consents, rate limits and URL attribution stay separate. `tenant:{providerKeyId}:{tenant}` → `{keyId}` indexes them. Minting a key for a tenant that already has one revokes the old key and carries its consents over. A vouched consent records `by` (the sysadmin's email), `byName`, `byOwner: "vouched:{providerKeyId}"`, `vouchedBy` (the provider's label), `version` and `at`.

Provider keys can't shorten URLs, call services or hold consents (403 `{"error": "provider_key"}`). Self-service keys from `/signup` have no vouched path: their consents still need a sign-in. Revoking a provider key (`DELETE /api/keys/{id}`) does not revoke the keys it issued; revoke those first with `DELETE /api/tenants/{tenant}` if needed. See [PHP_INTEGRATION.md](PHP_INTEGRATION.md#hosting-providers) for the flow.

#### Setting up a hosting provider

1. **The jethro.au operator creates the provider key** (needs `URLSHORTENER_ADMIN_KEY` in `.env`):

   ```bash
   devbox run create-provider-key "Example Hosting"
   ```

   The name is shown to tenants as "Managed by …" and recorded on every agreement the provider vouches for. The command prints the token, which jethro.au doesn't keep, so it can't be shown again; lose it and create another. It also prints the `revoke-key` command for the key.

2. **The provider configures its Jethro sites.** In the `conf.php` they all share:

   ```php
   define('JETHROAU_PROVIDER_KEY', 'cus_…');   // the token from step 1
   ```

   and in a site's own `conf.php`, unless the host name in its `BASE_URL` is a unique id that will never change:

   ```php
   define('JETHROAU_TENANT', 'site-id');   // unique per site, never changed
   ```

   jethro.au keeps one key per provider and tenant id: a site whose id changes gets a fresh key without its agreements, and two sites sharing an id share a key. The default, when `BASE_URL` has no host, is the database name. Each site's `SYSTEM_NAME` is sent as its organisation name.

   Never put `JETHROAU_API_KEY` (or `JETHROAU_SERVICES`) in a shared `conf.php`: agreements belong to a key, so every site would share them. Jethro stores each site's own key in its database.

3. **Each site's sysadmin turns services on.** In System Configuration → *jethro.au Services*, **Turn on URL shortening** / **Turn on SMS shortening** shows the service's privacy notice and "I agree to the privacy policy of … on behalf of <SYSTEM_NAME>". Confirming gets the site its key (first time only) and records the agreement with the sysadmin's name and email, vouched for by the provider. Nobody signs in at jethro.au. **Turn off** withdraws an agreement; **Deregister** revokes the site's key.

A site that registered itself before its provider set a provider key keeps working with its own key until a sysadmin turns a service on; Jethro then replaces it with a tenant key, without its old agreements or short-URL attribution. Deregister first to revoke the old key rather than leave it live.

### Devbox tooling

[Devbox](https://www.jetify.com/devbox) manages Node.js and PHP runtimes. Commands:

```bash
devbox run test                 # Run functional tests
devbox run deploy               # Redeploy the worker
devbox run shorten <url> [c]    # Create a short URL
devbox run stats <code> [--days N]   # Click counts from zone analytics (≤30 days)
devbox run list-urls            # List all active URLs
devbox run list-keys            # List API keys
devbox run create-key <label> [--type <type>]   # Create an API key
devbox run create-provider-key <name>           # Create a hosting provider key (prints Jethro conf.php lines)
devbox run revoke-key <id>      # Revoke an API key
devbox run redirect <code>      # Show redirect target
devbox run help                 # Show all commands
```

Environment configured via `.env` (gitignored) and `devbox.json` `env` field, which reads from `.env` via `"env_from": ".env"`.

### PHP library

Jethro is PHP, so we provide a PHP library for interacting with the shortener.

`src/php/UrlShortener.php` — interface + factory for use in any PHP project:

```php
require_once 'src/php/UrlShortener.php';

define('URLSHORTENER', 'jethroau');
define('JETHROAU_API_KEY', 'cus_...');   // the installation's jethro.au key, shared by all jethro.au services

$s = getUrlShortener();
// Short codes are salted with the API key prefix, so each installation
// produces different codes for the same URL — unguessable across tenants.
$s->shorten('https://example.com/long');                  // → https://jethro.au/s/abc123
$s->previewShorten('https://example.com/long');            // predicted, no API call — same code
$s->fetchRedirect('https://jethro.au/s/abc123');           // → ['status' => 302, 'location' => ...]

// You can override the campaign for semantic tagging (e.g. "sms", "email"):
$s->shorten('https://example.com/long', campaign: 'email');

// Bot protection: visitors must pass a Turnstile check before redirecting.
// $blockBots is part of the code hash, so protected and unprotected links to
// the same URL get different codes.
$s->shorten('https://example.com/long', campaign: 'sms', blockBots: true);
$s->previewShorten('https://example.com/long', campaign: 'sms', blockBots: true);

// Build a signup URL that stamps the key with a campaign id (the organisation)
// and records its consent to the URL shortener:
$signupUrl = $s->getSignupUrl('https://my.app/callback', 'my-organisation', 'url-shortener');
// → https://jethro.au/signup?redirect=...&campaign=my-organisation&service=url-shortener
```

`src/php/shorten.php` — CLI frontend using the library:

```bash
devbox run -- php src/php/shorten.php https://example.com/my-post twitter
# → https://jethro.au/s/abc123
```

### Tests

`devbox run test` — PHP functional test against the live API: predicts a short code via `previewShorten()`, creates it via the live API, confirms the codes match, fetches the short URL, and validates the 302 redirect to the original target.

`node test_worker.js` — Worker tests (72). The first 14 run `worker.js` in-process with a fake KV namespace and faked Resend and GitHub APIs, covering signup and consent end to end: the agree checkbox enforced by the server, consents minted at signup and carried over on re-signup, consent tickets through email and OAuth sign-in, and tickets being single use. The other 58 are an HTTP integration suite (services and consent through the admin API, `/api/authorize`, `/api/shorten` with and without consent, `/api/consents`, provider keys and `/api/tenants`, the privacy and landing pages). Point it at a deployed worker, or run the worker locally:

```bash
# .dev.vars holds local values for secrets declared in cloudflare.config.ts
cat > .dev.vars <<'EOF'
API_KEY=test-key
TURNSTILE_SITE_KEY=1x00000000000000000000AA
TURNSTILE_SECRET_KEY=dummy-secret-for-local-tests
EOF

npx cf dev                                   # serves on http://localhost:5173
BASE_URL=http://localhost:5173 API_KEY=test-key node test_worker.js
```

`.dev.vars` is gitignored. Secrets not declared in `cloudflare.config.ts` are not loaded by `cf dev`. When `TURNSTILE_*` are unset, the `block_bots` test skips its assertions instead of failing.

## Architecture

```
User → /s/{code} → Edge cache (1h fresh, 24h stale) → Cloudflare Worker (edge, <15ms) → KV lookup → 302 redirect
```

## Quick Start

### 1. Clone and install

```bash
git clone git@github.com:jethro-chms/jethro-url-shortener.git
cd jethro-url-shortener
devbox shell         # provisions Node.js 24 + PHP 8.4
npm install
```

### 2. Create a KV namespace

```
npx cf kv namespaces create --title URL_MAPPINGS
```

### 3. Configure `cloudflare.config.ts`

```bash
cp cloudflare.config.example.ts cloudflare.config.ts
```

In `cloudflare.config.ts` replace every `yourdomain.com` with your actual domain, and replace `YOUR_KV_NAMESPACE_ID` with the namespace printed in step 2:

```ts
triggers.fetch({ pattern: "yourdomain.com/s/*", zone: "yourdomain.com" }),
// ...
URL_MAPPINGS: bindings.kv({ id: "YOUR_KV_NAMESPACE_ID" }), // from step 2
```

The example config also routes the zone root (`yourdomain.com/`) to the worker's landing page, plus `/consent*`, `/api/authorize*`, `/api/consents*`, `/api/tenants*` and `/url-shortener/*` for the consent flow, hosting providers and the privacy page. If you upgraded from an earlier version, add those triggers too — without them the requests fall through to the origin and hang.

Set `PRIVACY_OPERATOR` and `PRIVACY_CONTACT`: they name who runs the service, and how to reach them, on the privacy page and landing page.

### 4. Set your admin API key

```bash
cp .env.example .env
# Add URLSHORTENER_ADMIN_KEY=your-secret-value
npx cf workers secrets update API_KEY --worker url-shortener --type secret_text   # Enter "$URLSHORTENER_ADMIN_KEY"
```

This is your **bootstrap admin key** — it has full access and cannot be revoked via the API. Use it to create additional keys (including scoped create-only keys) via `/api/keys`.


### 5. (Optional) Enable self-service API key signup

This step lets anyone mint their own `create`-scoped key by signing in at `https://yourdomain.com/signup`. Skip this step and the feature stays off. You can enable any or all of the three providers: Google OAuth, GitHub OAuth, and email magic link.

**Google** (in [Google Cloud Console](https://console.cloud.google.com/)):

1. Create (or select) a project — any name, e.g. `url-shortener`.
2. Under **APIs & Services → OAuth consent screen**, set the app name and support email, and choose **External** as the audience. Publish the app (while it's in "Testing" mode, only listed test users can sign in). The flow only requests the non-sensitive `openid email` scopes, so no Google review is required.
3. Under  [Google Auth Platform → Clients → Create client](https://console.cloud.google.com/auth/clients/create) click **Create Credentials → OAuth client ID**, application type **Web application**.
4. Add the authorized redirect URI: `https://yourdomain.com/auth/google/callback`
5. Copy the **Client ID** and **Client secret**.
6. Run:

```sh
npx cf workers secrets update GOOGLE_CLIENT_ID --worker url-shortener --type secret_text   # Enter **Client ID**
npx cf workers secrets update GOOGLE_CLIENT_SECRET --worker url-shortener --type secret_text   # Enter "**Client secret**"
```

**GitHub** (in [Developer settings → OAuth Apps](https://github.com/settings/developers)):

1. Click **New OAuth App**.
2. Set an application name, homepage URL `https://yourdomain.com`, and authorization callback URL: `https://yourdomain.com/auth/github/callback`
3. Register, then click **Generate a new client secret**. Copy the **Client ID** and the secret.
4. Run:

```sh
npx cf workers secrets update GITHUB_CLIENT_ID --worker url-shortener --type secret_text  # Enter Github **Client ID**
npx cf workers secrets update GITHUB_CLIENT_SECRET --worker url-shortener --type secret_text  # Enter Github **Client secret**
```

**Email magic link** (uses [Resend](https://resend.com) to deliver the link):

1. Create a [Resend](https://resend.com) account and get an API key. The API key only needs permission 'Sending access'.
2. Verify your sending domain, or use Resend's testing domain for development.
3. Run:

```bash
npx cf workers secrets update EMAIL_API_KEY --worker url-shortener --type secret_text    # Enter Resend API key
npx cf workers secrets update EMAIL_FROM --worker url-shortener --type secret_text  # e.g. "shortener@yourdomain.com"
```

### 6. (Optional) Enable bot protection for `block_bots` URLs

URLs created with `"block_bots": true` show a [Cloudflare Turnstile](https://developers.cloudflare.com/turnstile/) check before redirecting. Turnstile is free on the Free plan (up to 20 widgets per account, 10 hostnames per widget).

Create a widget for your domain (or use the dashboard: Turnstile → Add widget). The response contains the widget's `sitekey` and `secret`:

```bash
npx cf turnstile widgets create --name url-shortener --domains yourdomain.com --widget-mode managed
```

Store both values as Worker secrets:

```bash
npx cf workers secrets update TURNSTILE_SITE_KEY --worker url-shortener --type secret_text    # Widget sitekey
npx cf workers secrets update TURNSTILE_SECRET_KEY --worker url-shortener --type secret_text  # Widget secret
```

If you lose the secret, find the widget with `npx cf turnstile widgets list` and rotate it with `npx cf turnstile widgets rotate-secret <sitekey>` rather than creating another widget. Rotating invalidates outstanding `bot_pass` cookies, since the secret also signs them.

Without both secrets, requests with `block_bots: true` are rejected with 501, and existing protected links return 503 (fail closed).

### 7. (Optional) Receive replies with Cloudflare Email Routing

If you enabled self-signup, the URL shortener gained the ability to send signup emails a validation 'magic link'. That email would be sent through Resend.com, and will come from the `EMAIL_FROM` address (e.g. `shortener@yourdomain.com`).

Most probably, you don't expect or care about any emails sent _to_ `shortener@yourdomain.com` - it's just there for the magic link - but if you _do_ want emails there to go to a person, here is how.

First: Resend.com would be the logical choice (it's the email sender, why not also receive?), and it [is possible](https://resend.com/docs/dashboard/receiving/forward-emails) but only through a horrible webhook + code solution.

A simpler alternative is [Cloudflare Email Routing](https://developers.cloudflare.com/email-routing/), which forwards mail sent to an address on your domain to an existing mailbox. It only receives mail; magic links are still sent through Resend. 

To set this up:

1. Enable Email Routing for the zone. This adds and locks the required MX and SPF records:

```bash
npx cf email-routing enable -z yourdomain.com
```

2. Add the destination mailbox. Cloudflare emails it a verification link, which must be clicked before the rule in step 3 can be created:

```bash
npx cf email-routing addresses create --email you@example.com
```

3. Forward the address to that mailbox:

```bash
npx cf email-routing rules create -z yourdomain.com \
  --name "shortener -> you" \
  --matchers '[{"type":"literal","field":"to","value":"shortener@yourdomain.com"}]' \
  --actions '[{"type":"forward","value":["you@example.com"]}]'
```

4. Check that it's enabled (`"enabled": true`) and the rule exists, then send a test message to `shortener@yourdomain.com`:

```bash
npx cf email-routing settings get -z yourdomain.com
npx cf email-routing rules list -z yourdomain.com
```

### 8. Deploy

```bash
npx cf deploy
```

That's it — your URL shortener is live at `https://yourdomain.com/s/*`.

Visit `https://yourdomain.com/signup` to test: sign in, and your API key is shown once. Each identity holds one key; signing in again revokes the old key and issues a new one. Keys and their owners are visible to admins via `GET /api/keys`.

## API Reference

All write endpoints require `Authorization: Bearer YOUR_API_KEY` (admin or create, depending on the endpoint). Create keys can only use a service whose consent they hold (see [Services and consent](#services-and-consent)).

### Create a short URL

```bash
curl -X POST https://yourdomain.com/api/shorten \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://example.com/very/long/blog/post/",
    "code": "oauth",          # optional custom code (auto-generated if omitted)
    "campaign": "blog_post",  # optional campaign tag (default: "general")
    "notes": "OAuth guide",   # optional admin note (max 500 chars)
    "block_bots": true        # optional: require a Turnstile bot check before redirecting
  }'
```

Response:
```json
{
  "shortUrl": "https://yourdomain.com/s/oauth",
  "code": "oauth",
  "longUrl": "https://example.com/very/long/blog/post/"
}
```

If the same URL + campaign was already created, the response includes `"existing": true` and returns the existing short code (idempotent). `block_bots` is part of the identity: protected and unprotected links to the same URL get different codes (hash of `url::campaign::block_bots`).

Create keys need an accepted `url-shortener` consent; without one the response is 403 `{"error": "consent_required", "service": "url-shortener", "privacyUrl": "https://yourdomain.com/url-shortener/privacy"}` (`consent_outdated` for a consent to a superseded policy version).

`block_bots` links: `GET /s/{code}` returns a Turnstile page; the widget POSTs its token to `/s/{code}`, the worker verifies it with Cloudflare's siteverify API, then 303-redirects and sets a signed `bot_pass` cookie (30 minutes, all `/s/` links) so the visitor isn't challenged again. These responses are never cached. CLI: `devbox run shorten-protected <url> [campaign]`.

### Click statistics

The worker does **not** count clicks: there is no counter in KV and no `/api/stats` endpoint. Every request to `/s/{code}` is still logged by Cloudflare's zone analytics, and you can query those logs for free.

Limits:

- **31-day retention** on the free plan. Older data is gone; export it periodically if you need lifetime totals.
- **Sampled counts.** The `events.httpRequests` dataset is adaptively sampled; `SUM(sampleInterval)` gives an estimate, exact at low traffic.
- **No visitor detail beyond what Cloudflare logs.** Bots, link-preview fetchers (e.g. SMS/chat apps unfurling the link) and repeat visits all count as requests.

#### CLI (per code)

```bash
devbox run stats <code> [--days N]     # N = 1–30, default 30
```

```json
{
  "code": "oauth",
  "days": 7,
  "clicks": 142,
  "by_status": { "302": 142 }
}
```

`clicks` counts 302 (redirect) and 303 (redirect after bot check) responses for `/s/{code}` and `/s/{code}/…`. `by_status` shows everything else too, e.g. `200` for Turnstile challenge pages served to `block_bots` links. The command shells out to `npx cf`, which must be logged in (`npx cf auth`) with Analytics Read on the zone.

#### Raw SQL (top codes, custom queries)

`npx cf sql query` runs SQL against the analytics datasets. Queries must be scoped to the zone, and `ORDER BY` requires a `LIMIT`:

```bash
ZONE_ID=$(npx cf zones list --name yourdomain.com | jq -r '.[0].id')

# Top 20 short codes by redirects over the last 7 days
npx cf sql query --scope-zone "$ZONE_ID" "
  SELECT clientRequestPath AS path, SUM(sampleInterval) AS clicks
  FROM events.httpRequests
  WHERE clientRequestPath LIKE '/s/%'
    AND edgeResponseStatus IN (302, 303)
    AND timestamp >= NOW() - INTERVAL '7' DAY
  GROUP BY path ORDER BY clicks DESC LIMIT 20
  FORMAT JSON"
```

Useful columns include `clientRequestPath`, `clientRequestHttpHost`, `clientRefererHost`, `edgeResponseStatus`, `timestamp` and `sampleInterval`. List them all with:

```bash
npx cf sql datasets --account-tag <account-id> --dataset-name events.httpRequests --include-columns
```

#### Dashboard

In the Cloudflare dashboard, open the zone's HTTP traffic analytics and add a filter on path (e.g. starts with `/s/oauth`) to get the same counts as a chart.

### List all active URLs

```bash
curl https://yourdomain.com/api/urls \
  -H "Authorization: Bearer YOUR_API_KEY"
```

Requires admin key.

### List deleted URLs

```bash
curl https://yourdomain.com/api/urls/deleted \
  -H "Authorization: Bearer YOUR_API_KEY"
```

Requires admin key.

### Update a URL

```bash
curl -X PUT https://yourdomain.com/api/urls/oauth \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"url": "https://example.com/new-url/", "campaign": "updated", "notes": "Updated destination"}'
```

You can update the target URL, campaign, short code (rename), notes, and `block_bots`. Requires admin key.

### Soft delete (recoverable)

```bash
curl -X DELETE https://yourdomain.com/api/urls/oauth \
  -H "Authorization: Bearer YOUR_API_KEY"
```

Requires admin key.

### Restore a deleted URL

```bash
curl -X POST https://yourdomain.com/api/urls/oauth/restore \
  -H "Authorization: Bearer YOUR_API_KEY"
```

Requires admin key.

### Permanent delete (irreversible)

```bash
# Must soft-delete first, then permanently remove
curl -X DELETE https://yourdomain.com/api/urls/oauth/permanent \
  -H "Authorization: Bearer YOUR_API_KEY"
```

Requires admin key.

### List API keys

```bash
curl https://yourdomain.com/api/keys \
  -H "Authorization: Bearer YOUR_API_KEY"
```

Requires admin key.

### Create an API key

```bash
curl -X POST https://yourdomain.com/api/keys \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"type": "create", "label": "CI/CD pipeline"}'
```

Response:
```json
{
  "id": "uuid",
  "token": "cus_...",
  "type": "create",
  "label": "CI/CD pipeline",
  "created": "2025-07-01T10:30:00Z"
}
```

The `token` is only returned once on creation. `type` must be `"admin"`, `"create"` or `"provider"`; a provider key needs a `label` (the provider's name). Requires admin key.

### Revoke an API key

```bash
curl -X DELETE https://yourdomain.com/api/keys/{id} \
  -H "Authorization: Bearer YOUR_API_KEY"
```

Requires admin key. The bootstrap admin key (set via `cf workers secrets update`) cannot be revoked via the API.

### Revoke your own key (self-service deregistration)

```bash
curl -X DELETE https://yourdomain.com/api/keys/mine \
  -H "Authorization: Bearer YOUR_API_KEY"
```

Any valid key can revoke itself. This deletes the key (with its consents, and its tenant index entry for a tenant key) from KV and scrubs the owner's identity and campaign from any URLs they created — the shortened URLs themselves continue to work.

### Validate a key

```bash
curl https://yourdomain.com/api/validate \
  -H "Authorization: Bearer YOUR_API_KEY"
```

Any valid key. Returns `valid`, `type`, `label`, `created`, `tokenPrefix`, the owner fields and `createdByCampaign` when set, and `services`: for every service, `{ name, consented, accepted, current, version, by, at, privacyUrl }`. Admin keys report `consented`/`accepted`/`current` true and `version`/`by`/`at` null. Tenant keys add `issuedBy` (the provider's label) and `tenant`; provider keys report `type: "provider"` and no `services`. See [PHP_INTEGRATION.md](PHP_INTEGRATION.md#step-4--check-the-key-and-its-consents) for an example.

### Authorize a key for a service

```bash
curl "https://yourdomain.com/api/authorize?service=sms-shortener" \
  -H "Authorization: Bearer YOUR_API_KEY"
```

For other jethro.au Workers (through a service binding). 200 `{"authorized": true, "keyId": "…", "service": "sms-shortener"}` (`keyId` is null for the bootstrap key); 401 `{"error": "Unauthorized"}`; 403 `{"error": "consent_required" | "consent_outdated", "service", "privacyUrl"}`; 400 for an unknown service. Admin keys need no consent.

### Start consent to a service

```bash
curl -X POST https://yourdomain.com/api/consents \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"service": "sms-shortener", "redirect": "https://jethro.example/admin"}'
```

201 `{"consentUrl": "https://yourdomain.com/consent?ticket=…", "expiresIn": 600}`. Send a person to `consentUrl`: they tick **I agree** and sign in, the consent is recorded, and they are redirected to `redirect` (optional; absolute http(s)) with `sh_consented=sms-shortener`, or shown a confirmation page. The ticket (`ct:{uuid}` in KV) works once; an expired or used ticket, or a revoked key, gives a 410 page. 400 for an unknown service, a bad `redirect` or the bootstrap key; 401 for a bad key.

### Withdraw consent to a service

```bash
curl -X DELETE https://yourdomain.com/api/consents/sms-shortener \
  -H "Authorization: Bearer YOUR_API_KEY"
```

200 `{"withdrawn": true, "service": "sms-shortener"}`, also when there was no consent. 400 for an unknown service or the bootstrap key; 401 for a bad key.

### Record a consent (operators)

```bash
curl -X PUT https://yourdomain.com/api/keys/{id}/consents/sms-shortener \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"by": "admin@example.org"}'
```

Requires admin key. Records a consent given outside the sign-in flow (e.g. in writing); `by` says who agreed, `version` (`YYYY-MM-DD`, optional) defaults to the service's current `policyVersion`, and `byOwner` records the admin key used. 200 `{"id", "service", "consent"}`; 404 for an unknown key; 400 for a provider key. The tests use it to give consents.

### Tenants (provider keys)

All `/api/tenants` endpoints take a provider key: 401 for a bad key, 403 `{"error": "provider_key_required"}` for any other key type. `{tenant}` is the tenant id, URL-encoded.

```bash
# Issue (or rotate) a tenant's key
curl -X POST https://yourdomain.com/api/tenants \
  -H "Authorization: Bearer PROVIDER_KEY" -H "Content-Type: application/json" \
  -d '{"tenant": "site-42.host.example", "name": "Example Parish"}'
# → 201 {"token": "cus_...", "id": "...", "tenant": "site-42.host.example", "replaced": false}

# Record the tenant's consent, on its sysadmin's word
curl -X PUT https://yourdomain.com/api/tenants/site-42.host.example/consents/sms-shortener \
  -H "Authorization: Bearer PROVIDER_KEY" -H "Content-Type: application/json" \
  -d '{"agree": true, "by": {"name": "Example Sysadmin", "email": "sysadmin@example.org"}}'
# → 200 {"service": "sms-shortener", "consent": {"version", "by", "byName", "byOwner", "vouchedBy", "at"}}

# Withdraw it (idempotent) → 200 {"withdrawn": true, "service": "sms-shortener"}
curl -X DELETE https://yourdomain.com/api/tenants/site-42.host.example/consents/sms-shortener -H "Authorization: Bearer PROVIDER_KEY"

# List the provider's tenants → [{"tenant", "name", "keyId", "tokenPrefix", "created", "consents"}]
curl https://yourdomain.com/api/tenants -H "Authorization: Bearer PROVIDER_KEY"

# Revoke a tenant's key, as its own DELETE /api/keys/mine would → 200 {"revoked": true, "tenant": "..."}
curl -X DELETE https://yourdomain.com/api/tenants/site-42.host.example -H "Authorization: Bearer PROVIDER_KEY"
```

- `POST /api/tenants`: `tenant` is 1–200 characters of `[A-Za-z0-9._:-]`, `name` 1–100 characters; 400 otherwise. A tenant that already has a key gets a new one (`replaced: true`), its old key revoked and its consents carried over.
- `PUT …/consents/{service}`: 400 for an unknown service, `agree` other than `true`, or a missing/invalid `by.email` (≤254 characters) or `by.name` over 100 characters; 404 for a tenant this provider has not issued a key to.
- `DELETE /api/tenants/{tenant}`: 404 for an unknown tenant. The tenant key can still withdraw its own consents with `DELETE /api/consents/{service}` and revoke itself with `DELETE /api/keys/mine`.

## Caching

This worker uses [Cloudflare Workers Cache](https://blog.cloudflare.com/workers-cache/) to serve redirects from edge cache, reducing latency and KV read costs.

### Cached Endpoints

| Endpoint | Cache Duration | Stale-while-revalidate |
|---|---|---|
| `GET /s/{code}` (redirect) | 1 hour (`max-age=3600`) | 24 hours |

Not cached (`no-store`): 404 for unknown or deleted codes, 400 for invalid codes, and all `block_bots` responses. A cached 404 would outlive the code being created (creation does not purge the cache), so every request for an unknown code runs the Worker and costs one KV read.

### How It Works

- **Fresh window** (within `max-age`): The response is served directly from Cloudflare's edge cache. The Worker does NOT run.
- **Stale window** (`max-age` to `max-age + stale-while-revalidate`): The cached response is served immediately while the Worker runs in the background to revalidate.
- **After both windows**: A full cache miss occurs, and the Worker fetches from KV.

### Cache Invalidation

Cache entries are automatically purged when a URL is mutated:

- **Update** (`PUT /api/urls/{code}`) — purges redirect cache for the affected code(s)
- **Delete** (`DELETE /api/urls/{code}`) — purges cache so deleted URLs return 404 immediately
- **Restore** (`POST /api/urls/{code}/restore`) — purges cache so restored URLs are accessible
- **Permanent delete** (`DELETE /api/urls/{code}/permanent`) — purges cache

Cache tag used: `redirect:{code}`.

Purges are eventually consistent — expect a few seconds of propagation delay across the edge before a purged code reliably returns a fresh (`MISS`) response.

### Configuration

Cache is enabled in `cloudflare.config.ts` with `cache: { enabled: true }`. The `compatibilityDate` must be `2026-05-01` or later.

### Local Development

Workers Cache is a Cloudflare edge product and is **not** available in `cf dev`. The code guards against `ctx.cache` being undefined, so all endpoints continue to work normally without caching during local development.

## URL enumeration

Short codes are guessable. Generated codes are 6 hex characters, so there are only 16⁶ ≈ 16.7M of them, and `GET /s/{code}` needs no authentication. Anyone can walk the code space and collect every target URL. Treat short links as public: don't rely on an unguessable code to protect a sensitive target URL.

Scanning also costs you money or availability. Misses are never cached (see [Caching](#caching)), so each guess runs the Worker and does one KV read. On the free plan, about **100,000 requests in a UTC day** (≈1.2/s) exhausts the Worker request quota, and every route — including `/api/*` and `/signup` — fails until midnight UTC. That rate is far too low for Cloudflare's automatic DDoS protection to notice.

### Rate limiting `/s/*` with a WAF rule

A WAF rate-limiting rule blocks excess requests at the edge, before they reach the Worker. The free plan allows **one** rate-limiting rule, with a fixed 10-second period and 10-second block, counted per IP per data centre.

Check for an existing rule first. The free plan only allows one, and the command below **replaces** the whole `http_ratelimit` ruleset:

```bash
npx cf rulesets entrypoint get http_ratelimit -z yourdomain.com
```

If no rate-limit rules exist yet, this **fails with an error**, which is expected and means it's safe to continue:

```
[10003] could not find entrypoint ruleset in the http_ratelimit phase
404 Not Found
```

If it instead prints a ruleset, an existing rule is in place: add it to the `--rules` array below or it will be removed.

Create the rule (20 requests per 10 seconds per IP on `/s/*`):

```bash
npx cf rulesets entrypoint update http_ratelimit -z yourdomain.com --rules '[{
  "description": "Short-link enumeration",
  "expression": "starts_with(http.request.uri.path, \"/s/\")",
  "action": "block",
  "ratelimit": {
    "characteristics": ["ip.src", "cf.colo.id"],
    "period": 10,
    "requests_per_period": 20,
    "mitigation_timeout": 10
  }
}]'
```

Add `--validate-only` to check the rule without saving it. To remove it later, run the same command with `--rules '[]'`.

Notes:

- **Threshold.** A real visitor makes one request per link (plus a POST for `block_bots` links). The rule runs before the cache, so cached redirects count toward the limit too. Keep it generous enough for shared IPs (offices, mobile carrier NAT); 20 per 10 s is a reasonable start.
- **What it doesn't stop.** A single IP is still allowed up to ~172,800 requests a day, and a scan spread across many IPs is barely slowed. The rule makes enumeration slower and more expensive for the attacker; it doesn't prevent it.
- **Higher plans** can count only misses (a counting expression on the response code, e.g. `http.response.code eq 404`), use longer periods, and pick other characteristics. Check Cloudflare's rate-limiting docs for which plan unlocks each option.
- The real fix for guessability is longer codes (e.g. 8+ base62 characters), which makes a scan pointless rather than merely slower. That change would also need the PHP `previewShorten` updated to match.

## License

Apache License 2.0 — see [LICENSE](LICENSE).
