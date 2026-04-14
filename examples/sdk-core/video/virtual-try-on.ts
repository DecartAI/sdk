import fs from "node:fs";
import { createDecartClient, models } from "@decartai/sdk";
import { run } from "../lib/run";

run(async () => {
  const apiKey = process.env.DECART_API_KEY;
  if (!apiKey) {
    throw new Error("DECART_API_KEY environment variable is required");
  }

  const client = createDecartClient({
    apiKey,
  });

  console.log("Processing virtual try-on with lucy-2.1-vton...");

  const inputVideo = fs.readFileSync("input.mp4");

  const result = await client.queue.submitAndPoll({
    model: models.video("lucy-2.1-vton"),
    prompt: "Wearing a red leather jacket",
    data: new Blob([inputVideo]),
    onStatusChange: (job) => {
      console.log(`Job ${job.job_id}: ${job.status}`);
    },
  });

  if (result.status === "completed") {
    const output = Buffer.from(await result.data.arrayBuffer());
    fs.writeFileSync("output.mp4", output);
    console.log("Video saved to output.mp4");
  } else {
    console.log("Job failed:", result.error);
  }
});
