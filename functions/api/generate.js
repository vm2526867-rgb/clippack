// ClipPack backend (Cloudflare Pages Function)
// Lives at: functions/api/generate.js   ->   URL: /api/generate
//
// Set these in Cloudflare (Settings > Variables and Secrets):
//   GEMINI_API_KEY   (required, add it as a Secret)
//   GEMINI_MODEL     (optional; a model name from Google AI Studio, default below)

const DEFAULT_MODEL = "gemini-2.5-flash";
const MAX_PROMPT = 8000;
const MAX_IMAGES = 4;
const MAX_IMAGE_B64 = 1200000; // characters of base64 per frame (~0.9 MB)
const ALLOWED_MIME = ["image/jpeg", "image/png", "image/webp"];

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

// Only accept browser requests coming from this same site.
function sameOrigin(request) {
  const origin = request.headers.get("Origin");
  if (!origin) return true;
  try {
    return new URL(origin).host === new URL(request.url).host;
  } catch (e) {
    return false;
  }
}

function parseModelJson(text) {
  if (!text) return null;
  let t = String(text).trim();
  t = t.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  try {
    return JSON.parse(t);
  } catch (e) {}
  const a = t.indexOf("{");
  const b = t.lastIndexOf("}");
  if (a >= 0 && b > a) {
    try {
      return JSON.parse(t.slice(a, b + 1));
    } catch (e) {}
  }
  return null;
}

// Open /api/generate in a browser to check the setup (never shows the key).
export async function onRequestGet({ env }) {
  return json({
    ok: true,
    service: "clippack",
    keyConfigured: !!env.GEMINI_API_KEY,
    model: (env.GEMINI_MODEL || DEFAULT_MODEL).trim(),
    aiThumbnailConfigured: !!env.AI,
  });
}

export async function onRequestPost({ request, env }) {
  if (!sameOrigin(request)) return json({ error: "forbidden" }, 403);

  const key = env.GEMINI_API_KEY;
  if (!key) return json({ error: "not_configured" }, 500);

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ error: "bad_request" }, 400);
  }

  const prompt = body && typeof body.prompt === "string" ? body.prompt.slice(0, MAX_PROMPT) : "";
  if (prompt.trim().length < 20) return json({ error: "bad_request" }, 400);

  const imgs = body && Array.isArray(body.images) ? body.images.slice(0, MAX_IMAGES) : [];
  const parts = [{ text: prompt }];
  for (const im of imgs) {
    if (
      !im ||
      typeof im.data !== "string" ||
      im.data.length > MAX_IMAGE_B64 ||
      ALLOWED_MIME.indexOf(im.mime) < 0
    ) {
      return json({ error: "bad_image" }, 400);
    }
    parts.push({ inline_data: { mime_type: im.mime, data: im.data } });
  }

  const model = (env.GEMINI_MODEL || DEFAULT_MODEL).trim();
  if (!/^[A-Za-z0-9._-]+$/.test(model)) return json({ error: "not_configured" }, 500);
  const url = "https://generativelanguage.googleapis.com/v1beta/models/" + model + ":generateContent";

  let r;
  try {
    r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({
        contents: [{ role: "user", parts: parts }],
        generationConfig: { temperature: 0.8, responseMimeType: "application/json" },
      }),
    });
  } catch (e) {
    return json({ error: "upstream" }, 502);
  }

  if (r.status === 429) return json({ error: "rate_limited" }, 429);
  if (r.status === 400 || r.status === 401 || r.status === 403 || r.status === 404) {
    let detail = "";
    try {
      detail = (await r.text()).slice(0, 300);
    } catch (e) {}
    console.error("Gemini config error", r.status, detail);
    return json({ error: "upstream_config", status: r.status }, 502);
  }
  if (!r.ok) {
    console.error("Gemini upstream error", r.status);
    return json({ error: "upstream", status: r.status }, 502);
  }

  let data = null;
  try {
    data = await r.json();
  } catch (e) {}

  if (data && data.promptFeedback && data.promptFeedback.blockReason) {
    return json({ error: "refused" }, 422);
  }
  const cand = data && data.candidates && data.candidates[0];
  const text =
    cand && cand.content && Array.isArray(cand.content.parts)
      ? cand.content.parts
          .filter((p) => p && typeof p.text === "string" && p.thought !== true)
          .map((p) => p.text)
          .join("")
      : "";
  if (!text) return json({ error: cand && cand.finishReason === "SAFETY" ? "refused" : "invalid_json" }, 502);

  const parsed = parseModelJson(text);
  if (!parsed || typeof parsed !== "object") return json({ error: "invalid_json" }, 502);
  return json({ result: parsed });
      }
