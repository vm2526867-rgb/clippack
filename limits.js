// Shared helper: daily free limits + optional Pro license check (Lemon Squeezy).
// Used by functions/api/generate.js, thumbnail.js and account.js.
//
// Optional settings in Cloudflare (Settings > Variables and secrets):
//   FREE_DAILY_LIMIT   free AI generations per day per visitor   (default 3)
//   FREE_DAILY_PHOTOS  free AI photos per day per visitor        (default 2)
//   PRO_DAILY_LIMIT    generations per day for a Pro license     (default 150)
//   PRO_DAILY_PHOTOS   AI photos per day for a Pro license       (default 60)
//   CHECKOUT_URL       your Lemon Squeezy checkout link (https://...)
//   LS_STORE_ID        your Lemon Squeezy store id (turns license checking on)
//   LS_PRODUCT_ID      optional: only accept licenses for this product id
// Optional binding for exact counting across all Cloudflare locations:
//   USAGE              a KV namespace. Without it, counting uses the Cache API,
//                      which is per data center (good enough as a soft limit).

const LICENSE_OK_TTL = 600; // seconds a valid license result is remembered
const LICENSE_BAD_TTL = 120; // seconds an invalid result is remembered

function num(v, d) {
  const n = parseInt(v, 10);
  return isFinite(n) && n >= 0 ? n : d;
}

export function limitsFor(env) {
  return {
    free: { generate: num(env.FREE_DAILY_LIMIT, 3), photo: num(env.FREE_DAILY_PHOTOS, 2) },
    pro: { generate: num(env.PRO_DAILY_LIMIT, 150), photo: num(env.PRO_DAILY_PHOTOS, 60) },
  };
}

export function checkoutUrl(env) {
  const u = typeof env.CHECKOUT_URL === "string" ? env.CHECKOUT_URL.trim() : "";
  return /^https:\/\/[^\s]+$/i.test(u) ? u : "";
}

export function licensingEnabled(env) {
  return !!(env.LS_STORE_ID && String(env.LS_STORE_ID).trim());
}

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 32);
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function secondsLeftToday() {
  const now = new Date();
  const end = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return Math.max(60, Math.ceil((end - now.getTime()) / 1000));
}

function cacheReq(key) {
  return new Request("https://clippack-usage.invalid/" + encodeURIComponent(key));
}

async function readJson(env, key) {
  try {
    if (env.USAGE && typeof env.USAGE.get === "function") {
      const v = await env.USAGE.get(key);
      return v ? JSON.parse(v) : null;
    }
    if (typeof caches !== "undefined" && caches.default) {
      const res = await caches.default.match(cacheReq(key));
      if (res) return await res.json();
    }
  } catch (e) {}
  return null;
}

async function writeJson(env, key, value, ttl) {
  const t = Math.max(60, Math.floor(ttl));
  try {
    if (env.USAGE && typeof env.USAGE.put === "function") {
      await env.USAGE.put(key, JSON.stringify(value), { expirationTtl: t });
      return;
    }
    if (typeof caches !== "undefined" && caches.default) {
      await caches.default.put(
        cacheReq(key),
        new Response(JSON.stringify(value), { headers: { "Cache-Control": "public, max-age=" + t } })
      );
    }
  } catch (e) {}
}

// Ask Lemon Squeezy whether a license key is valid for this store/product.
async function validateLicense(env, licenseKey) {
  if (!licensingEnabled(env)) return { valid: false, reason: "licensing_off" };
  const key = String(licenseKey || "").trim();
  if (key.length < 8 || key.length > 200) return { valid: false, reason: "bad_format" };

  const id = await sha256Hex("lic:" + key);
  const cached = await readJson(env, "lic:" + id);
  if (cached && typeof cached.valid === "boolean") return { valid: cached.valid, id: id, reason: cached.reason };

  let result = { valid: false, reason: "invalid" };
  try {
    const r = await fetch("https://api.lemonsqueezy.com/v1/licenses/validate", {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
      body: "license_key=" + encodeURIComponent(key),
    });
    if (r.status === 429) return { valid: false, reason: "busy" }; // do not cache
    const j = await r.json().catch(() => null);
    if (j && j.valid === true && j.meta) {
      const storeOk = String(j.meta.store_id) === String(env.LS_STORE_ID).trim();
      const prod = env.LS_PRODUCT_ID ? String(env.LS_PRODUCT_ID).trim() : "";
      const prodOk = !prod || String(j.meta.product_id) === prod;
      const status = j.license_key && j.license_key.status;
      const liveOk = status === "active" || status === "inactive";
      result = storeOk && prodOk && liveOk ? { valid: true } : { valid: false, reason: "wrong_product" };
    } else if (j && j.license_key && j.license_key.status === "expired") {
      result = { valid: false, reason: "expired" };
    }
  } catch (e) {
    return { valid: false, reason: "busy" }; // network problem: do not cache
  }
  await writeJson(env, "lic:" + id, result, result.valid ? LICENSE_OK_TTL : LICENSE_BAD_TTL);
  return { valid: result.valid, id: id, reason: result.reason };
}

// Work out who is calling: a valid Pro license, or a free visitor identified by a hashed IP.
export async function getPlan(env, request) {
  const lic = request.headers.get("X-License-Key");
  if (lic) {
    const v = await validateLicense(env, lic);
    if (v.valid) return { plan: "pro", id: v.id };
  }
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  return { plan: "free", id: await sha256Hex("ip:" + ip) };
}

function usageKey(plan, kind) {
  return "use:" + today() + ":" + kind + ":" + plan.id;
}

export async function getUsage(env, plan, kind) {
  const limit = limitsFor(env)[plan.plan][kind];
  const rec = await readJson(env, usageKey(plan, kind));
  const used = rec && typeof rec.n === "number" ? rec.n : 0;
  return { plan: plan.plan, used: used, limit: limit, left: Math.max(0, limit - used) };
}

// Read-only check before doing expensive work.
export async function checkQuota(env, plan, kind) {
  const u = await getUsage(env, plan, kind);
  return { ok: u.used < u.limit, usage: u };
}

// Count one use, only after the work succeeded.
export async function commitQuota(env, plan, kind) {
  const u = await getUsage(env, plan, kind);
  const next = u.used + 1;
  await writeJson(env, usageKey(plan, kind), { n: next }, secondsLeftToday());
  return { plan: u.plan, used: next, limit: u.limit, left: Math.max(0, u.limit - next) };
}

export { validateLicense };
