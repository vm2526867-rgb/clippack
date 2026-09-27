// ClipPack backend (Cloudflare Pages Function)
// Lives at: functions/api/generate.js -> URL: /api/generate

const DEFAULT_MODEL = "gemini-2.5-flash";

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

export async function onRequestPost({ request, env }) {
  const key = env.GEMINI_API_KEY;
  if (!key) return json({ error: "not_configured" }, 500);

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ error: "bad_request" }, 400);
  }

  const { audioData, images = [], prompt = "" } = body;

  const parts = [];

  // 1. System Prompt (Deep Analysis Instructions)
  const systemPrompt = 
    "You are an expert YouTube SEO and viral content strategist. " +
    "Carefully listen to the audio track and analyze the sequence of video frames provided. " +
    "Understand the exact speech, tone, topic, and context of the video. " +
    "Generate highly accurate YouTube Metadata in STRICT JSON format:\n" +
    "{\n" +
    "  \"title\": \"Viral & engaging title based on exact video topic\",\n" +
    "  \"description\": \"Detailed SEO description explaining what was spoken in the video\",\n" +
    "  \"tags\": [\"tag1\", \"tag2\", \"tag3\"],\n" +
    "  \"hashtags\": [\"#tag1\", \"#tag2\"],\n" +
    "  \"thumbnail_prompt\": \"Visual concept idea for thumbnail\"\n" +
    "}";

  parts.push({ text: systemPrompt });

  if (prompt) {
    parts.push({ text: "User Context / Note: " + prompt });
  }

  // 2. Audio Part Attach Karein (Agar Frontend Se Aaya Hai)
  if (audioData) {
    parts.push({
      inline_data: {
        mime_type: "audio/wav",
        data: audioData
      }
    });
  }

  // 3. Frame Images Attach Karein
  for (const im of images) {
    if (im && im.data) {
      parts.push({ inline_data: { mime_type: im.mime || "image/jpeg", data: im.data } });
    }
  }

  const model = (env.GEMINI_MODEL || DEFAULT_MODEL).trim();
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

  try {
    const r = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": key,
      },
      body: JSON.stringify({
        contents: [{ role: "user", parts: parts }],
        generationConfig: {
          temperature: 0.7,
          responseMimeType: "application/json",
        },
      }),
    });

    if (!r.ok) {
      const errText = await r.text();
      return json({ error: "upstream_error", status: r.status, details: errText }, 502);
    }

    const data = await r.json();
    const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    const result = JSON.parse(rawText);

    return json({ result });
  } catch (e) {
    return json({ error: "server_error", message: e.message }, 500);
  }
}
