# Bun CLI Example

A simple CLI for text-to-image generation using the Decart SDK.

## Setup

1. Install dependencies:
   ```bash
   bun install
   ```

2. Set your API key:
   ```bash
   export DECART_API_KEY=your-api-key-here
   ```

3. Build:
   ```bash
   bun run build
   ```

4. Link the executable:
   ```bash
   bun link
   ```

## Usage

### Dev-time
```
./cli.ts text-to-image "A cyberpunk cityscape at night"
```

### Compiled
```bash
decart text-to-image "A cyberpunk cityscape at night"
```

The generated image will be saved to `output.png`.
