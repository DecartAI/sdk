# SDK Context

## Realtime

**Bouncer** is the WebSocket service that validates realtime requests, queues clients when capacity is constrained, and returns LiveKit room credentials once a session can start.

**Initial State** is caller-provided prompt and/or image content supplied to `client.realtime.connect(...)`. The SDK may also send an internal null-image bootstrap for passthrough startup, but that bootstrap is not considered caller initial state.

**Remote Stream Exposure** means invoking the SDK consumer's remote stream callback. This is distinct from LiveKit subscribing to remote tracks and building a `MediaStream` internally.

**Remote Stream Exposure Gate** is the startup rule that holds Remote Stream Exposure until caller-provided Initial State is acknowledged. It does not apply to the SDK's internal null-image bootstrap.
