# Bun CLI Example

A simple CLI for image editing using the Decart SDK.

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
```bash
./cli.ts image-edit "A cyberpunk cityscape at night" ./input.png
```

### Compiled
```bash
decart image-edit "A cyberpunk cityscape at night" ./input.png
```

The edited image will be saved to `output.png`.
