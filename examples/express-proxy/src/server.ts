import "dotenv/config";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { handler, route } from "@decartai/proxy/express";
import express from "express";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();

// Serve static files (HTML, JS, CSS)
app.use(express.static("public"));

// Serve SDK from node_modules for the example
const sdkDistPath = join(__dirname, "../../../packages/sdk/dist");
console.log(`Serving SDK from: ${sdkDistPath}`);
app.use(
  "/node_modules/@decartai/sdk",
  express.static(sdkDistPath, {
    setHeaders: (res, path) => {
      // Set proper content type for JavaScript modules
      if (path.endsWith(".js")) {
        res.setHeader("Content-Type", "application/javascript");
      }
    },
  }),
);

// Mount the Decart proxy middleware
// All requests to /api/decart/* will be proxied to api.decart.ai
app.use(route, handler());

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
  console.log(`Proxy endpoint: http://localhost:${port}/api/decart`);
  console.log("");
  console.log("Make sure to set DECART_API_KEY in your .env file");
});
