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

import { Room, RoomEvent, Track, type DisconnectReason } from "livekit-client";
import type { RealtimeObservability } from "./realtime-observability";

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
  const c = candidate as RTCIceCandidate & {
    address?: string;
    relatedAddress?: string;
    relatedPort?: number;
    tcpType?: string;
    networkType?: string;
    url?: string;
  };
  return {
    candidate: c.candidate,
    foundation: c.foundation,
    component: c.component,
    protocol: c.protocol,
    address: c.address ?? null,
    port: c.port,
    priority: c.priority,
    type: c.type,
    tcpType: c.tcpType ?? null,
    relatedAddress: c.relatedAddress ?? null,
    relatedPort: c.relatedPort ?? null,
    sdpMid: c.sdpMid,
    sdpMLineIndex: c.sdpMLineIndex,
    usernameFragment: c.usernameFragment,
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
 * Attach low-level instrumentation to a connected LiveKit `Room`. Safe to
 * call once per room. Returns a cleanup function that detaches all listeners.
 */
export function attachRoomInstrumentation(room: Room, observability: RealtimeObservability): () => void {
  const emit = (name: string, data: Record<string, unknown> = {}): void => {
    observability.emitInstrumentationEvent(name, data);
  };

  // Initial browser network snapshot — gives a baseline to compare against.
  emit("network-state", snapshotConnection());

  // Browser network events.
  const onOnline = () => emit("browser-online", { ...snapshotConnection() });
  const onOffline = () => emit("browser-offline", { ...snapshotConnection() });
  const onVisibility = () =>
    emit("page-visibility", { state: typeof document !== "undefined" ? document.visibilityState : null });
  const conn =
    typeof navigator !== "undefined" ? (navigator as Navigator & { connection?: EventTarget }).connection : undefined;
  const onConnChange = () => emit("network-change", snapshotConnection());
  if (typeof window !== "undefined") {
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
  }
  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", onVisibility);
  }
  conn?.addEventListener?.("change", onConnChange);

  // LiveKit Room lifecycle events worth seeing in Datadog.
  const onConnected = () => emit("room-connected", { name: room.name, sid: room.localParticipant?.sid });
  const onDisconnected = (reason?: DisconnectReason) => emit("room-disconnected", { reason });
  const onReconnecting = () => emit("room-reconnecting");
  const onSignalReconnecting = () => emit("room-signal-reconnecting");
  const onReconnected = () => emit("room-reconnected");
  const onConnectionStateChanged = (state: unknown) => emit("room-connection-state", { state });
  const onConnectionQualityChanged = (quality: unknown, participant: unknown) =>
    emit("connection-quality", {
      quality,
      participantIdentity: (participant as { identity?: string } | undefined)?.identity,
    });
  const onMediaDevicesError = (e: Error) => emit("media-devices-error", { name: e.name, message: e.message });
  const onLocalTrackPublished = (pub: unknown) => {
    const p = pub as { kind?: string; source?: string; trackSid?: string; mimeType?: string } | undefined;
    emit("local-track-published", { kind: p?.kind, source: p?.source, trackSid: p?.trackSid, mimeType: p?.mimeType });
  };
  const onParticipantConnected = (participant: unknown) =>
    emit("participant-connected", { identity: (participant as { identity?: string } | undefined)?.identity });
  const onTrackSubscribed = (track: unknown, _pub: unknown, participant: unknown) => {
    const t = track as { kind?: string; sid?: string } | undefined;
    const p = participant as { identity?: string } | undefined;
    emit("track-subscribed", { kind: t?.kind, trackSid: t?.sid, fromIdentity: p?.identity });
  };
  const onTrackMuted = (_pub: unknown, participant: unknown) =>
    emit("track-muted", { identity: (participant as { identity?: string } | undefined)?.identity });
  const onTrackUnmuted = (_pub: unknown, participant: unknown) =>
    emit("track-unmuted", { identity: (participant as { identity?: string } | undefined)?.identity });

  room.on(RoomEvent.Connected, onConnected);
  room.on(RoomEvent.Disconnected, onDisconnected);
  room.on(RoomEvent.Reconnecting, onReconnecting);
  room.on(RoomEvent.SignalReconnecting, onSignalReconnecting);
  room.on(RoomEvent.Reconnected, onReconnected);
  room.on(RoomEvent.ConnectionStateChanged, onConnectionStateChanged);
  room.on(RoomEvent.ConnectionQualityChanged, onConnectionQualityChanged);
  room.on(RoomEvent.MediaDevicesError, onMediaDevicesError);
  room.on(RoomEvent.LocalTrackPublished, onLocalTrackPublished);
  room.on(RoomEvent.ParticipantConnected, onParticipantConnected);
  room.on(RoomEvent.TrackSubscribed, onTrackSubscribed);
  room.on(RoomEvent.TrackMuted, onTrackMuted);
  room.on(RoomEvent.TrackUnmuted, onTrackUnmuted);

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
      room.off(RoomEvent.ConnectionStateChanged, onConnectionStateChanged);
      room.off(RoomEvent.ConnectionQualityChanged, onConnectionQualityChanged);
      room.off(RoomEvent.MediaDevicesError, onMediaDevicesError);
      room.off(RoomEvent.LocalTrackPublished, onLocalTrackPublished);
      room.off(RoomEvent.ParticipantConnected, onParticipantConnected);
      room.off(RoomEvent.TrackSubscribed, onTrackSubscribed);
      room.off(RoomEvent.TrackMuted, onTrackMuted);
      room.off(RoomEvent.TrackUnmuted, onTrackUnmuted);
    } catch {
      // ignore detach errors during teardown
    }
    if (typeof window !== "undefined") {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    }
    if (typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", onVisibility);
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

function attachPeerConnectionInstrumentation(
  pc: RTCPeerConnection,
  side: Side,
  emit: (name: string, data: Record<string, unknown>) => void,
  pcManager?: PcManagerLike,
): () => void {
  emit("pc-attached", {
    side,
    iceConnectionState: pc.iceConnectionState,
    connectionState: pc.connectionState,
    iceGatheringState: pc.iceGatheringState,
    signalingState: pc.signalingState,
  });

  const onIceCandidate = (ev: RTCPeerConnectionIceEvent) => {
    emit("ice-candidate", { side, ...summarizeCandidate(ev.candidate) });
  };
  const onIceCandidateError = (ev: Event) => {
    emit("ice-candidate-error", { side, ...summarizeCandidateError(ev as RTCPeerConnectionIceErrorEvent) });
  };
  const onIceConnectionStateChange = async () => {
    emit("ice-connection-state", { side, state: pc.iceConnectionState });
    // Snapshot the winning candidate pair when ICE settles (connected/completed)
    // or capture stats at the moment of failure for forensics.
    if (pc.iceConnectionState === "connected" || pc.iceConnectionState === "completed") {
      const pair = await snapshotSelectedPair(pc);
      if (pair) emit("selected-candidate-pair", { side, ...pair });
      if (pcManager?.getConnectedAddress) {
        try {
          const addr = await pcManager.getConnectedAddress();
          if (addr) emit("connected-address", { side, address: addr });
        } catch {
          // ignore
        }
      }
    }
  };
  const onConnectionStateChange = () => emit("pc-connection-state", { side, state: pc.connectionState });
  const onIceGatheringStateChange = () => emit("ice-gathering-state", { side, state: pc.iceGatheringState });
  const onSignalingStateChange = () => emit("signaling-state", { side, state: pc.signalingState });
  const onNegotiationNeeded = () => emit("negotiation-needed", { side });
  const onDataChannel = (ev: RTCDataChannelEvent) =>
    emit("data-channel-opened", {
      side,
      label: ev.channel.label,
      ordered: ev.channel.ordered,
      protocol: ev.channel.protocol,
    });
  const onTrack = (ev: RTCTrackEvent) =>
    emit("track-received", { side, kind: ev.track.kind, id: ev.track.id, label: ev.track.label });

  pc.addEventListener("icecandidate", onIceCandidate);
  pc.addEventListener("icecandidateerror", onIceCandidateError);
  pc.addEventListener("iceconnectionstatechange", onIceConnectionStateChange);
  pc.addEventListener("connectionstatechange", onConnectionStateChange);
  pc.addEventListener("icegatheringstatechange", onIceGatheringStateChange);
  pc.addEventListener("signalingstatechange", onSignalingStateChange);
  pc.addEventListener("negotiationneeded", onNegotiationNeeded);
  pc.addEventListener("datachannel", onDataChannel);
  pc.addEventListener("track", onTrack);

  return () => {
    pc.removeEventListener("icecandidate", onIceCandidate);
    pc.removeEventListener("icecandidateerror", onIceCandidateError);
    pc.removeEventListener("iceconnectionstatechange", onIceConnectionStateChange);
    pc.removeEventListener("connectionstatechange", onConnectionStateChange);
    pc.removeEventListener("icegatheringstatechange", onIceGatheringStateChange);
    pc.removeEventListener("signalingstatechange", onSignalingStateChange);
    pc.removeEventListener("negotiationneeded", onNegotiationNeeded);
    pc.removeEventListener("datachannel", onDataChannel);
    pc.removeEventListener("track", onTrack);
  };
}

// Re-export for convenience so consumers know what's available.
export { Track };
