import { afterEach, describe, expect, it, vi } from "vitest";

import {
  filterRtcConfiguration,
  filterTcpFromSdp,
  installIceFilter,
  isTcpCandidateString,
  isTcpIceCandidate,
  isTcpTurnUrl,
} from "../src/realtime/webrtc-ice-filter.js";

describe("isTcpTurnUrl", () => {
  it("flags turn:?transport=tcp as TCP", () => {
    expect(isTcpTurnUrl("turn:turn.decart.ai:3478?transport=tcp")).toBe(true);
  });

  it("flags turns: as TCP (TLS over TCP)", () => {
    expect(isTcpTurnUrl("turns:turn.decart.ai:443?transport=tcp")).toBe(true);
    expect(isTcpTurnUrl("turns:turn.decart.ai:5349")).toBe(true);
  });

  it("keeps turn: with explicit UDP transport", () => {
    expect(isTcpTurnUrl("turn:35.93.188.1:3478?transport=udp")).toBe(false);
  });

  it("keeps turn: without explicit transport (defaults to UDP)", () => {
    expect(isTcpTurnUrl("turn:35.93.188.1:3478")).toBe(false);
  });

  it("keeps stun: URLs", () => {
    expect(isTcpTurnUrl("stun:stun.l.google.com:19302")).toBe(false);
  });

  it("is case-insensitive on scheme + transport", () => {
    expect(isTcpTurnUrl("TURNS:turn.decart.ai:443")).toBe(true);
    expect(isTcpTurnUrl("Turn:host:3478?Transport=TCP")).toBe(true);
  });
});

describe("isTcpCandidateString", () => {
  it("flags TCP candidate lines", () => {
    expect(isTcpCandidateString("candidate:1 1 TCP 1518280447 192.168.1.1 9 typ host tcptype active")).toBe(true);
  });

  it("flags TCP candidate lines with a= prefix", () => {
    expect(isTcpCandidateString("a=candidate:1 1 TCP 1518280447 192.168.1.1 9 typ host tcptype active")).toBe(true);
  });

  it("keeps UDP candidate lines", () => {
    expect(isTcpCandidateString("candidate:2 1 UDP 2122252543 10.0.0.1 56432 typ host")).toBe(false);
  });

  it("is case-insensitive on the transport token", () => {
    expect(isTcpCandidateString("candidate:1 1 tcp 1518280447 192.168.1.1 9 typ host")).toBe(true);
    expect(isTcpCandidateString("candidate:1 1 udp 2122252543 10.0.0.1 56432 typ host")).toBe(false);
  });

  it("returns false for malformed strings without transport token", () => {
    expect(isTcpCandidateString("candidate:foo")).toBe(false);
    expect(isTcpCandidateString("")).toBe(false);
  });
});

describe("isTcpIceCandidate", () => {
  it("uses RTCIceCandidate.protocol when available", () => {
    expect(isTcpIceCandidate({ protocol: "tcp" } as RTCIceCandidate)).toBe(true);
    expect(isTcpIceCandidate({ protocol: "udp" } as RTCIceCandidate)).toBe(false);
  });

  it("falls back to parsing the candidate string in RTCIceCandidateInit", () => {
    const tcpInit: RTCIceCandidateInit = {
      candidate: "candidate:1 1 TCP 1518280447 192.168.1.1 9 typ host tcptype active",
      sdpMid: "0",
    };
    expect(isTcpIceCandidate(tcpInit)).toBe(true);
    const udpInit: RTCIceCandidateInit = {
      candidate: "candidate:2 1 UDP 2122252543 10.0.0.1 56432 typ host",
      sdpMid: "0",
    };
    expect(isTcpIceCandidate(udpInit)).toBe(false);
  });

  it("returns false for end-of-candidates marker (empty candidate string)", () => {
    expect(isTcpIceCandidate({ candidate: "", sdpMid: "0" })).toBe(false);
  });

  it("returns false for null/undefined", () => {
    expect(isTcpIceCandidate(null)).toBe(false);
    expect(isTcpIceCandidate(undefined)).toBe(false);
  });
});

describe("filterRtcConfiguration", () => {
  it("drops TURN-TCP and TURNS URLs while keeping UDP ones", () => {
    const config: RTCConfiguration = {
      iceServers: [
        {
          urls: [
            "turn:35.93.188.1:3478?transport=udp",
            "turns:turn.decart.ai:443?transport=tcp",
            "stun:stun.l.google.com:19302",
          ],
          username: "user",
          credential: "secret",
        },
      ],
    };
    const filtered = filterRtcConfiguration(config);
    expect(filtered?.iceServers).toEqual([
      {
        urls: ["turn:35.93.188.1:3478?transport=udp", "stun:stun.l.google.com:19302"],
        username: "user",
        credential: "secret",
      },
    ]);
  });

  it("flattens single-element urls back to a string", () => {
    const config: RTCConfiguration = {
      iceServers: [{ urls: ["turn:host:3478?transport=udp", "turns:host:443"] }],
    };
    const filtered = filterRtcConfiguration(config);
    expect(filtered?.iceServers).toEqual([{ urls: "turn:host:3478?transport=udp" }]);
  });

  it("drops servers whose URLs are entirely TCP", () => {
    const config: RTCConfiguration = {
      iceServers: [{ urls: ["turns:turn.decart.ai:443"] }, { urls: ["turn:35.93.188.1:3478?transport=udp"] }],
    };
    const filtered = filterRtcConfiguration(config);
    expect(filtered?.iceServers).toEqual([{ urls: "turn:35.93.188.1:3478?transport=udp" }]);
  });

  it("returns the original config unchanged if there are no iceServers", () => {
    const config: RTCConfiguration = { iceTransportPolicy: "all" };
    expect(filterRtcConfiguration(config)).toEqual(config);
  });

  it("returns undefined for undefined input", () => {
    expect(filterRtcConfiguration(undefined)).toBeUndefined();
  });
});

