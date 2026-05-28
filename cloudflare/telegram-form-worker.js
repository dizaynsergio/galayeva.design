const RATE_BUCKET = new Map();
const PHONE_BUCKET = new Map();
const DUP_BUCKET = new Map();

export default {
  async fetch(request, env) {
    const corsHeaders = {
      "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN || "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Vary": "Origin",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    if (request.method !== "POST") {
      return json({ ok: false, error: "method_not_allowed" }, 405, corsHeaders);
    }

    try {
      const ip = request.headers.get("CF-Connecting-IP") || "unknown";
      const ua = String(request.headers.get("User-Agent") || "").trim();
      const origin = String(request.headers.get("Origin") || "").trim();
      const referer = String(request.headers.get("Referer") || "").trim();
      const contentType = String(request.headers.get("Content-Type") || "").toLowerCase();
      const contentLength = Number(request.headers.get("Content-Length") || 0);
      const allowedOrigins = parseAllowedOrigins(env.ALLOWED_ORIGINS || env.ALLOWED_ORIGIN || "");
      const allowedHosts = allowedOrigins.map((o) => new URL(o).hostname);

      if (!contentType.includes("application/json")) {
        return json({ ok: false, error: "content_type_not_allowed" }, 415, corsHeaders);
      }
      if (!origin || !referer) {
        return json({ ok: false, error: "missing_origin_or_referer" }, 403, corsHeaders);
      }
      if (!isOriginAllowed(origin, allowedOrigins)) {
        return json({ ok: false, error: "origin_not_allowed" }, 403, corsHeaders);
      }
      if (!isRefererAllowed(referer, allowedOrigins)) {
        return json({ ok: false, error: "referer_not_allowed" }, 403, corsHeaders);
      }
      if (!ua || ua.length < 12) {
        return json({ ok: false, error: "bad_user_agent" }, 403, corsHeaders);
      }
      if (contentLength > 4096) {
        return json({ ok: false, error: "payload_too_large" }, 413, corsHeaders);
      }

      const rl = hitRateLimit(RATE_BUCKET, ip, 2, 10 * 60 * 1000);
      if (!rl.ok) {
        return json({ ok: false, error: "too_many_requests" }, 429, {
          ...corsHeaders,
          "Retry-After": String(rl.retryAfterSec),
        });
      }

      const body = await request.json();
      const name = String(body?.name || "").trim();
      const phone = String(body?.phone || "").trim();
      const message = String(body?.message || "").trim();
      const source = String(body?.source || "site").trim();
      const turnstileToken = String(body?.turnstileToken || "").trim();
      const clientTs = Number(body?.ts || 0);

      if (!name || !phone) {
        return json({ ok: false, error: "missing_fields" }, 400, corsHeaders);
      }

      if (!/^[\p{L}\s'.-]{2,80}$/u.test(name)) {
        return json({ ok: false, error: "invalid_name" }, 400, corsHeaders);
      }

      const digits = phone.replace(/\D/g, "");
      if (!/^\+?[\d\s()-]{8,24}$/.test(phone) || digits.length < 10 || digits.length > 15) {
        return json({ ok: false, error: "invalid_phone" }, 400, corsHeaders);
      }
      if (/(spam|bot|deadboot|autotest|test lead|qa bot)/i.test(name)) {
        return json({ ok: false, error: "blocked_name_pattern" }, 400, corsHeaders);
      }
      if (message.length > 2000) {
        return json({ ok: false, error: "message_too_long" }, 400, corsHeaders);
      }

      if (/(https?:\/\/|www\.|t\.me\/|telegram\.me\/)/i.test([name, phone, message].join(" "))) {
        return json({ ok: false, error: "links_not_allowed" }, 400, corsHeaders);
      }
      if (!clientTs || Math.abs(Date.now() - clientTs) > 10 * 60 * 1000) {
        return json({ ok: false, error: "stale_request" }, 400, corsHeaders);
      }

      if (!env.TURNSTILE_SECRET_KEY || !turnstileToken) {
        return json({ ok: false, error: "captcha_required" }, 400, corsHeaders);
      }
      const captchaOk = await verifyTurnstile(
        env.TURNSTILE_SECRET_KEY,
        turnstileToken,
        ip,
        allowedHosts,
        "contact_form"
      );
      if (!captchaOk) {
        return json({ ok: false, error: "captcha_failed" }, 400, corsHeaders);
      }

      const phoneRl = hitRateLimit(PHONE_BUCKET, digits, 1, 30 * 60 * 1000);
      if (!phoneRl.ok) {
        return json({ ok: false, error: "phone_rate_limited" }, 429, {
          ...corsHeaders,
          "Retry-After": String(phoneRl.retryAfterSec),
        });
      }

      const dedupeKey = `${name.toLowerCase()}|${digits}|${message.toLowerCase()}`;
      const dedupeRl = hitRateLimit(DUP_BUCKET, dedupeKey, 1, 24 * 60 * 60 * 1000);
      if (!dedupeRl.ok) {
        return json({ ok: false, error: "duplicate_submission" }, 429, {
          ...corsHeaders,
          "Retry-After": String(dedupeRl.retryAfterSec),
        });
      }

      if (!env.TG_BOT_TOKEN || !env.TG_CHAT_ID) {
        return json({ ok: false, error: "server_not_configured" }, 500, corsHeaders);
      }

      const text =
        "🎨 <b>Новая заявка с сайта</b>\n\n" +
        "<b>Имя:</b> " + escapeHtml(name) + "\n" +
        "<b>Телефон:</b> " + escapeHtml(phone) +
        (message ? "\n<b>Проект:</b> " + escapeHtml(message) : "") +
        "\n<b>Источник:</b> " + escapeHtml(source);

      const tgResponse = await fetch(
        `https://api.telegram.org/bot${env.TG_BOT_TOKEN}/sendMessage`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: env.TG_CHAT_ID,
            text,
            parse_mode: "HTML",
            disable_web_page_preview: true,
          }),
        }
      );

      const tgPayload = await tgResponse.json().catch(() => ({ ok: false }));
      if (!tgResponse.ok || !tgPayload.ok) {
        return json({ ok: false, error: "telegram_send_failed" }, 502, corsHeaders);
      }

      return json({ ok: true }, 200, corsHeaders);
    } catch {
      return json({ ok: false, error: "bad_request" }, 400, corsHeaders);
    }
  },
};

