/**
 * WebRTC / LiveKit / browser-network instrumentation that emits raw debug
 * data over the SDK observability sink (which the realtime WS forwards to
 * bouncer, where Datadog ingests it under the session's log context).
 *
 * Captures the kind of data that's actually useful when diagnosing an ICE
 * failure — every candidate gathered (host/srflx/relay/prflx, address,
 * port, priority, foundation), every state transition on both transports
 * (publisher/subscriber: ice/peer/gathering/signaling), candidate errors,
 * the selected pair on success, signaling traffic in/out, and the
 * browser's view of its own network state.
 *
 * The browser-side `Room` doesn't publicly expose the underlying
 * `RTCPeerConnection` objects, so we reach through `room.engine.pcManager`
 * via a typed-cast access path. `addEventListener` is used everywhere so
 * we never displace LiveKit's own handlers.
 */

import { DisconnectReason, Room, RoomEvent, Track } from "livekit-client";
import type { RealtimeObservability } from "./realtime-observability";

const DISCONNECT_REASON_NAMES: Record<number, string> = {
  [DisconnectReason.UNKNOWN_REASON]: "unknown",
  [DisconnectReason.CLIENT_INITIATED]: "client_initiated",
  [DisconnectReason.DUPLICATE_IDENTITY]: "duplicate_identity",
  [DisconnectReason.SERVER_SHUTDOWN]: "server_shutdown",
  [DisconnectReason.PARTICIPANT_REMOVED]: "participant_removed",
  [DisconnectReason.ROOM_DELETED]: "room_deleted",
  [DisconnectReason.STATE_MISMATCH]: "state_mismatch",
  [DisconnectReason.JOIN_FAILURE]: "join_failure",
  [DisconnectReason.MIGRATION]: "migration",
  [DisconnectReason.SIGNAL_CLOSE]: "signal_close",
  [DisconnectReason.ROOM_CLOSED]: "room_closed",
  [DisconnectReason.USER_UNAVAILABLE]: "user_unavailable",
  [DisconnectReason.USER_REJECTED]: "user_rejected",
  [DisconnectReason.SIP_TRUNK_FAILURE]: "sip_trunk_failure",
  [DisconnectReason.CONNECTION_TIMEOUT]: "connection_timeout",
  [DisconnectReason.MEDIA_FAILURE]: "media_failure",
};

function disconnectReasonString(reason: number | undefined): string | undefined {
  if (reason === undefined) return undefined;
  return DISCONNECT_REASON_NAMES[reason] ?? `unknown(${reason})`;
}

type Side = "publisher" | "subscriber";

// Loose typings for the parts of LiveKit's engine we touch. Everything is
// optional / `unknown` because these are private APIs that have moved
// across LiveKit versions; we degrade gracefully if a field is missing.
type EngineLike = {
  pcManager?: PcManagerLike;
};
type PcManagerLike = {
  publisher?: PcTransportLike;
  subscriber?: PcTransportLike;
  getConnectedAddress?: (target?: unknown) => Promise<string | undefined>;
};
type PcTransportLike = {
  pc?: RTCPeerConnection;
  // some livekit builds expose it as `_pc`
  _pc?: RTCPeerConnection;
};
type RoomWithEngine = Room & { engine?: EngineLike };

type ConnectionInfo = {
  effectiveType?: string;
  downlinkMbps?: number;
  rttMs?: number;
  saveData?: boolean;
  type?: string;
  online?: boolean;
};

function summarizeCandidate(candidate: RTCIceCandidate | null): Record<string, unknown> {
  if (!candidate) return { eof: true };
  // Keep only the fields useful for ICE debugging. Dropped vs. raw RTCIceCandidate:
  //   - candidate (raw SDP string — redundant with type/address/port/protocol)
  //   - sdpMid / sdpMLineIndex (mux indexing, not network-debug)
  //   - usernameFragment (ICE ufrag — auth, not network-debug)
  const c = candidate as RTCIceCandidate & {
    address?: string;
    relatedAddress?: string;
    relatedPort?: number;
    tcpType?: string;
    networkType?: string;
    url?: string;
  };
  return {
    type: c.type,
    protocol: c.protocol,
    address: c.address ?? null,
    port: c.port,
    priority: c.priority,
    foundation: c.foundation,
    component: c.component,
    tcpType: c.tcpType ?? null,
    relatedAddress: c.relatedAddress ?? null,
    relatedPort: c.relatedPort ?? null,
    networkType: c.networkType ?? null,
    url: c.url ?? null,
  };
}

