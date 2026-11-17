/**
 * Cloudflare Worker - jethro.au account and URL shortener
 *
 * Features:
 * - Short URL redirects: /s/{code}[/path][?query] → full URL, with extra
 *   path appended and query merged (request params override target params)
 * - Full CRUD API with Bearer token authentication
 * - Soft delete + restore + permanent delete
 * - jethro.au accounts: /signup mints one create-scoped key per signed-in
 *   identity (Google/GitHub OAuth or email magic link); one key serves an
 *   installation for every jethro.au service
 * - Per-service consent (SERVICES): an organisation agrees to each service's
 *   data handling separately, at signup or later through /consent. Create keys
 *   without an accepted consent are refused by /api/shorten and by
 *   /api/authorize, which other jethro.au Workers call over a service binding
 * - The URL shortener's privacy page at /url-shortener/privacy (privacy.js)
 *
 * Deploy: cf deploy
 * Companion article: https://www.iamdevbox.com/posts/building-self-hosted-url-shortener-cloudflare-workers/
 */

import { privacyPage } from './privacy.js';

// KV namespace binding: URL_MAPPINGS
// Configure in cloudflare.config.ts

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    // Short URL redirect: /s/{code}. POST carries a Turnstile token for
    // block_bots URLs.
    if (url.pathname.startsWith('/s/')) {
      if (request.method === 'POST') return handleBotCheck(request, url, env);
      return handleShortUrl(request, url, env);
    }

    // API: Create short URL (admin, or create key with url-shortener consent)
    if (url.pathname === '/api/shorten' && request.method === 'POST') {
      return handleCreateShortUrl(request, env);
    }

    // API: Key management (admin only, except /mine)
    if (url.pathname === '/api/keys' && request.method === 'GET') {
      return handleListKeys(request, env);
    }
    if (url.pathname === '/api/keys' && request.method === 'POST') {
      return handleCreateKey(request, env);
    }
    if (url.pathname === '/api/keys/mine' && request.method === 'DELETE') {
      return handleDeleteOwnKey(request, env);
    }
    const keyConsentMatch = url.pathname.match(/^\/api\/keys\/([^/]+)\/consents\/([^/]+)$/);
    if (keyConsentMatch && request.method === 'PUT') {
      return handleAdminPutConsent(request, env, keyConsentMatch[1], keyConsentMatch[2]);
    }
    if (url.pathname.match(/^\/api\/keys\/([^/]+)$/) && request.method === 'DELETE') {
      return handleDeleteKey(request, url, env);
    }

    // API: Validate the current API key (authenticated)
    if (url.pathname === '/api/validate' && request.method === 'GET') {
      return handleValidateKey(request, env);
    }

    // API: per-service authorization and consent (see SERVICES)
    if (url.pathname === '/api/authorize' && request.method === 'GET') {
      return handleAuthorize(request, url, env);
    }
    if (url.pathname === '/api/consents' && request.method === 'POST') {
      return handleCreateConsentTicket(request, url, env);
    }
    const consentMatch = url.pathname.match(/^\/api\/consents\/([^/]+)$/);
    if (consentMatch && request.method === 'DELETE') {
      return handleWithdrawConsent(request, env, consentMatch[1]);
    }

    // API: List all active URLs (admin only)
    if (url.pathname === '/api/urls' && request.method === 'GET') {
      return handleListUrls(request, env);
    }

    // API: Update URL (admin only)
    if (url.pathname.startsWith('/api/urls/') && request.method === 'PUT') {
      return handleUpdateUrl(request, url, env, ctx);
    }

    // API: Restore deleted URL (admin only) — must be before generic DELETE
    if (url.pathname.match(/^\/api\/urls\/[^/]+\/restore$/) && request.method === 'POST') {
      return handleRestoreUrl(request, url, env, ctx);
    }

    // API: Permanently delete URL (admin only) — must be before generic DELETE
    if (url.pathname.match(/^\/api\/urls\/[^/]+\/permanent$/) && request.method === 'DELETE') {
      return handlePermanentDelete(request, url, env, ctx);
    }

    // API: List deleted URLs (admin only)
    if (url.pathname === '/api/urls/deleted' && request.method === 'GET') {
      return handleListDeletedUrls(request, env);
    }

    // API: Soft delete URL (admin only)
    if (url.pathname.startsWith('/api/urls/') && request.method === 'DELETE') {
      return handleDeleteUrl(request, url, env, ctx);
    }

    // Landing page
    if (url.pathname === '/' && request.method === 'GET') {
      return htmlResponse(landingPage(env));
    }

    // The URL shortener's privacy page; its date is the service's policyVersion.
    if (url.pathname === SERVICES['url-shortener'].privacyPath && (request.method === 'GET' || request.method === 'HEAD')) {
      return new Response(privacyPage(env, SERVICES['url-shortener'].policyVersion), {
        headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=3600' },
      });
    }

    // Self-service signup: OAuth login → mint a create-scoped API key
    if (url.pathname === '/signup' && request.method === 'GET') {
      try {
        return handleSignupPage(url, env);
      } catch (e) {
        console.error('Signup page error:', e);
        return new Response('Signup error: ' + String(e.message || e), {
          status: 500,
          headers: { 'Content-Type': 'text/plain' },
        });
      }
    }

    // Consent to a service for an existing key (ticket from POST /api/consents)
    if (url.pathname === '/consent' && request.method === 'GET') {
      return handleConsentPage(url, env);
    }

    // Email magic-link flow, for signup and for consent
    if ((url.pathname === '/signup' || url.pathname === '/consent') && request.method === 'POST') {
      return handleEmailSignIn(request, url, env);
    }
    if (url.pathname === '/auth/email/callback' && request.method === 'GET') {
      return handleEmailCallback(request, url, env);
    }

    const oauthMatch = url.pathname.match(/^\/auth\/(google|github)\/(login|callback)$/);
    if (oauthMatch && request.method === 'GET') {
      return oauthMatch[2] === 'login'
        ? handleOAuthLogin(url, env, oauthMatch[1])
        : handleOAuthCallback(request, url, env, oauthMatch[1]);
    }

    return new Response('URL Shortener - see /api/* for endpoints', { status: 200 });
  },
};

/**
 * The jethro.au landing page: what the services are, that each is enabled
 * separately, and where their privacy pages are.
 */
