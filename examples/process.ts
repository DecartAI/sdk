import { createDecartClient, type FileInput, models } from "@decartai/sdk";

const fileInput = document.querySelector(
	'input[type="file"]',
) as HTMLInputElement;
const videoFile: FileInput = fileInput.files?.[0] as FileInput;
const imageFile: FileInput = fileInput.files?.[0] as FileInput;

const client = createDecartClient({
	baseUrl: "https://api.decart.ai",
	apiKey: "dcrt-dLMPLEvXIuYPCpC0U5QKJh7jTH9RK8EoAaMT",
});

const textToVideo = await client.process({
	model: models.video("lucy-pro-t2v"),
	prompt: "A cat walking in a park",
	seed: 42,
	resolution: "720p",
	orientation: "landscape",
});

const videoToVideo = await client.process({
	model: models.video("lucy-pro-v2v"),
	prompt: "Lego World",
	data: videoFile,
	enhance_prompt: true,
	num_inference_steps: 50,
});

const videoByUrl = await client.process({
	model: models.video("lucy-pro-v2v"),
	prompt: "Cyberpunk style",
	data: "https://example.com/video.mp4",
});

const firstLastFrame = await client.process({
	model: models.video("lucy-pro-flf2v"),
	prompt: "Smooth transition between frames",
	start: imageFile,
	end: imageFile,
	seed: 123,
});

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

const videoElement = document.createElement("video");
videoElement.src = URL.createObjectURL(textToVideo);
videoElement.play();

document.body.appendChild(videoElement);
