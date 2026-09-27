// ClipPack backend (Cloudflare Pages Function)
// Lives at: functions/api/generate.js

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

  const { fileUri, prompt = "" } = body;

  if (!fileUri) {
    return json({ error: "missing_file_uri", message: "Please upload video first via File API" }, 400);
  }

  const model = (env.GEMINI_MODEL || DEFAULT_MODEL).trim();
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

  const payload = {
    contents: [
      {
        role: "user",
        parts: [
          { file_data: { mime_type: "video/mp4", file_uri: fileUri } },
          {
            text: `Analyze this complete video carefully (audio, speech, visual sequence, and context).\n` +
                  `Creator Notes: "${prompt}"\n\n` +
                  `Generate accurate YouTube Metadata in JSON format:\n` +
                  `{\n` +
                  `  "title": "Engaging & Viral YouTube Title",\n` +
                  `  "description": "Detailed multi-paragraph SEO description summarizing the exact video content",\n` +
                  `  "tags": ["tag1", "tag2", "tag3"],\n` +
                  `  "hashtags": ["#hashtag1", "#hashtag2"],\n` +
                  `  "thumbnail_prompt": "Specific visual idea for creating thumbnail"\n` +
                  `}`
          }
        ]
      }
    ],
    generationConfig: { responseMimeType: "application/json", temperature: 0.7 }
  };

  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify(payload),
    });

    const data = await r.json();
    const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    const result = JSON.parse(rawText);

    return json({ result });
  } catch (e) {
    return json({ error: "upstream_error", details: e.message }, 502);
  }
}