function summarizeCandidateError(ev: RTCPeerConnectionIceErrorEvent): Record<string, unknown> {
  return {
    address: ev.address ?? null,
    port: ev.port ?? null,
    url: ev.url ?? null,
    errorCode: ev.errorCode,
    errorText: ev.errorText,
    hostCandidate: (ev as unknown as { hostCandidate?: string }).hostCandidate ?? null,
  };
}

function snapshotConnection(): ConnectionInfo {
  const info: ConnectionInfo = {};
  if (typeof navigator !== "undefined") {
    info.online = navigator.onLine;
    const conn = (navigator as Navigator & { connection?: Record<string, unknown> }).connection;
    if (conn) {
      info.effectiveType = conn.effectiveType as string | undefined;
      info.downlinkMbps = conn.downlink as number | undefined;
      info.rttMs = conn.rtt as number | undefined;
      info.saveData = conn.saveData as boolean | undefined;
      info.type = conn.type as string | undefined;
    }
  }
  return info;
}

async function snapshotSelectedPair(pc: RTCPeerConnection): Promise<Record<string, unknown> | null> {
  try {
    const report = await pc.getStats();
    let pair: RTCIceCandidatePairStats | null = null;
    const candidates = new Map<string, RTCIceCandidateStats>();
    report.forEach((stat) => {
      if (stat.type === "candidate-pair" && stat.state === "succeeded" && stat.nominated) {
        pair = stat as RTCIceCandidatePairStats;
      }
      if (stat.type === "local-candidate" || stat.type === "remote-candidate") {
        candidates.set(stat.id, stat as RTCIceCandidateStats);
      }
    });
    if (!pair) return null;
    const local = candidates.get(pair.localCandidateId);
    const remote = candidates.get(pair.remoteCandidateId);
    return {
      currentRoundTripTimeMs: pair.currentRoundTripTime != null ? pair.currentRoundTripTime * 1000 : null,
      availableOutgoingBitrate: pair.availableOutgoingBitrate ?? null,
      local: local
        ? {
            type: local.candidateType,
            protocol: local.protocol,
            address: (local as RTCIceCandidateStats & { address?: string }).address,
            port: local.port,
            networkType: (local as RTCIceCandidateStats & { networkType?: string }).networkType,
          }
        : null,
      remote: remote
        ? {
            type: remote.candidateType,
            protocol: remote.protocol,
            address: (remote as RTCIceCandidateStats & { address?: string }).address,
            port: remote.port,
          }
        : null,
    };
  } catch {
    return null;
  }
}

function getPc(transport: PcTransportLike | undefined): RTCPeerConnection | undefined {
  if (!transport) return undefined;
  return transport.pc ?? transport._pc;
}

/**
 * Walk `pc.getStats()` once and emit one synthetic `ice-candidate-past`
 * event per local-candidate (and `remote-candidate-past` per remote one)
 * already known to the PC. Covers the very common case where ICE
 * gathering finished before our `icecandidate` listener was attached.
 */
async function snapshotPastCandidates(
  pc: RTCPeerConnection,
  side: Side,
  emit: (name: string, data: Record<string, unknown>) => void,
): Promise<void> {
  try {
    const report = await pc.getStats();
    report.forEach((stat) => {
      if (stat.type === "local-candidate" || stat.type === "remote-candidate") {
        const c = stat as RTCIceCandidateStats & {
          address?: string;
          networkType?: string;
          relayProtocol?: string;
          url?: string;
        };
        emit("ice-candidate-past", {
          side,
          source: stat.type, // local-candidate | remote-candidate
          candidateType: c.candidateType,
          protocol: c.protocol,
          address: c.address ?? null,
          port: c.port,
          priority: c.priority,
          networkType: c.networkType ?? null,
          relayProtocol: c.relayProtocol ?? null,
          url: c.url ?? null,
        });
      }
    });
  } catch {
    // ignore
  }
}

