// ClipPack account endpoint (Cloudflare Pages Function)
// URL: /api/account
//   GET  -> plan (free/pro), today's usage, and the upgrade link
//   POST -> { license_key } checks a Lemon Squeezy license key

import { getPlan, getUsage, limitsFor, checkoutUrl, licensingEnabled, validateLicense } from "../lib/limits.js";

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

function sameOrigin(request) {
  const origin = request.headers.get("Origin");
  if (!origin) return true;
  try {
    return new URL(origin).host === new URL(request.url).host;
  } catch (e) {
    return false;
  }
}

export async function onRequestGet({ request, env }) {
  if (!sameOrigin(request)) return json({ error: "forbidden" }, 403);
  const plan = await getPlan(env, request);
  const gen = await getUsage(env, plan, "generate");
  const photo = await getUsage(env, plan, "photo");
  return json({
    plan: plan.plan,
    generate: { used: gen.used, limit: gen.limit, left: gen.left },
    photo: { used: photo.used, limit: photo.limit, left: photo.left },
    checkoutUrl: checkoutUrl(env),
    licensingEnabled: licensingEnabled(env),
    freeLimits: limitsFor(env).free,
  });
}

export async function onRequestPost({ request, env }) {
  if (!sameOrigin(request)) return json({ error: "forbidden" }, 403);
  if (!licensingEnabled(env)) return json({ valid: false, error: "licensing_off" }, 200);
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ error: "bad_request" }, 400);
  }
  const key = body && typeof body.license_key === "string" ? body.license_key.trim() : "";
  if (!key) return json({ error: "bad_request" }, 400);
  const v = await validateLicense(env, key);
  return json({ valid: !!v.valid, error: v.valid ? null : v.reason || "invalid" });
}
