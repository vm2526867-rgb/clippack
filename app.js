// Google File API par video upload karne ka frontend logic
async function processVideoWithGemini(videoFile, userPrompt = "") {
  try {
    // Step 1: Upload session initiate karein
    const initResponse = await fetch(
      `https://generativelanguage.googleapis.com/upload/v1beta/files?key=${GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: {
          "X-Goog-Upload-Protocol": "resumable",
          "X-Goog-Upload-Command": "start",
          "X-Goog-Upload-Header-Content-Length": videoFile.size,
          "X-Goog-Upload-Header-Content-Type": videoFile.type || "video/mp4",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          file: { display_name: videoFile.name || "user_video.mp4" },
        }),
      }
    );

    const uploadUrl = initResponse.headers.get("X-Goog-Upload-URL");

    // Step 2: Direct Video upload karein
    const uploadResponse = await fetch(uploadUrl, {
      method: "POST",
      headers: {
        "Content-Length": videoFile.size,
        "X-Goog-Upload-Offset": "0",
        "X-Goog-Upload-Command": "upload, finalize",
      },
      body: videoFile,
    });

    const fileData = await uploadResponse.json();
    const fileUri = fileData.file.uri;

    // Step 3: File processing completed hone tak wait karein
    let fileStatus = fileData.file.state;
    let fileInfo = fileData;

    while (fileStatus === "PROCESSING") {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      const statusRes = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/${fileData.file.name}?key=${GEMINI_API_KEY}`
      );
      fileInfo = await statusRes.json();
      fileStatus = fileInfo.state;
    }

    if (fileStatus !== "ACTIVE") {
      throw new Error("Video processing failed on Google servers.");
    }

    // Step 4: Final backend function ko call karein
    const generateRes = await fetch("/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fileUri: fileUri,
        mimeType: videoFile.type || "video/mp4",
        prompt: userPrompt,
      }),
    });

    const finalResult = await generateRes.json();
    return finalResult.result;
  } catch (err) {
    console.error("Error processing video:", err);
    alert("Video processing failed. Check console for details.");
  }
}