function landingPage(env) {
  const service = (id, what, repo) => `<li><strong>${escapeHtml(SERVICES[id].name)}</strong>: ${what}
      <a href="${escapeHtml(SERVICES[id].privacyPath)}">Privacy</a> · <a href="${repo}">Source code</a></li>`;
  const contact = env.PRIVACY_CONTACT
    ? ` For more information, contact <a href="mailto:${escapeHtml(env.PRIVACY_CONTACT)}">${escapeHtml(env.PRIVACY_CONTACT)}</a>.`
    : '';
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>jethro.au</title></head>
<body>
  <p>jethro.au hosts optional web services for installations of the Jethro church management system:</p>
  <ul>
    ${service('url-shortener', 'shortens web addresses in SMS messages sent from Jethro.', 'https://github.com/jethro-chms/jethro-url-shortener')}
    ${service('sms-shortener', 'suggests shorter wordings for SMS messages being written in Jethro, using Cloudflare Workers AI, so they need fewer SMS segments.', 'https://github.com/jethro-chms/jethro-sms-shortener')}
  </ul>
  <p>An installation registers one jethro.au API key, from Jethro's System Configuration page. Each service is then
  enabled separately: someone signs in and agrees, on behalf of their organisation, to how that service handles data,
  as described on its privacy page.${contact}</p>
</body>
</html>`;
}

/**
 * Redirect /s/{code} to the target URL. block_bots URLs get a Turnstile
 * challenge page unless the client holds a valid pass cookie.
 */
async function handleShortUrl(request, url, env) {
  const { code, restPath } = parseShortPath(url);

  // Codes never contain ':' — reject early so reserved KV records
  // (apikey:, idx:, tok:, owner:, ml:, ct:) are unreachable via public routes
  if (!code || code.includes(':')) {
    return new Response('Invalid short URL', {
      status: 400,
      headers: { 'Cache-Control': 'no-store' },
    });
  }

  try {
    const mapping = await env.URL_MAPPINGS.get(code, { type: 'json' });

    if (!mapping || mapping.deleted) {
      return new Response(null, {
        status: 404,
        headers: { 'Cache-Control': 'no-store' },
      });
    }

    if (mapping.block_bots) {
      if (!turnstileConfigured(env)) {
        return new Response('Bot protection is not configured', {
          status: 503,
          headers: { 'Cache-Control': 'no-store' },
        });
      }
      if (!(await hasValidBotPass(request, env))) {
        return htmlResponse(botCheckPage(env), 200);
      }
      // Never cache: the cache would serve the redirect to unchallenged clients.
      return new Response(null, {
        status: 302,
        headers: { Location: buildTarget(mapping.url, restPath, url.search), 'Cache-Control': 'no-store' },
      });
    }

    return new Response(null, {
      status: 302,
      headers: {
        Location: buildTarget(mapping.url, restPath, url.search),
        'Cache-Control': 'public, max-age=3600, stale-while-revalidate=86400',
        'Cache-Tag': `redirect:${code}`,
      },
    });
  } catch (error) {
    console.error('Error handling short URL:', error);
    return new Response('Internal Server Error', {
      status: 500,
      headers: { 'Cache-Control': 'no-store' },
    });
  }
}

/**
 * POST /api/shorten — Create a new short URL
 * Body: { url, code?, campaign?, notes?, block_bots? }
 *
 * Admin keys, or create keys whose organisation has an accepted
 * 'url-shortener' consent (403 consent_required / consent_outdated otherwise).
 */
async function handleCreateShortUrl(request, env) {
  try {
    const { err: authErr, auth } = await requireService(request, env, 'url-shortener');
    if (authErr) return authErr;

    const body = await request.json();
    const { url: longUrl, code, notes } = body;
    const blockBots = body.block_bots ?? false;

    if (typeof blockBots !== 'boolean') {
      return jsonResponse({ error: 'block_bots must be a boolean' }, 400);
    }
    if (blockBots && !turnstileConfigured(env)) {
      return jsonResponse({ error: 'block_bots is not available: bot protection is not configured on this server' }, 501);
    }

    if (!longUrl) {
      return jsonResponse({ error: 'url is required' }, 400);
    }

    const urlErr = validateTargetUrl(longUrl);
    if (urlErr) {
      return jsonResponse({ error: urlErr }, 400);
    }

    if (code !== undefined && code !== null && !isValidShortCode(code)) {
      return jsonResponse({ error: 'code must be 1-64 characters: letters, digits, hyphen or underscore' }, 400);
    }

    if (notes !== undefined && notes !== null && notes !== '') {
      if (typeof notes !== 'string') {
        return jsonResponse({ error: 'notes must be a string' }, 400);
      }
      if (notes.length > 500) {
        return jsonResponse({ error: 'notes must be 500 characters or less' }, 400);
      }
    }

    const campaign = body.campaign || 'general';

    if (typeof campaign !== 'string' || campaign.length > 64) {
      return jsonResponse({ error: 'campaign must be a string of at most 64 characters' }, 400);
    }

    // Check idempotency: same URL + campaign + block_bots → same code
    const idxKey = await hashKey(longUrl, campaign, blockBots);
    const existingIdx = await env.URL_MAPPINGS.get(`idx:${idxKey}`, { type: 'json' });
    if (existingIdx) {
      const existingMapping = await env.URL_MAPPINGS.get(existingIdx.code, { type: 'json' });
      if (existingMapping && !existingMapping.deleted) {
        const baseUrl = new URL(request.url).origin;
        return jsonResponse({
          shortUrl: `${baseUrl}/s/${existingIdx.code}`,
          code: existingIdx.code,
          longUrl: existingMapping.url,
          block_bots: !!existingMapping.block_bots,
          existing: true,
        });
      }
      // If it was soft-deleted, fall through and recreate
    }

    const shortCode = code || await generateShortCode(longUrl, campaign, blockBots, env);

    const existingCode = await env.URL_MAPPINGS.get(shortCode);
    if (existingCode) {
      return jsonResponse({ error: 'Short code already exists' }, 409);
    }

    // Store reverse index for idempotency
    await env.URL_MAPPINGS.put(`idx:${idxKey}`, JSON.stringify({
      code: shortCode,
      url: longUrl,
      campaign,
    }));

    const mapping = {
      url: longUrl,
      campaign,
      created: new Date().toISOString(),
      ...(blockBots ? { block_bots: true } : {}),
    };

    if (auth.owner) {
      mapping.createdBy = auth.owner;
    }
    if (auth.createdByCampaign) {
      mapping.createdByCampaign = auth.createdByCampaign;
    }

    if (notes && notes.trim()) {
      mapping.notes = notes.trim();
    }

    await env.URL_MAPPINGS.put(shortCode, JSON.stringify(mapping));

    const baseUrl = new URL(request.url).origin;
    return jsonResponse({
      shortUrl: `${baseUrl}/s/${shortCode}`,
      code: shortCode,
      longUrl,
      block_bots: blockBots,
    });
  } catch (error) {
    console.error('Error creating short URL:', error);
    return jsonResponse({ error: 'Internal Server Error' }, 500);
  }
}

/**
 * GET /api/urls — List all active (non-deleted) URLs
 */
async function handleListUrls(request, env) {
  const t0 = Date.now();
  const authErr = await requireAdmin(request, env);
  if (authErr) return authErr;

  try {
    const urls = [];
    let cursor = null;
    let pages = 0;
    let totalKeys = 0;

    do {
      const listResult = await env.URL_MAPPINGS.list({ cursor });
      pages++;
      totalKeys += listResult.keys.length;

      for (const key of listResult.keys) {
        if (key.name.includes(':')) continue; // skip reserved records (idx:, apikey:, tok:, owner:, ml:, ct:)

        const mapping = await env.URL_MAPPINGS.get(key.name, { type: 'json' });
        if (!mapping || mapping.deleted) continue;

        urls.push({
          code: key.name,
          url: mapping.url,
          campaign: mapping.campaign,
          created: mapping.created,
          ...(mapping.notes ? { notes: mapping.notes } : {}),
          ...(mapping.createdBy ? { createdBy: mapping.createdBy } : {}),
          ...(mapping.createdByCampaign ? { createdByCampaign: mapping.createdByCampaign } : {}),
          ...(mapping.block_bots ? { block_bots: true } : {}),
        });
      }

      cursor = listResult.list_complete ? null : listResult.cursor;
    } while (cursor);

    urls.sort((a, b) => new Date(b.created) - new Date(a.created));
    console.log(`[listUrls] done: ${urls.length} URLs, ${pages} pages, ${totalKeys} total keys, ${Date.now() - t0}ms`);

    return jsonResponse({ urls, total: urls.length });
  } catch (error) {
    console.error('Error listing URLs:', error);
    return jsonResponse({ error: 'Internal Server Error' }, 500);
  }
}

/**
 * PUT /api/urls/{code} — Update URL, campaign, code, notes, or block_bots
 */
async function handleUpdateUrl(request, url, env, ctx) {
  const authErr = await requireAdmin(request, env);
    if (authErr) return authErr;

  const oldCode = url.pathname.split('/api/urls/')[1];
  if (!oldCode) {
    return jsonResponse({ error: 'Invalid code' }, 400);
  }

  try {
    const existing = await env.URL_MAPPINGS.get(oldCode, { type: 'json' });
    if (!existing) {
      return jsonResponse({ error: 'Short URL not found' }, 404);
    }

    const body = await request.json();
    const { url: newUrl, campaign, code: newCode, notes, block_bots: blockBots } = body;

    if (blockBots !== undefined && typeof blockBots !== 'boolean') {
      return jsonResponse({ error: 'block_bots must be a boolean' }, 400);
    }
    if (blockBots && !turnstileConfigured(env)) {
      return jsonResponse({ error: 'block_bots is not available: bot protection is not configured on this server' }, 501);
    }

    if (newUrl) {
      const urlErr = validateTargetUrl(newUrl);
      if (urlErr) {
        return jsonResponse({ error: urlErr }, 400);
      }
    }

    if (newCode && !isValidShortCode(newCode)) {
      return jsonResponse({ error: 'code must be 1-64 characters: letters, digits, hyphen or underscore' }, 400);
    }

    if (campaign !== undefined && campaign !== null) {
      if (typeof campaign !== 'string' || campaign.length > 64) {
        return jsonResponse({ error: 'campaign must be a string of at most 64 characters' }, 400);
      }
    }

    if (notes !== undefined && notes !== null) {
      if (typeof notes !== 'string') {
        return jsonResponse({ error: 'notes must be a string' }, 400);
      }
      if (notes.length > 500) {
        return jsonResponse({ error: 'notes must be 500 characters or less' }, 400);
      }
    }

    const updated = {
      url: newUrl || existing.url,
      campaign: campaign !== undefined ? campaign : existing.campaign,
      created: existing.created,
      updated: new Date().toISOString(),
    };

    if (existing.deleted !== undefined) updated.deleted = existing.deleted;
    if (existing.createdBy) updated.createdBy = existing.createdBy;
    if (existing.createdByCampaign) updated.createdByCampaign = existing.createdByCampaign;
    if (blockBots !== undefined ? blockBots : existing.block_bots) updated.block_bots = true;

    if (notes !== undefined) {
      if (notes.trim()) updated.notes = notes.trim();
    } else if (existing.notes) {
      updated.notes = existing.notes;
    }

    if (newCode && newCode !== oldCode) {
      const existingNew = await env.URL_MAPPINGS.get(newCode);
      if (existingNew) {
        return jsonResponse({ error: 'New code already exists' }, 409);
      }

      await env.URL_MAPPINGS.put(newCode, JSON.stringify(updated));
      await env.URL_MAPPINGS.delete(oldCode);

      // Invalidate cache for both old and new codes
      purgeCacheForCode(ctx, oldCode);
      purgeCacheForCode(ctx, newCode);

      return jsonResponse({ code: newCode, oldCode, ...updated, block_bots: !!updated.block_bots });
    }

    await env.URL_MAPPINGS.put(oldCode, JSON.stringify(updated));

    // Invalidate cache for the updated code
    purgeCacheForCode(ctx, oldCode);

    return jsonResponse({ code: oldCode, ...updated, block_bots: !!updated.block_bots });
  } catch (error) {
    console.error('Error updating URL:', error);
    return jsonResponse({ error: 'Internal Server Error' }, 500);
  }
}

/**
 * DELETE /api/urls/{code} — Soft delete (marks deleted=true, preserves data)
 */
async function handleDeleteUrl(request, url, env, ctx) {
  const authErr = await requireAdmin(request, env);
    if (authErr) return authErr;

  const code = url.pathname.split('/api/urls/')[1];
  if (!code) {
    return jsonResponse({ error: 'Invalid code' }, 400);
  }

  try {
    const existing = await env.URL_MAPPINGS.get(code, { type: 'json' });
    if (!existing) {
      return jsonResponse({ error: 'Short URL not found' }, 404);
    }

    const updated = {
      ...existing,
      deleted: true,
      deletedAt: new Date().toISOString(),
    };

    await env.URL_MAPPINGS.put(code, JSON.stringify(updated));

    purgeCacheForCode(ctx, code);

    return jsonResponse({ deleted: true, code });
  } catch (error) {
    console.error('Error deleting URL:', error);
    return jsonResponse({ error: 'Internal Server Error' }, 500);
  }
}

/**
 * POST /api/urls/{code}/restore — Restore a soft-deleted URL
 */
async function handleRestoreUrl(request, url, env, ctx) {
  const authErr = await requireAdmin(request, env);
    if (authErr) return authErr;

  const match = url.pathname.match(/^\/api\/urls\/([^/]+)\/restore$/);
  const code = match ? match[1] : null;

  if (!code) {
    return jsonResponse({ error: 'Invalid code' }, 400);
  }

  try {
    const existing = await env.URL_MAPPINGS.get(code, { type: 'json' });
    if (!existing) {
      return jsonResponse({ error: 'Short URL not found' }, 404);
    }

    if (!existing.deleted) {
      return jsonResponse({ error: 'Short URL is not deleted' }, 400);
    }

    const restored = { ...existing, deleted: false, restoredAt: new Date().toISOString() };
    delete restored.deletedAt;

    await env.URL_MAPPINGS.put(code, JSON.stringify(restored));

    purgeCacheForCode(ctx, code);

    return jsonResponse({ restored: true, code, url: restored.url });
  } catch (error) {
    console.error('Error restoring URL:', error);
    return jsonResponse({ error: 'Internal Server Error' }, 500);
  }
}

/**
 * GET /api/urls/deleted — List all soft-deleted URLs
 */
async function handleListDeletedUrls(request, env) {
  const authErr = await requireAdmin(request, env);
    if (authErr) return authErr;

  try {
    const urls = [];
    let cursor = null;

    do {
      const listResult = await env.URL_MAPPINGS.list({ cursor });

      for (const key of listResult.keys) {
        if (key.name.includes(':')) continue; // skip reserved records (idx:, apikey:, tok:, owner:, ml:, ct:)

        const mapping = await env.URL_MAPPINGS.get(key.name, { type: 'json' });
        if (mapping && mapping.deleted) {
          const urlObj = {
            code: key.name,
            url: mapping.url,
            campaign: mapping.campaign,
            created: mapping.created,
            deletedAt: mapping.deletedAt,
          };
          if (mapping.notes) urlObj.notes = mapping.notes;
          if (mapping.createdBy) urlObj.createdBy = mapping.createdBy;
          if (mapping.createdByCampaign) urlObj.createdByCampaign = mapping.createdByCampaign;
          urls.push(urlObj);
        }
      }

      cursor = listResult.list_complete ? null : listResult.cursor;
    } while (cursor);

    urls.sort((a, b) => new Date(b.deletedAt) - new Date(a.deletedAt));

    return jsonResponse({ urls, total: urls.length });
  } catch (error) {
    console.error('Error listing deleted URLs:', error);
    return jsonResponse({ error: 'Internal Server Error' }, 500);
  }
}

/**
 * DELETE /api/urls/{code}/permanent — Permanently delete from KV (irreversible)
 */
async function handlePermanentDelete(request, url, env, ctx) {
  const authErr = await requireAdmin(request, env);
    if (authErr) return authErr;

  const match = url.pathname.match(/^\/api\/urls\/([^/]+)\/permanent$/);
  const code = match ? match[1] : null;

  if (!code) {
    return jsonResponse({ error: 'Invalid code' }, 400);
  }

  try {
    const existing = await env.URL_MAPPINGS.get(code, { type: 'json' });
    if (!existing) {
      return jsonResponse({ error: 'Short URL not found' }, 404);
    }

    if (!existing.deleted) {
      return jsonResponse({ error: 'Only soft-deleted URLs can be permanently removed' }, 400);
    }

    await env.URL_MAPPINGS.delete(code);

    purgeCacheForCode(ctx, code);

    return jsonResponse({ permanentlyDeleted: true, code });
  } catch (error) {
    console.error('Error permanently deleting URL:', error);
    return jsonResponse({ error: 'Internal Server Error' }, 500);
  }
}

/**
 * Generate a deterministic short code from URL + campaign hash.
 * Uses the first 6 chars of SHA-256 hex digest.
 * Falls back to random if the deterministic code is taken (collision).
 */
async function generateShortCode(url, campaign, blockBots, env) {
  const hk = await hashKey(url, campaign, blockBots); // 64-char hex SHA-256
  const detCode = hk.slice(0, 6);                // 16^6 ≈ 16M combinations
  const existing = await env.URL_MAPPINGS.get(detCode);
  if (!existing) return detCode;

  // Collision — fall back to random (rare)
  const ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const LENGTH = 6;
  for (let attempt = 0; attempt < 10; attempt++) {
    const code = Array.from(
      crypto.getRandomValues(new Uint8Array(LENGTH)),
      (b) => ALPHABET[b % ALPHABET.length]
    ).join('');
    const e = await env.URL_MAPPINGS.get(code);
    if (!e) return code;
  }
  throw new Error('Failed to generate unique short code');
}

/**
 * Hash URL + campaign (+ block_bots marker) for idempotency lookup.
 * The marker is only appended when set, so unprotected codes are unchanged
 * and a protected link never collides with an unprotected one.
 * Returns a hex string.
 */
async function hashKey(url, campaign, blockBots = false) {
  return sha256Hex(`${url}::${campaign}${blockBots ? '::block_bots' : ''}`);
}

/**
 * SHA-256 of a string as lowercase hex.
 */
async function sha256Hex(input) {
  const data = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Short codes: 1-64 chars of [A-Za-z0-9_-].
 * Excludes ':' so user codes can never collide with reserved KV prefixes
 * (idx:, apikey:, tok:, owner:, ml:, ct:).
 */
function isValidShortCode(code) {
  return typeof code === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(code);
}

/**
 * Split a /s/ path into the short code and any trailing path.
 * '/s/abc/x/y' → { code: 'abc', restPath: '/x/y' }; '/s/abc' → { code: 'abc', restPath: '' }.
 * Codes never contain '/', so the first '/' after the code ends it.
 */
function parseShortPath(url) {
  const tail = url.pathname.slice('/s/'.length);
  const i = tail.indexOf('/');
  return i === -1 ? { code: tail, restPath: '' } : { code: tail.slice(0, i), restPath: tail.slice(i) };
}

/**
 * Merge a request's trailing path and query into the stored target URL.
 * Path: appended to the target path without doubled slashes. Query: target
 * params whose key the request also sets are dropped, then the request query
 * is appended verbatim; untouched target params keep their original encoding.
 * Scheme/host always come from the stored target.
 */
function buildTarget(targetUrl, restPath, search) {
  if (!restPath && !search) return targetUrl;
  const t = new URL(targetUrl);
  if (restPath) t.pathname = t.pathname.replace(/\/+$/, '') + restPath.replace(/\/{2,}/g, '/');
  if (search) {
    const reqKeys = new Set(new URLSearchParams(search).keys());
    const kept = t.search.slice(1).split('&').filter((pair) => {
      if (!pair) return false;
      const key = new URLSearchParams(`${pair.split('=')[0]}=`).keys().next().value;
      return !reqKeys.has(key);
    });
    t.search = [...kept, search.slice(1)].join('&');
  }
  return t.toString();
}

/**
 * Validate a redirect target. Returns an error message or null (valid).
 */
function validateTargetUrl(u) {
  if (typeof u !== 'string' || u.length > 2048) {
    return 'url must be a string of at most 2048 characters';
  }
  let parsed;
  try {
    parsed = new URL(u);
  } catch {
    return 'url must be an absolute URL';
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return 'url must use http or https';
  }
  return null;
}

/**
 * Purge Workers Cache entries associated with a short code.
 * Purging is non-blocking via ctx.waitUntil.
 * Guards against ctx.cache being undefined (cache not enabled, older runtime, local dev).
 *
 * @param {object} ctx - ExecutionContext from the fetch handler
 * @param {string} code - The short URL code whose cache entries to purge
 */
function purgeCacheForCode(ctx, code) {
  if (!ctx || !ctx.cache || typeof ctx.cache.purge !== 'function') {
    console.warn('Workers Cache unavailable; skipping purge for', code);
    return;
  }
  const tags = [`redirect:${code}`];
  ctx.waitUntil(
    ctx.cache.purge({ tags }).catch((err) => {
      console.error('Error purging cache for', code, err);
    })
  );
}

/**
 * Verify Bearer token API key. Returns { authorized, type, owner?, keyId?, createdByCampaign?, key? }.
 *
 * Bootstrap key (env.API_KEY, set via cf workers secrets update) always has admin access
 * and no KV record (no keyId or key). All other keys are looked up O(1) by
 * SHA-256(token) → tok:{hash} → apikey:{id}; `key` is that apikey record.
 * There is no plaintext-token walk — keys are always stored hashed.
 */
async function verifyApiKey(request, env) {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return { authorized: false };
  }
  const token = authHeader.slice(7);

  // Bootstrap key always has admin access
  if (env.API_KEY && token === env.API_KEY) {
    return { authorized: true, type: 'admin' };
  }

  // All other keys: O(1) lookup by token hash (two KV gets, no list walk)
  const tokenHash = await sha256Hex(token);
  const tokRef = await env.URL_MAPPINGS.get(`tok:${tokenHash}`, { type: 'json' });
  if (tokRef && tokRef.id) {
    const keyData = await env.URL_MAPPINGS.get(`apikey:${tokRef.id}`, { type: 'json' });
    if (keyData) {
      return {
        authorized: true, type: keyData.type, owner: keyData.owner, keyId: keyData.id,
        createdByCampaign: keyData.createdByCampaign, key: keyData,
      };
    }
  }

  return { authorized: false };
}

/**
 * Require admin access. Returns 401/403 or null (pass).
 */
async function requireAdmin(request, env) {
  const auth = await verifyApiKey(request, env);
  if (!auth.authorized) return jsonResponse({ error: 'Unauthorized' }, 401);
  if (auth.type !== 'admin') return jsonResponse({ error: 'Forbidden: admin key required' }, 403);
  return null;
}

/**
 * GET /api/keys — List all API keys (admin only)
 */
async function handleListKeys(request, env) {
  const err = await requireAdmin(request, env);
  if (err) return err;

  try {
    const apiKeys = [];
    const { keys } = await env.URL_MAPPINGS.list({ prefix: 'apikey:' });

    for (const key of keys) {
      const keyData = await env.URL_MAPPINGS.get(key.name, { type: 'json' });
      if (keyData) {
        apiKeys.push({
          id: keyData.id,
          type: keyData.type,
          label: keyData.label || '',
          created: keyData.created,
          tokenPrefix: keyData.tokenPrefix || (keyData.token ? keyData.token.slice(0, 8) + '...' : ''),
          ...(keyData.owner ? { owner: keyData.owner, ownerEmail: keyData.ownerEmail } : {}),
          ...(keyData.createdByCampaign ? { createdByCampaign: keyData.createdByCampaign } : {}),
          ...(keyData.consents && Object.keys(keyData.consents).length ? { consents: keyData.consents } : {}),
        });
      }
    }

    apiKeys.sort((a, b) => new Date(a.created) - new Date(b.created));
    return jsonResponse(apiKeys);
  } catch (error) {
    console.error('Error listing keys:', error);
    return jsonResponse({ error: 'Internal Server Error' }, 500);
  }
}

/**
 * POST /api/keys — Create a new API key (admin only)
 * Body: { type: "admin"|"create", label: "..." }
 */
async function handleCreateKey(request, env) {
  const err = await requireAdmin(request, env);
  if (err) return err;

  try {
    const body = await request.json();
    const { type, label } = body;

    if (!type || !['admin', 'create'].includes(type)) {
      return jsonResponse({ error: 'type must be "admin" or "create"' }, 400);
    }
    if (label && (typeof label !== 'string' || label.length > 100)) {
      return jsonResponse({ error: 'label must be a string under 100 characters' }, 400);
    }

    const id = crypto.randomUUID();
    const token = 'cus_' + crypto.randomUUID().replace(/-/g, '');
    const tokenHash = await sha256Hex(token);
    const keyData = {
      id,
      type,
      label: label || '',
      tokenHash,
      tokenPrefix: token.slice(0, 8) + '...',
      created: new Date().toISOString(),
    };

    await env.URL_MAPPINGS.put(`apikey:${id}`, JSON.stringify(keyData));
    await env.URL_MAPPINGS.put(`tok:${tokenHash}`, JSON.stringify({ id }));

    return jsonResponse({
      id,
      token,        // Only returned once on creation
      type,
      label: label || '',
      created: keyData.created,
    }, 201);
  } catch (error) {
    console.error('Error creating key:', error);
    return jsonResponse({ error: 'Internal Server Error' }, 500);
  }
}

/**
 * DELETE /api/keys/{id} — Revoke an API key (admin only)
 */
async function handleDeleteKey(request, url, env) {
  const err = await requireAdmin(request, env);
  if (err) return err;

  const match = url.pathname.match(/^\/api\/keys\/([^/]+)$/);
  const id = match ? match[1] : null;
  if (!id) return jsonResponse({ error: 'Invalid key id' }, 400);

  try {
    const existing = await env.URL_MAPPINGS.get(`apikey:${id}`, { type: 'json' });
    if (!existing) {
      return jsonResponse({ error: 'Key not found' }, 404);
    }

    // Prevent deleting the bootstrap key via KV (can't delete env.API_KEY anyway)
    await env.URL_MAPPINGS.delete(`apikey:${id}`);
    if (existing.tokenHash) await env.URL_MAPPINGS.delete(`tok:${existing.tokenHash}`);
    if (existing.owner) await env.URL_MAPPINGS.delete(`owner:${existing.owner}`);
    return jsonResponse({ revoked: true, id });
  } catch (error) {
    console.error('Error deleting key:', error);
    return jsonResponse({ error: 'Internal Server Error' }, 500);
  }
}

/**
 * DELETE /api/keys/mine — Revoke the calling key (self-service deregistration).
 * Any valid key (admin, create, or self-service) can revoke itself.
 * The bootstrap env.API_KEY cannot be revoked this way.
 *
 * After deleting the key records, scans all URL mappings and scrubs any
 * createdBy / createdByCampaign attribution that matches this key's owner,
 * so that deregistration leaves no trace of the owner's identity or campaign.
 */
async function handleDeleteOwnKey(request, env) {
  const auth = await verifyApiKey(request, env);
  if (!auth.authorized) {
    return jsonResponse({ error: 'Unauthorized' }, 401);
  }
  // Bootstrap key has no KV record — can't self-revoke.
  if (!auth.keyId) {
    return jsonResponse({ error: 'The bootstrap admin key cannot be revoked via the API' }, 400);
  }

  try {
    const existing = await env.URL_MAPPINGS.get(`apikey:${auth.keyId}`, { type: 'json' });
    const owner = existing?.owner || null;

    // Delete the key records.
    await env.URL_MAPPINGS.delete(`apikey:${auth.keyId}`);
    if (existing && existing.tokenHash) await env.URL_MAPPINGS.delete(`tok:${existing.tokenHash}`);
    if (owner) await env.URL_MAPPINGS.delete(`owner:${owner}`);

    // Scrub attribution from any URL this key created.
    if (owner) {
      let cursor = null;
      do {
        const listResult = await env.URL_MAPPINGS.list({ cursor });
        for (const key of listResult.keys) {
          if (key.name.includes(':')) continue;
          const mapping = await env.URL_MAPPINGS.get(key.name, { type: 'json' });
          if (!mapping || mapping.createdBy !== owner) continue;
          delete mapping.createdBy;
          delete mapping.createdByCampaign;
          await env.URL_MAPPINGS.put(key.name, JSON.stringify(mapping));
        }
        cursor = listResult.list_complete ? null : listResult.cursor;
      } while (cursor);
    }

    return jsonResponse({ revoked: true, id: auth.keyId });
  } catch (error) {
    console.error('Error deleting own key:', error);
    return jsonResponse({ error: 'Internal Server Error' }, 500);
  }
}

/**
 * GET /api/validate — Validate the current Bearer token and return its metadata.
 * Any valid key (admin, create, or self-service) can call this.
 *
 * `services` reports, for every service in SERVICES, whether the key's
 * organisation has agreed to it ({@link consentStatus}) and where its privacy
 * page is. Admin keys need no consent: consented/accepted/current are true and
 * version/by/at null.
 */
async function handleValidateKey(request, env) {
  const auth = await verifyApiKey(request, env);
  if (!auth.authorized) {
    return jsonResponse({ error: 'Unauthorized' }, 401);
  }
  const services = serviceStatuses(auth, new URL(request.url));

  // Bootstrap admin key — no keyId or KV record.
  if (!auth.key) {
    return jsonResponse({
      valid: true,
      type: 'admin',
      label: 'Bootstrap admin key',
      created: null,
      services,
    });
  }

  const keyData = auth.key;
  return jsonResponse({
    valid: true,
    type: keyData.type,
    label: keyData.label || '',
    created: keyData.created,
    ...(keyData.owner ? { owner: keyData.owner } : {}),
    ...(keyData.ownerEmail ? { ownerEmail: keyData.ownerEmail } : {}),
    ...(keyData.provider ? { provider: keyData.provider } : {}),
    ...(keyData.createdByCampaign ? { createdByCampaign: keyData.createdByCampaign } : {}),
    tokenPrefix: keyData.tokenPrefix || (keyData.token ? keyData.token.slice(0, 8) + '...' : ''),
    services,
  });
}

/**
 * Return JSON response with CORS headers
 */
function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...CORS_HEADERS,
    },
  });
}

// ---------------------------------------------------------------------------
// jethro.au services and per-service consent.
//
// An installation holds one key (see signup below) for every service, but
// each service also needs its organisation's agreement to that service's
// data handling: a consent, given by a signed-in person and recorded on the
// key. Admin keys need none.
//   apikey:{id}.consents[serviceId] → { version, by, byOwner, at }
//   ct:{uuid} → { keyId, service, redirect, created }   (consent ticket, 10 min TTL, single use)
//
// Consent is given at signup (/signup?service=…, with the agree checkbox) or
// later: POST /api/consents (Bearer) → /consent?ticket=… → sign-in →
// redirect with sh_consented. DELETE /api/consents/{service} withdraws it;
// PUT /api/keys/{id}/consents/{service} (admin) records one given another way.
// Re-signup carries a key's consents over to its replacement. Services check
// consent with requireService (here) or GET /api/authorize (other Workers).
// ---------------------------------------------------------------------------

/**
 * jethro.au services that need an organisation's consent, by id.
 *
 * policyVersion is the "last updated" date of the service's privacy page:
 * change both together. The URL shortener's page renders its policyVersion;
 * the SMS shortener's page (POLICY_VERSION in jethro-sms-shortener/privacy.js)
 * must be edited to match. A consent is accepted while its version >=
 * minPolicyVersion, and current when it equals policyVersion. Raise
 * minPolicyVersion only for material changes: every organisation must then
 * agree again before the service works for it.
 *
 * acknowledgement completes "By enabling it, you acknowledge that …".
 */
export const SERVICES = {
  'url-shortener': {
    name: 'jethro.au URL shortener',
    policyVersion: '2026-11-18',
    minPolicyVersion: '2026-11-18',
    privacyPath: '/url-shortener/privacy',
    acknowledgement: 'web addresses shortened from Jethro will be stored at jethro.au with your organisation\'s name, '
      + 'and anyone who has a short link can follow it to the address',
  },
  'sms-shortener': {
    name: 'jethro.au SMS shortener',
    policyVersion: '2026-11-18',
    minPolicyVersion: '2026-11-18',
    privacyPath: '/sms-shortener/privacy',
    acknowledgement: 'the text of SMS messages being written in Jethro will be sent to jethro.au and processed by Cloudflare Workers AI to suggest shorter wordings',
  },
};

const CONSENT_TICKET_TTL = 600; // 10 minutes in seconds

/** The SERVICES entry for an id, or null (own properties only: no '__proto__' and the like). */
function serviceOf(id) {
  return typeof id === 'string' && Object.hasOwn(SERVICES, id) ? SERVICES[id] : null;
}

/** Absolute URL of a service's privacy page, on the origin serving `url`. */
function servicePrivacyUrl(url, serviceId) {
  return redirectOrigin(url) + SERVICES[serviceId].privacyPath;
}

/**
 * A key's consent to a service.
 *
 * @param {object|undefined} keyData  apikey record (undefined for the bootstrap key)
 * @param {string} serviceId  a SERVICES id
 * @param {boolean} admin  admin keys need no consent: all true, version/by/at null
 * @returns {{consented: boolean, accepted: boolean, current: boolean,
 *   version: string|null, by: string|null, at: string|null}}
 *   consented: a consent is recorded; accepted: its version >= minPolicyVersion
 *   (the service works); current: its version === policyVersion
 */
function consentStatus(keyData, serviceId, admin) {
  if (admin) return { consented: true, accepted: true, current: true, version: null, by: null, at: null };
  const s = SERVICES[serviceId];
  const c = keyData?.consents?.[serviceId];
  return {
    consented: !!c,
    accepted: !!c && c.version >= s.minPolicyVersion,
    current: !!c && c.version === s.policyVersion,
    version: c?.version ?? null,
    by: c?.by ?? null,
    at: c?.at ?? null,
  };
}

/** The `services` map of /api/validate for a verified key. */
function serviceStatuses(auth, url) {
  return Object.fromEntries(Object.keys(SERVICES).map((id) => [id, {
    name: SERVICES[id].name,
    ...consentStatus(auth.key, id, auth.type === 'admin'),
    privacyUrl: servicePrivacyUrl(url, id),
  }]));
}

/**
 * A consent record for a service's current policy, given now by a signed-in identity.
 *
 * @param {{owner: string, email: string}} identity
 */
function newConsent(serviceId, identity) {
  return {
    version: SERVICES[serviceId].policyVersion,
    by: identity.email,
    byOwner: identity.owner,
    at: new Date().toISOString(),
  };
}

/**
 * Require a key that may use a service: admin, or create with an accepted
 * consent to it.
 *
 * @returns {Promise<{err: Response|null, auth: object}>} err: 401 { error: 'Unauthorized' },
 *   or 403 { error: 'consent_required'|'consent_outdated', service, privacyUrl }
 */
async function requireService(request, env, serviceId) {
  const auth = await verifyApiKey(request, env);
  if (!auth.authorized) {
    return { err: jsonResponse({ error: 'Unauthorized' }, 401), auth };
  }
  if (auth.type === 'admin') return { err: null, auth };
  if (auth.type !== 'create') {
    return { err: jsonResponse({ error: 'Forbidden: create key required' }, 403), auth };
  }
  const status = consentStatus(auth.key, serviceId, false);
  if (!status.accepted) {
    return {
      err: jsonResponse({
        error: status.consented ? 'consent_outdated' : 'consent_required',
        service: serviceId,
        privacyUrl: servicePrivacyUrl(new URL(request.url), serviceId),
      }, 403),
      auth,
    };
  }
  return { err: null, auth };
}

/**
 * GET /api/authorize?service={id} — may the Bearer key use this service?
 * For other jethro.au Workers, through a service binding.
 *
 * → 200 { authorized: true, keyId, service } (keyId null for the bootstrap key);
 *   401 / 403 as {@link requireService}; 400 for an unknown service.
 */
async function handleAuthorize(request, url, env) {
  const service = url.searchParams.get('service') || '';
  if (!serviceOf(service)) return jsonResponse({ error: 'Unknown service', service }, 400);
  const { err, auth } = await requireService(request, env, service);
  if (err) return err;
  return jsonResponse({ authorized: true, keyId: auth.keyId ?? null, service });
}

/**
 * POST /api/consents — start consent to a service for the Bearer key.
 * Body: { service, redirect? }
 *
 * Stores a single-use ticket (ct:{uuid}, 10 minutes) and returns the page
 * where a person signs in and agrees: 201 { consentUrl, expiresIn }. After
 * sign-in they are sent to `redirect` (absolute http(s), as isValidReturnTo)
 * with sh_consented={service}, or shown a confirmation page without one.
 * 400 unknown service, invalid redirect, or the bootstrap key (no record to
 * hold a consent); 401 bad key.
 */
async function handleCreateConsentTicket(request, url, env) {
  const auth = await verifyApiKey(request, env);
  if (!auth.authorized) return jsonResponse({ error: 'Unauthorized' }, 401);
  if (!auth.key) return jsonResponse({ error: 'The bootstrap admin key needs no consent' }, 400);

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: 'Body must be JSON' }, 400);
  }
  const service = body?.service;
  if (!serviceOf(service)) return jsonResponse({ error: 'Unknown service', service: service ?? null }, 400);
  const redirect = body.redirect ?? '';
  if (redirect !== '' && (typeof redirect !== 'string' || !isValidReturnTo(redirect))) {
    return jsonResponse({ error: 'redirect must be an absolute http(s) URL' }, 400);
  }

  const ticket = crypto.randomUUID();
  await env.URL_MAPPINGS.put(`ct:${ticket}`, JSON.stringify({
    keyId: auth.keyId,
    service,
    redirect,
    created: new Date().toISOString(),
  }), { expirationTtl: CONSENT_TICKET_TTL });

  return jsonResponse({
    consentUrl: `${redirectOrigin(url)}/consent?ticket=${ticket}`,
    expiresIn: CONSENT_TICKET_TTL,
  }, 201);
}

/**
 * DELETE /api/consents/{service} — withdraw the Bearer key's consent to a
 * service, which then refuses the key. Idempotent: 200 { withdrawn: true, service }.
 * 400 unknown service or the bootstrap key; 401 bad key.
 */
async function handleWithdrawConsent(request, env, serviceId) {
  const auth = await verifyApiKey(request, env);
  if (!auth.authorized) return jsonResponse({ error: 'Unauthorized' }, 401);
  if (!serviceOf(serviceId)) return jsonResponse({ error: 'Unknown service', service: serviceId }, 400);
  if (!auth.key) return jsonResponse({ error: 'The bootstrap admin key needs no consent' }, 400);

  const key = auth.key;
  if (key.consents && Object.hasOwn(key.consents, serviceId)) {
    delete key.consents[serviceId];
    await env.URL_MAPPINGS.put(`apikey:${key.id}`, JSON.stringify(key));
  }
  return jsonResponse({ withdrawn: true, service: serviceId });
}

/**
 * PUT /api/keys/{id}/consents/{service} — record a consent on a key (admin only),
 * for agreement given outside the sign-in flow (e.g. in writing) and for tests.
 * Body: { by: string (who agreed, e.g. an email address), version?: 'YYYY-MM-DD' }
 * version defaults to the service's policyVersion; byOwner records the admin key
 * used ('admin:{keyId}' or 'admin:bootstrap').
 * → 200 { id, service, consent }; 400 bad service or body; 404 unknown key.
 */
async function handleAdminPutConsent(request, env, keyId, serviceId) {
  const auth = await verifyApiKey(request, env);
  if (!auth.authorized) return jsonResponse({ error: 'Unauthorized' }, 401);
  if (auth.type !== 'admin') return jsonResponse({ error: 'Forbidden: admin key required' }, 403);
  if (!serviceOf(serviceId)) return jsonResponse({ error: 'Unknown service', service: serviceId }, 400);

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: 'Body must be JSON' }, 400);
  }
  const by = body?.by;
  if (typeof by !== 'string' || by.trim() === '' || by.length > 254) {
    return jsonResponse({ error: 'by must be a non-empty string of at most 254 characters' }, 400);
  }
  const version = body.version ?? SERVICES[serviceId].policyVersion;
  if (typeof version !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(version)) {
    return jsonResponse({ error: 'version must be a date, YYYY-MM-DD' }, 400);
  }

  const key = await env.URL_MAPPINGS.get(`apikey:${keyId}`, { type: 'json' });
  if (!key) return jsonResponse({ error: 'Key not found' }, 404);
  const consent = {
    version,
    by: by.trim(),
    byOwner: `admin:${auth.keyId ?? 'bootstrap'}`,
    at: new Date().toISOString(),
  };
  key.consents = { ...key.consents, [serviceId]: consent };
  await env.URL_MAPPINGS.put(`apikey:${keyId}`, JSON.stringify(key));
  return jsonResponse({ id: keyId, service: serviceId, consent });
}

/**
 * A live consent ticket and the key it is for, or null when the ticket is
 * unknown, expired or used, or the key has since been revoked.
 *
 * @returns {Promise<{ticket: {keyId: string, service: string, redirect: string, created: string},
 *   key: object} | null>}
 */
async function loadConsentTicket(env, ticketId) {
  if (typeof ticketId !== 'string' || !/^[0-9a-f-]{36}$/.test(ticketId)) return null;
  const ticket = await env.URL_MAPPINGS.get(`ct:${ticketId}`, { type: 'json' });
  if (!ticket || !serviceOf(ticket.service)) return null;
  const key = await env.URL_MAPPINGS.get(`apikey:${ticket.keyId}`, { type: 'json' });
  return key ? { ticket, key } : null;
}

const CONSENT_HEADING = 'Enable a jethro.au service';

/** 410 page for a consent ticket that is expired, used, or whose key was revoked. */
function consentGonePage(extraHeaders = {}) {
  return htmlResponse(signupShell(
    `<p>This link has expired or has already been used, or the API key it was for has been revoked.
     Please start again from Jethro.</p>`, CONSENT_HEADING), 410, extraHeaders);
}

/** Label of the required agree checkbox. */
function agreeLabel(org) {
  return `I agree to this on behalf of ${org || 'my organisation'}`;
}

/** What a person agrees to by enabling a service, with a link to its privacy page. */
function acknowledgementHtml(serviceId, url) {
  const s = SERVICES[serviceId];
  return `<p><strong>${escapeHtml(s.name)}:</strong> by enabling it, you acknowledge that ${escapeHtml(s.acknowledgement)}.
     Please read its <a href="${escapeHtml(servicePrivacyUrl(url, serviceId))}">privacy policy</a>.</p>`;
}

/**
 * GET /consent?ticket={uuid} — ask a person to sign in and agree, on behalf of
 * the key's organisation, to the ticket's service. The sign-in completes in
 * {@link completeConsentTicket}.
 */
async function handleConsentPage(url, env) {
  const ticketId = url.searchParams.get('ticket') || '';
  const loaded = await loadConsentTicket(env, ticketId);
  if (!loaded) return consentGonePage();
  const { ticket, key } = loaded;
  const org = key.createdByCampaign || '';

  const form = signInForm(env, { action: '/consent', hidden: { ticket: ticketId }, agree: agreeLabel(org) });
  if (!form) {
    return htmlResponse(signupShell('<p>Sign-in is not enabled on this server.</p>', CONSENT_HEADING), 501);
  }
  const body = `
      <p>Enable the <strong>${escapeHtml(SERVICES[ticket.service].name)}</strong> for the jethro.au API key
      registered to <strong>${escapeHtml(org || 'an unnamed organisation')}</strong>.</p>
      ${acknowledgementHtml(ticket.service, url)}
      <p>Sign in to confirm. Your email address, the time and the version of the privacy policy you agreed to are
      recorded with the key.</p>
      ${form}`;
  return htmlResponse(signupShell(body, CONSENT_HEADING));
}

/**
 * Finish a consent sign-in: record the ticket's consent on its key, given by
 * `identity`, use up the ticket, and redirect to the ticket's redirect with
 * sh_consented={service} (or show a confirmation page). 410 when the ticket
 * or its key is gone.
 *
 * @param {object} extraHeaders  added to the response (e.g. clearing the OAuth state cookie)
 */
async function completeConsentTicket(env, url, ticketId, identity, extraHeaders = {}) {
  const loaded = await loadConsentTicket(env, ticketId);
  if (!loaded) return consentGonePage(extraHeaders);
  const { ticket, key } = loaded;

  await env.URL_MAPPINGS.delete(`ct:${ticketId}`);
  key.consents = { ...key.consents, [ticket.service]: newConsent(ticket.service, identity) };
  await env.URL_MAPPINGS.put(`apikey:${key.id}`, JSON.stringify(key));

  if (ticket.redirect && isValidReturnTo(ticket.redirect)) {
    return redirectWith(ticket.redirect, { sh_consented: ticket.service }, extraHeaders);
  }
  const body = `
      <p>Thank you, <strong>${escapeHtml(identity.email)}</strong>. The ${escapeHtml(SERVICES[ticket.service].name)} is now
      enabled for the jethro.au API key registered to ${escapeHtml(key.createdByCampaign || 'your organisation')}.</p>
      <p>You can close this page and return to Jethro.</p>`;
  return htmlResponse(signupShell(body, CONSENT_HEADING), 200, extraHeaders);
}

/**
 * 302 to an app's return URL with query parameters added.
 *
 * @param {Record<string, string>} params  parameters to set (empty values are skipped)
 */
function redirectWith(returnTo, params, extraHeaders = {}) {
  const r = new URL(returnTo);
  for (const [k, v] of Object.entries(params)) {
    if (v) r.searchParams.set(k, v);
  }
  return new Response(null, {
    status: 302,
    headers: { Location: r.toString(), 'Cache-Control': 'no-store', ...extraHeaders },
  });
}

// ---------------------------------------------------------------------------
// Self-service signup: OAuth (Google / GitHub) → create-scoped API key.
//
// Flow: GET /signup → GET /auth/{provider}/login (sets a random state cookie,
// redirects to the provider) → GET /auth/{provider}/callback (verifies state,
// exchanges the code, resolves a verified email) → finishSignIn.
//
// Each identity holds exactly one key; signing in again revokes the old key
// and mints a fresh one, keeping the old key's consents. Tokens are stored hashed:
//   apikey:{id}     → key record (tokenHash + tokenPrefix, no plaintext, consents)
//   tok:{sha256}    → { id }        (O(1) auth lookup)
//   owner:{ident}   → { keyId }     (one-key-per-identity replacement)
//
// The same sign-in also confirms a consent (/consent?ticket=…): the ticket
// rides through the state cookie or magic-link record instead of a signup.
//
// Secrets (cf workers secrets update): GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET,
// GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET. A provider with no client ID is
// hidden from /signup and /consent, and its /auth routes return 501.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Self-service signup: email magic link → create-scoped API key.
//
// Flow: POST /signup or /consent (email) → send magic link with one-time token
// (ml:{token} in KV, 10min TTL) → GET /auth/email/callback?token=... (validate,
// finishSignIn).
//
// Owners are "email:{sha256(email)}" — one key per verified email address.
// Requires secrets: EMAIL_API_KEY (Resend API key), EMAIL_FROM (sender address).
// ---------------------------------------------------------------------------

const MAGIC_LINK_TOKEN_TTL = 600; // 10 minutes in seconds

/**
 * What a sign-in is for. Carried from the form through the OAuth state cookie
 * or the magic-link record to {@link finishSignIn}.
 *
 * @typedef {{kind: 'signup', redirect: string, campaign: string, service: string, agreed: boolean}
 *   | {kind: 'consent', ticket: string, service: string, agreed: boolean}} SignInPurpose
 *   signup: a key, optionally with consent to `service` (a SERVICES id, or '');
 *   consent: consent on the key of consent ticket `ticket`. agreed: the agree box was ticked.
 */

/**
 * Read a sign-in's purpose from its parameters.
 *
 * @param {(name: string) => string} param  request parameter by name ('' when absent)
 * @param {boolean} consent  a consent sign-in (POST /consent, or a `ticket` parameter)
 * @returns {SignInPurpose}
 */
function signInPurpose(param, consent) {
  const agreed = param('agree') === '1';
  if (consent) return { kind: 'consent', ticket: param('ticket'), service: '', agreed };
  return {
    kind: 'signup',
    redirect: param('redirect'),
    campaign: param('campaign').slice(0, 64),
    service: serviceOf(param('service')) ? param('service') : '',
    agreed,
  };
}

/**
 * Parameters of a sign-in request: form or JSON body fields, falling back to
 * the query string.
 *
 * @returns {Promise<(name: string) => string>}
 */
async function requestParams(request, url) {
  let fields = {};
  if (request.method === 'POST') {
    try {
      const contentType = request.headers.get('Content-Type') || '';
      fields = contentType.includes('application/json')
        ? (await request.json()) ?? {}
        : Object.fromEntries(await request.formData());
    } catch {
      fields = {};
    }
  }
  return (name) => {
    const v = Object.hasOwn(fields, name) ? fields[name] : url.searchParams.get(name);
    return typeof v === 'string' ? v.trim() : '';
  };
}

/** Where a refused sign-in should go back to: the page it started from. */
function signInStartUrl(purpose) {
  if (purpose.kind === 'consent') return `/consent?ticket=${encodeURIComponent(purpose.ticket)}`;
  const qs = new URLSearchParams();
  for (const k of ['redirect', 'campaign', 'service']) {
    if (purpose[k]) qs.set(k, purpose[k]);
  }
  return '/signup' + (qs.size ? '?' + qs : '');
}

/**
 * Check a sign-in may start: a consent, or a signup for a service, needs the
 * agree box ticked (enforced here, not only by the browser), and a consent
 * needs a live ticket. Fills in a consent purpose's service from its ticket.
 *
 * @param {SignInPurpose} purpose
 * @returns {Promise<{error: Response} | {org: string}>} org: the organisation agreed for
 */
async function checkSignIn(env, purpose) {
  if ((purpose.kind === 'consent' || purpose.service) && !purpose.agreed) {
    const heading = purpose.kind === 'consent' ? CONSENT_HEADING : undefined;
    return {
      error: htmlResponse(signupShell(
        `<p>Please tick “I agree” to continue. <a href="${escapeHtml(signInStartUrl(purpose))}">Back</a>.</p>`, heading), 400),
    };
  }
  if (purpose.kind === 'consent') {
    const loaded = await loadConsentTicket(env, purpose.ticket);
    if (!loaded) return { error: consentGonePage() };
    purpose.service = loaded.ticket.service;
    return { org: loaded.key.createdByCampaign || '' };
  }
  return { org: purpose.campaign };
}

/**
 * Finish a sign-in for `identity`: record a consent ({@link completeConsentTicket}),
 * or mint the identity's key — with consent to the signup's service — and
 * redirect back with sh_apikey, sh_email, sh_replaced and sh_consented, or show
 * the key.
 *
 * @param {SignInPurpose} purpose  as checked by {@link checkSignIn} when the sign-in started
 * @param {object} extraHeaders  added to the response
 */
async function finishSignIn(env, url, purpose, identity, extraHeaders = {}) {
  if (purpose.kind === 'consent') {
    return completeConsentTicket(env, url, purpose.ticket, identity, extraHeaders);
  }
  const service = purpose.agreed && serviceOf(purpose.service) ? purpose.service : '';
  const { token, replaced, consented } = await mintSelfServiceKey(env, identity, purpose.campaign, service);

  // If the signup was initiated from an app integration, redirect back with
  // the key instead of showing it (see isValidReturnTo for the accepted risk).
  if (purpose.redirect && isValidReturnTo(purpose.redirect)) {
    return redirectWith(purpose.redirect, {
      sh_apikey: token,
      sh_email: identity.email,
      sh_replaced: replaced ? '1' : '',
      sh_consented: consented,
    }, extraHeaders);
  }

  const body = `
      <p>Signed in as <strong>${escapeHtml(identity.email)}</strong>.</p>
      ${replaced ? '<p>Your previous key has been revoked and replaced.</p>' : ''}
      ${consented ? `<p>The ${escapeHtml(SERVICES[consented].name)} is enabled for this key.</p>` : ''}
      <p>Your API key — <strong>copy it now; it is shown only once</strong>:</p>
      <pre><code>${escapeHtml(token)}</code></pre>
      <p>Use it as a Bearer token:</p>
      <pre><code>curl -X POST ${escapeHtml(redirectOrigin(url))}/api/shorten \\
  -H "Authorization: Bearer ${escapeHtml(token)}" \\
  -H "Content-Type: application/json" \\
  -d '{"url": "https://example.com/some/long/path"}'</code></pre>
      <p>Lost it? Just <a href="/signup">sign in again</a> for a new key.</p>`;
  return htmlResponse(signupShell(body), 200, extraHeaders);
}

/**
 * POST /signup, POST /consent — accept an email address, store a one-time
 * magic-link token (ml:{token} → { email, purpose }, 10 minutes) and send
 * the link. Accepts form or JSON bodies; signup parameters may also come
 * from the query string.
 */
async function handleEmailSignIn(request, url, env) {
  if (!env.EMAIL_API_KEY || !env.EMAIL_FROM) {
    return htmlResponse(signupShell('<p>Email sign-in is not enabled on this server.</p>'), 501);
  }

  const param = await requestParams(request, url);
  const purpose = signInPurpose(param, url.pathname === '/consent' || param('ticket') !== '');
  const check = await checkSignIn(env, purpose);
  if (check.error) return check.error;

  const email = param('email');
  if (!email || !email.includes('@') || email.length > 254) {
    return htmlResponse(signupShell(
      `<p>Please enter a valid email address. <a href="${escapeHtml(signInStartUrl(purpose))}">Try again</a>.</p>`), 400);
  }

  const token = crypto.randomUUID();
  await env.URL_MAPPINGS.put(
    `ml:${token}`,
    JSON.stringify({ email, purpose, created: new Date().toISOString() }),
    { expirationTtl: MAGIC_LINK_TOKEN_TTL }
  );

  const sent = await sendMagicLink(email, token, redirectOrigin(url), env, purpose, check.org);
  if (!sent) {
    // Clean up the KV entry so it can't be used later.
    await env.URL_MAPPINGS.delete(`ml:${token}`);
    return htmlResponse(signupShell(
      `<p>Failed to send the email. Please try again later. <a href="${escapeHtml(signInStartUrl(purpose))}">Back</a>.</p>`), 502);
  }

  return htmlResponse(signupShell(
    `<p>A magic link has been sent to <strong>${escapeHtml(email)}</strong>.</p>
     <p>Check your inbox and click the link to ${purpose.kind === 'consent' ? 'confirm' : 'receive your API key'}.
     The link expires in 10 minutes.</p>`, purpose.kind === 'consent' ? CONSENT_HEADING : undefined
  ));
}

/**
 * GET /auth/email/callback?token=... — use up the magic-link token and finish
 * the sign-in it was sent for ({@link finishSignIn}).
 */
async function handleEmailCallback(request, url, env) {
  const token = url.searchParams.get('token');

  if (!token) {
    return htmlResponse(signupShell('<p>Missing token. <a href="/signup">Try again</a>.</p>'), 400);
  }

  const record = await env.URL_MAPPINGS.get(`ml:${token}`, { type: 'json' });
  if (!record || !record.purpose) {
    return htmlResponse(signupShell('<p>This link has expired or already been used. <a href="/signup">Request a new one</a>.</p>'), 410);
  }

  // Consume the token immediately to prevent reuse.
  await env.URL_MAPPINGS.delete(`ml:${token}`);

  const email = record.email || '';
  // Owner identity is a hash so emails aren't stored in plaintext in the KV key.
  const owner = 'email:' + (await sha256Hex(email));
  const identity = { owner, email, provider: 'email' };

  try {
    return await finishSignIn(env, url, record.purpose, identity);
  } catch (error) {
    console.error('Email callback failed:', error);
    return htmlResponse(signupShell('<p>Sign-in failed. <a href="/signup">Try again</a>.</p>'), 502);
  }
}

/**
 * Send a magic-link email via Resend (resend.com).
 *
 * Requires env.EMAIL_API_KEY (Resend API key) and env.EMAIL_FROM. The email
 * says what the link is for: a key, a key with a service enabled, or a
 * consent; for a service it repeats what was agreed and links the service's
 * privacy policy. Returns true on success.
 *
 * @param {SignInPurpose} purpose  as checked by {@link checkSignIn} (service filled in)
 * @param {string} org  the organisation agreed for ('' = unnamed)
 */
async function sendMagicLink(email, token, origin, env, purpose, org) {
  const link = `${origin}/auth/email/callback?token=${encodeURIComponent(token)}`;
  const s = serviceOf(purpose.service);
  const onBehalf = org || 'your organisation';
  let subject, intro;
  if (purpose.kind === 'consent') {
    subject = `Confirm: enable the ${s.name}`;
    intro = `Click the link below to confirm that you agree, on behalf of ${onBehalf}, to enabling the ${s.name} for its jethro.au API key:`;
  } else {
    subject = 'Your jethro.au API key — magic link';
    intro = `Click the link below to receive your jethro.au API key${s ? ` and enable the ${s.name}` : ''}:`;
  }
  const ack = s ? `By enabling it, you acknowledge, on behalf of ${onBehalf}, that ${s.acknowledgement}.` : '';
  const privacyUrl = s ? origin + s.privacyPath : '';

  try {
    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.EMAIL_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: env.EMAIL_FROM,
        to: [email],
        subject,
        text: `${intro}\n\n${link}\n\n`
          + (s ? `${ack} Privacy policy: ${privacyUrl}\n\n` : '')
          + `This link expires in 10 minutes. If you didn't request this, you can ignore this email.`,
        html: `<p>${escapeHtml(intro)}</p>
<p><a href="${link}">${link}</a></p>`
          + (s ? `\n<p>${escapeHtml(ack)} Please see the <a href="${escapeHtml(privacyUrl)}">privacy policy</a>.</p>` : '')
          + `\n<p>This link expires in 10 minutes.</p>
<p>If you didn't request this, you can ignore this email.</p>`,
      }),
    });

    return resp.ok;
  } catch (error) {
    console.error('sendMagicLink error:', error);
    return false;
  }
}