describe("filterTcpFromSdp", () => {
  const sdp = [
    "v=0",
    "o=- 1 2 IN IP4 0.0.0.0",
    "s=-",
    "m=video 9 UDP/TLS/RTP/SAVPF 96",
    "a=candidate:1 1 UDP 2122252543 10.0.0.1 56432 typ host",
    "a=candidate:2 1 TCP 1518280447 10.0.0.1 9 typ host tcptype active",
    "a=candidate:3 1 udp 1694498815 1.2.3.4 56432 typ srflx raddr 10.0.0.1 rport 56432",
    "a=candidate:4 1 tcp 1518214143 1.2.3.4 9 typ srflx raddr 10.0.0.1 rport 9 tcptype passive",
    "a=end-of-candidates",
  ].join("\r\n");

  it("removes TCP a=candidate lines and keeps everything else", () => {
    const result = filterTcpFromSdp({ type: "offer", sdp });
    expect(result.sdp).toBeDefined();
    expect(result.sdp).not.toMatch(/candidate:2/);
    expect(result.sdp).not.toMatch(/candidate:4/);
    expect(result.sdp).toMatch(/candidate:1 1 UDP/);
    expect(result.sdp).toMatch(/candidate:3 1 udp/);
    expect(result.sdp).toMatch(/a=end-of-candidates/);
  });

  it("returns the input unchanged when there are no TCP candidates", () => {
    const udpOnly = ["v=0", "a=candidate:1 1 UDP 2122252543 10.0.0.1 56432 typ host"].join("\r\n");
    const input = { type: "offer" as const, sdp: udpOnly };
    expect(filterTcpFromSdp(input)).toBe(input);
  });

  it("returns the input unchanged when sdp is undefined", () => {
    const input = { type: "offer" as const };
    expect(filterTcpFromSdp(input)).toBe(input);
  });
});

