import type { LocalTrack, RemoteTrack, Room } from "livekit-client";
import type { StatsProvider } from "./webrtc-stats";

export function createLiveKitStatsProvider(room: Room): StatsProvider {
  let uid = 0;

  const collectFromTrack = async (
    track: LocalTrack | RemoteTrack | undefined,
    entries: Array<[string, unknown]>,
  ): Promise<void> => {
    if (!track) return;
    let report: RTCStatsReport | undefined;
    try {
      report = await track.getRTCStatsReport();
    } catch {
      return;
    }
    if (!report) return;
    report.forEach((stat, id) => {
      entries.push([`${id}#${uid++}`, stat]);
    });
  };

  return {
    async getStats(): Promise<RTCStatsReport> {
      const entries: Array<[string, unknown]> = [];

      for (const pub of room.localParticipant.trackPublications.values()) {
        await collectFromTrack(pub.track, entries);
      }

      for (const participant of room.remoteParticipants.values()) {
        for (const pub of participant.trackPublications.values()) {
          await collectFromTrack(pub.track as RemoteTrack | undefined, entries);
        }
      }

      return new Map(entries) as unknown as RTCStatsReport;
    },
  };
}
