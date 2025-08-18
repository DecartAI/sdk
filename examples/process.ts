import fs from "node:fs";
import {
	createMirageClient,
	type ProcessOptions,
	type ProcessResult,
	type VideoInput,
} from "@decartai/mirage";

const videoFile: VideoInput = fs.readFileSync("examples/video.mp4");

// 1. Create a client
const client = createMirageClient({
	baseUrl: "https://api.decart.ai/mirage/v1", // optional, defaults to https://...
	apiKey: "dcrt-dLMPLEvXIuYPCpC0U5QKJh7jTH9RK8EoAaMT",
});

// 2. Process a video
// 2.1. Process a video file - upload the video file to the server, process it, and return the processed video url
const processedVideoByFile: ProcessResult = await client.process.video(
	videoFile, // required, the video file to process. type: File | Buffer | Stream.
	{
		prompt: {
			// optional, defaults to undefined, will return the original stream if no prompt is sent
			text: "Lego World",
			enrich: true, // optional, defaults to true
		},
		mirror: false, // optional, defaults to false (useful for use-cases like front-facing cameras),
	} satisfies ProcessOptions,
);

// 2.2. Process a remote video URL - send the video url to the server, download the video, process it, and return the processed video url
const processedVideoByUrl: ProcessResult = await client.process.video(
	"https://www.youtube.com/watch?v=dQw4w9WgXcQ?download=true", // required, the url of the video to process. type: string.
	{
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
videoElement.src = processedVideoByFile.videoUrl;
videoElement.src = processedVideoByUrl.videoUrl;
videoElement.play();

document.body.appendChild(videoElement);