const STATE_COOKIE = 'oauth_state';

const OAUTH_PROVIDERS = {
  google: {
    name: 'Google',
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    scope: 'openid email',
    clientId: (env) => env.GOOGLE_CLIENT_ID,
    clientSecret: (env) => env.GOOGLE_CLIENT_SECRET,
    fetchIdentity: fetchGoogleIdentity,
  },
  github: {
    name: 'GitHub',
    authorizeUrl: 'https://github.com/login/oauth/authorize',
    scope: 'user:email',
    clientId: (env) => env.GITHUB_CLIENT_ID,
    clientSecret: (env) => env.GITHUB_CLIENT_SECRET,
    fetchIdentity: fetchGithubIdentity,
  },
};

/**
 * The sign-in form shared by /signup and /consent: one form, so its agree
 * checkbox gates every way of signing in. The email button posts to `action`;
 * each configured OAuth provider's button submits the same fields by GET to
 * /auth/{provider}/login. Returns null when no sign-in method is configured.
 *
 * @param {{action: string, hidden: Record<string, string>, agree: string|null}} options
 *   hidden: fields to carry (empty values skipped); agree: label of the
 *   required agree checkbox, or null for none
 */
function signInForm(env, { action, hidden, agree }) {
  const providers = Object.entries(OAUTH_PROVIDERS).filter(([, p]) => p.clientId(env));
  const emailEnabled = !!(env.EMAIL_API_KEY && env.EMAIL_FROM);
  if (providers.length === 0 && !emailEnabled) return null;

  let html = `<form method="post" action="${escapeHtml(action)}">`;
  for (const [name, value] of Object.entries(hidden)) {
    if (value) html += `\n        <input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`;
  }
  if (agree) {
    html += `
        <p><label><input type="checkbox" name="agree" value="1" required> ${escapeHtml(agree)}</label></p>`;
  }
  // Email is checked by the server rather than marked required, so that the
  // provider buttons can submit the form without it.
  if (emailEnabled) {
    html += `
        <p>
          <label for="email">Email address:</label><br>
          <input type="email" id="email" name="email"
                 placeholder="you@example.com"
                 style="padding:0.5em;width:100%;max-width:24em;box-sizing:border-box;">
        </p>
        <p><button type="submit" class="btn">Send magic link</button></p>`;
  }
  if (providers.length > 0) {
    if (emailEnabled) html += '\n        <hr style="margin:1.5em 0"><p>Or sign in with a provider:</p>';
    for (const [id, p] of providers) {
      html += `\n        <button type="submit" class="btn" formmethod="get" formaction="/auth/${id}/login">Sign in with ${p.name}</button>`;
    }
  }
  return html + '\n      </form>';
}

