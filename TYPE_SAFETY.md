# Type-Safe Process API

The process API now provides **both compile-time type safety and runtime validation** through model-specific input schemas.

## How It Works

Each model declares its own input schema using Zod, and TypeScript automatically infers the correct types based on the model you select:

```typescript
// ✅ Text-to-Video: only prompt required
await client.process({
  model: models.video("lucy-pro-t2v"),
  prompt: "A cat walking",
  seed: 42, // optional
  orientation: "landscape", // optional
});

// ✅ Image-to-Video: requires prompt + data (file)
await client.process({
  model: models.video("lucy-pro-i2v"),
  prompt: "Make it cinematic",
  data: imageFile,
  resolution: "720p", // optional
});

// ✅ First-Last-Frame: requires prompt + start + end
await client.process({
  model: models.video("lucy-pro-flf2v"),
  prompt: "Smooth transition",
  start: imageFile1,
  end: imageFile2,
});

// ❌ TypeScript error: 'data' doesn't exist for t2v models
await client.process({
  model: models.video("lucy-pro-t2v"),
  prompt: "A cat",
  data: videoFile, // Type error!
});
```

## Benefits

### 1. Compile-Time Type Safety
TypeScript knows which fields are valid for each model through conditional type inference:

```typescript
type ProcessOptions<T extends ModelDefinition> = {
  model: T;
  signal?: AbortSignal;
} & InferModelInputs<T>; // Infers fields from model schema
```

### 2. Runtime Validation
Zod schemas catch invalid inputs with clear error messages:

```typescript
// Missing required field
await client.process({
  model: models.video("lucy-pro-i2v"),
  prompt: "test"
  // Missing 'data' field
});
// Error: Invalid inputs for lucy-pro-i2v: data is required
```

### 3. Single Source of Truth
Model schemas in `src/shared/model.ts` drive both types and validation:

```typescript
export const modelInputSchemas = {
  "lucy-pro-i2v": z.object({
    prompt: z.string(),
    data: fileInputSchema, // Required
    seed: z.number().optional(),
    resolution: z.string().optional(),
  }),
  // ... more models
} as const;
```

### 4. Autocomplete
IDEs show correct fields for each model with inline documentation.

### 5. No Field Mapping Confusion
Renamed `file` → `data` to match OpenAPI spec directly.

## Architecture

1. **Model Registry** (`src/shared/model.ts`): Each model includes `inputSchema`
2. **Conditional Types** (`src/process/types.ts`): `ProcessOptions<T>` infers fields from model
3. **Runtime Validation** (`src/process/client.ts`): Validates using `model.inputSchema.safeParse()`
4. **Generic Model Helpers**: `models.video<T>(model: T)` returns `ModelDefinition<T>` for proper inference

## Adding New Models

```typescript
// 1. Add schema
export const modelInputSchemas = {
  "new-model": z.object({
    prompt: z.string(),
    customField: z.number(),
  }),
} as const;

// 2. Add to model union
export const videoModels = z.union([
  z.literal("new-model"),
  // ... existing models
]);

// 3. Add to registry
const _models = {
  video: {
    "new-model": {
      name: "new-model" as const,
      urlPath: "/v1/generate/new-model",
      fps: 25,
      width: 1280,
      height: 704,
      inputSchema: modelInputSchemas["new-model"],
    },
  },
};
```

That's it! TypeScript and runtime validation automatically work.