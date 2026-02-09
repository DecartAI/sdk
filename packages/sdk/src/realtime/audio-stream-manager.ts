/**
 * Manages an audio stream for live_avatar mode.
 * Creates a continuous audio stream that outputs silence by default,
 * and allows playing audio files through the stream.
 */
export class AudioStreamManager {
  private audioContext: AudioContext;
  private destination: MediaStreamAudioDestinationNode;
  private silenceOscillator: OscillatorNode;
  private silenceGain: GainNode;
  private currentSource: AudioBufferSourceNode | null = null;
  private _isPlaying = false;

  constructor() {
    this.audioContext = new AudioContext();
    this.destination = this.audioContext.createMediaStreamDestination();

    // Create silence generator: oscillator → gain(0) → destination
    // This ensures continuous audio frames are sent even when no audio is playing
    this.silenceOscillator = this.audioContext.createOscillator();
    this.silenceGain = this.audioContext.createGain();
    this.silenceGain.gain.value = 0; // Silent

    this.silenceOscillator.connect(this.silenceGain);
    this.silenceGain.connect(this.destination);
    this.silenceOscillator.start();
  }

  /**
   * Get the MediaStream to pass to WebRTC.
   * This stream outputs silence when no audio is playing.
   */
  getStream(): MediaStream {
    return this.destination.stream;
  }

  /**
   * Check if audio is currently playing.
   */
  isPlaying(): boolean {
    return this._isPlaying;
  }

  /**
   * Play audio through the stream.
   * When the audio ends, the stream automatically reverts to silence.
   * @param audio - Audio data as Blob, File, or ArrayBuffer
   * @returns Promise that resolves when audio finishes playing
   */
  async playAudio(audio: Blob | File | ArrayBuffer): Promise<void> {
    // Ensure AudioContext is running (may be suspended due to autoplay policy)
    if (this.audioContext.state === "suspended") {
      await this.audioContext.resume();
    }

    // Stop any currently playing audio
    if (this._isPlaying) {
      this.stopAudio();
    }

    // Convert to ArrayBuffer if needed
    let arrayBuffer: ArrayBuffer;
    if (audio instanceof ArrayBuffer) {
      arrayBuffer = audio;
    } else {
      arrayBuffer = await audio.arrayBuffer();
    }

    // Decode the audio data
    const audioBuffer = await this.audioContext.decodeAudioData(arrayBuffer);

    // Create and configure the source node
    const source = this.audioContext.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(this.destination);

    this.currentSource = source;
    this._isPlaying = true;

    // Return a promise that resolves when audio ends
    return new Promise<void>((resolve) => {
      source.onended = () => {
        this._isPlaying = false;
        this.currentSource = null;
        resolve();
      };
      source.start();
    });
  }

  /**
   * Stop currently playing audio immediately.
   * The stream will revert to silence.
   */
  stopAudio(): void {
    if (this.currentSource) {
      try {
        this.currentSource.stop();
      } catch {
        // Ignore errors if already stopped
      }
      this.currentSource = null;
    }
    this._isPlaying = false;
  }

  /**
   * Clean up resources.
   */
  cleanup(): void {
    this.stopAudio();
    try {
      this.silenceOscillator.stop();
    } catch {
      // Ignore if already stopped
    }
    void this.audioContext.close().catch(() => {});
  }
}
