import { createDecartClient, type DecartClient, models } from "@decartai/sdk";
import { Hono } from "hono";

type Bindings = {
  DECART_API_KEY: string;
};

type Variables = {
  decart: DecartClient;
};

const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();

// Middleware to create and share the Decart client
app.use("*", async (c, next) => {
  const client = createDecartClient({
    apiKey: c.env.DECART_API_KEY,
  });
  c.set("decart", client);
  await next();
});

// Text-to-image generation
app.post("/api/image/generate", async (c) => {
  const client = c.get("decart");
  const { prompt } = await c.req.json<{ prompt: string }>();

  const blob = await client.process({
    model: models.image("lucy-pro-t2i"),
    prompt,
  });

  return new Response(blob, {
    headers: { "Content-Type": "image/png" },
  });
});

// Submit video generation job (async)
app.post("/api/video/generate", async (c) => {
  const client = c.get("decart");
  const { prompt } = await c.req.json<{ prompt: string }>();

  const job = await client.queue.submit({
    model: models.video("lucy-pro-t2v"),
    prompt,
  });

  return c.json({ jobId: job.job_id, status: job.status });
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
