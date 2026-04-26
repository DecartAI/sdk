/**
 * Realtime transport: LiveKit (SFU) only. Control messages (prompt, set_image,
 * session_id, generation_tick, acks) flow over the bouncer WebSocket; media
 * uses `livekit_join` / `livekit_room_info` and a LiveKit room.
 */

export type TransportKind = "livekit";

export { LiveKitConnection } from "./livekit";
