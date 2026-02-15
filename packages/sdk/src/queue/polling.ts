import type { JobStatusResponse, QueueJobResult } from "./types";

const POLLING_DEFAULTS = {
  interval: 1500, // 1.5 seconds between polls
  initialDelay: 500, // Wait before first poll
};

/**
 * Sleep for a given number of milliseconds.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Poll until the job is completed or failed.
 * No timeout - backend returns "failed" after 10 minutes.
 */
export async function pollUntilComplete({
  checkStatus,
  getContent,
  onStatusChange,
  signal,
}: {
  checkStatus: () => Promise<JobStatusResponse>;
  getContent: () => Promise<Blob>;
  onStatusChange?: (job: JobStatusResponse) => void;
  signal?: AbortSignal;
}): Promise<QueueJobResult> {
  // Initial delay before first poll
  await sleep(POLLING_DEFAULTS.initialDelay);

  while (true) {
    // Check if aborted
    if (signal?.aborted) {
      throw new Error("Polling aborted");
    }

    const status = await checkStatus();

    // Notify callback
    if (onStatusChange) {
      onStatusChange(status);
    }

    if (status.status === "completed") {
      const data = await getContent();
      return { status: "completed", job_id: status.job_id, data };
    }

    if (status.status === "failed") {
      return { status: "failed", job_id: status.job_id, error: "Job failed" };
    }

    // Still pending or processing, wait and poll again
    await sleep(POLLING_DEFAULTS.interval);
  }
}
