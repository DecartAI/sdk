/**
 * Wraps `globalThis.RTCPeerConnection` to drop TCP ICE candidates so the
 * realtime media path only attempts UDP (direct UDP host/srflx and TURN-UDP).
 *
 * Why this exists — it's a quality-of-experience knob, not a security one.
 * In production ~10% of clients negotiate TCP to the SFU when their UDP ICE
 * checks fail, even though ~90% of those clients had a working `udp srflx`
 * candidate (so UDP works at the network layer; it's the SFU-specific UDP
 * path that's lossy enough to lose connectivity checks). WebRTC media over
 * TCP is the worst of both worlds: TCP's head-of-line blocking and
 * retransmits fight WebRTC's real-time pacing and produce the stalls and
 * choppy playback customers report. Forcing UDP-only either succeeds (good
 * experience) or fails fast (clean error the app can show) — both are
 * preferable to a session limping along on TCP.
 *
 * TCP candidates can reach a `PeerConnection` through three independent
 * paths, so the filter closes all three:
 *  1. `RTCConfiguration.iceServers` — strip `?transport=tcp` and `turns:`
 *     URLs so the browser never gathers TURN-TCP/TLS relay candidates.
 *  2. `setRemoteDescription` SDP — strip `a=candidate ... TCP ...` lines so
 *     the SFU's TCP host candidate is never paired against ours.
 *  3. `addIceCandidate` — drop trickled TCP candidates that arrive after
 *     the initial SDP exchange.
 *
 * The patch is reference-counted: the first `installIceFilter` swaps
 * `globalThis.RTCPeerConnection` for a `Proxy`, the matching uninstall
 * restores the original constructor when the last caller releases.
 *
 * Opting out: a caller who insists on keeping TCP — e.g. an app whose
 * users sit behind networks that block UDP entirely — passes
 * `allowTcp: true` and gets the unfiltered constructor back. Default is
 * `false` because in our 48h sample only ~0.4% of total sessions had no
 * UDP candidate at all and would actually benefit from TCP fallback.
 */

export interface IceFilterOptions {
  /**
   * Opt out of TCP filtering. Default `false` (TCP candidates blocked).
   * Set to `true` for callers whose users need TCP fallback because UDP
   * is unreachable on their network — at the cost of the choppy-playback
   * behavior we're trying to avoid.
   */
  allowTcp: boolean;
}

type PeerConnectionCtor = typeof RTCPeerConnection;

interface InstalledState {
  original: PeerConnectionCtor;
}

let installed: InstalledState | null = null;
let refcount = 0;

/**
 * Patch `globalThis.RTCPeerConnection` to drop TCP ICE candidates.
 * Returns an uninstall function — call it when the session ends to release.
 *
 * If `allowTcp` is true, this is a no-op and the returned function is also a no-op.
 * If `RTCPeerConnection` is not available in the runtime (Node without polyfill),
 * this is a no-op.
 */
export function installIceFilter(options: IceFilterOptions): () => void {
  if (options.allowTcp) return noop;

  const ctor = (globalThis as { RTCPeerConnection?: PeerConnectionCtor }).RTCPeerConnection;
  if (!ctor) return noop;

  refcount += 1;
  if (!installed) {
    installed = { original: ctor };
    (globalThis as { RTCPeerConnection?: PeerConnectionCtor }).RTCPeerConnection = makeFilteredPeerConnection(ctor);
  }

  let released = false;
  return () => {
    if (released) return;
    released = true;
    refcount -= 1;
    if (refcount <= 0) {
      refcount = 0;
      if (installed) {
        (globalThis as { RTCPeerConnection?: PeerConnectionCtor }).RTCPeerConnection = installed.original;
        installed = null;
      }
    }
  };
}

function noop(): void {
  /* no-op */
}

function makeFilteredPeerConnection(Original: PeerConnectionCtor): PeerConnectionCtor {
  return new Proxy(Original, {
    construct(target, args) {
      const [config, ...rest] = args as [RTCConfiguration | undefined, ...unknown[]];
      const filteredConfig = filterRtcConfiguration(config);
      const pc = Reflect.construct(target, [filteredConfig, ...rest]);
      attachInstanceFilters(pc);
      return pc;
    },
  }) as PeerConnectionCtor;
}

/**
 * Filter `iceServers` URLs to remove TCP-TURN entries (and TURNS, which is TLS-over-TCP).
 * Returns the config unmodified if there is nothing to filter.
 */
