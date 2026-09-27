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

  const { fileUri, mimeType = "video/mp4", prompt = "" } = body;

  if (!fileUri) {
    return json({ error: "missing_file_uri", message: "fileUri is required" }, 400);
  }

  const model = (env.GEMINI_MODEL || DEFAULT_MODEL).trim();
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

  const payload = {
    contents: [
      {
        role: "user",
        parts: [
          {
            file_data: {
              mime_type: mimeType,
              file_uri: fileUri,
            },
          },
          {
            text:
              "Watch and listen to this entire video carefully. Analyze the spoken audio/speech, visual content, tone, and context in detail.\n" +
              `User Notes: "${prompt}"\n\n` +
              "Generate highly accurate, viral YouTube Metadata in STRICT JSON format:\n" +
              "{\n" +
              '  "title": "Exact catchy title matching video context",\n' +
              '  "description": "Detailed multi-paragraph SEO description explaining everything spoken and shown in the video",\n' +
              '  "tags": ["tag1", "tag2", "tag3"],\n' +
              '  "hashtags": ["#hashtag1", "#hashtag2"],\n' +
              '  "thumbnail_prompt": "Creative visual prompt for thumbnail based on key video scenes"\n' +
              "}",
          },
        ],
      },
    ],
    generationConfig: {
      responseMimeType: "application/json",
      temperature: 0.7,
    },
  };

  try {
    const r = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": key,
      },
      body: JSON.stringify(payload),
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