/**
 * GET /signup?redirect=&campaign=&service= — sign-in page for a jethro.au API
 * key. With a known `service`, the page states what enabling it means, links
 * its privacy policy and requires the agree checkbox; the key is minted with
 * that consent.
 */
function handleSignupPage(url, env) {
  const purpose = signInPurpose((name) => (url.searchParams.get(name) || '').trim(), false);
  const s = serviceOf(purpose.service);

  const form = signInForm(env, {
    action: '/signup',
    hidden: { redirect: purpose.redirect, campaign: purpose.campaign, service: purpose.service },
    agree: s ? agreeLabel(purpose.campaign) : null,
  });
  if (!form) {
    return htmlResponse(signupShell('<p>Self-service signup is not enabled on this server.</p>'), 501);
  }

  let body = s
    ? `<p>Sign in to receive your jethro.au API key and enable the ${escapeHtml(s.name)}.`
    : '<p>Sign in to receive a jethro.au API key.';
  body += ` Your installation needs one key; each jethro.au service is enabled for it separately.
     Signing in again replaces it.</p>`;
  if (s) body += '\n      ' + acknowledgementHtml(purpose.service, url);
  return htmlResponse(signupShell(body + '\n      ' + form));
}

/**
 * GET /auth/{provider}/login — check the sign-in may start ({@link checkSignIn}),
 * set the CSRF state cookie (carrying the sign-in's purpose) and redirect to
 * the provider.
 */