/**
 * Attach low-level instrumentation to a connected LiveKit `Room`. Safe to
 * call once per room. Returns a cleanup function that detaches all listeners.
 */
export function attachRoomInstrumentation(room: Room, observability: RealtimeObservability): () => void {
  const emit = (name: string, data: Record<string, unknown> = {}): void => {
    observability.emitInstrumentationEvent(name, data);
  };

  // Initial browser network snapshot — gives a baseline to compare against.
  emit("network-state", snapshotConnection());

  // Browser network events relevant to ICE failure debugging. Page
  // visibility transitions are intentionally not forwarded — they're
  // noise for connection diagnostics.
  const onOnline = () => emit("browser-online", { ...snapshotConnection() });
  const onOffline = () => emit("browser-offline", { ...snapshotConnection() });
  const conn =
    typeof navigator !== "undefined" ? (navigator as Navigator & { connection?: EventTarget }).connection : undefined;
  const onConnChange = () => emit("network-change", snapshotConnection());
  if (typeof window !== "undefined") {
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
  }
  conn?.addEventListener?.("change", onConnChange);

  // LiveKit Room lifecycle events that matter for connection debugging.
  // Steady-state events (connection-quality, track-subscribed/muted/unmuted,
  // local-track-published, participant-connected, page-visibility) are
  // intentionally not forwarded — they're noise once a session is up and
  // running, and the goal of this stream is to debug WHY connections fail
  // or take too long, not narrate a healthy session.
  const onConnected = () => emit("room-connected", { name: room.name, sid: room.localParticipant?.sid });
  const onDisconnected = (reason?: DisconnectReason) =>
    emit("room-disconnected", { reason, reasonName: disconnectReasonString(reason) });
  const onReconnecting = () => emit("room-reconnecting");
  const onSignalReconnecting = () => emit("room-signal-reconnecting");
  const onReconnected = () => emit("room-reconnected");
  const onMediaDevicesError = (e: Error) => emit("media-devices-error", { name: e.name, message: e.message });

  room.on(RoomEvent.Connected, onConnected);
  room.on(RoomEvent.Disconnected, onDisconnected);
  room.on(RoomEvent.Reconnecting, onReconnecting);
  room.on(RoomEvent.SignalReconnecting, onSignalReconnecting);
  room.on(RoomEvent.Reconnected, onReconnected);
  room.on(RoomEvent.MediaDevicesError, onMediaDevicesError);
  // RoomEvent.ConnectionStateChanged is intentionally not hooked — its
  // states duplicate room-connected / -reconnecting / -disconnected.

  // Attach to the underlying RTCPeerConnections for ICE-level visibility.
  // Done lazily on next tick — LiveKit creates the PC transports during
  // `room.connect()`, and the engine may not be wired up yet at the
  // moment we register Room events. Polling for a short window covers
  // both early and late attach scenarios.
  const pcCleanups: Array<() => void> = [];
  const attachedSides = new Set<Side>();
  const attachPcEventsIfReady = (): boolean => {
    const engine = (room as RoomWithEngine).engine;
    const mgr = engine?.pcManager;
    if (!mgr) return false;
    for (const side of ["publisher", "subscriber"] as Side[]) {
      if (attachedSides.has(side)) continue;
      const pc = getPc(side === "publisher" ? mgr.publisher : mgr.subscriber);
      if (!pc) continue;
      attachedSides.add(side);
      pcCleanups.push(attachPeerConnectionInstrumentation(pc, side, emit, mgr));
    }
    return attachedSides.size === 2;
  };
  // Try immediately, then poll briefly for the late case.
  if (!attachPcEventsIfReady()) {
    let attempts = 0;
    const poll = setInterval(() => {
      attempts++;
      if (attachPcEventsIfReady() || attempts > 50) {
        clearInterval(poll);
      }
    }, 100);
    pcCleanups.push(() => clearInterval(poll));
  }

  return () => {
    try {
      room.off(RoomEvent.Connected, onConnected);
      room.off(RoomEvent.Disconnected, onDisconnected);
      room.off(RoomEvent.Reconnecting, onReconnecting);
      room.off(RoomEvent.SignalReconnecting, onSignalReconnecting);
      room.off(RoomEvent.Reconnected, onReconnected);
      room.off(RoomEvent.MediaDevicesError, onMediaDevicesError);
    } catch {
      // ignore detach errors during teardown
    }
    if (typeof window !== "undefined") {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    }
    conn?.removeEventListener?.("change", onConnChange);
    for (const fn of pcCleanups) {
      try {
        fn();
      } catch {
        // ignore
      }
    }
  };
}

