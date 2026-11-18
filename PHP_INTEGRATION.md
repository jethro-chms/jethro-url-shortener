# PHP Integration — jethro.au API key, signup and service consent

This document describes how a PHP application (Jethro) obtains its jethro.au API key without an admin manually creating one, and how it enables each jethro.au service for that key.

## How it works

An installation has **one jethro.au API key**, shared by every jethro.au service (the URL shortener, the [SMS shortener](https://github.com/jethro-chms/jethro-sms-shortener), …). Each service also needs the organisation's **consent**: a signed-in person agrees, on behalf of the organisation, to that service's data handling as described on its privacy page. jethro.au records the consent on the key — who agreed (`by`, their email), when (`at`) and which privacy-policy version (`version`). Services refuse a create key without it, with HTTP 403 `consent_required` (or `consent_outdated` after a material policy change).

```
Admin page                    jethro.au Worker              Google / GitHub / email
    │                              │                              │
    │  "Register" link ──────────► │                              │
    │  /signup?redirect=...        │                              │
    │    &campaign=...&service=... │  page: what the service      │
    │                              │  shares + "I agree" box      │
    │                              │── sign-in ──────────────────►│
    │                              │◄──── verified identity ──────│
    │◄── redirect with key ────────│  key minted with consent     │
    │  ?sh_apikey=cus_...          │                              │
    │  &sh_email=name@domain       │                              │
    │  &sh_consented=url-shortener │                              │
    ▼                              │                              │
  Save key to config               │                              │

Later, to enable another service for the same key:

    │── POST /api/consents ──────► │  {service, redirect} → consentUrl (10 min, single use)
    │  send the user to consentUrl │  page: service, organisation, "I agree" box, sign-in
    │◄── redirect ─────────────────│  consent recorded
    │  ?sh_consented=sms-shortener │
```

Service ids and their privacy pages:

| Service id | Name | Privacy page |
|------------|------|--------------|
| `url-shortener` | jethro.au URL shortener | `https://jethro.au/url-shortener/privacy` |
| `sms-shortener` | jethro.au SMS shortener | `https://jethro.au/sms-shortener/privacy` |

## Step 1 — Add the signup link

If `JETHROAU_API_KEY` is not defined, show the registration link. Pass the service being turned on as `$service`, and the organisation's name as `$campaign` (it is stamped on the key and shown in "I agree to this on behalf of …").

```php
<?php
require_once 'src/php/UrlShortener.php';

// The absolute URL the signup flow should redirect back to.
$callbackUrl = 'https://' . $_SERVER['HTTP_HOST'] . $_SERVER['REQUEST_URI'];

$signupUrl = (new JethroAuUrlShortener(apiKey: ''))->getSignupUrl($callbackUrl, 'Example Church', 'url-shortener');
?>
<a href="<?= htmlspecialchars($signupUrl) ?>">Register with jethro.au to enable the URL shortener</a>
```

The worker accepts any absolute `http(s)` URL as `redirect`, because the integrating app runs on its own domain. The key travels in the redirect's query string; see `isValidReturnTo` in `worker.js` for the accepted risk.

With a `service`, the signup page shows what the service shares and a required **I agree** checkbox. The worker refuses the sign-in (HTTP 400) unless it was ticked, for email and OAuth alike. Without a `service`, the key is minted with no consents.

## Step 2 — Handle the callback

After sign-in, the worker redirects back to your page with these query parameters:

| Parameter      | Description                                    |
|----------------|------------------------------------------------|
| `sh_apikey`    | The API key (starts with `cus_`)               |
| `sh_email`     | The email address of the signed-in user        |
| `sh_replaced`  | Present (value `1`) if an existing key was replaced |
| `sh_consented` | The service id consented to, when the signup was for a service |

At the top of your admin page (before any output), check for the callback:

```php
<?php
require_once 'src/php/UrlShortener.php';

if (JethroAuUrlShortener::isSignupCallback()) {
    $payload = JethroAuUrlShortener::getTokenFromCallback();
    if ($payload !== null) {
        // Save the key to conf.php (see Step 3)
        saveApiKey($payload['token']);

        $msg = 'API key registered for ' . htmlspecialchars($payload['email']);
        if ($payload['replaced']) {
            $msg .= ' (previous key replaced)';
        }
        if ($payload['consented'] !== '') {
            $msg .= '; enabled ' . htmlspecialchars($payload['consented']);
        }
        // Redirect to self to clear the query params from the URL
        header('Location: ' . strtok($_SERVER['REQUEST_URI'], '?'));
        echo '<p>' . $msg . ' — <a href="' . htmlspecialchars($_SERVER['REQUEST_URI']) . '">Continue</a></p>';
        exit;
    }
}
?>
```

**Important:** After saving the key, redirect to yourself without the query parameters. Otherwise the key remains visible in the browser's address bar and history.

## Step 3 — Save the API key

The token should be written to `conf.php` as the `JETHROAU_API_KEY` constant, which both the URL shortener and the SMS shortener clients read. A helper for appending to the config file:

```php
<?php
/**
 * Append (or update) a define() line in conf.php.
 */
function saveApiKey(string $token): void
{
    $confFile = __DIR__ . '/conf.php';
    $content = file_get_contents($confFile);
    $newLine = "define('JETHROAU_API_KEY', '" . addslashes($token) . "');\n";

    if (preg_match("/^define\\(['\"]JETHROAU_API_KEY['\"]/m", $content)) {
        // Replace existing
        $content = preg_replace(
            "/^define\\(['\"]JETHROAU_API_KEY['\"],\\s*'.*'\\);$/m",
            $newLine,
            $content
        );
    } else {
        $content .= "\n" . $newLine;
    }

    file_put_contents($confFile, $content);
}
```

**Security note:** The API key is write-only — it cannot be retrieved from the worker after this. If the key is lost, the user signs in again, which revokes the old key and issues a new one. The new key keeps the old key's consents.

## Step 4 — Check the key and its consents

`GET /api/validate` describes the key, and its `services` map says, for every jethro.au service, whether the organisation has agreed to it:

```bash
curl https://jethro.au/api/validate -H "Authorization: Bearer $JETHROAU_API_KEY"
```

```json
{
  "valid": true,
  "type": "create",
  "label": "admin@example.com",
  "created": "2026-11-18T01:02:03.000Z",
  "createdByCampaign": "Example Church",
  "tokenPrefix": "cus_1234...",
  "services": {
    "url-shortener": {
      "name": "jethro.au URL shortener",
      "consented": true, "accepted": true, "current": true,
      "version": "2026-11-18", "by": "admin@example.com", "at": "2026-11-18T01:02:03.000Z",
      "privacyUrl": "https://jethro.au/url-shortener/privacy"
    },
    "sms-shortener": {
      "name": "jethro.au SMS shortener",
      "consented": false, "accepted": false, "current": false,
      "version": null, "by": null, "at": null,
      "privacyUrl": "https://jethro.au/sms-shortener/privacy"
    }
  }
}
```

- `consented` — a consent is recorded.
- `accepted` — its version is at least the service's minimum: the service works for this key.
- `current` — it is for the latest version of the privacy page. A consent can be accepted but not current after a minor policy update; you may offer to re-confirm.
- Admin keys need no consent: all three are `true` and `version`/`by`/`at` are `null`.

## Step 5 — Enable another service later (consent flow)

To turn on a service for an existing key, ask the worker for a consent URL and send an administrator there:

```bash
curl -X POST https://jethro.au/api/consents \
  -H "Authorization: Bearer $JETHROAU_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"service": "sms-shortener", "redirect": "https://jethro.example/?view=admin__system_configuration"}'
# → 201 {"consentUrl": "https://jethro.au/consent?ticket=…", "expiresIn": 600}
```

```php
<?php
$ch = curl_init('https://jethro.au/api/consents');
curl_setopt_array($ch, [
    CURLOPT_POST => true, CURLOPT_RETURNTRANSFER => true, CURLOPT_TIMEOUT => 5,
    CURLOPT_HTTPHEADER => ['Authorization: Bearer ' . JETHROAU_API_KEY, 'Content-Type: application/json'],
    CURLOPT_POSTFIELDS => json_encode(['service' => 'sms-shortener', 'redirect' => $callbackUrl]),
]);
$data = json_decode((string)curl_exec($ch), true);
if (curl_getinfo($ch, CURLINFO_HTTP_CODE) === 201) {
    header('Location: ' . $data['consentUrl']);
    exit;
}
```

The consent page names the service and the organisation the key is registered to (`createdByCampaign`), shows what the service shares with a link to its privacy page, and asks the person to tick **I agree** and sign in (email magic link, Google or GitHub). The person signing in need not be the one who registered the key: the consent records whoever agreed. jethro.au then records the consent and redirects to `redirect` with `sh_consented=<service>` (no `sh_apikey`: the key does not change). Without a `redirect`, a confirmation page is shown.

The consent URL expires after 10 minutes and works once; afterwards, or if the key has been revoked, it shows a 410 page. Errors: 400 for an unknown service or a `redirect` that is not an absolute http(s) URL; 401 for a bad key.

## Step 6 — Turn a service off

```bash
curl -X DELETE https://jethro.au/api/consents/sms-shortener -H "Authorization: Bearer $JETHROAU_API_KEY"
# → 200 {"withdrawn": true, "service": "sms-shortener"}   (also when there was no consent)
```

The service then refuses the key with `consent_required` until consent is given again. To delete the key and its consents altogether, use `DELETE /api/keys/mine` (Deregister).

## Step 7 — Handle consent errors

A service refuses a create key without an accepted consent with HTTP 403:

```json
{"error": "consent_required", "service": "url-shortener", "privacyUrl": "https://jethro.au/url-shortener/privacy"}
```

`error` is `consent_required` (never agreed, or withdrawn) or `consent_outdated` (agreed to a version older than the service now accepts). The PHP clients throw `RuntimeException` with the code in the message, e.g. `URL shortener: API error (consent_required)` or `SMS shortener: API error (consent_outdated)`. Offer the consent flow (Step 5) in response.

## Step 8 — Verify the integration

```bash
curl -X POST https://jethro.au/api/shorten \
  -H "Authorization: Bearer <key-from-conf.php>" \
  -H "Content-Type: application/json" \
  -d '{"url": "https://example.com/test", "campaign": "integration-test"}'

# 200 with a shortUrl once the url-shortener consent is given; 403 consent_required before
```

## Shorten with bot protection (optional)

Add `"block_bots": true` to require visitors to pass a Cloudflare Turnstile check before the redirect. The flag is part of the code hash, so a protected link and an unprotected link to the same URL get **different** codes.

```bash
curl -X POST https://jethro.au/api/shorten \
  -H "Authorization: Bearer <key-from-conf.php>" \
  -H "Content-Type: application/json" \
  -d '{"url": "https://example.com/test", "campaign": "integration-test", "block_bots": true}'
```

From PHP, pass `blockBots: true` to the library; `previewShorten()` predicts the matching code with the same parameters:

```php
$protected = $s->shorten('https://example.com/test', campaign: 'integration-test', blockBots: true);
$predicted = $s->previewShorten('https://example.com/test', campaign: 'integration-test', blockBots: true);
// $protected === $predicted
```

Requires `TURNSTILE_SITE_KEY` / `TURNSTILE_SECRET_KEY` on the worker (see README step 6). Without them the API returns 501 for `"block_bots": true`.

## Hosting providers

A hosting provider running many Jethro installations (tenants) can register them without anyone signing in at jethro.au. The jethro.au operator issues the provider one **provider key** (`POST /api/keys` with `{"type": "provider", "label": "<provider name>"}`). The provider's own systems hold it — never a tenant's `conf.php` — and use it to:

1. **Issue each tenant its key.** The tenant's key is an ordinary create key; save it to that tenant's `JETHROAU_API_KEY` (Step 3). `tenant` is a stable id of the provider's choosing (1–200 characters of `[A-Za-z0-9._:-]`), `name` the organisation's name (≤100 characters), which is shown on consent pages and stamped on its short URLs.

   ```bash
   curl -X POST https://jethro.au/api/tenants \
     -H "Authorization: Bearer $PROVIDER_KEY" -H "Content-Type: application/json" \
     -d '{"tenant": "site-42.host.example", "name": "Example Parish"}'
   # → 201 {"token": "cus_...", "id": "...", "tenant": "site-42.host.example", "replaced": false}
   ```

   Calling it again for the same tenant rotates the key: the old one is revoked, its consents carry over, and `replaced` is `true`.

2. **Record the tenant's agreement to a service**, when the tenant's sysadmin — signed in to the provider's Jethro hosting, so already authenticated — ticks "I agree" on the tenant's behalf. Show them the service's acknowledgement and privacy page first (the validate `services` map has each `privacyUrl`):

   ```bash
   curl -X PUT https://jethro.au/api/tenants/site-42.host.example/consents/sms-shortener \
     -H "Authorization: Bearer $PROVIDER_KEY" -H "Content-Type: application/json" \
     -d '{"agree": true, "by": {"name": "Example Sysadmin", "email": "sysadmin@example.org"}}'
   # → 200 {"service": "sms-shortener", "consent": {"version": "2026-11-18", "by": "sysadmin@example.org",
   #         "byName": "Example Sysadmin", "byOwner": "vouched:<providerKeyId>", "vouchedBy": "<provider name>", "at": "..."}}
   ```

   `agree` must be `true` and `by.email` a valid address. jethro.au records the consent on the tenant's key as vouched for by the provider; the tenant's key then passes `/api/authorize` and `/api/shorten` for that service, and `GET /api/validate` with the tenant's key shows it (plus `issuedBy`, the provider's name, and `tenant`).

3. **Turn a service off** with `DELETE /api/tenants/{tenant}/consents/{service}` (idempotent, 200 `{"withdrawn": true, "service"}`). The tenant's own key can also call `DELETE /api/consents/{service}`.

4. **List its tenants** with `GET /api/tenants` → `[{"tenant", "name", "keyId", "tokenPrefix", "created", "consents"}]`.

5. **Revoke a tenant's key** with `DELETE /api/tenants/{tenant}` → 200 `{"revoked": true, "tenant"}`. This is exactly what the tenant's own `DELETE /api/keys/mine` (Deregister) does, including removing the tenant's identity and organisation name from its short URLs.

`{tenant}` in paths is the URL-encoded tenant id (`rawurlencode()` in PHP). Errors: 401 for a bad key; 403 `{"error": "provider_key_required"}` when a non-provider key calls `/api/tenants`; 400 for bad input or an unknown service; 404 for a tenant the provider has not issued a key to. The provider key itself cannot shorten URLs, call services or hold consents (403 `{"error": "provider_key"}`).

Self-service keys (from `/signup`) cannot be vouched for: their consents always come from a person signing in at jethro.au (Steps 1 and 5).

## Reference

### JethroAuUrlShortener signup methods

| Method | Description |
|--------|-------------|
| `getSignupUrl(string $redirectAfter, string $campaign = '', string $service = ''): string` | Build the signup URL. `$redirectAfter` is the absolute URL the worker will redirect back to with the key; `$campaign` names the organisation; `$service` (a service id) makes the signup also record consent to that service. |
| `isSignupCallback(): bool` | Returns `true` if the current request contains a signup callback (`sh_apikey` in GET params). |
| `getTokenFromCallback(): ?array` | Extracts `{token, email, replaced, consented}` from the callback, or `null` if invalid/absent. `consented` is the service id, or `''`. |

### JethroAuUrlShortener shortening methods

| Method | Description |
|--------|-------------|
| `shorten(string $url, ?string $campaign = null, bool $blockBots = false): string` | Create (or fetch, if already created) a short URL. `$campaign` defaults to the API-key prefix; `$blockBots` requires a Turnstile check before the redirect. Throws `RuntimeException` (`… API error (consent_required)`) without the url-shortener consent. |
| `previewShorten(string $url, ?string $campaign = null, bool $blockBots = false): string` | Predict the short URL locally, without an API call. Must be passed the same arguments as `shorten()` or the predicted code will differ. |
| `fetchRedirect(string $shortUrl): array` | Fetch a short URL and return `['status' => int, 'location' => string]`. |

`block_bots` is part of the code hash, so `shorten(..., blockBots: true)` and `previewShorten(..., blockBots: true)` agree with each other, while a protected link never collides with an unprotected one for the same URL and campaign.

### Callback query parameters

The worker appends these to your `redirect` URL:

- `sh_apikey` — the API key (starts with `cus_`); signup only
- `sh_email` — the verified email of the identity; signup only
- `sh_replaced=1` — set when the identity already had a key (old key was revoked)
- `sh_consented=<service>` — set when a consent was recorded (signup for a service, or the consent flow)

### Key characteristics

- **Scope:** `create` only — can use services it has consent for; cannot list/update/delete URLs or manage keys
- **One per identity:** Signing in again revokes the old key and issues a new one, keeping its consents
- **Consents:** per service, recorded with who agreed, when and which policy version; kept until withdrawn or the key is revoked
- **Attribution:** URLs created with this key carry a `createdBy` field (e.g. `google:123456789`)

### Troubleshooting

| Problem | Likely cause |
|---------|-------------|
| `/signup` or `/consent` returns 501 | No sign-in method configured (`cf workers secrets update GOOGLE_CLIENT_ID` etc., or `EMAIL_API_KEY` / `EMAIL_FROM`) |
| Sign-in returns 400 "Please tick “I agree”" | The agree box was not ticked; a signup for a service and every consent require it |
| `/consent` returns 410 | The consent URL expired (10 minutes), was already used, or the key was revoked; request a new one |
| `403 consent_required` | The organisation has not agreed to that service (or withdrew); use the consent flow |
| `403 consent_outdated` | The service's privacy policy changed materially; use the consent flow to agree to the new version |
| Google shows `redirect_uri_mismatch` | The redirect URI registered in Google Console must be `https://yourdomain/auth/google/callback` |
| Callback redirect doesn't fire | The `redirect` param must be an absolute `http(s)` URL; check for typos or trailing whitespace |
