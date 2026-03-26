#!/usr/bin/env bun
import { createDecartClient, models } from "@decartai/sdk";

const [command, prompt, inputPath] = process.argv.slice(2);

if (command !== "image-edit" || !prompt || !inputPath) {
  console.error("Usage: decart image-edit <prompt> <input-image-path>");
  process.exit(1);
}

const client = createDecartClient();
const inputImage = Bun.file(inputPath);

console.log("Editing image...");
const image = await client.process({
  model: models.image("lucy-pro-i2i"),
  prompt,
  data: inputImage,
});

await Bun.write("output.png", image);

console.log("Image saved to output.png");