async function handleOAuthLogin(url, env, providerId) {
  const provider = OAUTH_PROVIDERS[providerId];
  if (!provider.clientId(env)) {
    return htmlResponse(signupShell(`<p>${provider.name} sign-in is not configured.</p>`), 501);
  }

  const param = (name) => (url.searchParams.get(name) || '').trim();
  const purpose = signInPurpose(param, param('ticket') !== '');
  const check = await checkSignIn(env, purpose);
  if (check.error) return check.error;
  if (purpose.kind === 'signup' && !isValidReturnTo(purpose.redirect)) purpose.redirect = '';

  const state = Array.from(crypto.getRandomValues(new Uint8Array(16)))
    .map((b) => b.toString(16).padStart(2, '0')).join('');
  const cookieValue = JSON.stringify({ state, purpose });

  const redirectUri = redirectOrigin(url) + `/auth/${providerId}/callback`;

  const params = new URLSearchParams({
    client_id: provider.clientId(env),
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: provider.scope,
    state,
  });

  return new Response(null, {
    status: 302,
    headers: {
      Location: `${provider.authorizeUrl}?${params}`,
      'Set-Cookie': `${STATE_COOKIE}=${encodeURIComponent(cookieValue)}; HttpOnly; Secure; Path=/auth; SameSite=Lax; Max-Age=600`,
      'Cache-Control': 'no-store',
    },
  });
}

