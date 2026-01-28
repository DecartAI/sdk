import "dotenv/config";
import { createDecartClient, models } from "@decartai/sdk";
import express from "express";

const app = express();
app.use(express.json());

const client = createDecartClient({
  apiKey: process.env.DECART_API_KEY!,
});

// Generate image from text (sync - returns immediately)
app.post("/api/image/generate", async (req, res) => {
  try {
    const { prompt } = req.body;

    const blob = await client.process({
      model: models.image("lucy-pro-t2i"),
      prompt,
    });

    const buffer = Buffer.from(await blob.arrayBuffer());
    res.setHeader("Content-Type", "image/png");
    res.send(buffer);
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

// Transform image (sync - returns immediately)
app.post("/api/image/transform", async (req, res) => {
  try {
    const { prompt, imageUrl } = req.body;

    const blob = await client.process({
      model: models.image("lucy-pro-i2i"),
      prompt,
      data: imageUrl,
    });

    const buffer = Buffer.from(await blob.arrayBuffer());
    res.setHeader("Content-Type", "image/png");
    res.send(buffer);
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

// Submit video generation job (async - returns job ID)
app.post("/api/video/generate", async (req, res) => {
  try {
    const { prompt } = req.body;

    const job = await client.queue.submit({
      model: models.video("lucy-pro-t2v"),
      prompt,
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
    const { prompt, videoUrl } = req.body;

    const result = await client.queue.submitAndPoll({
      model: videoUrl ? models.video("lucy-pro-v2v") : models.video("lucy-pro-t2v"),
      prompt,
      ...(videoUrl && { data: videoUrl }),
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
  console.log("  POST /api/image/generate      - Generate image from text");
  console.log("  POST /api/image/transform     - Transform image");
  console.log("  POST /api/video/generate      - Submit video job");
  console.log("  GET  /api/video/status/:id    - Check job status");
  console.log("  GET  /api/video/result/:id    - Get video result");
  console.log("  POST /api/video/generate-sync - Generate video (wait for result)");
});
