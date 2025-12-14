import fs from "node:fs";
import { createDecartClient, models } from "@decartai/sdk";
import { run } from "../lib/run";

run(async () => {
  const client = createDecartClient({
    apiKey: process.env.DECART_API_KEY!,
  });

  console.log("Transforming image...");

  // Read input image
  const inputImage = fs.readFileSync("input.png");

  const blob = await client.process({
    model: models.image("lucy-pro-i2i"),
    prompt: "Transform to watercolor painting style",
    data: new Blob([inputImage]),
  });

  // Save to file
  const output = Buffer.from(await blob.arrayBuffer());
  fs.writeFileSync("output.png", output);
  console.log("Image saved to output.png");
});
