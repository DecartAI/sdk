# Decart Express Proxy Middleware

> [!IMPORTANT]  
> Before setting up the proxy, ensure you have `DECART_API_KEY` set as an enviornment variable.

## Usage
```typescript
import express from "express";
import { decartProxy } from "@decartai/proxy/express";

const app = express();

// Mount the proxy middleware
app.use("/api/decart", decartProxy)

app.listen(3000);
```

Then use the SDK on the client side:

```typescript
import { createDecartClient, models } from "@decartai/sdk";

const client = createDecartClient({ proxy: "/api/decart" });

// Use the client as normal
const result = await client.process({
  model: models.image("lucy-pro-t2i"),
  prompt: "A beautiful sunset",
});
```
