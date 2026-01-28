import fs from "node:fs";
import { createDecartClient, models } from "@decartai/sdk";
import { run } from "../lib/run";

run(async () => {
  const client = createDecartClient({
    apiKey: process.env.DECART_API_KEY!,
  });

  console.log("Generating video from text using new API...");

  // New API: client.submitAndWait() with onProgress instead of client.queue.submitAndPoll() with onStatusChange
  const result = await client.submitAndWait({
    model: models.video("lucy-pro-t2v"),
    prompt: "An astronaut riding a horse on Mars, cinematic lighting",
    onProgress: (job) => {
      console.log(`Job ${job.job_id}: ${job.status}`);
    },
  });

  if (result.status === "completed") {
    const output = Buffer.from(await result.data.arrayBuffer());
    fs.writeFileSync("output-new-api.mp4", output);
    console.log("Video saved to output-new-api.mp4");
  } else {
    console.log("Job failed:", result.error);
  }
});
