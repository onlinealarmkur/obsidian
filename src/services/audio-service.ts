import { MAX_SOUND_DURATION_MS, MAX_VOLUME, MIN_VOLUME, SOUND_PREVIEW_DURATION_MS } from "../constants";

interface Playback {
  generation: number;
  context: AudioContext;
  oscillator?: OscillatorNode;
  gain?: GainNode;
  stopTimer?: number;
  closed: boolean;
}

interface PlaybackRequest {
  playback?: Playback;
  cancelled: boolean;
}

export interface AudioPlaybackHandle {
  readonly started: Promise<boolean>;
  stop: () => void;
}

export class AudioService {
  private generation = 0;
  private playback?: Playback;

  public async play(volume: number): Promise<boolean> {
    return (await this.startPlayback(volume, MAX_SOUND_DURATION_MS)) !== undefined;
  }

  public playPreview(volume: number): AudioPlaybackHandle {
    const request: PlaybackRequest = { cancelled: false };
    const started = this.startPlayback(volume, SOUND_PREVIEW_DURATION_MS, request)
      .then((playback) => playback !== undefined);
    return {
      started,
      stop: () => {
        request.cancelled = true;
        if (request.playback !== undefined) this.stopIfCurrent(request.playback);
      }
    };
  }

  public stop(): void {
    ++this.generation;
    const playback = this.playback;
    this.playback = undefined;
    if (playback !== undefined) this.closePlayback(playback);
  }

  private async startPlayback(volume: number, durationMs: number, request?: PlaybackRequest): Promise<Playback | undefined> {
    const generation = ++this.generation;
    const previousPlayback = this.playback;
    this.playback = undefined;
    if (previousPlayback !== undefined) this.closePlayback(previousPlayback);
    try {
      const AudioContextConstructor = window.AudioContext;
      const context = new AudioContextConstructor();
      const playback: Playback = { generation, context, closed: false };
      if (request !== undefined) request.playback = playback;
      this.playback = playback;
      await context.resume();
      if (request?.cancelled === true || !this.isCurrent(playback)) {
        this.stopIfCurrent(playback);
        this.closePlayback(playback);
        return undefined;
      }
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      playback.oscillator = oscillator;
      playback.gain = gain;
      oscillator.type = "sine";
      oscillator.frequency.value = 880;
      const normalizedVolume = Math.max(MIN_VOLUME, Math.min(MAX_VOLUME, volume)) / MAX_VOLUME;
      const maximumGain = normalizedVolume * 0.18;
      gain.gain.setValueAtTime(0, context.currentTime);
      for (let offset = 0; offset < durationMs / 1_000; offset += 0.8) {
        gain.gain.setValueAtTime(0, context.currentTime + offset);
        gain.gain.linearRampToValueAtTime(maximumGain, context.currentTime + offset + 0.03);
        gain.gain.setValueAtTime(maximumGain, context.currentTime + offset + 0.25);
        gain.gain.linearRampToValueAtTime(0, context.currentTime + offset + 0.32);
      }
      oscillator.connect(gain);
      gain.connect(context.destination);
      oscillator.start();
      playback.stopTimer = window.setTimeout(() => {
        this.stopIfCurrent(playback);
      }, durationMs);
      return playback;
    } catch {
      const playback = this.playback;
      if (playback?.generation === generation) {
        this.playback = undefined;
        this.closePlayback(playback);
      }
      return undefined;
    }
  }

  private stopIfCurrent(playback: Playback): void {
    if (!this.isCurrent(playback)) return;
    ++this.generation;
    this.playback = undefined;
    this.closePlayback(playback);
  }

  private isCurrent(playback: Playback): boolean {
    return this.playback === playback && this.generation === playback.generation && !playback.closed;
  }

  private closePlayback(playback: Playback): void {
    if (playback.closed) return;
    playback.closed = true;
    if (playback.stopTimer !== undefined) window.clearTimeout(playback.stopTimer);
    try { playback.oscillator?.stop(); } catch { /* The oscillator may already be stopped. */ }
    try { playback.oscillator?.disconnect(); } catch { /* The audio node may already be disconnected. */ }
    try { playback.gain?.disconnect(); } catch { /* The audio node may already be disconnected. */ }
    try { void playback.context.close().catch(() => undefined); } catch { /* The context may already be closed. */ }
  }
}