/**
 * GET /auth/{provider}/callback — verify state, exchange the code, and finish
 * the sign-in ({@link finishSignIn}).
 */
async function handleOAuthCallback(request, url, env, providerId) {
  const provider = OAUTH_PROVIDERS[providerId];
  if (!provider.clientId(env)) {
    return htmlResponse(signupShell(`<p>${provider.name} sign-in is not configured.</p>`), 501);
  }

  if (url.searchParams.get('error')) {
    return htmlResponse(signupShell(`<p>Sign-in was cancelled or refused. <a href="/signup">Try again</a>.</p>`), 400);
  }

  const state = url.searchParams.get('state');
  const cookieRaw = getCookie(request, STATE_COOKIE);
  let cookie = null;
  try {
    cookie = cookieRaw ? JSON.parse(decodeURIComponent(cookieRaw)) : null;
  } catch {
    cookie = null;
  }
  if (!state || !cookie?.state || state !== cookie.state || !cookie.purpose) {
    return htmlResponse(signupShell('<p>Sign-in session expired or invalid. <a href="/signup">Try again</a>.</p>'), 400);
  }

  const code = url.searchParams.get('code');
  if (!code) {
    return htmlResponse(signupShell('<p>Missing authorization code. <a href="/signup">Try again</a>.</p>'), 400);
  }

  const clearCookie = {
    'Set-Cookie': `${STATE_COOKIE}=; HttpOnly; Secure; Path=/auth; SameSite=Lax; Max-Age=0`,
  };
  try {
    const redirectUri = redirectOrigin(url) + `/auth/${providerId}/callback`;
    const identity = await provider.fetchIdentity(code, redirectUri, env);
    return await finishSignIn(env, url, cookie.purpose, identity, clearCookie);
  } catch (error) {
    console.error(`OAuth ${providerId} callback failed:`, error);
    return htmlResponse(signupShell('<p>Sign-in failed. <a href="/signup">Try again</a>.</p>'), 502);
  }
}

