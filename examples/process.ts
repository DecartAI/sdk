import {
	createDecartClient,
	models,
	type ProcessOptions,
	type VideoInput,
} from "@decartai/sdk";

const fileInput = document.querySelector(
	'input[type="file"]',
) as HTMLInputElement;
const videoFile: VideoInput = fileInput.files?.[0] as VideoInput;

// 1. Create a client
const client = createDecartClient({
	baseUrl: "https://api.decart.ai", // optional, defaults to https://...
	apiKey: "dcrt-dLMPLEvXIuYPCpC0U5QKJh7jTH9RK8EoAaMT",
});

// 2. Process a video
// 2.1. Process a video file - upload the video file to the server, process it, and return the processed video
const processedVideoByFile = await client.process.video(
	videoFile, // required, the video file to process. type: File | Buffer | Stream.
	{
		model: models.v2v("decart-v2v-v2.0-704p"),
		prompt: {
			// optional, defaults to undefined, will return the original stream if no prompt is sent
			text: "Lego World",
			enrich: true, // optional, defaults to true
		},
		mirror: false, // optional, defaults to false (useful for use-cases like front-facing cameras),
	} satisfies ProcessOptions,
);

// 2.2. Process a remote video URL - send the video url to the server, download the video, process it, and return the processed video
const processedVideoByUrl = await client.process.video(
	"https://www.youtube.com/watch?v=dQw4w9WgXcQ?download=true", // required, the url of the video to process. type: string.
	{
		model: models.v2v("decart-v2v-v1.0-432p"),
		prompt: {
			// optional, defaults to undefined, will return the original stream if no prompt is sent
			text: "Lego World",
			enrich: true, // optional, defaults to true
		},
		mirror: false, // optional, defaults to false (useful for use-cases like front-facing cameras)
	} satisfies ProcessOptions,
);

// 3. Play the video
const videoElement = document.createElement("video");
videoElement.src = URL.createObjectURL(processedVideoByFile);
videoElement.src = URL.createObjectURL(processedVideoByUrl);
videoElement.play();

document.body.appendChild(videoElement);
