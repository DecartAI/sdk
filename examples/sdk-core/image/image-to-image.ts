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

  // Optional: provide a reference image to guide the edit
  // const referenceImage = fs.readFileSync("reference.png");

  const blob = await client.process({
    model: models.image("lucy-pro-i2i"),
    prompt: "Transform to watercolor painting style",
    data: new Blob([inputImage]),
    // reference_image: new Blob([referenceImage]),
  });

  // Save to file
  const output = Buffer.from(await blob.arrayBuffer());
  fs.writeFileSync("output.png", output);
  console.log("Image saved to output.png");
});
