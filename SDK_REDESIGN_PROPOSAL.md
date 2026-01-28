# SDK Redesign Proposal (API-667)

## Current Issues

1. **Type/Runtime Mismatch**: `client.process()` types suggest it accepts any model, but it only works with image models
2. **Execution Mode Confusion**: The distinction between `process` and `queue` is about sync vs async, not image vs video
3. **Hidden Capabilities**: Both image and video models have both sync (`urlPath`) and async (`queueUrlPath`) endpoints, but the API doesn't expose this flexibility
4. **Naming Clarity**: "process" doesn't clearly communicate "synchronous generation"
5. **API Surface**: Nested `queue.*` methods create unnecessary nesting

## Proposed Solution

### New API Structure

```typescript
const client = createDecartClient({ apiKey: "..." })

// Synchronous generation (for models with urlPath)
const blob = await client.generate({
  model: models.image("lucy-pro-t2i"),
  prompt: "A cat"
})

// Async job submission + auto-wait (for models with queueUrlPath)
const result = await client.submitAndWait({
  model: models.video("lucy-pro-t2v"),
  prompt: "A cat",
  onProgress: (job) => console.log(job.status)
})

// Manual job management (for models with queueUrlPath)
const job = await client.submit({
  model: models.video("lucy-pro-t2v"),
  prompt: "A cat"
})
const status = await client.getJobStatus(job.job_id)
const blob = await client.getJobResult(job.job_id)

// Realtime (unchanged)
const connection = await client.realtime.connect(stream, {
  model: models.realtime("mirage_v2"),
  onRemoteStream: (stream) => {}
})
```

### Key Changes

1. **Rename `process` → `generate`**: Clearer intent, works with any model that has `urlPath`
2. **Flatten queue methods**: Move from `queue.submit` to `submit`, etc. - simpler API surface
3. **Rename `submitAndPoll` → `submitAndWait`**: More intuitive naming
4. **Rename `onStatusChange` → `onProgress`**: More intuitive naming
5. **New method names**: `getJobStatus` and `getJobResult` instead of `status` and `result`

### Type Safety

The new API uses TypeScript to enforce which models work with which methods based on model capabilities:

- Models with `urlPath` can use `generate()` (sync)
- Models with `queueUrlPath` can use `submit()`, `submitAndWait()`, etc. (async)
- Realtime models work with `realtime.connect()`

This means in the future, if a model supports both sync and async, both APIs will work!

### Backward Compatibility

The old API remains functional with deprecation warnings:

- `client.process()` → deprecated, use `client.generate()`
- `client.queue.submit()` → deprecated, use `client.submit()`
- `client.queue.submitAndPoll()` → deprecated, use `client.submitAndWait()`
- `client.queue.status()` → deprecated, use `client.getJobStatus()`
- `client.queue.result()` → deprecated, use `client.getJobResult()`

## Migration Guide

### Before (old API)

```typescript
// Image generation
const blob = await client.process({
  model: models.image("lucy-pro-t2i"),
  prompt: "A cat"
})

// Video generation
const result = await client.queue.submitAndPoll({
  model: models.video("lucy-pro-t2v"),
  prompt: "A cat",
  onStatusChange: (job) => console.log(job.status)
})

// Manual polling
const job = await client.queue.submit({
  model: models.video("lucy-pro-t2v"),
  prompt: "A cat"
})
const status = await client.queue.status(job.job_id)
const blob = await client.queue.result(job.job_id)
```

### After (new API)

```typescript
// Image generation (same models, new method name)
const blob = await client.generate({
  model: models.image("lucy-pro-t2i"),
  prompt: "A cat"
})

// Video generation (flattened API, renamed callback)
const result = await client.submitAndWait({
  model: models.video("lucy-pro-t2v"),
  prompt: "A cat",
  onProgress: (job) => console.log(job.status)
})

// Manual polling (flattened API, clearer method names)
const job = await client.submit({
  model: models.video("lucy-pro-t2v"),
  prompt: "A cat"
})
const status = await client.getJobStatus(job.job_id)
const blob = await client.getJobResult(job.job_id)
```

## Benefits

1. **Clearer Intent**: Method names clearly communicate what they do
2. **Future-Proof**: Models can support multiple execution modes
3. **Simpler API Surface**: Flatter structure, easier to discover
4. **Better Types**: Type constraints match actual capabilities
5. **Backward Compatible**: Old code continues to work

## Implementation Plan

1. ✅ Create proposal document
2. Create new method implementations
3. Add deprecation warnings to old methods
4. Update types to support both APIs
5. Update documentation and examples
6. Update tests
7. Create migration guide

## Open Questions

1. Should we keep `onStatusChange` for backward compatibility or only use `onProgress`?
   - **Decision**: Support both, map `onStatusChange` to `onProgress` internally with deprecation warning
2. Should old methods log deprecation warnings immediately or wait for a version?
   - **Decision**: Add warnings now but don't remove until next major version
