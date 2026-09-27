// ClipPack backend (Cloudflare Pages Function)
// Lives at: functions/api/generate.js -> URL: /api/generate

const DEFAULT_MODEL = "gemini-2.5-flash";
const MAX_PROMPT = 8000;
const MAX_IMAGES = 6;
const MAX_IMAGE_B64 = 1500000;
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

export async function onRequestGet({ env }) {
  return json({
    ok: true,
    service: "clippack",
    keyConfigured: !!env.GEMINI_API_KEY,
    model: (env.GEMINI_MODEL || DEFAULT_MODEL).trim(),
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
  const imgs = body && Array.isArray(body.images) ? body.images.slice(0, MAX_IMAGES) : [];
  
  const parts = [];
  
  // Custom Detailed Instructions for Gemini
  const systemInstruction = 
    "You are a professional YouTube SEO & Viral Content Creator. " +
    "Analyze the provided image frames carefully. Treat them as a continuous video sequence. " +
    "Extract exact visual details, context, and intent to write highly accurate YouTube Metadata.\n\n" +
    "Return STRICT JSON only in this exact format:\n" +
    "{\n" +
    "  \"title\": \"Catchy Viral Title\",\n" +
    "  \"description\": \"Detailed SEO Description based on video content\",\n" +
    "  \"tags\": [\"tag1\", \"tag2\", \"tag3\"],\n" +
    "  \"hashtags\": [\"#tag1\", \"#tag2\"],\n" +
    "  \"thumbnail_prompt\": \"Detailed description for thumbnail image generation\"\n" +
    "}";

  parts.push({ text: systemInstruction });
  if (prompt) {
    parts.push({ text: "User Context / Video Note: " + prompt });
  }

  for (const im of imgs) {
    if (
      im &&
      typeof im.data === "string" &&
      im.data.length <= MAX_IMAGE_B64 &&
      ALLOWED_MIME.indexOf(im.mime) >= 0
    ) {
      parts.push({ inline_data: { mime_type: im.mime, data: im.data } });
    }
  }

  const model = (env.GEMINI_MODEL || DEFAULT_MODEL).trim();
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { 
        "Content-Type": "application/json", 
        "x-goog-api-key": key 
      },
      body: JSON.stringify({
        contents: [{ role: "user", parts: parts }],
        generationConfig: { 
          temperature: 0.7,
          responseMimeType: "application/json"
        }
      }),
    });

    if (!r.ok) {
      const errText = await r.text();
      console.error("Gemini Error:", r.status, errText);
      return json({ error: "upstream_error", status: r.status, details: errText }, 502);
    }

    const data = await r.json();
    const cand = data && data.candidates && data.candidates[0];
    const text = cand && cand.content && cand.content.parts && cand.content.parts[0] ? cand.content.parts[0].text : "";
    
    const parsed = parseModelJson(text);
    if (!parsed) return json({ error: "invalid_json", raw: text }, 502);

    return json({ result: parsed });
  } catch (e) {
    return json({ error: "server_error", message: e.message }, 500);
  }
    }
