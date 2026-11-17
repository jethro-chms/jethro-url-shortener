import { bindings, defineConfig, triggers } from "cf/config";


export default defineConfig({
	worker: {
		name: "url-shortener",
		compatibilityDate: "2026-05-01",
		entrypoint: "worker.js",
		cache: {
			enabled: true,
		},
		triggers: [
			triggers.fetch({
				pattern: "yourdomain.com/s/*",
				zone: "yourdomain.com",
			}),
			triggers.fetch({
				pattern: "yourdomain.com/api/shorten*",
				zone: "yourdomain.com",
			}),
			triggers.fetch({
				pattern: "yourdomain.com/api/validate*",
				zone: "yourdomain.com",
			}),
			triggers.fetch({
				pattern: "yourdomain.com/api/urls*",
				zone: "yourdomain.com",
			}),
			triggers.fetch({
				pattern: "yourdomain.com/api/urls/*",
				zone: "yourdomain.com",
			}),
			triggers.fetch({
				pattern: "yourdomain.com/api/keys*",
				zone: "yourdomain.com",
			}),
			triggers.fetch({
				pattern: "yourdomain.com/api/keys/*",
				zone: "yourdomain.com",
			}),
			triggers.fetch({
				pattern: "yourdomain.com/signup*",
				zone: "yourdomain.com",
			}),
			triggers.fetch({
				pattern: "yourdomain.com/auth/*",
				zone: "yourdomain.com",
			}),
			triggers.fetch({
				pattern: "yourdomain.com/consent*",
				zone: "yourdomain.com",
			}),
			triggers.fetch({
				pattern: "yourdomain.com/api/authorize*",
				zone: "yourdomain.com",
			}),
			triggers.fetch({
				pattern: "yourdomain.com/api/consents*",
				zone: "yourdomain.com",
			}),
			triggers.fetch({
				pattern: "yourdomain.com/url-shortener/*",
				zone: "yourdomain.com",
			}),
			triggers.fetch({
				pattern: "yourdomain.com/",
				zone: "yourdomain.com",
			}),
		],
		env: {
			URL_MAPPINGS: bindings.kv({
				id: "YOUR_KV_NAMESPACE_ID",
			}),
			// Named on the privacy page (/url-shortener/privacy) and the landing page.
			PRIVACY_OPERATOR: bindings.text("Your organisation name"),
			PRIVACY_CONTACT: bindings.text("privacy@yourdomain.com"),
			// Declare secrets here so `cf dev` loads their local values from
			// .dev.vars (see README "Tests"); production values come from
			// `cf workers secrets update`, which this does not override.
			API_KEY: bindings.secret(),
			TURNSTILE_SITE_KEY: bindings.secret(),
			TURNSTILE_SECRET_KEY: bindings.secret(),
		},
	},
});