function summarizeIceServers(pc: RTCPeerConnection): Array<Record<string, unknown>> {
  try {
    const cfg = pc.getConfiguration();
    return (cfg.iceServers ?? []).map((s) => ({
      urls: Array.isArray(s.urls) ? s.urls : [s.urls],
      hasUsername: !!s.username,
      hasCredential: !!s.credential,
    }));
  } catch {
    return [];
  }
}

function attachPeerConnectionInstrumentation(
  pc: RTCPeerConnection,
  side: Side,
  emit: (name: string, data: Record<string, unknown>) => void,
  _pcManager?: PcManagerLike,
): () => void {
  // pc-attached carries the PC's iceServers config — directly answers
  // "did the SDK get STUN/TURN URLs from the JoinResponse?". Credentials
  // are redacted (we only log whether they were present).
  emit("pc-attached", {
    side,
    iceConnectionState: pc.iceConnectionState,
    connectionState: pc.connectionState,
    iceGatheringState: pc.iceGatheringState,
    signalingState: pc.signalingState,
    iceServers: summarizeIceServers(pc),
    iceTransportPolicy: pc.getConfiguration().iceTransportPolicy ?? null,
  });

  // The PC may already have gathered all its candidates by the time we
  // attach. addEventListener('icecandidate', ...) only catches FUTURE
  // events, so we walk getStats() once to surface what was already
  // produced. This is the data we'd care about most for an ICE-failure
  // post-mortem (srflx address, candidate types, the winning pair).
  void snapshotPastCandidates(pc, side, emit);
  if (pc.iceConnectionState === "connected" || pc.iceConnectionState === "completed") {
    void (async () => {
      const pair = await snapshotSelectedPair(pc);
      if (pair) emit("selected-candidate-pair", { side, ...pair, snapshot: true });
    })();
  }

  const onIceCandidate = (ev: RTCPeerConnectionIceEvent) => {
    emit("ice-candidate", { side, ...summarizeCandidate(ev.candidate) });
  };
  const onIceCandidateError = (ev: Event) => {
    emit("ice-candidate-error", { side, ...summarizeCandidateError(ev as RTCPeerConnectionIceErrorEvent) });
  };
  const onIceConnectionStateChange = async () => {
    emit("ice-connection-state", { side, state: pc.iceConnectionState });
    // Snapshot the winning candidate pair when ICE settles.
    if (pc.iceConnectionState === "connected" || pc.iceConnectionState === "completed") {
      const pair = await snapshotSelectedPair(pc);
      if (pair) emit("selected-candidate-pair", { side, ...pair });
    }
  };
  const onConnectionStateChange = () => emit("pc-connection-state", { side, state: pc.connectionState });
  const onIceGatheringStateChange = () => emit("ice-gathering-state", { side, state: pc.iceGatheringState });
  // signalingstatechange + negotiationneeded + track + datachannel are
  // intentionally not hooked — they fire on every SDP renegotiation cycle
  // (each prompt / set_image triggers one) and bury the ICE-level signal.

  pc.addEventListener("icecandidate", onIceCandidate);
  pc.addEventListener("icecandidateerror", onIceCandidateError);
  pc.addEventListener("iceconnectionstatechange", onIceConnectionStateChange);
  pc.addEventListener("connectionstatechange", onConnectionStateChange);
  pc.addEventListener("icegatheringstatechange", onIceGatheringStateChange);

  return () => {
    pc.removeEventListener("icecandidate", onIceCandidate);
    pc.removeEventListener("icecandidateerror", onIceCandidateError);
    pc.removeEventListener("iceconnectionstatechange", onIceConnectionStateChange);
    pc.removeEventListener("connectionstatechange", onConnectionStateChange);
    pc.removeEventListener("icegatheringstatechange", onIceGatheringStateChange);
  };
}

// Re-export for convenience so consumers know what's available.
export { Track };
