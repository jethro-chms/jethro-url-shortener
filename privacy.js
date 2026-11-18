/**
 * The URL shortener's privacy page, served at GET /url-shortener/privacy
 * (SERVICES['url-shortener'].privacyPath in worker.js).
 *
 * Static apart from the operator and contact address (env.PRIVACY_OPERATOR,
 * env.PRIVACY_CONTACT) and the "last updated" date, which is the service's
 * policyVersion in worker.js: change the text and bump that date together,
 * since consents record the version they agreed to. Every statement here
 * describes worker.js; re-check it when changing what is stored.
 */

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

/** '2026-11-18' → '18 November 2026'. */
function longDate(isoDate) {
  const [y, m, d] = isoDate.split('-').map(Number);
  const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  return `${d} ${months[m - 1]} ${y}`;
}

/**
 * Render the privacy page.
 *
 * @param {{PRIVACY_OPERATOR?: string, PRIVACY_CONTACT?: string}} env
 * @param {string} policyVersion  SERVICES['url-shortener'].policyVersion (YYYY-MM-DD), shown as the last-updated date
 * @returns {string} HTML document
 */
export function privacyPage(env, policyVersion) {
  const operator = escapeHtml(env.PRIVACY_OPERATOR || 'the operator of this service');
  const contact = env.PRIVACY_CONTACT
    ? `<a href="mailto:${escapeHtml(env.PRIVACY_CONTACT)}">${escapeHtml(env.PRIVACY_CONTACT)}</a>`
    : 'the operator';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>jethro.au URL shortener: privacy</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 46em; margin: 2em auto; padding: 0 1em; line-height: 1.5; color: #222; }
  h1 { font-size: 1.6em; } h2 { font-size: 1.2em; margin-top: 1.6em; }
  code { background: #f3f3f3; padding: 0 0.2em; }
  .summary { background: #f5f8fc; border-left: 4px solid #3a6ea5; padding: 0.6em 1em; }
</style>
</head>
<body>
<h1>jethro.au URL shortener: privacy</h1>
<p><em>Last updated ${escapeHtml(longDate(policyVersion))}.</em></p>

<div class="summary">
<p><strong>In short:</strong> when the URL shortener is turned on, Jethro sends web addresses to jethro.au to be
replaced by short links such as <code>https://jethro.au/s/abc123</code>. Each address is stored, with your
organisation's name and who registered your Jethro site (the person who signed in, or your hosting provider), until it
is deleted. Anyone who has a short link can follow it to the address, and short links can be guessed, so don't shorten
addresses that must stay private.</p>
</div>

<h2>Who runs this service</h2>
<p>The URL shortener at jethro.au is operated by ${operator}. Questions, requests and complaints about privacy:
${contact}.</p>
<p>It is optional. It only works once your Jethro site has a jethro.au API key and your organisation has agreed to
the terms on this page. Its source code is public:
<a href="https://github.com/jethro-chms/jethro-url-shortener">github.com/jethro-chms/jethro-url-shortener</a>.</p>

<h2>Two ways to register</h2>
<ul>
  <li><strong>Self-registered.</strong> A Jethro administrator signs in at jethro.au with Google, GitHub or an emailed
    sign-in link, which gives your site its API key. Agreeing to a service is done the same way: someone signs in at
    jethro.au and ticks "I agree" on your organisation's behalf.</li>
  <li><strong>Through a hosting provider.</strong> If a hosting provider runs your Jethro site, it can obtain your
    site's API key from jethro.au for you, using its own provider key; nobody signs in at jethro.au. When your
    site's system administrator, signed in to the Jethro site your provider hosts, ticks "I agree" on your
    organisation's behalf, the provider passes their name and email address to jethro.au and vouches for them.</li>
</ul>

<h2>What is sent</h2>
<p>To shorten an address, Jethro sends over HTTPS:</p>
<ul>
  <li>the web address (URL) to shorten;</li>
  <li>a campaign tag, which Jethro sets to the start of your API key unless told otherwise;</li>
  <li>whether visitors must pass a bot check before being redirected;</li>
  <li>your Jethro site's API key.</li>
</ul>
<p>Nothing else from Jethro is sent: not the SMS message, its recipients, or their details. Personal details are only
sent if they are part of the address itself.</p>

<h2>What is stored</h2>
<p><strong>For each short link:</strong> the address, its campaign tag, when it was created, any notes added to it,
whether it has a bot check, and who created it: for a self-registered key, the sign-in account of the person who
registered (a Google or GitHub account number, or a one-way hash of an email address); for a key issued through a
hosting provider, the provider's key id and your site's tenant id. Your organisation's name as given at registration
is stored with it. If the operator edits or deletes the link, the time of that change is stored too. A separate index,
used so that shortening the same address twice gives the same link, stores the address, campaign tag and short
code.</p>
<p><strong>For your API key:</strong> a one-way hash of the key and its first 8 characters; your organisation's name;
when it was created; and</p>
<ul>
  <li>for a self-registered key, the email address and the Google, GitHub or email account of the person who signed
    in;</li>
  <li>for a key issued through a hosting provider, which provider issued it and the tenant id it uses for your site
    (no sign-in details: nobody signed in).</li>
</ul>
<p><strong>For each jethro.au service your organisation has agreed to:</strong> when, and which version of that
service's privacy page was agreed to, and who agreed:</p>
<ul>
  <li>for a self-registered key, the email address and sign-in account of the person who signed in and ticked
    "I agree";</li>
  <li>for a key issued through a hosting provider, the name and email address of your site's system administrator
    who ticked "I agree", as vouched for by the provider, and which provider vouched for them.</li>
</ul>
<p><strong>Briefly, while signing in:</strong> email sign-in links and consent links last 10 minutes and can be used
once; a cookie protects Google and GitHub sign-in for up to 10 minutes.</p>

<h2>Who can see it</h2>
<ul>
  <li><strong>Anyone with a short link</strong> is redirected to its address. Short codes are 6 characters, few
    enough that someone could try them all, so treat every shortened address as public. Don't shorten addresses that
    contain personal details, passwords or access tokens.</li>
  <li><strong>The operator</strong> can list every short link with who created it, and every API key with its
    owner and agreements, to run the service and answer requests.</li>
  <li><strong>Your hosting provider</strong>, if it issued your key, can list the keys it issued with their
    organisation names and agreements, record or withdraw agreements, and revoke the keys. It cannot list, change or
    delete short links.</li>
  <li><strong>Your Jethro site</strong> can create short links with its key, but cannot list, change or delete
    them.</li>
</ul>

<h2>Following a short link</h2>
<p>When someone follows a short link, this service looks the code up and redirects them. It stores nothing about the
visit: no click counts, IP addresses or cookies. Cloudflare, which serves jethro.au, counts requests for each address
in its analytics, so the operator can see how often a short link was followed.
For links with a bot check, Cloudflare Turnstile checks the visitor, and a <code>bot_pass</code> cookie remembers for
30 minutes that they passed.</p>

<h2>Service providers</h2>
<ul>
  <li><strong>Cloudflare, Inc.</strong> runs this service (Cloudflare Workers), stores its data (Workers KV), and
    handles every request, including visitors' IP addresses and browser details, as described in its
    <a href="https://www.cloudflare.com/privacypolicy/">Privacy Policy</a>. Cloudflare runs a global network, so data
    may be processed and stored outside Australia.</li>
  <li><strong>Resend</strong> delivers email sign-in links, so it receives the email address and the link
    (self-registered keys only).</li>
  <li><strong>Google</strong> or <strong>GitHub</strong>, if you sign in with them, tell this service your account
    number and verified email address (self-registered keys only).</li>
  <li><strong>Your hosting provider</strong>, if it registered your site, sends jethro.au your organisation's name,
    your site's tenant id, and the name and email address of the system administrator who agreed to a service.</li>
</ul>

<h2>How long it is kept, and your choices</h2>
<ul>
  <li>Short links are kept until the operator deletes them; they do not expire. Deleted links can be restored until
    the operator removes them permanently. Ask us to remove a link.</li>
  <li><strong>Withdrawing agreement</strong> for the URL shortener (<code>DELETE /api/consents/url-shortener</code>,
    or by your hosting provider if it issued your key) stops your key creating short links. Existing links keep
    working.</li>
  <li><strong>Deregistering</strong> (<em>Deregister</em> in Jethro, or <code>DELETE /api/keys/mine</code>) deletes
    your API key, its registration details and its record of agreements, and removes who created them (sign-in
    account or provider and tenant id, and organisation name) from every short link created with it. The links
    themselves, with their addresses and campaign tags, keep working. A hosting provider revoking a key it issued has
    the same effect.</li>
  <li>Signing in again, or a hosting provider issuing a new key for your site, replaces your key with a new one; the
    record of agreements carries over to it.</li>
  <li>If the operator revokes a key, its key record and agreements are deleted, but its short links keep who created
    them until deleted.</li>
</ul>

<h2>Changes</h2>
<p>If this page changes, the date at the top changes too, and agreements record the date they were given for. If the
change is material, your organisation will be asked to agree again before the URL shortener works for it.</p>
</body>
</html>`;
}
