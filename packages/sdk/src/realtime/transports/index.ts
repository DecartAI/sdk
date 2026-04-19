/**
 * Transport dispatch for the realtime SDK.
 *
 * Today the SDK ships two transports:
 *   - aiortc  (default, shipping): raw RTCPeerConnection + WebSocket signaling.
 *             The inference server handles media via aiortc server-side.
 *   - livekit (opt-in): joins a LiveKit SFU room; the inference server
 *             publishes/subscribes in the same room.
 *
 * Both transports talk to bouncer via the same WS URL. The transport-specific
 * difference is only in the media setup handshake (SDP offer vs. room_info)
 * and which media stack moves frames. Control messages (prompt, set_image,
 * session_id, generation_tick, acks) flow over the bouncer WS for both.
 */

export type TransportKind = "aiortc" | "livekit";

// Re-export the two concrete connections via a named surface so consumers
// (WebRTCManager) don't need to import from each file individually.
export { WebRTCConnection as AiortcConnection } from "../webrtc-connection";
export { LiveKitConnection } from "./livekit";
