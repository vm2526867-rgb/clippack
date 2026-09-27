// ClipPack backend - V2 video-grounded AI analysis
// functions/api/generate.js -> /api/generate

const DEFAULT_MODEL = "gemini-3.1-flash-lite";

const MAX_PROMPT = 8000;
const MAX_IMAGES = 12;
const MAX_IMAGE_B64 = 1200000;
const ALLOWED_MIME = ["image/jpeg", "image/png", "image/webp"];
const MAX_TREND_TEXT = 1800;

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

  t = t
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/i, "")
    .trim();

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
  return cand &&
    cand.content &&
    Array.isArray(cand.content.parts)
    ? cand.content.parts
        .filter(
          (p) =>
            p &&
            typeof p.text === "string" &&
            p.thought !== true
        )
        .map((p) => p.text)
        .join("")
    : "";
}

async function callGemini(model, key, parts, extra) {
  const url =
    "https://generativelanguage.googleapis.com/v1beta/models/" +
    model +
    ":generateContent";

  const body = {
    contents: [
      {
        role: "user",
        parts: parts,
      },
    ],
  };

  if (extra && extra.tools) {
    body.tools = extra.tools;
  }

  body.generationConfig = Object.assign(
    {
      temperature: 0.7,
    },
    (extra && extra.generationConfig) || {}
  );

  let r;

  try {
    r = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": key,
      },
      body: JSON.stringify(body),
    });
  } catch (e) {
    throw { code: "upstream" };
  }

  if (r.status === 429) {
    throw { code: "rate_limited" };
  }

  if (
    r.status === 400 ||
    r.status === 401 ||
    r.status === 403 ||
    r.status === 404
  ) {
    let detail = "";

    try {
      detail = (await r.text()).slice(0, 500);
    } catch (e) {}

    console.error(
      "Gemini config error",
      r.status,
      detail
    );

    throw {
      code: "upstream_config",
      status: r.status,
    };
  }

  if (!r.ok) {
    console.error(
      "Gemini upstream error",
      r.status
    );

    throw {
      code: "upstream",
      status: r.status,
    };
  }

  let data = null;

  try {
    data = await r.json();
  } catch (e) {}

  if (
    data &&
    data.promptFeedback &&
    data.promptFeedback.blockReason
  ) {
    throw { code: "refused" };
  }

  const cand =
    data &&
    data.candidates &&
    data.candidates[0];

  const text = textFromCandidate(cand);

  if (!text) {
    throw {
      code:
        cand &&
        cand.finishReason === "SAFETY"
          ? "refused"
          : "invalid_json",
    };
  }

  return {
    text: text,
    cand: cand,
  };
}

export async function onRequestGet({ env }) {
  return json({
    ok: true,
    service: "clippack",
    keyConfigured: !!env.GEMINI_API_KEY,
    model: (env.GEMINI_MODEL || DEFAULT_MODEL).trim(),
    aiThumbnailConfigured: !!env.AI,
    trendSearchEnabled: true,
    maxFrames: MAX_IMAGES,
  });
}

