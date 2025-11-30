import { createDecartClient, type FileInput, models } from "@decartai/sdk";

const fileInput = document.querySelector(
	'input[type="file"]',
) as HTMLInputElement;
const videoFile: FileInput = fileInput.files?.[0] as FileInput;
const imageFile: FileInput = fileInput.files?.[0] as FileInput;

const client = createDecartClient({
	baseUrl: "https://api.decart.ai",
	apiKey: "your-api-key",
});

// ============================================
// Process API - Image Models (synchronous)
// ============================================

const textToImage = await client.process({
	model: models.image("lucy-pro-t2i"),
	prompt: "A beautiful sunset over mountains",
	orientation: "portrait",
});

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

// ============================================
// Queue API - Video Models (asynchronous)
// ============================================

const textToVideo = await client.queue.submitAndPoll({
	model: models.video("lucy-pro-t2v"),
	prompt: "A cat walking in a park",
	seed: 42,
	resolution: "720p",
	orientation: "landscape",
});

const videoToVideo = await client.queue.submitAndPoll({
	model: models.video("lucy-pro-v2v"),
	prompt: "Lego World",
	data: videoFile,
	enhance_prompt: true,
	num_inference_steps: 50,
});

const fastVideoToVideo = await client.queue.submitAndPoll({
	model: models.video("lucy-fast-v2v"),
	prompt: "Change the car to a vintage motorcycle",
	data: videoFile,
	resolution: "720p",
	enhance_prompt: true,
	seed: 42,
});

const videoByUrl = await client.queue.submitAndPoll({
	model: models.video("lucy-pro-v2v"),
	prompt: "Cyberpunk style",
	data: "https://example.com/video.mp4",
});

const firstLastFrame = await client.queue.submitAndPoll({
	model: models.video("lucy-pro-flf2v"),
	prompt: "Smooth transition between frames",
	start: imageFile,
	end: imageFile,
	seed: 123,
});

const imageToVideoMotion = await client.queue.submitAndPoll({
	model: models.video("lucy-motion"),
	data: imageFile,
	trajectory: [
		{ frame: 0, x: 0, y: 0 },
		{ frame: 1, x: 100, y: 100 },
	],
});

// Display video result
if (textToVideo.status === "completed") {
	const videoElement = document.createElement("video");
	videoElement.src = URL.createObjectURL(textToVideo.data);
	videoElement.play();
	document.body.appendChild(videoElement);
}
