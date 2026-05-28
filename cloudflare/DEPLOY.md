# Secure Telegram Form (Cloudflare Worker)

## 1) Revoke compromised bot token
- In Telegram `@BotFather` run `/revoke`, then create a fresh token with `/token`.

## 2) Prepare Worker
- Install Wrangler:
  - `npm i -g wrangler`
- Login:
  - `wrangler login`
- In `cloudflare/` copy config:
  - `cp wrangler.toml.example wrangler.toml`

## 3) Set secrets (never store token in git)
- `wrangler secret put TG_BOT_TOKEN`
- `wrangler secret put TG_CHAT_ID`
- `wrangler secret put TURNSTILE_SECRET_KEY`

## 4) Deploy
- `cd cloudflare`
- `wrangler deploy`

You will get a URL like:
- `https://galayeva-form-bot.<your-subdomain>.workers.dev`

## 5) Connect website form
- Open `index.html`
- In `<form id="orderForm" ... data-endpoint="...">` replace the placeholder URL with your Worker URL.

## 6) CORS origin
- In `wrangler.toml` set:
  - `ALLOWED_ORIGIN = "https://galayeva.design"`
- For local testing set:
  - `ALLOWED_ORIGIN = "*"`

## 7) Turnstile setup
- In Cloudflare dashboard, create a Turnstile widget for `galayeva.design`.
- Copy:
  - **Site key** (public) -> put into `index.html`:
    - `data-turnstile-sitekey="..."`
    - `data-sitekey="..."`
  - **Secret key** (private) -> set as Worker secret:
    - `TURNSTILE_SECRET_KEY`
