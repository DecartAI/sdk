# React + Vite Weather Outfit

A simple React + Vite demo that generates weather-appropriate outfits from an input photo using the Decart SDK (image-to-image with the `lucy-image-2` model).

## Setup

1. Copy `.env.example` to `.env` and add your Decart API key:

```sh
cp .env.example .env
```

2. Install dependencies & build:

```sh
pnpm install
pnpm build
```

3. Start the development server:

```sh
pnpm dev
```

4. Open [http://localhost:5173](http://localhost:5173) in your browser.

## How to use

- Pick a weather condition.
- Keep the default sample photo or upload your own image.
- Click **Generate outfit** to create a new image tailored to the selected weather.
- View the generated result alongside your source image.

## How it works

1. The chosen image (sample or uploaded) is sent to Decart.
2. The `lucy-image-2` model applies a prompt.
3. The processed image is returned.

## Model

`lucy-image-2` — image-to-image style/editing model used to restyle outfits for the selected weather.