export async function onRequestPost({ request, env }) {
  if (!sameOrigin(request)) {
    return json(
      { error: "forbidden" },
      403
    );
  }

  const key = env.GEMINI_API_KEY;

  if (!key) {
    return json(
      { error: "not_configured" },
      500
    );
  }

  let body;

  try {
    body = await request.json();
  } catch (e) {
    return json(
      { error: "bad_request" },
      400
    );
  }

  const prompt =
    body &&
    typeof body.prompt === "string"
      ? body.prompt.slice(0, MAX_PROMPT)
      : "";

  if (prompt.trim().length < 20) {
    return json(
      { error: "bad_request" },
      400
    );
  }

  const imgs =
    body &&
    Array.isArray(body.images)
      ? body.images.slice(0, MAX_IMAGES)
      : [];

  const imageParts = [];

  for (const im of imgs) {
    if (
      !im ||
      typeof im.data !== "string" ||
      im.data.length > MAX_IMAGE_B64 ||
      ALLOWED_MIME.indexOf(im.mime) < 0
    ) {
      return json(
        { error: "bad_image" },
        400
      );
    }

    imageParts.push({
      inline_data: {
        mime_type: im.mime,
        data: im.data,
      },
    });
  }

  const model =
    (env.GEMINI_MODEL || DEFAULT_MODEL).trim();

  if (!/^[A-Za-z0-9._-]+$/.test(model)) {
    return json(
      { error: "not_configured" },
      500
    );
  }

  /*
   * PASS 1
   *
   * First understand the ACTUAL video.
   * Do not generate titles yet.
   */
  let analysisText = "";

  try {
    const analysisPrompt = `
You are ClipPack's video understanding engine.

IMPORTANT:
The attached images are sequential frames from ONE VIDEO.
Treat them as a timeline, not as unrelated pictures.

Analyze ONLY what can reasonably be seen in the frames and the creator note.

Your job is to identify the actual content of the video.

Return plain text with these sections:

VIDEO_TOPIC:
MAIN_SUBJECT:
MAIN_ACTION:
START:
MIDDLE:
END:
IMPORTANT_MOMENT:
VISIBLE_TEXT:
VIDEO_TYPE:
AUDIENCE:
CONTENT_CONFIDENCE:

Rules:
- Do NOT invent people, objects, locations, events or dialogue.
- If something cannot be determined, write "unknown".
- Follow the sequence from early frames to later frames.
- Pay special attention to changes between frames.
- Read visible on-screen text when possible.
- Do not call something "viral" unless there is evidence from the separate trend search.
- The creator note is context only; visible video evidence has priority.

Creator note:
"${prompt.slice(0, 800)}"
`;

    const analysisParts = [
      { text: analysisPrompt },
    ].concat(imageParts);

    const pass1 = await callGemini(
      model,
      key,
      analysisParts,
      {
        tools: [{ google_search: {} }],
        generationConfig: {
          temperature: 0.4,
        },
      }
    );

    analysisText = pass1.text.slice(
      0,
      7000
    );
  } catch (e) {
    console.error(
      "Video analysis failed:",
      e && e.code
    );

    /*
     * Do not fail the complete request if search/
     * analysis has a temporary problem.
     */
    analysisText = "";
  }

  /*
   * PASS 2
   *
   * Generate metadata ONLY after understanding
   * the actual video.
   */
  const finalPrompt = `
You are ClipPack's final content optimization engine.

The user wants REAL metadata based on the ACTUAL VIDEO.

First use the attached video frames.
Then use the VIDEO ANALYSIS below.
The video analysis is evidence about the sequence of the video.

Do NOT create generic titles.
Do NOT describe something that is not visible.
Do NOT invent an event just because it sounds clickable.

If the frames and analysis do not prove a claim, do not make that claim.

VIDEO ANALYSIS:
"""
${analysisText || "No separate analysis available. Carefully inspect the frames yourself."}
"""

CREATOR REQUEST:
"""
${prompt}
"""

Create metadata that accurately represents the video.

Requirements:

1. titles:
- exactly 3
- highly relevant to the actual video
- natural Hindi/Hinglish/English according to requested language
- interesting but NOT misleading

2. description:
- 2 to 5 useful lines
- describe the actual video
- naturally include relevant keywords

3. hashtags:
- 8 to 12
- directly related to the actual subject
- do not add random generic hashtags just for popularity

4. tags:
- 10 to 15
- search keywords directly related to the video

5. thumbnail_text:
- short
- based on the actual key moment

6. thumbnail_emoji:
- one suitable emoji if useful

7. best_frame:
- number from 1 to ${Math.max(
    1,
    imageParts.length
  )}
- choose the frame that best represents the actual video

8. best_time:
- give a reasonable posting window
- do not claim it guarantees views

9. comment_replies:
- exactly 3
- natural replies relevant to the video

10. summary:
- one short sentence explaining what the video actually contains

11. topic:
- actual topic/category of the video

12. content_confidence:
- number from 0 to 100
- confidence that the generated metadata accurately represents the visible video

13. improvements:
- exactly 3 practical improvements based on the actual video

14. hooks:
- exactly 5 short opening-hook ideas relevant to the actual video

15. risk:
Return:
{
  "level": "low" | "medium" | "high",
  "reason": "..."
}
Only mention visible/obvious potential reused-content or copyright concerns.
Do not make legal conclusions.

Return ONLY valid JSON using exactly this structure:

{
  "summary": "",
  "topic": "",
  "content_confidence": 0,
  "titles": ["", "", ""],
  "description": "",
  "hashtags": ["#"],
  "tags": [""],
  "thumbnail_text": "",
  "thumbnail_emoji": "",
  "best_frame": 1,
  "best_time": "",
  "comment_replies": ["", "", ""],
  "hooks": ["", "", "", "", ""],
  "improvements": ["", "", ""],
  "risk": {
    "level": "low",
    "reason": ""
  }
}
`;

  const finalParts = [
    {
      text: finalPrompt,
    },
  ].concat(imageParts);

  let pass2;

  try {
    pass2 = await callGemini(
      model,
      key,
      finalParts,
      {
        generationConfig: {
          temperature: 0.65,
          responseMimeType:
            "application/json",
        },
      }
    );
  } catch (e) {
    if (
      e &&
      e.code === "upstream_config"
    ) {
      return json(
        {
          error: "upstream_config",
          status: e.status,
        },
        502
      );
    }

    if (
      e &&
      e.code === "upstream"
    ) {
      return json(
        {
          error: "upstream",
          status: e.status,
        },
        502
      );
    }

    return json(
      {
        error:
          (e && e.code) ||
          "upstream",
      },
      e &&
        e.code === "rate_limited"
        ? 429
        : 502
    );
  }

  const parsed =
    parseModelJson(pass2.text);

  if (
    !parsed ||
    typeof parsed !== "object"
  ) {
    console.error(
      "Gemini returned invalid JSON:",
      pass2.text.slice(0, 1000)
    );

    return json(
      { error: "invalid_json" },
      502
    );
  }

  parsed._video_analyzed =
    !!analysisText;

  parsed._frames_analyzed =
    imageParts.length;

  return json({
    result: parsed,
  });
}
