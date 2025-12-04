import fs from "node:fs";
import { createDecartClient, models } from "@decartai/sdk";
import { run } from "../lib/run";

run(async () => {
	const client = createDecartClient({
		apiKey: process.env.DECART_API_KEY!,
	});

	console.log("Submitting video generation job...");

	// Submit job
	const job = await client.queue.submit({
		model: models.video("lucy-pro-t2v"),
		prompt: "A timelapse of a flower blooming",
	});

	console.log("Job ID:", job.job_id);
	console.log("Polling for completion...");

	// Manual polling loop
	let status = await client.queue.status(job.job_id);
	while (status.status === "pending" || status.status === "processing") {
		console.log(`Status: ${status.status}`);
		await new Promise((r) => setTimeout(r, 2000));
		status = await client.queue.status(job.job_id);
	}

	if (status.status === "completed") {
		const blob = await client.queue.result(job.job_id);
		const output = Buffer.from(await blob.arrayBuffer());
		fs.writeFileSync("output.mp4", output);
		console.log("Video saved to output.mp4");
	} else {
		console.log("Job failed");
	}
});