describe("installIceFilter", () => {
  let originalCtor: typeof RTCPeerConnection | undefined;

  afterEach(() => {
    // Restore whatever global may have been set up by tests.
    (globalThis as { RTCPeerConnection?: typeof RTCPeerConnection }).RTCPeerConnection = originalCtor;
    originalCtor = undefined;
  });

  it("is a no-op when allowTcp is true", () => {
    const stubCtor = vi.fn() as unknown as typeof RTCPeerConnection;
    originalCtor = stubCtor;
    (globalThis as { RTCPeerConnection?: typeof RTCPeerConnection }).RTCPeerConnection = stubCtor;
    const release = installIceFilter({ allowTcp: true });
    expect((globalThis as { RTCPeerConnection?: typeof RTCPeerConnection }).RTCPeerConnection).toBe(stubCtor);
    release(); // should not throw
  });

  it("is a no-op when RTCPeerConnection is undefined (Node without polyfill)", () => {
    originalCtor = (globalThis as { RTCPeerConnection?: typeof RTCPeerConnection }).RTCPeerConnection;
    delete (globalThis as { RTCPeerConnection?: typeof RTCPeerConnection }).RTCPeerConnection;
    const release = installIceFilter({ allowTcp: false });
    expect((globalThis as { RTCPeerConnection?: typeof RTCPeerConnection }).RTCPeerConnection).toBeUndefined();
    release();
  });

  it("wraps RTCPeerConnection and restores on last release (refcounted)", () => {
    const stubCtor = vi.fn(function StubPC(this: object, config: RTCConfiguration | undefined) {
      Object.assign(this, {
        _config: config,
        setRemoteDescription: vi.fn(async (_d: RTCSessionDescriptionInit) => {}),
        addIceCandidate: vi.fn(async (_c?: RTCIceCandidateInit | RTCIceCandidate) => {}),
      });
    }) as unknown as typeof RTCPeerConnection;
    originalCtor = stubCtor;
    (globalThis as { RTCPeerConnection?: typeof RTCPeerConnection }).RTCPeerConnection = stubCtor;

    const release1 = installIceFilter({ allowTcp: false });
    const wrapped1 = (globalThis as { RTCPeerConnection?: typeof RTCPeerConnection }).RTCPeerConnection;
    expect(wrapped1).not.toBe(stubCtor);

    const release2 = installIceFilter({ allowTcp: false });
    const wrapped2 = (globalThis as { RTCPeerConnection?: typeof RTCPeerConnection }).RTCPeerConnection;
    expect(wrapped2).toBe(wrapped1); // same wrapper across nested installs

    release1();
    expect((globalThis as { RTCPeerConnection?: typeof RTCPeerConnection }).RTCPeerConnection).toBe(wrapped1); // still wrapped
    release2();
    expect((globalThis as { RTCPeerConnection?: typeof RTCPeerConnection }).RTCPeerConnection).toBe(stubCtor); // restored
  });

  it("filters TCP TURN URLs from the constructor config", () => {
    const seenConfigs: Array<RTCConfiguration | undefined> = [];
    const stubCtor = vi.fn(function StubPC(this: object, config: RTCConfiguration | undefined) {
      seenConfigs.push(config);
      Object.assign(this, {
        setRemoteDescription: vi.fn(async (_d: RTCSessionDescriptionInit) => {}),
        addIceCandidate: vi.fn(async (_c?: RTCIceCandidateInit | RTCIceCandidate) => {}),
      });
    }) as unknown as typeof RTCPeerConnection;
    originalCtor = stubCtor;
    (globalThis as { RTCPeerConnection?: typeof RTCPeerConnection }).RTCPeerConnection = stubCtor;

    const release = installIceFilter({ allowTcp: false });
    try {
      const PC = (globalThis as { RTCPeerConnection?: typeof RTCPeerConnection }).RTCPeerConnection;
      if (!PC) throw new Error("expected wrapped constructor");
      new PC({
        iceServers: [
          {
            urls: ["turn:host:3478?transport=udp", "turns:host:443?transport=tcp"],
            username: "u",
            credential: "c",
          },
        ],
      });
      expect(seenConfigs).toHaveLength(1);
      expect(seenConfigs[0]?.iceServers).toEqual([
        { urls: "turn:host:3478?transport=udp", username: "u", credential: "c" },
      ]);
    } finally {
      release();
    }
  });

  it("filters TCP candidates passed to addIceCandidate", async () => {
    let realAddIceCalls = 0;
    const stubCtor = vi.fn(function StubPC(this: object) {
      Object.assign(this, {
        setRemoteDescription: vi.fn(async (_d: RTCSessionDescriptionInit) => {}),
        addIceCandidate: vi.fn(async (_c?: RTCIceCandidateInit | RTCIceCandidate) => {
          realAddIceCalls += 1;
        }),
      });
    }) as unknown as typeof RTCPeerConnection;
    originalCtor = stubCtor;
    (globalThis as { RTCPeerConnection?: typeof RTCPeerConnection }).RTCPeerConnection = stubCtor;

    const release = installIceFilter({ allowTcp: false });
    try {
      const PC = (globalThis as { RTCPeerConnection?: typeof RTCPeerConnection }).RTCPeerConnection;
      if (!PC) throw new Error("expected wrapped constructor");
      const pc = new PC();
      await pc.addIceCandidate({
        candidate: "candidate:1 1 TCP 1518280447 1.2.3.4 9 typ host tcptype active",
        sdpMid: "0",
      });
      await pc.addIceCandidate({ candidate: "candidate:2 1 UDP 2122252543 1.2.3.4 56432 typ host", sdpMid: "0" });
      expect(realAddIceCalls).toBe(1); // only the UDP one passes through
    } finally {
      release();
    }
  });

  it("filters TCP candidate lines from SDP in setRemoteDescription", async () => {
    let receivedSdp: string | undefined;
    const stubCtor = vi.fn(function StubPC(this: object) {
      Object.assign(this, {
        setRemoteDescription: vi.fn(async (d: RTCSessionDescriptionInit) => {
          receivedSdp = d.sdp;
        }),
        addIceCandidate: vi.fn(async (_c?: RTCIceCandidateInit | RTCIceCandidate) => {}),
      });
    }) as unknown as typeof RTCPeerConnection;
    originalCtor = stubCtor;
    (globalThis as { RTCPeerConnection?: typeof RTCPeerConnection }).RTCPeerConnection = stubCtor;

    const release = installIceFilter({ allowTcp: false });
    try {
      const PC = (globalThis as { RTCPeerConnection?: typeof RTCPeerConnection }).RTCPeerConnection;
      if (!PC) throw new Error("expected wrapped constructor");
      const pc = new PC();
      const sdp = [
        "v=0",
        "a=candidate:1 1 UDP 2122252543 10.0.0.1 56432 typ host",
        "a=candidate:2 1 TCP 1518280447 10.0.0.1 9 typ host tcptype active",
        "a=end-of-candidates",
      ].join("\r\n");
      await pc.setRemoteDescription({ type: "offer", sdp });
      expect(receivedSdp).toBeDefined();
      expect(receivedSdp).toMatch(/candidate:1 1 UDP/);
      expect(receivedSdp).not.toMatch(/candidate:2 1 TCP/);
    } finally {
      release();
    }
  });
});
