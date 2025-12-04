#!/usr/bin/env bun
import { createDecartClient, models } from "@decartai/sdk";

const [command, prompt] = process.argv.slice(2);

if (command !== "text-to-image" || !prompt) {
	console.error("Usage: decart text-to-image <prompt>");
	process.exit(1);
}

const client = createDecartClient();

console.log("Generating image...");
const image = await client.process({
	model: models.image("lucy-pro-t2i"),
	prompt,
});

await Bun.write("output.png", image);

console.log("Image saved to output.png");
