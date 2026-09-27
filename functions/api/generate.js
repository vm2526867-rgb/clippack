// ClipPack backend (Cloudflare Pages Function)
// Lives at: functions/api/generate.js   ->   URL: /api/generate
//
// Set these in Cloudflare (Settings > Variables and Secrets):
//   GEMINI_API_KEY   (required, add it as a Secret)
//   GEMINI_MODEL     (optional; a model name from Google AI Studio, default below)

const DEFAULT_MODEL = "gemini-2.5-flash"; // Audio & Visual analysis ke liye Flash best model hai
const MAX_PROMPT = 8000;
const MAX_IMAGES = 4;
const MAX_IMAGE_B64 = 1200000; // characters of base64 per frame (~0.9 MB)
const ALLOWED_IMAGE_MIME = ["image/jpeg", "image/png", "image/webp"];
const ALLOWED_AUDIO_MIME = ["audio/wav", "audio/mp3", "audio/mpeg", "audio/ogg", "audio/webm"];
const MAX_TREND_TEXT = 900; // characters of trend research kept for the second pass

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

function textFromCandidate(cand) {
  return cand && cand.content && Array.isArray(cand.content.parts)
    ? cand.content.parts
        .filter((p) => p && typeof p.text === "string" && p.thought !== true)
        .map((p) => p.text)
        .join("")
    : "";
}

// One call to the Gemini API. `extra` merges into generationConfig / adds tools.
async function callGemini(model, key, parts, extra) {
  const url = "https://generativelanguage.googleapis.com/v1beta/models/" + model + ":generateContent";
  const body = { contents: [{ role: "user", parts: parts }] };
  if (extra && extra.tools) body.tools = extra.tools;
  body.generationConfig = Object.assign({ temperature: 0.8 }, (extra && extra.generationConfig) || {});

  let r;
  try {
    r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify(body),
    });
  } catch (e) {
    throw { code: "upstream" };
  }

  if (r.status === 429) throw { code: "rate_limited" };
  if (r.status === 400 || r.status === 401 || r.status === 403 || r.status === 404) {
    let detail = "";
    try {
      detail = (await r.text()).slice(0, 300);
    } catch (e) {}
    console.error("Gemini config error", r.status, detail);
    throw { code: "upstream_config", status: r.status };
  }
  if (!r.ok) {
    console.error("Gemini upstream error", r.status);
    throw { code: "upstream", status: r.status };
  }

  let data = null;
  try {
    data = await r.json();
  } catch (e) {}

  if (data && data.promptFeedback && data.promptFeedback.blockReason) throw { code: "refused" };
  const cand = data && data.candidates && data.candidates[0];
  const text = textFromCandidate(cand);
  if (!text) throw { code: cand && cand.finishReason === "SAFETY" ? "refused" : "invalid_json" };
  return { text: text, cand: cand };
}

// Open /api/generate in a browser to check the setup
export async function onRequestGet({ env }) {
  return json({
    ok: true,
    service: "clippack",
    keyConfigured: !!env.GEMINI_API_KEY,
    model: (env.GEMINI_MODEL || DEFAULT_MODEL).trim(),
    aiThumbnailConfigured: !!env.AI,
    trendSearchEnabled: true,
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

  // 1. Audio Data Input (Agur frontend audio bhejta hai)
  const mediaParts = [];
  if (body && body.audio && typeof body.audio.data === "string") {
    const audioMime = body.audio.mime || "audio/wav";
    if (ALLOWED_AUDIO_MIME.includes(audioMime)) {
      mediaParts.push({ inline_data: { mime_type: audioMime, data: body.audio.data } });
    }
  }

  // 2. Visual Image Frames Input
  const imgs = body && Array.isArray(body.images) ? body.images.slice(0, MAX_IMAGES) : [];
  for (const im of imgs) {
    if (
      im &&
      typeof im.data === "string" &&
      im.data.length <= MAX_IMAGE_B64 &&
      ALLOWED_IMAGE_MIME.includes(im.mime)
    ) {
      mediaParts.push({ inline_data: { mime_type: im.mime, data: im.data } });
    }
  }

  // Validation: kam se kam Audio, Image ya text prompt hona chahiye
  if (mediaParts.length === 0 && prompt.trim().length < 10) {
    return json({ error: "bad_request", message: "Provide audio, images, or a detailed prompt" }, 400);
  }

  const model = (env.GEMINI_MODEL || DEFAULT_MODEL).trim();
  if (!/^[A-Za-z0-9._-]+$/.test(model)) return json({ error: "not_configured" }, 500);

  // Pass 1: Google Search Research Pass
  let trendText = "";
  try {
    const researchPrompt =
      "Carefully analyze the attached audio track/speech and video frames. Identify the exact content topic, spoken details, and niche. " +
      "Use Google Search to find real, current trends on YouTube Shorts & Instagram Reels in India for this niche (hashtags, formats, key concepts). " +
      "Reply in 4 to 6 plain text lines with the niche and real trends found. If nothing is found, state it in one line.\n\n" +
      "Creator's note: \"" + prompt.slice(0, 400) + "\"";

    const researchParts = [{ text: researchPrompt }].concat(mediaParts);
    const pass1 = await callGemini(model, key, researchParts, {
      tools: [{ google_search: {} }],
      generationConfig: { temperature: 1.0 },
    });
    trendText = pass1.text.slice(0, MAX_TREND_TEXT);
  } catch (e) {
    console.error("Trend research skipped:", e && e.code);
    trendText = "";
  }

  // Pass 2: Main Metadata Generation Pass
  const instructionPrompt = 
    "You are a YouTube SEO expert. Deeply analyze the spoken audio/speech and visual frames provided. " +
    "Understand the complete context, spoken words, timing, and topic. " +
    (prompt ? "Creator instructions: " + prompt + "\n" : "") +
    (trendText ? "Relevant current search trends:\n\"\"\"\n" + trendText + "\n\"\"\"\n" : "") +
    "Generate highly accurate YouTube Metadata in STRICT JSON format with these exact keys: " +
    "\"title\", \"description\", \"tags\" (array), \"hashtags\" (array), \"thumbnail_prompt\".";

  const finalParts = [{ text: instructionPrompt }].concat(mediaParts);

  let pass2;
  try {
    pass2 = await callGemini(model, key, finalParts, {
      generationConfig: { responseMimeType: "application/json" },
    });
  } catch (e) {
    if (e && e.code === "upstream_config") return json({ error: "upstream_config", status: e.status }, 502);
    if (e && e.code === "upstream") return json({ error: "upstream", status: e.status }, 502);
    return json({ error: (e && e.code) || "upstream" }, e && e.code === "rate_limited" ? 429 : 502);
  }

  const parsed = parseModelJson(pass2.text);
  if (!parsed || typeof parsed !== "object") return json({ error: "invalid_json" }, 502);
  parsed._trend_researched = !!trendText;
  return json({ result: parsed });
      }
