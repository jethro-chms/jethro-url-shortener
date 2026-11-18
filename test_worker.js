/**
 * Tests for the URL Shortener Worker, in two parts:
 *
 * 1. Sign-in flows, in-process: worker.js runs in Node with a fake KV
 *    namespace and faked Resend and GitHub APIs, so the signup and consent
 *    flows (magic links, OAuth, consent tickets) run end to end without
 *    secrets or a server.
 * 2. HTTP integration tests. Run with: npx cf dev (in one terminal), then
 *    node test_worker.js
 *
 * Or run the HTTP tests against your deployed worker:
 *   BASE_URL=https://yourdomain.com API_KEY=your-key node test_worker.js
 */

import worker, { SERVICES } from './worker.js';

const BASE_URL = process.env.BASE_URL || 'http://localhost:5173';
const API_KEY = process.env.API_KEY || 'test-key';

const headers = {
  'Content-Type': 'application/json',
  Authorization: `Bearer ${API_KEY}`,
};

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (err) {
    console.log(`  ❌ ${name}: ${err.message}`);
    failed++;
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message || 'Assertion failed');
}

async function runTests() {
  console.log('\n🧪 URL Shortener Worker Tests\n');

  const testCode = `test-${Date.now()}`;

  // Create
  console.log('📌 Create short URL');
  let created;
  await test('POST /api/shorten creates a URL', async () => {
    const resp = await fetch(`${BASE_URL}/api/shorten`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        url: 'https://www.iamdevbox.com/posts/building-self-hosted-url-shortener-cloudflare-workers/',
        code: testCode,
        campaign: 'test',
        notes: 'Integration test',
      }),
    });
    assert(resp.status === 200, `Expected 200, got ${resp.status}`);
    created = await resp.json();
    assert(created.code === testCode, `Expected code ${testCode}, got ${created.code}`);
    assert(created.shortUrl.includes(`/s/${testCode}`), 'shortUrl should include the code');
  });

  await test('POST /api/shorten rejects duplicate code', async () => {
    const resp = await fetch(`${BASE_URL}/api/shorten`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ url: 'https://example.com/', code: testCode }),
    });
    assert(resp.status === 409, `Expected 409 Conflict, got ${resp.status}`);
  });

  await test('POST /api/shorten requires authentication', async () => {
    const resp = await fetch(`${BASE_URL}/api/shorten`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com/' }),
    });
    assert(resp.status === 401, `Expected 401, got ${resp.status}`);
  });

  await test('POST /api/shorten rejects non-http(s) URLs', async () => {
    const resp = await fetch(`${BASE_URL}/api/shorten`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ url: 'javascript:alert(1)' }),
    });
    assert(resp.status === 400, `Expected 400, got ${resp.status}`);
  });

  await test('POST /api/shorten rejects codes with reserved characters', async () => {
    const resp = await fetch(`${BASE_URL}/api/shorten`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ url: 'https://example.com/', code: 'apikey:evil' }),
    });
    assert(resp.status === 400, `Expected 400, got ${resp.status}`);
  });

  await test('POST /api/shorten rejects non-boolean block_bots', async () => {
    const resp = await fetch(`${BASE_URL}/api/shorten`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ url: 'https://example.com/', block_bots: 'yes' }),
    });
    assert(resp.status === 400, `Expected 400, got ${resp.status}`);
  });

  await test('block_bots URL serves a Turnstile challenge instead of redirecting', async () => {
    const bbCode = `${testCode}-bb`;
    const resp = await fetch(`${BASE_URL}/api/shorten`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ url: 'https://example.com/protected', code: bbCode, block_bots: true }),
    });
    // 501 when TURNSTILE_* secrets are not configured on this worker
    if (resp.status === 501) return;
    assert(resp.status === 200, `Expected 200, got ${resp.status}`);
    try {
      const get = await fetch(`${BASE_URL}/s/${bbCode}`, { redirect: 'manual' });
      assert(get.status === 200, `Expected challenge page (200), got ${get.status}`);
      assert((await get.text()).includes('cf-turnstile'), 'Expected Turnstile widget');
      const post = await fetch(`${BASE_URL}/s/${bbCode}`, {
        method: 'POST', redirect: 'manual', body: new URLSearchParams({ 'cf-turnstile-response': 'invalid' }),
      });
      assert(post.status === 403, `Expected invalid token to be rejected with 403, got ${post.status}`);
    } finally {
      await fetch(`${BASE_URL}/api/urls/${bbCode}`, { method: 'DELETE', headers });
      await fetch(`${BASE_URL}/api/urls/${bbCode}/permanent`, { method: 'DELETE', headers });
    }
  });

  // Signup / OAuth
  console.log('\n🔑 Self-service signup');
  await test('GET /signup serves the signup page', async () => {
    const resp = await fetch(`${BASE_URL}/signup`);
    // 200 when at least one OAuth provider is configured, 501 otherwise
    assert([200, 501].includes(resp.status), `Expected 200 or 501, got ${resp.status}`);
    const contentType = resp.headers.get('Content-Type') || '';
    assert(contentType.includes('text/html'), `Expected HTML, got ${contentType}`);
  });

  await test('GET /auth/google/login redirects to Google (or 501 if unconfigured)', async () => {
    const resp = await fetch(`${BASE_URL}/auth/google/login`, { redirect: 'manual' });
    assert([302, 501].includes(resp.status), `Expected 302 or 501, got ${resp.status}`);
    if (resp.status === 302) {
      const location = resp.headers.get('Location') || '';
      assert(location.startsWith('https://accounts.google.com/'), `Unexpected Location: ${location}`);
      const cookie = resp.headers.get('Set-Cookie') || '';
      assert(cookie.includes('oauth_state='), 'Should set oauth_state cookie');
    }
  });

  await test('GET /auth/google/callback without state cookie is rejected', async () => {
    const resp = await fetch(`${BASE_URL}/auth/google/callback?state=abc&code=fake`, { redirect: 'manual' });
    assert([400, 501].includes(resp.status), `Expected 400 or 501, got ${resp.status}`);
  });

  await test('GET /s/{code} rejects reserved-prefix codes', async () => {
    const resp = await fetch(`${BASE_URL}/s/apikey:foo`, { redirect: 'manual' });
    assert(resp.status === 400, `Expected 400, got ${resp.status}`);
  });

  // Path/query passthrough
  console.log('\n↪️  Path and query passthrough');
  const ptFixtures = {
    base: 'https://example.com/base/?keep=1&view=home#frag',
    page: 'https://example.com/page?q=hello%20world',
    origin: 'https://example.com/',
  };
  const ptCodes = {};
  for (const [name, target] of Object.entries(ptFixtures)) {
    const code = `pt-${name}-${Date.now()}`;
    const resp = await fetch(`${BASE_URL}/api/shorten`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ url: target, code, campaign: 'test' }),
    });
    if (resp.status === 200) ptCodes[name] = code;
    else console.log(`  ⚠️  could not create passthrough fixture ${name}: ${resp.status}`);
  }
  const ptCases = [
    ['base', '', ptFixtures.base],
    ['base', '/x/y', 'https://example.com/base/x/y?keep=1&view=home#frag'],
    ['base', '//x', 'https://example.com/base/x?keep=1&view=home#frag'],
    ['base', '?view=admin', 'https://example.com/base/?keep=1&view=admin#frag'],
    ['base', '/x?a=1&a=2', 'https://example.com/base/x?keep=1&view=home&a=1&a=2#frag'],
    ['page', '/', 'https://example.com/page/?q=hello%20world'],
    ['page', '/extra?z=1', 'https://example.com/page/extra?q=hello%20world&z=1'],
    ['origin', '/?view=admin__system_configuration', 'https://example.com/?view=admin__system_configuration'],
  ];
  for (const [name, suffix, expected] of ptCases) {
    await test(`GET /s/{${name}}${suffix} → ${expected}`, async () => {
      assert(ptCodes[name], `fixture ${name} missing`);
      const resp = await fetch(`${BASE_URL}/s/${ptCodes[name]}${suffix}`, { redirect: 'manual' });
      assert(resp.status === 302, `Expected 302, got ${resp.status}`);
      const location = resp.headers.get('Location');
      assert(location === expected, `Expected ${expected}, got ${location}`);
    });
  }
  await test('GET /s/{code}x (unknown code) returns 404', async () => {
    assert(ptCodes.base, 'fixture base missing');
    const resp = await fetch(`${BASE_URL}/s/${ptCodes.base}x/y`, { redirect: 'manual' });
    assert(resp.status === 404, `Expected 404, got ${resp.status}`);
  });
  for (const code of Object.values(ptCodes)) {
    await fetch(`${BASE_URL}/api/urls/${code}`, { method: 'DELETE', headers });
    await fetch(`${BASE_URL}/api/urls/${code}/permanent`, { method: 'DELETE', headers });
  }

  // List
  console.log('\n📋 List URLs');
  await test('GET /api/urls returns list', async () => {
    const resp = await fetch(`${BASE_URL}/api/urls`, { headers });
    assert(resp.status === 200, `Expected 200, got ${resp.status}`);
    const data = await resp.json();
    assert(Array.isArray(data.urls), 'urls should be an array');
    assert(typeof data.total === 'number', 'total should be a number');
  });

  await test('GET /api/urls requires authentication', async () => {
    const resp = await fetch(`${BASE_URL}/api/urls`);
    assert(resp.status === 401, `Expected 401, got ${resp.status}`);
  });

  // Update
  console.log('\n✏️  Update URL');
  await test('PUT /api/urls/{code} updates URL', async () => {
    const resp = await fetch(`${BASE_URL}/api/urls/${testCode}`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ campaign: 'updated-test' }),
    });
    assert(resp.status === 200, `Expected 200, got ${resp.status}`);
    const updated = await resp.json();
    assert(updated.campaign === 'updated-test', 'Campaign should be updated');
  });

  // Delete & Restore
  console.log('\n🗑️  Delete and Restore');
  await test('DELETE /api/urls/{code} soft-deletes URL', async () => {
    const resp = await fetch(`${BASE_URL}/api/urls/${testCode}`, {
      method: 'DELETE',
      headers,
    });
    assert(resp.status === 200, `Expected 200, got ${resp.status}`);
    const data = await resp.json();
    assert(data.deleted === true, 'deleted should be true');
  });

  await test('GET /api/urls/deleted shows deleted URL', async () => {
    const resp = await fetch(`${BASE_URL}/api/urls/deleted`, { headers });
    assert(resp.status === 200, `Expected 200, got ${resp.status}`);
    const data = await resp.json();
    const found = data.urls.find((u) => u.code === testCode);
    assert(found, `Deleted URL ${testCode} should appear in deleted list`);
  });

  await test('POST /api/urls/{code}/restore restores URL', async () => {
    const resp = await fetch(`${BASE_URL}/api/urls/${testCode}/restore`, {
      method: 'POST',
      headers,
    });
    assert(resp.status === 200, `Expected 200, got ${resp.status}`);
    const data = await resp.json();
    assert(data.restored === true, 'restored should be true');
  });

  // Permanent delete (cleanup)
  console.log('\n💀 Permanent Delete');
  await test('DELETE /api/urls/{code} soft-deletes before permanent delete', async () => {
    const resp = await fetch(`${BASE_URL}/api/urls/${testCode}`, {
      method: 'DELETE',
      headers,
    });
    assert(resp.status === 200, `Expected 200, got ${resp.status}`);
  });

  await test('DELETE /api/urls/{code}/permanent permanently removes URL', async () => {
    const resp = await fetch(`${BASE_URL}/api/urls/${testCode}/permanent`, {
      method: 'DELETE',
      headers,
    });
    assert(resp.status === 200, `Expected 200, got ${resp.status}`);
    const data = await resp.json();
    assert(data.permanentlyDeleted === true, 'permanentlyDeleted should be true');
  });

  // Services and consent
  console.log('\n🤝 Services and consent');
  const bearer = (token) => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${token}` });
  const validate = async (token) => (await fetch(`${BASE_URL}/api/validate`, { headers: bearer(token) })).json();
  const authorize = (token, service) => fetch(`${BASE_URL}/api/authorize?service=${service}`, { headers: bearer(token) });
  const putConsent = (id, service, body, token = API_KEY) => fetch(`${BASE_URL}/api/keys/${id}/consents/${service}`, {
    method: 'PUT', headers: bearer(token), body: JSON.stringify(body),
  });
  let ck = null; // { id, token } of a create key made for these tests

  await test('POST /api/keys creates a create key (no consents)', async () => {
    const resp = await fetch(`${BASE_URL}/api/keys`, {
      method: 'POST', headers, body: JSON.stringify({ type: 'create', label: 'consent-test' }),
    });
    assert(resp.status === 201, `Expected 201, got ${resp.status}`);
    ck = await resp.json();
  });

  try {
    await test('GET /api/validate lists every service, unconsented, for a new create key', async () => {
      const data = await validate(ck.token);
      for (const id of Object.keys(SERVICES)) {
        const s = data.services?.[id];
        assert(s, `services.${id} missing`);
        assert(s.name === SERVICES[id].name, `services.${id}.name`);
        assert(s.consented === false && s.accepted === false && s.current === false, `services.${id} flags`);
        assert(s.version === null && s.by === null && s.at === null, `services.${id} version/by/at`);
        assert(s.privacyUrl.endsWith(SERVICES[id].privacyPath), `services.${id}.privacyUrl`);
      }
    });

    await test('GET /api/validate reports admin keys as consented to every service', async () => {
      const data = await validate(API_KEY);
      for (const id of Object.keys(SERVICES)) {
        const s = data.services[id];
        assert(s.consented && s.accepted && s.current && s.version === null, `services.${id}: ${JSON.stringify(s)}`);
      }
    });

    await test('GET /api/authorize: 400 unknown service, 401 bad key, 200 admin', async () => {
      assert((await authorize(ck.token, 'nope')).status === 400, 'unknown service');
      assert((await authorize(ck.token, '__proto__')).status === 400, '__proto__ is not a service');
      const bad = await authorize('cus_bad', 'sms-shortener');
      assert(bad.status === 401, `bad key: ${bad.status}`);
      assert((await bad.json()).error === 'Unauthorized', 'bad key body');
      const admin = await authorize(API_KEY, 'sms-shortener');
      assert(admin.status === 200, `admin: ${admin.status}`);
      assert((await admin.json()).authorized === true, 'admin authorized');
    });

    await test('GET /api/authorize → 403 consent_required without consent', async () => {
      const resp = await authorize(ck.token, 'sms-shortener');
      assert(resp.status === 403, `Expected 403, got ${resp.status}`);
      const data = await resp.json();
      assert(data.error === 'consent_required', `error ${data.error}`);
      assert(data.service === 'sms-shortener', `service ${data.service}`);
      assert(data.privacyUrl.endsWith('/sms-shortener/privacy'), `privacyUrl ${data.privacyUrl}`);
    });

    await test('POST /api/shorten → 403 consent_required for a create key without url-shortener consent', async () => {
      const resp = await fetch(`${BASE_URL}/api/shorten`, {
        method: 'POST', headers: bearer(ck.token), body: JSON.stringify({ url: 'https://example.com/consent-test' }),
      });
      assert(resp.status === 403, `Expected 403, got ${resp.status}`);
      const data = await resp.json();
      assert(data.error === 'consent_required' && data.service === 'url-shortener', JSON.stringify(data));
      assert(data.privacyUrl.endsWith('/url-shortener/privacy'), `privacyUrl ${data.privacyUrl}`);
    });

    await test('PUT /api/keys/{id}/consents/{service} is admin-only and checks its input', async () => {
      assert((await putConsent(ck.id, 'sms-shortener', { by: 'x@example.com' }, ck.token)).status === 403, 'create key');
      assert((await putConsent(ck.id, 'sms-shortener', {})).status === 400, 'missing by');
      assert((await putConsent(ck.id, 'sms-shortener', { by: 'x@example.com', version: 'soon' })).status === 400, 'bad version');
      assert((await putConsent(ck.id, 'nope', { by: 'x@example.com' })).status === 400, 'unknown service');
      assert((await putConsent('no-such-key', 'sms-shortener', { by: 'x@example.com' })).status === 404, 'unknown key');
    });

    await test('a consent older than minPolicyVersion → 403 consent_outdated', async () => {
      const put = await putConsent(ck.id, 'sms-shortener', { by: 'tester@example.com', version: '2000-01-01' });
      assert(put.status === 200, `PUT: ${put.status}`);
      const resp = await authorize(ck.token, 'sms-shortener');
      assert(resp.status === 403, `Expected 403, got ${resp.status}`);
      assert((await resp.json()).error === 'consent_outdated', 'consent_outdated');
      const s = (await validate(ck.token)).services['sms-shortener'];
      assert(s.consented && !s.accepted && !s.current && s.version === '2000-01-01', JSON.stringify(s));
    });

    await test('a current consent → GET /api/authorize 200 with the keyId', async () => {
      assert((await putConsent(ck.id, 'sms-shortener', { by: 'tester@example.com' })).status === 200, 'PUT');
      const resp = await authorize(ck.token, 'sms-shortener');
      assert(resp.status === 200, `Expected 200, got ${resp.status}`);
      const data = await resp.json();
      assert(data.authorized === true && data.keyId === ck.id && data.service === 'sms-shortener', JSON.stringify(data));
      const s = (await validate(ck.token)).services['sms-shortener'];
      assert(s.consented && s.accepted && s.current, JSON.stringify(s));
      assert(s.version === SERVICES['sms-shortener'].policyVersion && s.by === 'tester@example.com' && s.at, JSON.stringify(s));
      assert((await authorize(ck.token, 'url-shortener')).status === 403, 'consents are per service');
    });

    await test('POST /api/shorten succeeds once the url-shortener consent is given', async () => {
      assert((await putConsent(ck.id, 'url-shortener', { by: 'tester@example.com' })).status === 200, 'PUT');
      const code = `${testCode}-consent`;
      const resp = await fetch(`${BASE_URL}/api/shorten`, {
        method: 'POST', headers: bearer(ck.token), body: JSON.stringify({ url: 'https://example.com/consent-test', code }),
      });
      assert(resp.status === 200, `Expected 200, got ${resp.status}`);
      await fetch(`${BASE_URL}/api/urls/${code}`, { method: 'DELETE', headers });
      await fetch(`${BASE_URL}/api/urls/${code}/permanent`, { method: 'DELETE', headers });
    });

    let consentUrl = null;
    await test('POST /api/consents → 201 with a consent URL', async () => {
      const resp = await fetch(`${BASE_URL}/api/consents`, {
        method: 'POST', headers: bearer(ck.token),
        body: JSON.stringify({ service: 'sms-shortener', redirect: 'https://jethro.example/admin' }),
      });
      assert(resp.status === 201, `Expected 201, got ${resp.status}`);
      const data = await resp.json();
      assert(/\/consent\?ticket=[0-9a-f-]{36}$/.test(data.consentUrl), `consentUrl ${data.consentUrl}`);
      assert(data.expiresIn === 600, `expiresIn ${data.expiresIn}`);
      consentUrl = data.consentUrl;
    });

    await test('POST /api/consents rejects an unknown service, a bad redirect and a bad key', async () => {
      const post = (body, token = ck.token) => fetch(`${BASE_URL}/api/consents`, {
        method: 'POST', headers: bearer(token), body: JSON.stringify(body),
      });
      assert((await post({ service: 'nope' })).status === 400, 'unknown service');
      assert((await post({ service: 'sms-shortener', redirect: 'javascript:alert(1)' })).status === 400, 'bad redirect');
      assert((await post({ service: 'sms-shortener' }, 'cus_bad')).status === 401, 'bad key');
    });

    await test('GET /consent names the service (501 when no sign-in is configured); unknown ticket → 410', async () => {
      const resp = await fetch(consentUrl.replace(/^https?:\/\/[^/]+/, BASE_URL));
      assert([200, 501].includes(resp.status), `Expected 200 or 501, got ${resp.status}`);
      if (resp.status === 200) {
        const html = await resp.text();
        assert(html.includes(SERVICES['sms-shortener'].name) && html.includes('name="agree"'), 'page content');
      }
      const gone = await fetch(`${BASE_URL}/consent?ticket=00000000-0000-0000-0000-000000000000`);
      assert(gone.status === 410, `Expected 410, got ${gone.status}`);
    });

    await test('DELETE /api/consents/{service} withdraws consent, idempotently', async () => {
      for (let i = 0; i < 2; i++) {
        const resp = await fetch(`${BASE_URL}/api/consents/sms-shortener`, { method: 'DELETE', headers: bearer(ck.token) });
        assert(resp.status === 200, `Expected 200, got ${resp.status}`);
        const data = await resp.json();
        assert(data.withdrawn === true && data.service === 'sms-shortener', JSON.stringify(data));
      }
      const resp = await authorize(ck.token, 'sms-shortener');
      assert(resp.status === 403 && (await resp.json()).error === 'consent_required', 'refused after withdrawal');
      assert((await authorize(ck.token, 'url-shortener')).status === 200, 'other consents kept');
    });

    await test('DELETE /api/consents/{service} rejects an unknown service and a bad key', async () => {
      assert((await fetch(`${BASE_URL}/api/consents/nope`, { method: 'DELETE', headers: bearer(ck.token) })).status === 400, 'unknown');
      assert((await fetch(`${BASE_URL}/api/consents/sms-shortener`, { method: 'DELETE', headers: bearer('cus_bad') })).status === 401, 'bad key');
    });
  } finally {
    if (ck) await fetch(`${BASE_URL}/api/keys/${ck.id}`, { method: 'DELETE', headers });
  }

  // Hosting providers
  console.log('\n🏢 Hosting providers');
  const api = (path, { method = 'GET', token = API_KEY, body } = {}) => fetch(`${BASE_URL}${path}`, {
    method, headers: bearer(token), ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const mkKey = async (body) => {
    const resp = await api('/api/keys', { method: 'POST', body });
    assert(resp.status === 201, `POST /api/keys ${JSON.stringify(body)}: ${resp.status}`);
    return resp.json();
  };
  const tenantPath = (t) => `/api/tenants/${encodeURIComponent(t)}`;
  const T1 = `host.example:${Date.now()}`;
  const T2 = `${T1}-two`;
  let pv = null; // provider key { id, token }
  let pv2 = null; // a second provider
  let plain = null; // an ordinary create key
  let t1 = null; // T1's current key { id, token }
  const pcode = `${testCode}-tenant`;

  try {
    await test('POST /api/keys creates a provider key (label required)', async () => {
      assert((await api('/api/keys', { method: 'POST', body: { type: 'provider' } })).status === 400, 'no label');
      pv = await mkKey({ type: 'provider', label: 'Example Hosting' });
      assert(pv.type === 'provider' && pv.token.startsWith('cus_'), JSON.stringify(pv));
      pv2 = await mkKey({ type: 'provider', label: 'Other Hosting' });
      plain = await mkKey({ type: 'create', label: 'not a provider' });
    });

    await test('a provider key cannot use services or consent for itself', async () => {
      for (const resp of [
        await api('/api/authorize?service=sms-shortener', { token: pv.token }),
        await api('/api/shorten', { method: 'POST', token: pv.token, body: { url: 'https://example.com/provider' } }),
        await api('/api/consents', { method: 'POST', token: pv.token, body: { service: 'sms-shortener' } }),
      ]) {
        assert(resp.status === 403, `Expected 403, got ${resp.status}`);
        assert((await resp.json()).error === 'provider_key', 'provider_key');
      }
    });

    await test('GET /api/validate for a provider key: type provider, no services', async () => {
      const data = await (await api('/api/validate', { token: pv.token })).json();
      assert(data.type === 'provider' && data.label === 'Example Hosting' && !('services' in data), JSON.stringify(data));
    });

    await test('/api/tenants refuses non-provider keys (403 provider_key_required) and bad keys (401)', async () => {
      for (const token of [API_KEY, plain.token]) {
        const resp = await api('/api/tenants', { method: 'POST', token, body: { tenant: T1, name: 'X' } });
        assert(resp.status === 403 && (await resp.json()).error === 'provider_key_required', `token ${token.slice(0, 6)}`);
      }
      assert((await api('/api/tenants', { token: plain.token })).status === 403, 'GET with a create key');
      assert((await api('/api/tenants', { token: 'cus_bad' })).status === 401, 'bad key');
    });

    await test('POST /api/tenants rejects bad input', async () => {
      for (const body of [
        { tenant: 'has space', name: 'X' }, { tenant: 'x'.repeat(201), name: 'X' }, { tenant: '', name: 'X' },
        { tenant: T1 }, { tenant: T1, name: 'x'.repeat(101) },
      ]) {
        const resp = await api('/api/tenants', { method: 'POST', token: pv.token, body });
        assert(resp.status === 400, `${JSON.stringify(body).slice(0, 40)}: ${resp.status}`);
      }
    });

    await test('POST /api/tenants mints a tenant key; validate shows issuedBy and tenant', async () => {
      const resp = await api('/api/tenants', { method: 'POST', token: pv.token, body: { tenant: T1, name: 'Example Parish' } });
      assert(resp.status === 201, `Expected 201, got ${resp.status}`);
      t1 = await resp.json();
      assert(t1.token.startsWith('cus_') && t1.id && t1.tenant === T1 && t1.replaced === false, JSON.stringify(t1));
      const data = await (await api('/api/validate', { token: t1.token })).json();
      assert(data.type === 'create' && data.issuedBy === 'Example Hosting' && data.tenant === T1, JSON.stringify(data));
      assert(data.createdByCampaign === 'Example Parish' && !('ownerEmail' in data) && !('provider' in data), 'tenant fields');
      assert(data.services['sms-shortener'].consented === false, 'no consents yet');
      const auth = await api('/api/authorize?service=sms-shortener', { token: t1.token });
      assert(auth.status === 403 && (await auth.json()).error === 'consent_required', 'consent required');
    });

    await test('PUT /api/tenants/{tenant}/consents/{service} checks its input', async () => {
      const put = (body, { tenant = T1, service = 'sms-shortener', token = pv.token } = {}) =>
        api(`${tenantPath(tenant)}/consents/${service}`, { method: 'PUT', token, body });
      const by = { name: 'Example Sysadmin', email: 'sysadmin@example.org' };
      assert((await put({ agree: false, by })).status === 400, 'agree false');
      assert((await put({ agree: 'yes', by })).status === 400, 'agree not true');
      assert((await put({ agree: true, by: { name: 'Example Sysadmin' } })).status === 400, 'no email');
      assert((await put({ agree: true, by: { email: 'not-an-email' } })).status === 400, 'bad email');
      assert((await put({ agree: true, by: { ...by, name: 'x'.repeat(101) } })).status === 400, 'long name');
      assert((await put({ agree: true, by }, { service: 'nope' })).status === 400, 'unknown service');
      assert((await put({ agree: true, by }, { tenant: `${T1}-none` })).status === 404, 'unknown tenant');
      assert((await put({ agree: true, by }, { token: pv2.token })).status === 404, "another provider's tenant");
      assert((await put({ agree: true, by }, { token: plain.token })).status === 403, 'create key');
    });

    await test('a vouched consent lets the tenant key use the service (authorize and shorten 200)', async () => {
      for (const service of ['sms-shortener', 'url-shortener']) {
        const resp = await api(`${tenantPath(T1)}/consents/${service}`, {
          method: 'PUT', token: pv.token, body: { agree: true, by: { name: 'Example Sysadmin', email: 'sysadmin@example.org' } },
        });
        assert(resp.status === 200, `PUT ${service}: ${resp.status}`);
        const { service: s, consent } = await resp.json();
        assert(s === service && consent.version === SERVICES[service].policyVersion, JSON.stringify(consent));
        assert(consent.by === 'sysadmin@example.org' && consent.byName === 'Example Sysadmin', 'by');
        assert(consent.byOwner === `vouched:${pv.id}` && consent.vouchedBy === 'Example Hosting' && consent.at, 'vouched');
      }
      const auth = await api('/api/authorize?service=sms-shortener', { token: t1.token });
      assert(auth.status === 200, `authorize: ${auth.status}`);
      assert((await auth.json()).keyId === t1.id, 'keyId is the tenant key');
      const short = await api('/api/shorten', { method: 'POST', token: t1.token, body: { url: 'https://example.com/tenant', code: pcode } });
      assert(short.status === 200, `shorten: ${short.status}`);
      const s = (await (await api('/api/validate', { token: t1.token })).json()).services['sms-shortener'];
      assert(s.consented && s.accepted && s.current && s.by === 'sysadmin@example.org', JSON.stringify(s));
    });

    await test('POST /api/tenants again rotates the key, carrying its consents over', async () => {
      const resp = await api('/api/tenants', { method: 'POST', token: pv.token, body: { tenant: T1, name: 'Example Parish' } });
      assert(resp.status === 201, `Expected 201, got ${resp.status}`);
      const next = await resp.json();
      assert(next.replaced === true && next.id !== t1.id, JSON.stringify(next));
      assert((await api('/api/validate', { token: t1.token })).status === 401, 'old key revoked');
      t1 = next;
      assert((await api('/api/authorize?service=sms-shortener', { token: t1.token })).status === 200, 'consent carried over');
    });

    await test('consents are withdrawn by the provider (idempotently) or by the tenant key itself', async () => {
      for (let i = 0; i < 2; i++) {
        const resp = await api(`${tenantPath(T1)}/consents/sms-shortener`, { method: 'DELETE', token: pv.token });
        assert(resp.status === 200, `DELETE: ${resp.status}`);
        const data = await resp.json();
        assert(data.withdrawn === true && data.service === 'sms-shortener', JSON.stringify(data));
      }
      const auth = await api('/api/authorize?service=sms-shortener', { token: t1.token });
      assert(auth.status === 403 && (await auth.json()).error === 'consent_required', 'refused after withdrawal');
      assert((await api('/api/consents/url-shortener', { method: 'DELETE', token: t1.token })).status === 200, 'tenant withdraws');
      const short = await api('/api/shorten', { method: 'POST', token: t1.token, body: { url: 'https://example.com/tenant-2' } });
      assert(short.status === 403, `shorten after withdrawal: ${short.status}`);
    });

    await test('GET /api/tenants lists only this provider\'s tenants', async () => {
      assert((await api('/api/tenants', { method: 'POST', token: pv.token, body: { tenant: T2, name: 'Second Parish' } })).status === 201, 'mint T2');
      const resp = await api('/api/tenants', { token: pv.token });
      assert(resp.status === 200, `Expected 200, got ${resp.status}`);
      const list = await resp.json();
      const one = list.find((t) => t.tenant === T1);
      assert(one && one.name === 'Example Parish' && one.keyId === t1.id && one.tokenPrefix && one.created, JSON.stringify(one));
      assert(typeof one.consents === 'object' && !one.consents['sms-shortener'], 'consents');
      assert(list.some((t) => t.tenant === T2 && t.name === 'Second Parish'), 'T2 listed');
      assert((await (await api('/api/tenants', { token: pv2.token })).json()).length === 0, 'other provider sees none');
    });

    await test('DELETE /api/tenants/{tenant} revokes the key, scrubs attribution and removes the index', async () => {
      const before = (await (await api('/api/urls')).json()).urls.find((u) => u.code === pcode);
      assert(before?.createdBy === `tenant:${pv.id}:${T1}` && before.createdByCampaign === 'Example Parish', JSON.stringify(before));
      const resp = await api(tenantPath(T1), { method: 'DELETE', token: pv.token });
      assert(resp.status === 200, `Expected 200, got ${resp.status}`);
      const data = await resp.json();
      assert(data.revoked === true && data.tenant === T1, JSON.stringify(data));
      assert((await api('/api/validate', { token: t1.token })).status === 401, 'key revoked');
      const after = (await (await api('/api/urls')).json()).urls.find((u) => u.code === pcode);
      assert(after && !after.createdBy && !after.createdByCampaign, JSON.stringify(after));
      assert(!(await (await api('/api/tenants', { token: pv.token })).json()).some((t) => t.tenant === T1), 'unlisted');
      assert((await api(tenantPath(T1), { method: 'DELETE', token: pv.token })).status === 404, 'second delete');
    });

    await test("a tenant key's DELETE /api/keys/mine also removes its tenant index entry", async () => {
      const minted = await (await api('/api/tenants', { method: 'POST', token: pv.token, body: { tenant: T2, name: 'Second Parish' } })).json();
      assert((await api('/api/keys/mine', { method: 'DELETE', token: minted.token })).status === 200, 'deregistered');
      assert(!(await (await api('/api/tenants', { token: pv.token })).json()).some((t) => t.tenant === T2), 'unlisted');
      const put = await api(`${tenantPath(T2)}/consents/sms-shortener`, {
        method: 'PUT', token: pv.token, body: { agree: true, by: { email: 'sysadmin@example.org' } },
      });
      assert(put.status === 404, `vouching for a deregistered tenant: ${put.status}`);
    });
  } finally {
    await api(`/api/urls/${pcode}`, { method: 'DELETE' });
    await api(`/api/urls/${pcode}/permanent`, { method: 'DELETE' });
    for (const k of [pv, pv2, plain]) if (k) await api(`/api/keys/${k.id}`, { method: 'DELETE' });
  }

  console.log('\n📄 Pages');
  await test('GET /url-shortener/privacy is dated by the url-shortener policyVersion', async () => {
    const resp = await fetch(`${BASE_URL}/url-shortener/privacy`);
    assert(resp.status === 200, `Expected 200, got ${resp.status}`);
    const html = await resp.text();
    const [y, m, d] = SERVICES['url-shortener'].policyVersion.split('-').map(Number);
    const month = new Date(Date.UTC(y, m - 1, d)).toLocaleString('en-AU', { month: 'long', timeZone: 'UTC' });
    assert(html.includes(`Last updated ${d} ${month} ${y}.`), 'last-updated date');
    assert(html.includes('Self-registered') && html.includes('Through a hosting provider'), 'both ways to register');
    assert(html.includes('as vouched for by the provider'), 'vouched agreements');
    assert(html.includes('can list the keys it issued'), 'what a provider can do');
  });

  await test('GET / names both services and links their privacy pages', async () => {
    const html = await (await fetch(`${BASE_URL}/`)).text();
    for (const s of Object.values(SERVICES)) {
      assert(html.includes(s.name) && html.includes(`href="${s.privacyPath}"`), `mentions ${s.name}`);
    }
  });
}

/** Fake Workers KV namespace (no TTLs). */
function fakeKv() {
  const data = new Map();
  return {
    data,
    async get(key, opts) {
      if (!data.has(key)) return null;
      return opts?.type === 'json' ? JSON.parse(data.get(key)) : data.get(key);
    },
    async put(key, value) { data.set(key, String(value)); },
    async delete(key) { data.delete(key); },
    async list({ prefix = '' } = {}) {
      return { keys: [...data.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })), list_complete: true };
    },
  };
}

/**
 * Signup and consent flows, run in-process against fake KV, Resend and GitHub.
 */
async function runFlowTests() {
  console.log('\n🔐 Sign-in flows (in-process, fake KV, email and GitHub)\n');

  const env = {
    URL_MAPPINGS: fakeKv(),
    API_KEY: 'admin-secret',
    EMAIL_API_KEY: 'resend-test',
    EMAIL_FROM: 'noreply@example.com',
    GITHUB_CLIENT_ID: 'gh-client',
    GITHUB_CLIENT_SECRET: 'gh-secret',
  };
  const emails = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url === 'https://api.resend.com/emails') {
      emails.push(JSON.parse(init.body));
      return Response.json({ id: 'email-1' });
    }
    if (url === 'https://github.com/login/oauth/access_token') return Response.json({ access_token: 'gh-token' });
    if (url === 'https://api.github.com/user') return Response.json({ id: 4242 });
    if (url === 'https://api.github.com/user/emails') {
      return Response.json([{ email: 'gh-user@example.com', primary: true, verified: true }]);
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  const ORIGIN = 'https://jethro.au';
  const RETURN = 'https://jethro.example/admin?view=config';
  const call = (path, { method = 'GET', form, json, token, cookie } = {}) => {
    const h = {};
    if (token) h.Authorization = `Bearer ${token}`;
    if (cookie) h.Cookie = cookie;
    if (json) h['Content-Type'] = 'application/json';
    const body = form ? new URLSearchParams(form) : json ? JSON.stringify(json) : undefined;
    return worker.fetch(new Request(ORIGIN + path, { method, headers: h, body, redirect: 'manual' }), env, {});
  };
  const query = (resp) => new URL(resp.headers.get('Location')).searchParams;
  const validate = async (token) => (await call('/api/validate', { token })).json();
  /** Path of the magic link in the latest email. */
  const lastLink = () => {
    const m = emails.at(-1).text.match(/https:\/\/jethro\.au(\/auth\/email\/callback\?token=[\w-]+)/);
    assert(m, 'email contains a magic link');
    return m[1];
  };
  /** Complete a GitHub sign-in started by GET `loginPath`. */
  const githubSignIn = async (loginPath) => {
    const login = await call(loginPath);
    assert(login.status === 302, `login: expected 302, got ${login.status}`);
    const state = new URL(login.headers.get('Location')).searchParams.get('state');
    const cookie = login.headers.get('Set-Cookie').split(';')[0];
    return call(`/auth/github/callback?state=${state}&code=c`, { cookie });
  };
  const smsAck = SERVICES['sms-shortener'].acknowledgement;

  try {
    await test('signup page for a service shows its acknowledgement, privacy link and a required agree box', async () => {
      const resp = await call(`/signup?service=sms-shortener&campaign=Example%20Church&redirect=${encodeURIComponent(RETURN)}`);
      assert(resp.status === 200, `Expected 200, got ${resp.status}`);
      const html = await resp.text();
      assert(html.includes(smsAck), 'acknowledgement');
      assert(html.includes(`${ORIGIN}/sms-shortener/privacy`), 'privacy link');
      assert(html.includes('name="agree" value="1" required'), 'required agree box');
      assert(html.includes('I agree to this on behalf of Example Church'), 'agree label names the organisation');
      assert(html.includes('formaction="/auth/github/login"'), 'GitHub button submits the same form');
    });

    await test('plain signup page has no agree box; unknown services are ignored', async () => {
      const html = await (await call('/signup?service=nope')).text();
      assert(!html.includes('name="agree"'), 'no agree box');
      assert(!html.includes('name="service"'), 'unknown service not carried');
    });

    await test('a service signup without agree is refused by the server (email and OAuth)', async () => {
      const sent = emails.length;
      const form = { email: 'admin@example.com', service: 'sms-shortener', redirect: RETURN };
      assert((await call('/signup', { method: 'POST', form })).status === 400, 'email POST');
      assert((await call('/auth/github/login?service=sms-shortener')).status === 400, 'OAuth login');
      assert(emails.length === sent, 'no email sent');
    });

    let smsKey;
    await test('email signup with agree mints a key with that consent and redirects with sh_consented', async () => {
      const form = { email: 'admin@example.com', service: 'sms-shortener', campaign: 'Example Church', redirect: RETURN, agree: '1' };
      assert((await call('/signup', { method: 'POST', form })).status === 200, 'email sent');
      assert(emails.at(-1).text.includes(smsAck) && emails.at(-1).text.includes('/sms-shortener/privacy'), 'email repeats the agreement');
      const resp = await call(lastLink());
      assert(resp.status === 302, `Expected 302, got ${resp.status}`);
      const q = query(resp);
      assert(resp.headers.get('Location').startsWith('https://jethro.example/admin?view=config&'), 'returns to the app');
      assert(q.get('sh_apikey').startsWith('cus_') && q.get('sh_email') === 'admin@example.com', 'key and email');
      assert(q.get('sh_consented') === 'sms-shortener' && !q.has('sh_replaced'), q.toString());
      smsKey = q.get('sh_apikey');
      const data = await validate(smsKey);
      assert(data.createdByCampaign === 'Example Church', 'campaign');
      const s = data.services['sms-shortener'];
      assert(s.consented && s.current && s.by === 'admin@example.com', JSON.stringify(s));
      assert(!data.services['url-shortener'].consented, 'only the agreed service');
      assert((await call('/api/authorize?service=sms-shortener', { token: smsKey })).status === 200, 'authorized');
    });

    await test('a magic link works once', async () => {
      await call('/signup', { method: 'POST', form: { email: 'once@example.com' } });
      const link = lastLink();
      assert((await call(link)).status === 200, 'first use shows the key');
      assert((await call(link)).status === 410, 'second use');
    });

    await test('plain re-signup replaces the key, keeps its consents, and adds no sh_consented', async () => {
      await call('/signup', { method: 'POST', form: { email: 'admin@example.com', redirect: RETURN } });
      const resp = await call(lastLink());
      const q = query(resp);
      assert(q.get('sh_replaced') === '1' && !q.has('sh_consented'), q.toString());
      assert((await call('/api/validate', { token: smsKey })).status === 401, 'old key revoked');
      smsKey = q.get('sh_apikey');
      assert((await validate(smsKey)).services['sms-shortener'].consented, 'consent carried over');
    });

    let ghKey;
    await test('OAuth signup carries the service and agreement through the state cookie', async () => {
      const resp = await githubSignIn(`/auth/github/login?service=url-shortener&agree=1&campaign=Example%20Church&redirect=${encodeURIComponent(RETURN)}`);
      assert(resp.status === 302, `Expected 302, got ${resp.status}`);
      const q = query(resp);
      assert(q.get('sh_consented') === 'url-shortener' && q.get('sh_email') === 'gh-user@example.com', q.toString());
      assert(resp.headers.get('Set-Cookie').includes('Max-Age=0'), 'state cookie cleared');
      ghKey = q.get('sh_apikey');
      const s = (await validate(ghKey)).services['url-shortener'];
      assert(s.current && s.by === 'gh-user@example.com', JSON.stringify(s));
    });

    /** Start consent to `service` for `token`'s key; returns the ticket query, '?ticket=…'. */
    const newTicket = async (token, service, redirect) => {
      const resp = await call('/api/consents', { method: 'POST', token, json: { service, ...(redirect ? { redirect } : {}) } });
      assert(resp.status === 201, `POST /api/consents: expected 201, got ${resp.status}`);
      return new URL((await resp.json()).consentUrl).search;
    };

    let ticket;
    await test('consent page names the service and organisation and requires agreement', async () => {
      ticket = await newTicket(ghKey, 'sms-shortener', RETURN);
      const resp = await call(`/consent${ticket}`);
      assert(resp.status === 200, `Expected 200, got ${resp.status}`);
      const html = await resp.text();
      assert(html.includes(SERVICES['sms-shortener'].name) && html.includes(smsAck), 'service and acknowledgement');
      assert(html.includes(`${ORIGIN}/sms-shortener/privacy`), 'privacy link');
      assert(html.includes('registered to <strong>Example Church</strong>'), 'organisation');
      assert(html.includes('name="agree" value="1" required') && html.includes('on behalf of Example Church'), 'agree box');
      assert(html.includes('Sign in with GitHub') && html.includes('name="email"'), 'sign-in options');
    });

    await test('a consent sign-in without agree is refused by the server (email and OAuth)', async () => {
      const id = new URLSearchParams(ticket).get('ticket');
      assert((await call('/consent', { method: 'POST', form: { ticket: id, email: 'staff@example.com' } })).status === 400, 'email');
      assert((await call(`/auth/github/login${ticket}`)).status === 400, 'OAuth');
    });

    let secondLink;
    await test('email consent records who agreed and redirects with sh_consented', async () => {
      const form = { ticket: new URLSearchParams(ticket).get('ticket'), email: 'staff@example.com', agree: '1' };
      assert((await call('/consent', { method: 'POST', form })).status === 200, 'first email');
      const firstLink = lastLink();
      assert(emails.at(-1).subject.startsWith('Confirm') && emails.at(-1).text.includes(smsAck), 'email says what is agreed');
      assert((await call('/consent', { method: 'POST', form })).status === 200, 'second email');
      secondLink = lastLink();
      const resp = await call(firstLink);
      assert(resp.status === 302, `Expected 302, got ${resp.status}`);
      assert(resp.headers.get('Location').startsWith(`${RETURN}&`), 'returns to the ticket redirect');
      const q = query(resp);
      assert(q.get('sh_consented') === 'sms-shortener' && !q.has('sh_apikey'), q.toString());
      const data = await validate(ghKey);
      assert(data.services['sms-shortener'].current && data.services['sms-shortener'].by === 'staff@example.com', 'consent by the signer');
      assert(data.services['url-shortener'].by === 'gh-user@example.com', 'other consent unchanged');
    });

    await test('a consent ticket is single use', async () => {
      assert((await call(secondLink)).status === 410, 'another magic link for the used ticket');
      assert((await call(`/consent${ticket}`)).status === 410, 'consent page');
      assert((await call(`/auth/github/login${ticket}&agree=1`)).status === 410, 'OAuth login');
    });

    await test('OAuth consent without a redirect shows a confirmation page', async () => {
      const t = await newTicket(smsKey, 'url-shortener');
      const resp = await githubSignIn(`/auth/github/login${t}&agree=1`);
      assert(resp.status === 200, `Expected 200, got ${resp.status}`);
      assert((await resp.text()).includes('is now'), 'confirmation');
      assert((await validate(smsKey)).services['url-shortener'].by === 'gh-user@example.com', 'consent recorded');
    });

    await test('a consent ticket for a revoked key → 410', async () => {
      const t = await newTicket(smsKey, 'sms-shortener');
      assert((await call('/api/keys/mine', { method: 'DELETE', token: smsKey })).status === 200, 'deregistered');
      assert((await call(`/consent${t}`)).status === 410, 'consent page');
    });

    await test('POST /api/consents with the bootstrap key → 400', async () => {
      const resp = await call('/api/consents', { method: 'POST', token: env.API_KEY, json: { service: 'sms-shortener' } });
      assert(resp.status === 400, `Expected 400, got ${resp.status}`);
    });
  } finally {
    globalThis.fetch = realFetch;
  }
}

async function main() {
  await runFlowTests();
  await runTests();
  console.log(`\n${'─'.repeat(40)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Test runner error:', err);
  process.exit(1);
});
