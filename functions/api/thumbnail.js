// ClipPack backend (Cloudflare Pages Function)
// Lives at: functions/api/thumbnail.js   ->   URL: /api/thumbnail
//
// Needs a Workers AI binding named AI. Add it in Cloudflare:
// Settings > Bindings > Add > Workers AI, and name it exactly "AI".
// This is free (10,000 neurons/day) and needs no API key.

const MAX_THUMB_PROMPT = 300;

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

export async function onRequestPost({ request, env }) {
  if (!sameOrigin(request)) return json({ error: "forbidden" }, 403);
  if (!env.AI) return json({ error: "ai_not_configured" }, 500);

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ error: "bad_request" }, 400);
  }

  const note = body && typeof body.prompt === "string" ? body.prompt.trim().slice(0, MAX_THUMB_PROMPT) : "";
  if (note.length < 3) return json({ error: "bad_request" }, 400);

  const prompt = (
    "Vertical smartphone video thumbnail photo, vibrant colors, sharp focus, high detail, no text, no watermark, no logos. Scene: " +
    note
  ).slice(0, 2048);

  let result;
  try {
    result = await env.AI.run("@cf/black-forest-labs/flux-1-schnell", {
      prompt: prompt,
      steps: 4,
    });
  } catch (e) {
    console.error("Workers AI error", e && e.message);
    return json({ error: "upstream" }, 502);
  }

  if (!result || typeof result.image !== "string" || !result.image) {
    return json({ error: "invalid_json" }, 502);
  }
  return json({ image: result.image });
}