/**
 * Exchange a Google authorization code and return { owner, email, provider }.
 * The id_token comes straight from Google over TLS, so decoding its payload
 * without signature verification is safe here.
 */
async function fetchGoogleIdentity(code, redirectUri, env) {
  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }),
  });
  const data = await resp.json();
  if (!resp.ok || !data.id_token) {
    throw new Error(`Google token exchange failed: ${data.error || resp.status}`);
  }

  const claims = decodeJwtPayload(data.id_token);
  if (!claims.sub || !claims.email || claims.email_verified !== true) {
    throw new Error('Google identity lacks a verified email');
  }
  return { owner: `google:${claims.sub}`, email: claims.email, provider: 'google' };
}

/**
 * Exchange a GitHub authorization code and return { owner, email, provider }.
 */
async function fetchGithubIdentity(code, redirectUri, env) {
  const resp = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
      redirect_uri: redirectUri,
    }),
  });
  const data = await resp.json();
  if (!data.access_token) {
    throw new Error(`GitHub token exchange failed: ${data.error || resp.status}`);
  }

  const ghHeaders = {
    Authorization: `Bearer ${data.access_token}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'url-shortener-worker', // GitHub API rejects requests without one
  };

  const user = await (await fetch('https://api.github.com/user', { headers: ghHeaders })).json();
  if (!user.id) {
    throw new Error('GitHub user lookup failed');
  }

  const emails = await (await fetch('https://api.github.com/user/emails', { headers: ghHeaders })).json();
  const best = Array.isArray(emails)
    ? emails.find((e) => e.primary && e.verified) || emails.find((e) => e.verified)
    : null;
  const email = best ? best.email : null;
  if (!email) {
    throw new Error('GitHub account has no verified email');
  }
  return { owner: `github:${user.id}`, email, provider: 'github' };
}

/**
 * Mint a create-scoped key for an identity, revoking any key it already holds;
 * the revoked key's consents carry over to the new one.
 *
 * @param {string} campaign - optional campaign id from the signup flow (max 64 chars)
 * @param {string} service - a SERVICES id the signer agreed to on the signup page, or ''
 * @returns {Promise<{token: string, replaced: boolean, consented: string}>}
 *   consented: `service` when its consent was recorded now, else ''
 */
async function mintSelfServiceKey(env, identity, campaign = '', service = '') {
  const ownerKey = `owner:${identity.owner}`;
  const prev = await env.URL_MAPPINGS.get(ownerKey, { type: 'json' });
  let replaced = false;
  let consents = {};

  if (prev && prev.keyId) {
    const prevKey = await env.URL_MAPPINGS.get(`apikey:${prev.keyId}`, { type: 'json' });
    await env.URL_MAPPINGS.delete(`apikey:${prev.keyId}`);
    if (prevKey && prevKey.tokenHash) {
      await env.URL_MAPPINGS.delete(`tok:${prevKey.tokenHash}`);
    }
    consents = { ...prevKey?.consents };
    replaced = true;
  }

  const consented = serviceOf(service) ? service : '';
  if (consented) consents[consented] = newConsent(consented, identity);

  const id = crypto.randomUUID();
  const token = 'cus_' + crypto.randomUUID().replace(/-/g, '');
  const tokenHash = await sha256Hex(token);
  const keyData = {
    id,
    type: 'create',
    label: identity.email,
    owner: identity.owner,
    ownerEmail: identity.email,
    provider: identity.provider,
    tokenPrefix: token.slice(0, 8) + '...',
    tokenHash,
    created: new Date().toISOString(),
    consents,
  };

  if (campaign) {
    keyData.createdByCampaign = campaign;
  }

  await env.URL_MAPPINGS.put(`apikey:${id}`, JSON.stringify(keyData));
  await env.URL_MAPPINGS.put(`tok:${tokenHash}`, JSON.stringify({ id }));
  await env.URL_MAPPINGS.put(ownerKey, JSON.stringify({ keyId: id }));

  return { token, replaced, consented };
}

/**
 * Decode a JWT payload (no signature verification — only for tokens received
 * directly from the issuer over TLS).
 */
function decodeJwtPayload(jwt) {
  const part = jwt.split('.')[1];
  const b64 = part.replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
  const bytes = Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes));
}

/**
 * Validate a post-signup return URL: must be an absolute http(s) URL.  We do
 * NOT enforce same-origin because the redirect target is the integrating app,
 * which runs on a different domain than the shortener.
 *
 * ACCEPTED RISK — the API key is passed as a query parameter (sh_apikey) on
 * the redirect.  An attacker who convinces a victim to click a crafted
 * /signup?redirect=https://evil.com link could receive the key.  Mitigations:
 *   • The key is also shown on an HTML success page — the redirect is a
 *     convenience, not the only path to the key.
 *   • The victim must actively complete sign-in (OAuth or magic link).
 *   • Each identity holds exactly one key; re-signing rotates it.
 */
function isValidReturnTo(returnTo, _requestUrl) {
  if (!returnTo) return false;
  // Only absolute http(s) — reject javascript:, data:, etc.
  if (!/^https?:\/\//.test(returnTo)) return false;
  try {
    new URL(returnTo);
    return true;
  } catch {
    return false;
  }
}

/**
 * Return the origin for OAuth redirect URIs, forcing HTTPS except for localhost.
 * Cloudflare terminates TLS at the edge, so url.origin may be http:// internally.
 */
function redirectOrigin(url) {
  if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') {
    return url.origin;
  }
  return `https://${url.host}`;
}

