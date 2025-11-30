/**
 * Process API Examples - Image Models Only (Node.js)
 *
 * The process API supports synchronous image generation.
 * For video models, use the queue API instead (see queue.ts).
 *
 * Note: API keys should be kept private and never exposed in browser code.
 */
import fs from "node:fs";
import { createDecartClient, models } from "@decartai/sdk";

const client = createDecartClient({
	apiKey: process.env.DECART_API_KEY || "your-api-key",
});

async function main() {
	// Text-to-Image generation
	console.log("Generating image from text...");
	const textToImage = await client.process({
		model: models.image("lucy-pro-t2i"),
		prompt: "A beautiful sunset over mountains",
		orientation: "portrait",
	});

	// Save the generated image
	const imageBuffer = Buffer.from(await textToImage.arrayBuffer());
	fs.writeFileSync("output_t2i.png", imageBuffer);
	console.log("Image saved to output_t2i.png");

	// Image-to-Image transformation
	console.log("Transforming image...");
	const inputImage = fs.readFileSync("output_t2i.png");
	const imageToImage = await client.process({
		model: models.image("lucy-pro-i2i"),
		prompt: "Oil painting style",
		data: new Blob([inputImage]),
		enhance_prompt: false,
	});

	// Save the transformed image
	const transformedBuffer = Buffer.from(await imageToImage.arrayBuffer());
	fs.writeFileSync("output_i2i.png", transformedBuffer);
	console.log("Image saved to output_i2i.png");
}

main().catch(console.error);