function json(payload, status, headers) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...headers,
    },
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
}

function hitRateLimit(store, key, limit, windowMs) {
  const now = Date.now();
  const record = store.get(key) || { count: 0, resetAt: now + windowMs };
  if (now > record.resetAt) {
    record.count = 0;
    record.resetAt = now + windowMs;
  }
  record.count += 1;
  store.set(key, record);

  if (store.size > 5000) {
    for (const [k, value] of store.entries()) {
      if (value.resetAt <= now) store.delete(k);
    }
  }

  if (record.count > limit) {
    return { ok: false, retryAfterSec: Math.max(1, Math.ceil((record.resetAt - now) / 1000)) };
  }
  return { ok: true };
}

function parseAllowedOrigins(raw) {
  return String(raw || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => s.replace(/\/+$/, ""));
}

function isOriginAllowed(origin, allowedOrigins) {
  const normalized = origin.replace(/\/+$/, "");
  return allowedOrigins.includes(normalized);
}

function isRefererAllowed(referer, allowedOrigins) {
  return allowedOrigins.some((origin) => referer.startsWith(origin));
}

async function verifyTurnstile(secret, response, remoteip, allowedHosts, expectedAction) {
  const form = new URLSearchParams();
  form.set("secret", secret);
  form.set("response", response);
  if (remoteip && remoteip !== "unknown") form.set("remoteip", remoteip);

  const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
  if (!res.ok) return false;
  const payload = await res.json().catch(() => ({ success: false }));
  if (!payload || !payload.success) return false;

  const tokenHost = String(payload.hostname || "");
  if (allowedHosts.length && !allowedHosts.includes(tokenHost)) return false;

  const tokenAction = String(payload.action || "");
  if (expectedAction && tokenAction !== expectedAction) return false;
  return true;
}
