const RATE_BUCKET = new Map();

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
      const origin = request.headers.get("Origin") || "";
      const referer = request.headers.get("Referer") || "";
      const allowedOrigin = String(env.ALLOWED_ORIGIN || "").trim();
      if (allowedOrigin && origin && origin !== allowedOrigin) {
        return json({ ok: false, error: "origin_not_allowed" }, 403, corsHeaders);
      }
      if (allowedOrigin && referer && !referer.startsWith(allowedOrigin)) {
        return json({ ok: false, error: "referer_not_allowed" }, 403, corsHeaders);
      }

      const rl = hitRateLimit(ip, 3, 10 * 60 * 1000);
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

      if (/(https?:\/\/|www\.|t\.me\/|telegram\.me\/)/i.test([name, phone, message].join(" "))) {
        return json({ ok: false, error: "links_not_allowed" }, 400, corsHeaders);
      }

      if (!env.TURNSTILE_SECRET_KEY || !turnstileToken) {
        return json({ ok: false, error: "captcha_required" }, 400, corsHeaders);
      }
      const captchaOk = await verifyTurnstile(env.TURNSTILE_SECRET_KEY, turnstileToken, ip);
      if (!captchaOk) {
        return json({ ok: false, error: "captcha_failed" }, 400, corsHeaders);
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

function hitRateLimit(ip, limit, windowMs) {
  const now = Date.now();
  const record = RATE_BUCKET.get(ip) || { count: 0, resetAt: now + windowMs };
  if (now > record.resetAt) {
    record.count = 0;
    record.resetAt = now + windowMs;
  }
  record.count += 1;
  RATE_BUCKET.set(ip, record);

  if (RATE_BUCKET.size > 5000) {
    for (const [key, value] of RATE_BUCKET.entries()) {
      if (value.resetAt <= now) RATE_BUCKET.delete(key);
    }
  }

  if (record.count > limit) {
    return { ok: false, retryAfterSec: Math.max(1, Math.ceil((record.resetAt - now) / 1000)) };
  }
  return { ok: true };
}

async function verifyTurnstile(secret, response, remoteip) {
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
  return Boolean(payload && payload.success);
}
