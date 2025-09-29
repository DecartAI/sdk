import {
	createDecartClient,
	type FileInput,
	models,
	type ProcessOptions,
} from "@decartai/sdk";

const fileInput = document.querySelector(
	'input[type="file"]',
) as HTMLInputElement;
const videoFile: FileInput = fileInput.files?.[0] as FileInput;

// 1. Create a client
const client = createDecartClient({
	baseUrl: "https://api.decart.ai", // optional, defaults to https://...
	apiKey: "dcrt-dLMPLEvXIuYPCpC0U5QKJh7jTH9RK8EoAaMT",
});

// 2. Process a video
// 2.1. Process a video file - upload the video file to the server, process it, and return the processed video
const processedVideoByFile = await client.process({
	model: models.video("lucy-pro-v2v"),
	prompt: "Lego World",
	file: videoFile,
} satisfies ProcessOptions);

// 2.2. Process a remote video URL - send the video url to the server, download the video, process it, and return the processed video
const processedVideoByUrl = await client.process({
	model: models.video("lucy-pro-v2v"),
	prompt: "Lego World",
	file: "https://www.youtube.com/watch?v=dQw4w9WgXcQ?download=true",
} satisfies ProcessOptions);

// 3. Play the video
const videoElement = document.createElement("video");
videoElement.src = URL.createObjectURL(processedVideoByFile);
videoElement.src = URL.createObjectURL(processedVideoByUrl);
videoElement.play();

document.body.appendChild(videoElement);