export function filterRtcConfiguration(config: RTCConfiguration | undefined): RTCConfiguration | undefined {
  if (!config?.iceServers || config.iceServers.length === 0) return config;
  const filteredServers = config.iceServers
    .map((server) => filterIceServer(server))
    .filter((server): server is RTCIceServer => server !== null);
  return { ...config, iceServers: filteredServers };
}

function filterIceServer(server: RTCIceServer): RTCIceServer | null {
  const rawUrls = server.urls;
  const urls = Array.isArray(rawUrls) ? rawUrls : [rawUrls];
  const filtered = urls.filter((url) => typeof url === "string" && !isTcpTurnUrl(url));
  if (filtered.length === 0) return null;
  return { ...server, urls: filtered.length === 1 ? filtered[0] : filtered };
}

/**
 * `turn:host:port?transport=tcp` → TCP transport to TURN. Drop.
 * `turns:host:port` (any scheme starting `turns:`) → TLS-over-TCP. Drop.
 * `turn:host:port` (no transport) → defaults to UDP. Keep.
 * `turn:host:port?transport=udp` → UDP. Keep.
 * Anything that is not `turn:` or `turns:` (e.g. `stun:`) → Keep.
 */
export function isTcpTurnUrl(url: string): boolean {
  const lower = url.toLowerCase();
  if (lower.startsWith("turns:")) return true;
  if (!lower.startsWith("turn:")) return false;
  return /[?&]transport=tcp\b/.test(lower);
}

function attachInstanceFilters(pc: RTCPeerConnection): void {
  const originalSetRemoteDescription = pc.setRemoteDescription.bind(pc);
  pc.setRemoteDescription = function patchedSetRemoteDescription(
    description: RTCSessionDescriptionInit,
  ): Promise<void> {
    return originalSetRemoteDescription(filterTcpFromSdp(description));
  } as RTCPeerConnection["setRemoteDescription"];

  const originalAddIceCandidate = pc.addIceCandidate.bind(pc);
  pc.addIceCandidate = function patchedAddIceCandidate(
    candidate?: RTCIceCandidateInit | RTCIceCandidate,
  ): Promise<void> {
    if (isTcpIceCandidate(candidate)) return Promise.resolve();
    return originalAddIceCandidate(candidate);
  } as RTCPeerConnection["addIceCandidate"];
}

/**
 * Returns true if the given candidate is a TCP candidate that should be dropped.
 * Accepts both `RTCIceCandidate` (has `.protocol`) and `RTCIceCandidateInit`
 * (only has the raw `candidate` string).
 */
export function isTcpIceCandidate(candidate: RTCIceCandidate | RTCIceCandidateInit | null | undefined): boolean {
  if (!candidate) return false;
  // End-of-candidates marker has empty `candidate` string — leave alone.
  const candidateString = "candidate" in candidate ? (candidate.candidate ?? "") : "";
  // Prefer the parsed `.protocol` on real RTCIceCandidate objects.
  const protocol = (candidate as RTCIceCandidate).protocol;
  if (typeof protocol === "string") {
    return protocol.toLowerCase() === "tcp";
  }
  if (!candidateString) return false;
  return isTcpCandidateString(candidateString);
}

/**
 * SDP candidate format (RFC 5245):
 *   `candidate:<foundation> <component> <transport> <priority> <ip> <port> typ <type> ...`
 * The transport token is the 3rd whitespace-separated field. We only drop when
 * that token is TCP (case-insensitive), to avoid matching IP/port strings that
 * coincidentally contain "tcp".
 */
export function isTcpCandidateString(candidateLine: string): boolean {
  // Strip the leading "a=" if present (SDP context) and the "candidate:" prefix.
  let body = candidateLine.trim();
  if (body.startsWith("a=")) body = body.slice(2);
  if (body.startsWith("candidate:")) body = body.slice("candidate:".length);
  const fields = body.split(/\s+/);
  if (fields.length < 3) return false;
  return fields[2].toLowerCase() === "tcp";
}

/**
 * Strip TCP `a=candidate:` lines from an SDP description.
 * Preserves the description's `type` and any other fields; mutates only `sdp`.
 */
export function filterTcpFromSdp(description: RTCSessionDescriptionInit): RTCSessionDescriptionInit {
  if (!description.sdp) return description;
  const lines = description.sdp.split(/\r?\n/);
  let dropped = 0;
  const kept: string[] = [];
  for (const line of lines) {
    if (line.startsWith("a=candidate:") && isTcpCandidateString(line)) {
      dropped += 1;
      continue;
    }
    kept.push(line);
  }
  if (dropped === 0) return description;
  return { ...description, sdp: kept.join("\r\n") };
}
