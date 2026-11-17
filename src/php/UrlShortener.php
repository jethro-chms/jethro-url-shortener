<?php
// SPDX-License-Identifier: Apache-2.0
/**
 * URL Shortener abstraction, and the client for the jethro.au URL shortener.
 *
 * The API key is the installation's jethro.au key (constant JETHROAU_API_KEY),
 * shared with the other jethro.au services. Shortening also needs the
 * organisation's consent to the URL shortener, recorded at jethro.au: given at
 * signup (getSignupUrl() with $service 'url-shortener') or later through
 * POST /api/consents (see PHP_INTEGRATION.md). Without it shorten() throws
 * "URL shortener: API error (consent_required)" (or consent_outdated).
 */

interface UrlShortener
{
    /**
     * @param string|null $campaign defaults to the first 8 chars of the API key
     * @param bool $blockBots visitors must pass a Cloudflare Turnstile bot check before redirecting
     */
    public function shorten(string $url, ?string $campaign = null, bool $blockBots = false): string;
    /** @param string|null $campaign defaults to the first 8 chars of the API key */
    public function previewShorten(string $url, ?string $campaign = null, bool $blockBots = false): string;
    public function fetchRedirect(string $shortUrl): array;
}

class JethroAuUrlShortener implements UrlShortener
{
    public function __construct(
        private string $apiKey,
        private string $endpoint = 'https://jethro.au/api/shorten',
        private string $signupBase = 'https://jethro.au',
    ) {}

    /**
     * Build the URL that starts the self-service signup flow (OAuth or email
     * magic link) for the installation's jethro.au API key.
     *
     * After sign-in, the worker redirects back to $redirectAfter with:
     *   ?sh_apikey=<token>&sh_email=<email>[&sh_replaced=1][&sh_consented=<service>]
     *
     * @param string $redirectAfter Absolute URL on your site to receive the API key
     * @param string $campaign      Optional campaign id to stamp on the key (max 64 chars):
     *                              your organisation's name, shown when agreeing to services
     * @param string $service       Optional jethro.au service id (e.g. 'url-shortener',
     *                              'sms-shortener'): the signup page then asks the signer to
     *                              agree to it on the organisation's behalf, and the key is
     *                              minted with that consent (sh_consented=<service>)
     */
    public function getSignupUrl(string $redirectAfter, string $campaign = '', string $service = ''): string
    {
        $url = $this->signupBase . '/signup?redirect=' . urlencode($redirectAfter);
        if ($campaign !== '') {
            $url .= '&campaign=' . urlencode($campaign);
        }
        if ($service !== '') {
            $url .= '&service=' . urlencode($service);
        }
        return $url;
    }

    /**
     * Check whether the current request is a signup callback returning a key.
     */
    public static function isSignupCallback(): bool
    {
        return isset($_GET['sh_apikey']);
    }

    /**
     * Extract the API-key payload from a signup callback, or null if absent/invalid.
     *
     * @return array{token: string, email: string, replaced: bool, consented: string}|null
     *         consented: the service consented to at signup ('' for none)
     */
    public static function getTokenFromCallback(): ?array
    {
        if (!self::isSignupCallback()) {
            return null;
        }
        $token = $_GET['sh_apikey'] ?? '';
        $email = $_GET['sh_email'] ?? '';
        if ($token === '' || !str_starts_with($token, 'cus_')) {
            return null;
        }
        return [
            'token' => $token,
            'email' => $email !== '' ? $email : 'unknown',
            'replaced' => !empty($_GET['sh_replaced']),
            'consented' => (string)($_GET['sh_consented'] ?? ''),
        ];
    }

