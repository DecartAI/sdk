import fs from "node:fs";
import { createDecartClient, models } from "@decartai/sdk";
import { run } from "../lib/run";

run(async () => {
  const client = createDecartClient({
    apiKey: process.env.DECART_API_KEY!,
  });

  console.log("Transforming video...");

  const inputVideo = fs.readFileSync("input.mp4");

  // Basic usage with prompt only
  const result = await client.queue.submitAndPoll({
    model: models.video("lucy-pro-v2v"),
    prompt: "Transform to anime style",
    data: new Blob([inputVideo]),
    onStatusChange: (job) => {
      console.log(`Job ${job.job_id}: ${job.status}`);
    },
  });

  // With reference image - use an image to guide what to add to the video
  // const referenceImage = fs.readFileSync("hat.png");
  // const result = await client.queue.submitAndPoll({
  //   model: models.video("lucy-pro-v2v"),
  //   prompt: "Add the hat from the reference image to the person",
  //   data: new Blob([inputVideo]),
  //   reference_image: new Blob([referenceImage]),
  //   onStatusChange: (job) => {
  //     console.log(`Job ${job.job_id}: ${job.status}`);
  //   },
  // });

  if (result.status === "completed") {
    const output = Buffer.from(await result.data.arrayBuffer());
    fs.writeFileSync("output.mp4", output);
    console.log("Video saved to output.mp4");
  } else {
    console.log("Job failed:", result.error);
  }
});