function getCookie(request, name) {
  const cookieHeader = request.headers.get('Cookie') || '';
  for (const part of cookieHeader.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return null;
}

function escapeHtml(s) {
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/**
 * HTML page for the signup and consent flows.
 *
 * @param {string} body  HTML content
 * @param {string} heading  page heading (and title)
 */
function signupShell(body, heading = 'Get an API key') {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>jethro.au — ${escapeHtml(heading)}</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 40rem; margin: 4rem auto; padding: 0 1rem; line-height: 1.5; }
    .btn { display: inline-block; margin: 0.5rem 0.5rem 0.5rem 0; padding: 0.6rem 1.2rem; border: 1px solid #888;
           border-radius: 6px; text-decoration: none; color: inherit; background: none; font: inherit; cursor: pointer; }
    pre { background: #f4f4f4; padding: 1rem; border-radius: 6px; overflow-x: auto; }
    @media (prefers-color-scheme: dark) { body { background: #111; color: #eee; } pre { background: #222; } }
  </style>
</head>
<body>
  <h1>${escapeHtml(heading)}</h1>
  ${body}
</body>
</html>`;
}

function htmlResponse(html, status = 200, extraHeaders = {}) {
  return new Response(html, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      ...extraHeaders,
    },
  });
}

// ---------------------------------------------------------------------------
// Bot protection (Cloudflare Turnstile) for block_bots URLs
//
// GET /s/{code} → challenge page with the Turnstile widget → widget auto-POSTs
// its token to /s/{code} → siteverify → set signed pass cookie → 303 to target.
// Secrets: TURNSTILE_SITE_KEY, TURNSTILE_SECRET_KEY. The secret also signs the
// pass cookie, so rotating it invalidates outstanding passes.
// ---------------------------------------------------------------------------

const BOT_PASS_COOKIE = 'bot_pass';
const BOT_PASS_TTL = 30 * 60; // seconds

function turnstileConfigured(env) {
  return !!(env.TURNSTILE_SITE_KEY && env.TURNSTILE_SECRET_KEY);
}

async function hmacHex(secret, message) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function hasValidBotPass(request, env) {
  const raw = getCookie(request, BOT_PASS_COOKIE);
  if (!raw) return false;
  const [exp, sig] = raw.split('.');
  if (!exp || !sig || !(Number(exp) > Date.now() / 1000)) return false;
  return sig === await hmacHex(env.TURNSTILE_SECRET_KEY, `bot_pass:${exp}`);
}

function botCheckPage(env, error = '') {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Checking your browser…</title>
  <script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>
  <style>body { font-family: system-ui, sans-serif; max-width: 40rem; margin: 4rem auto; padding: 0 1rem; line-height: 1.5; }</style>
</head>
<body>
  <p>${error ? escapeHtml(error) + ' ' : ''}Please confirm you are not a robot to continue.</p>
  <form method="post" id="f">
    <div class="cf-turnstile" data-sitekey="${escapeHtml(env.TURNSTILE_SITE_KEY)}" data-callback="onPass"></div>
    <noscript><p>JavaScript is required to continue.</p></noscript>
  </form>
  <script>function onPass() { document.getElementById('f').submit(); }</script>
</body>
</html>`;
}

/**
 * POST /s/{code} — verify a Turnstile token, then redirect to the target.
 */
async function handleBotCheck(request, url, env) {
  const { code, restPath } = parseShortPath(url);
  if (!code || code.includes(':')) {
    return new Response('Invalid short URL', { status: 400, headers: { 'Cache-Control': 'no-store' } });
  }

  try {
    const mapping = await env.URL_MAPPINGS.get(code, { type: 'json' });
    if (!mapping || mapping.deleted) {
      return new Response(null, { status: 404, headers: { 'Cache-Control': 'no-store' } });
    }
    // Unprotected codes don't need the check: send the client to the plain redirect.
    if (!mapping.block_bots) {
      return new Response(null, { status: 303, headers: { Location: url.pathname + url.search, 'Cache-Control': 'no-store' } });
    }
    if (!turnstileConfigured(env)) {
      return new Response('Bot protection is not configured', { status: 503, headers: { 'Cache-Control': 'no-store' } });
    }

    const form = await request.formData();
    const token = form.get('cf-turnstile-response');
    if (!token) {
      return htmlResponse(botCheckPage(env, 'Verification failed.'), 400);
    }

    const verifyBody = new FormData();
    verifyBody.append('secret', env.TURNSTILE_SECRET_KEY);
    verifyBody.append('response', token);
    const ip = request.headers.get('CF-Connecting-IP');
    if (ip) verifyBody.append('remoteip', ip);
    const verifyResp = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      body: verifyBody,
    });
    const outcome = await verifyResp.json();
    if (!outcome.success) {
      return htmlResponse(botCheckPage(env, 'Verification failed.'), 403);
    }

    const exp = Math.floor(Date.now() / 1000) + BOT_PASS_TTL;
    const sig = await hmacHex(env.TURNSTILE_SECRET_KEY, `bot_pass:${exp}`);
    return new Response(null, {
      status: 303,
      headers: {
        Location: buildTarget(mapping.url, restPath, url.search),
        'Cache-Control': 'no-store',
        'Set-Cookie': `${BOT_PASS_COOKIE}=${exp}.${sig}; Path=/s/; Max-Age=${BOT_PASS_TTL}; HttpOnly; Secure; SameSite=Lax`,
      },
    });
  } catch (error) {
    console.error('Bot check failed:', error);
    return new Response('Internal Server Error', { status: 500, headers: { 'Cache-Control': 'no-store' } });
  }
}
