import "dotenv/config";
import express from "express";
import { createDecartClient, models } from "@decartai/sdk";

const app = express();
app.use(express.json());

const client = createDecartClient({
  apiKey: process.env.DECART_API_KEY!,
});

function parseBase64DataUrl(dataUrl: unknown, mediaType: "image" | "video"): Blob {
  if (typeof dataUrl !== "string") {
    throw new Error(`${mediaType}DataUrl must be a base64 data URL string`);
  }

  const match = /^data:([^;]+);base64,(.+)$/.exec(dataUrl);
  if (!match) {
    throw new Error(`${mediaType}DataUrl must be a valid base64 data URL`);
  }

  const [, mimeType, base64] = match;
  if (!mimeType.startsWith(`${mediaType}/`)) {
    throw new Error(`${mediaType}DataUrl must contain a ${mediaType} MIME type`);
  }

  return new Blob([Buffer.from(base64, "base64")], { type: mimeType });
}

// Edit image (sync - returns immediately)
app.post("/api/image/edit", async (req, res) => {
  try {
    const { prompt, imageDataUrl } = req.body;

    if (!prompt || !imageDataUrl) {
      return res.status(400).json({ error: "prompt and imageDataUrl are required" });
    }

    const blob = await client.process({
      model: models.image("lucy-pro-i2i"),
      prompt,
      data: parseBase64DataUrl(imageDataUrl, "image"),
    });

    const buffer = Buffer.from(await blob.arrayBuffer());
    res.setHeader("Content-Type", "image/png");
    res.send(buffer);
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

// Submit video editing job (async - returns job ID)
app.post("/api/video/generate", async (req, res) => {
  try {
    const { prompt, videoDataUrl } = req.body;

    if (!prompt || !videoDataUrl) {
      return res.status(400).json({ error: "prompt and videoDataUrl are required" });
    }

    const job = await client.queue.submit({
      model: models.video("lucy-pro-v2v"),
      prompt,
      data: parseBase64DataUrl(videoDataUrl, "video"),
    });

    res.json({ jobId: job.job_id, status: job.status });
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

// Check video job status
app.get("/api/video/status/:jobId", async (req, res) => {
  try {
    const status = await client.queue.status(req.params.jobId);
    res.json(status);
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

// Get video result (when completed)
app.get("/api/video/result/:jobId", async (req, res) => {
  try {
    const blob = await client.queue.result(req.params.jobId);
    const buffer = Buffer.from(await blob.arrayBuffer());
    res.setHeader("Content-Type", "video/mp4");
    res.send(buffer);
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

// Generate video with automatic polling (convenience endpoint)
app.post("/api/video/generate-sync", async (req, res) => {
  try {
    const { prompt, videoDataUrl } = req.body;

    if (!prompt || !videoDataUrl) {
      return res.status(400).json({ error: "prompt and videoDataUrl are required" });
    }

    const result = await client.queue.submitAndPoll({
      model: models.video("lucy-pro-v2v"),
      prompt,
      data: parseBase64DataUrl(videoDataUrl, "video"),
    });

    if (result.status === "completed") {
      const buffer = Buffer.from(await result.data.arrayBuffer());
      res.setHeader("Content-Type", "video/mp4");
      res.send(buffer);
    } else {
      res.status(500).json({ error: result.error });
    }
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
  console.log("");
  console.log("Available endpoints:");
  console.log("  POST /api/image/edit           - Edit image from base64 data URL + prompt");
  console.log("  POST /api/video/generate      - Submit video edit job from base64 data URL + prompt");
  console.log("  GET  /api/video/status/:id    - Check job status");
  console.log("  GET  /api/video/result/:id    - Get video result");
  console.log("  POST /api/video/generate-sync - Edit video (wait for result)");
});
