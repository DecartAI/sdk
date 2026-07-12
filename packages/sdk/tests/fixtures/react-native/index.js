import "./bootstrap";
import { createDecartClient, models, resolveFpsNumber } from "@decartai/sdk";

const model = models.realtime("lucy-2.5");
const client = createDecartClient({ apiKey: "fixture-key", telemetry: false });

globalThis.__DECART_REACT_NATIVE_FIXTURE__ = {
  client,
  fps: resolveFpsNumber(model.fps),
};
