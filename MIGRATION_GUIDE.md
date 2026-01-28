# SDK API Migration Guide

## Overview

The Decart SDK has been redesigned to provide a clearer, more intuitive API while maintaining full backward compatibility. This guide will help you migrate to the new API.

## Why the Redesign?

The previous API had several issues:

1. **Confusing naming**: "process" didn't clearly indicate synchronous operation
2. **Unnecessary nesting**: `queue.*` methods created extra API surface
3. **Type constraints**: The API was organized by model type (image/video) rather than capability (sync/async)
4. **Unclear callbacks**: `onStatusChange` wasn't as intuitive as `onProgress`

The new API addresses all these issues while keeping your existing code working.

## Quick Reference

| Old API | New API | Notes |
|---------|---------|-------|
| `client.process()` | `client.generate()` | Clearer intent |
| `client.queue.submit()` | `client.submit()` | Flatter structure |
| `client.queue.submitAndPoll()` | `client.submitAndWait()` | More intuitive naming |
| `client.queue.status()` | `client.getJobStatus()` | Explicit method name |
| `client.queue.result()` | `client.getJobResult()` | Explicit method name |
| `onStatusChange` | `onProgress` | More intuitive naming |

## Migration Examples

### Synchronous Image Generation

#### Before (Old API)

```typescript
import { createDecartClient, models } from "@decartai/sdk";

const client = createDecartClient({ apiKey: "your-api-key" });

const blob = await client.process({
  model: models.image("lucy-pro-t2i"),
  prompt: "A beautiful sunset"
});
```

#### After (New API)

```typescript
import { createDecartClient, models } from "@decartai/sdk";

const client = createDecartClient({ apiKey: "your-api-key" });

const blob = await client.generate({
  model: models.image("lucy-pro-t2i"),
  prompt: "A beautiful sunset"
});
```

**Change**: `client.process()` → `client.generate()`

---

### Async Video Generation with Auto-Polling

#### Before (Old API)

```typescript
const result = await client.queue.submitAndPoll({
  model: models.video("lucy-pro-t2v"),
  prompt: "A cat playing piano",
  onStatusChange: (job) => {
    console.log(`Job ${job.job_id}: ${job.status}`);
  }
});

if (result.status === "completed") {
  videoElement.src = URL.createObjectURL(result.data);
}
```

#### After (New API)

```typescript
const result = await client.submitAndWait({
  model: models.video("lucy-pro-t2v"),
  prompt: "A cat playing piano",
  onProgress: (job) => {
    console.log(`Job ${job.job_id}: ${job.status}`);
  }
});

if (result.status === "completed") {
  videoElement.src = URL.createObjectURL(result.data);
}
```

**Changes**:
- `client.queue.submitAndPoll()` → `client.submitAndWait()`
- `onStatusChange` → `onProgress`

---

### Manual Job Management

#### Before (Old API)

```typescript
// Submit job
const job = await client.queue.submit({
  model: models.video("lucy-pro-t2v"),
  prompt: "A cat playing piano"
});

// Check status
const status = await client.queue.status(job.job_id);

// Get result
if (status.status === "completed") {
  const blob = await client.queue.result(job.job_id);
  videoElement.src = URL.createObjectURL(blob);
}
```

#### After (New API)

```typescript
// Submit job
const job = await client.submit({
  model: models.video("lucy-pro-t2v"),
  prompt: "A cat playing piano"
});

// Check status
const status = await client.getJobStatus(job.job_id);

// Get result
if (status.status === "completed") {
  const blob = await client.getJobResult(job.job_id);
  videoElement.src = URL.createObjectURL(blob);
}
```

**Changes**:
- `client.queue.submit()` → `client.submit()`
- `client.queue.status()` → `client.getJobStatus()`
- `client.queue.result()` → `client.getJobResult()`

---

## Backward Compatibility

**All old methods still work!** The old API has been marked as deprecated but will continue to function. You can migrate gradually:

1. **Now**: Start using the new API in new code
2. **Soon**: Update existing code at your convenience
3. **Later**: In a future major version (v1.0.0), the old API will be removed

## Benefits of the New API

### 1. Clearer Intent

```typescript
// Old: What does "process" mean?
await client.process({ ... })

// New: Obviously synchronous generation
await client.generate({ ... })
```

### 2. Flatter Structure

```typescript
// Old: Nested structure
await client.queue.submit({ ... })
await client.queue.status(jobId)
await client.queue.result(jobId)

// New: Flat structure
await client.submit({ ... })
await client.getJobStatus(jobId)
await client.getJobResult(jobId)
```

### 3. Better Naming

```typescript
// Old: Not immediately clear
onStatusChange: (job) => { ... }

// New: Indicates progress tracking
onProgress: (job) => { ... }
```

### 4. Future-Proof

The new API is organized by capability (sync vs async) rather than model type (image vs video). This means future models can support both sync and async operations without API changes.

## Deprecation Timeline

- **v0.0.40+**: New API available, old API deprecated
- **v0.1.0**: Console warnings added for old API usage
- **v1.0.0**: Old API removed

## Need Help?

- Documentation: https://docs.platform.decart.ai/sdks/javascript
- GitHub Issues: https://github.com/decartai/sdk-js/issues
- Discord: https://discord.gg/decart

## Complete Example: Before and After

### Before (Old API)

```typescript
import { createDecartClient, models } from "@decartai/sdk";

const client = createDecartClient({ apiKey: process.env.DECART_API_KEY });

// Image generation
const image = await client.process({
  model: models.image("lucy-pro-t2i"),
  prompt: "A sunset"
});

// Video generation with auto-polling
const videoResult = await client.queue.submitAndPoll({
  model: models.video("lucy-pro-t2v"),
  prompt: "A cat",
  onStatusChange: (job) => console.log(job.status)
});

// Manual job management
const job = await client.queue.submit({
  model: models.video("lucy-pro-i2v"),
  prompt: "Animate this",
  data: imageBlob
});

let status = await client.queue.status(job.job_id);
while (status.status === "processing") {
  await new Promise(r => setTimeout(r, 1000));
  status = await client.queue.status(job.job_id);
}

const result = await client.queue.result(job.job_id);
```

### After (New API)

```typescript
import { createDecartClient, models } from "@decartai/sdk";

const client = createDecartClient({ apiKey: process.env.DECART_API_KEY });

// Image generation
const image = await client.generate({
  model: models.image("lucy-pro-t2i"),
  prompt: "A sunset"
});

// Video generation with auto-polling
const videoResult = await client.submitAndWait({
  model: models.video("lucy-pro-t2v"),
  prompt: "A cat",
  onProgress: (job) => console.log(job.status)
});

// Manual job management
const job = await client.submit({
  model: models.video("lucy-pro-i2v"),
  prompt: "Animate this",
  data: imageBlob
});

let status = await client.getJobStatus(job.job_id);
while (status.status === "processing") {
  await new Promise(r => setTimeout(r, 1000));
  status = await client.getJobStatus(job.job_id);
}

const result = await client.getJobResult(job.job_id);
```

**Result**: Clearer, more intuitive code with the same functionality!
