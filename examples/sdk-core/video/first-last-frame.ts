import fs from "node:fs";
import { createDecartClient, models } from "@decartai/sdk";
import { run } from "../lib/run";

run(async () => {
	const client = createDecartClient({
		apiKey: process.env.DECART_API_KEY!,
	});

	console.log("Generating video from first/last frames...");

	const firstFrame = fs.readFileSync("first-frame.png");
	const lastFrame = fs.readFileSync("last-frame.png");

	const result = await client.queue.submitAndPoll({
		model: models.video("lucy-pro-flf2v"),
		prompt: "Smooth transition between scenes",
		start: new Blob([firstFrame]),
		end: new Blob([lastFrame]),
		onStatusChange: (job) => {
			console.log(`Job ${job.job_id}: ${job.status}`);
		},
	});

	if (result.status === "completed") {
		const output = Buffer.from(await result.data.arrayBuffer());
		fs.writeFileSync("output.mp4", output);
		console.log("Video saved to output.mp4");
	} else {
		console.log("Job failed:", result.error);
	}
});
