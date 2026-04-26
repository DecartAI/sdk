import { createDecartClient, models } from "@decartai/sdk";
import { Hono } from "hono";

type DecartClient = ReturnType<typeof createDecartClient>;

type Bindings = {
  DECART_API_KEY: string;
};

type Variables = {
  decart: DecartClient;
};

const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();

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

  const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
  return new Blob([bytes], { type: mimeType });
}

// Middleware to create and share the Decart client
app.use("*", async (c, next) => {
  const client = createDecartClient({
    apiKey: c.env.DECART_API_KEY,
  });
  c.set("decart", client);
  await next();
});

// Image editing
app.post("/api/image/generate", async (c) => {
  try {
    const client = c.get("decart");
    const { prompt, imageDataUrl } = await c.req.json<{ prompt?: string; imageDataUrl?: string }>();

    if (!prompt || !imageDataUrl) {
      return c.json({ error: "prompt and imageDataUrl are required" }, 400);
    }

    const blob = await client.process({
      model: models.image("lucy-image-2"),
      prompt,
      data: parseBase64DataUrl(imageDataUrl, "image"),
    });

    return new Response(blob, {
      headers: { "Content-Type": "image/png" },
    });
  } catch (error) {
    return c.json({ error: String(error) }, 500);
  }
});

// Submit video editing job (async)
app.post("/api/video/generate", async (c) => {
  try {
    const client = c.get("decart");
    const { prompt, videoDataUrl } = await c.req.json<{ prompt?: string; videoDataUrl?: string }>();

    if (!prompt || !videoDataUrl) {
      return c.json({ error: "prompt and videoDataUrl are required" }, 400);
    }

    const job = await client.queue.submit({
      model: models.video("lucy-clip"),
      prompt,
      data: parseBase64DataUrl(videoDataUrl, "video"),
    });

    return c.json({ jobId: job.job_id, status: job.status });
  } catch (error) {
    return c.json({ error: String(error) }, 500);
  }
});

// Check video job status
app.get("/api/video/status/:jobId", async (c) => {
  const client = c.get("decart");
  const jobId = c.req.param("jobId");
  const status = await client.queue.status(jobId);

  return c.json(status);
});

// Get video result
app.get("/api/video/result/:jobId", async (c) => {
  const client = c.get("decart");
  const jobId = c.req.param("jobId");
  const blob = await client.queue.result(jobId);

  return new Response(blob, {
    headers: { "Content-Type": "video/mp4" },
  });
});

export default app;
