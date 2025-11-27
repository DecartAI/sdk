import { createDecartClient, type FileInput, models } from "@decartai/sdk";

const fileInput = document.querySelector(
	'input[type="file"]',
) as HTMLInputElement;
const imageFile: FileInput = fileInput.files?.[0] as FileInput;

const client = createDecartClient({
	apiKey: "your-api-key",
});

// Automatic polling - submits and waits for completion
const result = await client.queue.submitAndPoll({
	model: models.video("lucy-pro-i2v"),
	prompt: "The image comes to life with gentle motion",
	data: imageFile,
	resolution: "720p",
	onStatusChange: (job) => {
		console.log(`Job ${job.job_id}: ${job.status}`);
	},
});

if (result.status === "completed") {
	const videoElement = document.createElement("video");
	videoElement.src = URL.createObjectURL(result.data);
	videoElement.play();
	document.body.appendChild(videoElement);
} else {
	console.error("Job failed:", result.error);
}

// Manual polling - submit and poll yourself
const job = await client.queue.submit({
	model: models.video("lucy-pro-t2v"),
	prompt: "A cat playing piano",
	resolution: "480p",
});

console.log(`Job submitted: ${job.job_id}`);

let status = await client.queue.status(job.job_id);
while (status.status === "pending" || status.status === "processing") {
	await new Promise((r) => setTimeout(r, 2000));
	status = await client.queue.status(job.job_id);
}

if (status.status === "completed") {
	const blob = await client.queue.result(job.job_id);
	const videoElement = document.createElement("video");
	videoElement.src = URL.createObjectURL(blob);
	videoElement.play();
	document.body.appendChild(videoElement);
}
