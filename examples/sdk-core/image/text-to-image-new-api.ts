import fs from "node:fs";
import { createDecartClient, models } from "@decartai/sdk";
import { run } from "../lib/run";

run(async () => {
  const client = createDecartClient({
    apiKey: process.env.DECART_API_KEY!,
  });

  console.log("Generating image from text using new API...");

  // New API: client.generate() instead of client.process()
  const blob = await client.generate({
    model: models.image("lucy-pro-t2i"),
    prompt: "A cyberpunk cityscape at night with neon lights",
  });

  // Save to file
  const output = Buffer.from(await blob.arrayBuffer());
  fs.writeFileSync("output-new-api.png", output);
  console.log("Image saved to output-new-api.png");
});
