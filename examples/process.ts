/**
 * Process API Examples - Image Models Only
 *
 * The process API supports synchronous image generation.
 * For video models, use the queue API instead (see queue.ts).
 */
import { createDecartClient, type FileInput, models } from "@decartai/sdk";

const fileInput = document.querySelector(
	'input[type="file"]',
) as HTMLInputElement;
const imageFile: FileInput = fileInput.files?.[0] as FileInput;

const client = createDecartClient({
	baseUrl: "https://api.decart.ai",
	apiKey: "your-api-key",
});

// Text-to-Image generation
const textToImage = await client.process({
	model: models.image("lucy-pro-t2i"),
	prompt: "A beautiful sunset over mountains",
	orientation: "portrait",
});

// Image-to-Image transformation
const imageToImage = await client.process({
	model: models.image("lucy-pro-i2i"),
	prompt: "Oil painting style",
	data: imageFile,
	enhance_prompt: false,
});

// Display image result
const imgElement = document.createElement("img");
imgElement.src = URL.createObjectURL(textToImage);
document.body.appendChild(imgElement);
