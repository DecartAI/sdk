import fs from "node:fs";
import { createDecartClient, models } from "@decartai/sdk";
import { run } from "../lib/run";

run(async () => {
  const client = createDecartClient({
    apiKey: process.env.DECART_API_KEY!,
  });

  console.log("Generating video with manual polling using new API...");

  // New API: client.submit() instead of client.queue.submit()
  const job = await client.submit({
    model: models.video("lucy-pro-t2v"),
    prompt: "A serene waterfall in a lush forest",
  });

  console.log(`Job submitted: ${job.job_id}`);

  // Poll for status using new API methods
  while (true) {
    // New API: client.getJobStatus() instead of client.queue.status()
    const status = await client.getJobStatus(job.job_id);
    console.log(`Job ${status.job_id}: ${status.status}`);

    if (status.status === "completed") {
      // New API: client.getJobResult() instead of client.queue.result()
      const blob = await client.getJobResult(job.job_id);
      const output = Buffer.from(await blob.arrayBuffer());
      fs.writeFileSync("output-manual-polling-new-api.mp4", output);
      console.log("Video saved to output-manual-polling-new-api.mp4");
      break;
    }

    if (status.status === "failed") {
      console.error("Job failed");
      break;
    }

    // Wait before polling again
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
});