    public function shorten(string $url, ?string $campaign = null, bool $blockBots = false): string
    {
        $campaign ??= substr($this->apiKey, 0, 8);
        static $cache = [];
        $key = $url . '|' . $campaign . '|' . (int)$blockBots;
        if (isset($cache[$key])) return $cache[$key];

        $ch = curl_init($this->endpoint);
        curl_setopt_array($ch, [
            CURLOPT_POST => true, CURLOPT_RETURNTRANSFER => true,
            CURLOPT_HTTPHEADER => ["Authorization: Bearer {$this->apiKey}", 'Content-Type: application/json'],
            CURLOPT_POSTFIELDS => json_encode(['url' => $url, 'campaign' => $campaign, 'block_bots' => $blockBots]),
            CURLOPT_TIMEOUT => 5,
        ]);
        $body = curl_exec($ch);
        $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
        $error = curl_error($ch);
        curl_close($ch);
        if ($error) throw new \RuntimeException("URL shortener: network error ($error)");

        $data = json_decode($body, true);
        if ($httpCode !== 200 || !is_array($data) || !isset($data['shortUrl']))
            throw new \RuntimeException("URL shortener: API error (" . ($data['error'] ?? "HTTP $httpCode") . ")");

        $shortUrl = $data['shortUrl'];
        if (!is_string($shortUrl) || $shortUrl === '' || !str_starts_with($shortUrl, 'https://') || preg_match('/[<>"\']/', $shortUrl))
            throw new \RuntimeException("URL shortener: invalid shortUrl returned");

        return $cache[$key] = $shortUrl;
    }

    public function previewShorten(string $url, ?string $campaign = null, bool $blockBots = false): string
    {
        $campaign ??= substr($this->apiKey, 0, 8);
        $code = substr(hash('sha256', $url . '::' . $campaign . ($blockBots ? '::block_bots' : '')), 0, 6);
        return 'https://jethro.au/s/' . $code;
    }

    public function fetchRedirect(string $shortUrl): array
    {
        $ch = curl_init($shortUrl);
        curl_setopt_array($ch, [CURLOPT_RETURNTRANSFER => true, CURLOPT_FOLLOWLOCATION => false, CURLOPT_TIMEOUT => 10]);
        curl_exec($ch);
        $status = curl_getinfo($ch, CURLINFO_HTTP_CODE);
        $location = curl_getinfo($ch, CURLINFO_REDIRECT_URL);
        $error = curl_error($ch);
        curl_close($ch);
        if ($error) throw new \RuntimeException("URL shortener: network error ($error)");
        return ['status' => $status, 'location' => $location];
    }
}

/**
 * The configured URL shortener (memoized), using the installation's jethro.au
 * API key from the JETHROAU_API_KEY constant ('' when undefined).
 *
 * @throws \RuntimeException when URLSHORTENER is blank or unsupported
 */
function getUrlShortener(): UrlShortener
{
    static $shortener = null;
    if ($shortener !== null) return $shortener;
    $config = urlShortenerConfig();
    if (!$config['configured']) {
        throw new \RuntimeException('URLSHORTENER not configured');
    }
    if (!$config['supported']) {
        throw new \RuntimeException("Unsupported URLSHORTENER: {$config['raw']}. Use 'jethroau' or 'https://jethro.au'.");
    }
    return $shortener = new JethroAuUrlShortener(
        apiKey: defined('JETHROAU_API_KEY') ? (string) JETHROAU_API_KEY : '',
        endpoint: $config['base'] . '/api/shorten',
        signupBase: $config['base'],
    );
}

/**
 * Interpret the URLSHORTENER setting — the one definition of what it may be.
 *
 * Both getUrlShortener() (which shortens) and the status panel (which reports
 * whether shortening works) use this, so the panel cannot say "Operational"
 * while every shorten call throws.
 *
 * Accepts 'jethroau' or 'https://jethro.au', case-insensitively and with any
 * trailing slashes. Blank means "not configured": getUrlShortener() then throws.
 *
 * @return array{raw: string, configured: bool, supported: bool, base: string}
 *         raw: the setting as written; configured: not blank; supported: usable;
 *         base: canonical service URL ('' when blank or unsupported)
 */
function urlShortenerConfig(?string $setting = null): array
{
    $raw = trim($setting ?? (defined('URLSHORTENER') ? (string) URLSHORTENER : 'https://jethro.au'));
    $key = rtrim($raw, '/');
    $supported = $key !== ''
        && (strcasecmp($key, 'jethroau') === 0 || strcasecmp($key, 'https://jethro.au') === 0);
    return [
        'raw' => $raw,
        'configured' => $key !== '',
        'supported' => $supported,
        'base' => $supported ? 'https://jethro.au' : '',
    ];
}
