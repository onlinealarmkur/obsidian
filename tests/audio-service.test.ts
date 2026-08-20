import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_SOUND_DURATION_MS, SOUND_PREVIEW_DURATION_MS } from "../src/constants";
import { AudioService } from "../src/services/audio-service";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolvePromise: ((value: T) => void) | undefined;
  let rejectPromise: ((reason: unknown) => void) | undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return {
    promise,
    resolve: (value) => resolvePromise?.(value),
    reject: (reason) => rejectPromise?.(reason)
  };
}

class FakeOscillator {
  public type = "sine";
  public readonly frequency = { value: 0 };
  public startCount = 0;
  public stopCount = 0;
  public throwOnDisconnect = false;

  public connect(_target: unknown): void {
    return;
  }

  public disconnect(): void {
    if (this.throwOnDisconnect) throw new Error("oscillator disconnect failed");
  }

  public start(): void {
    ++this.startCount;
  }

  public stop(): void {
    ++this.stopCount;
  }
}

class FakeGain {
  public readonly gain = {
    setValueAtTime: (_value: number, _time: number): void => undefined,
    linearRampToValueAtTime: (_value: number, _time: number): void => undefined
  };
  public throwOnDisconnect = false;

  public connect(_target: unknown): void {
    return;
  }

  public disconnect(): void {
    if (this.throwOnDisconnect) throw new Error("gain disconnect failed");
  }
}

class FakeAudioContext {
  public static readonly instances: FakeAudioContext[] = [];
  public readonly currentTime = 0;
  public readonly destination = {};
  public readonly resumeDeferred = deferred<undefined>();
  public readonly oscillators: FakeOscillator[] = [];
  public readonly gains: FakeGain[] = [];
  public closeCount = 0;
  public throwOnClose = false;

  public constructor() {
    FakeAudioContext.instances.push(this);
  }

  public resume(): Promise<void> {
    return this.resumeDeferred.promise;
  }

  public createOscillator(): FakeOscillator {
    const oscillator = new FakeOscillator();
    this.oscillators.push(oscillator);
    return oscillator;
  }

  public createGain(): FakeGain {
    const gain = new FakeGain();
    this.gains.push(gain);
    return gain;
  }

  public close(): Promise<void> {
    ++this.closeCount;
    if (this.throwOnClose) throw new Error("context close failed");
    return Promise.resolve();
  }
}

describe("AudioService", () => {
  beforeEach(() => {
    FakeAudioContext.instances.length = 0;
    vi.useFakeTimers();
    vi.stubGlobal("window", {
      AudioContext: FakeAudioContext,
      clearTimeout: globalThis.clearTimeout,
      setTimeout: globalThis.setTimeout
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("cancels a play whose context resume is still pending", async () => {
    const service = new AudioService();
    const playing = service.play(70);
    const context = FakeAudioContext.instances[0];
    expect(context).toBeDefined();

    service.stop();
    context?.resumeDeferred.resolve(undefined);

    await expect(playing).resolves.toBe(false);
    expect(context?.oscillators).toHaveLength(0);
    expect(context?.closeCount).toBe(1);
  });

  it("fails closed when the desktop does not expose Web Audio", async () => {
    vi.stubGlobal("window", {
      clearTimeout: globalThis.clearTimeout,
      setTimeout: globalThis.setTimeout
    });
    const service = new AudioService();

    await expect(service.play(70)).resolves.toBe(false);
    expect(() => service.stop()).not.toThrow();
  });

  it("allows only the newest overlapping play to become audible", async () => {
    const service = new AudioService();
    const first = service.play(50);
    const firstContext = FakeAudioContext.instances[0];
    const second = service.play(80);
    const secondContext = FakeAudioContext.instances[1];

    secondContext?.resumeDeferred.resolve(undefined);
    await expect(second).resolves.toBe(true);
    firstContext?.resumeDeferred.resolve(undefined);
    await expect(first).resolves.toBe(false);

    expect(firstContext?.oscillators).toHaveLength(0);
    expect(secondContext?.oscillators[0]?.startCount).toBe(1);
    expect(secondContext?.oscillators[0]?.stopCount).toBe(0);
  });

  it("does not let an old resume failure stop newer playback", async () => {
    const service = new AudioService();
    const first = service.play(50);
    const firstContext = FakeAudioContext.instances[0];
    const second = service.play(80);
    const secondContext = FakeAudioContext.instances[1];

    secondContext?.resumeDeferred.resolve(undefined);
    await expect(second).resolves.toBe(true);
    firstContext?.resumeDeferred.reject(new Error("old resume failed"));
    await expect(first).resolves.toBe(false);

    expect(secondContext?.oscillators[0]?.stopCount).toBe(0);
    expect(secondContext?.closeCount).toBe(0);
  });

  it("automatically stops an oscillator exactly once", async () => {
    const service = new AudioService();
    const playing = service.play(70);
    const context = FakeAudioContext.instances[0];
    context?.resumeDeferred.resolve(undefined);
    await expect(playing).resolves.toBe(true);

    await vi.advanceTimersByTimeAsync(MAX_SOUND_DURATION_MS);
    await vi.advanceTimersByTimeAsync(MAX_SOUND_DURATION_MS);

    expect(context?.oscillators[0]?.stopCount).toBe(1);
    expect(context?.closeCount).toBe(1);
  });

  it("uses a short preview duration and lets its handle stop playback early", async () => {
    const service = new AudioService();
    const preview = service.playPreview(70);
    const context = FakeAudioContext.instances[0];
    context?.resumeDeferred.resolve(undefined);

    await expect(preview.started).resolves.toBe(true);
    await vi.advanceTimersByTimeAsync(SOUND_PREVIEW_DURATION_MS - 1);
    expect(context?.oscillators[0]?.stopCount).toBe(0);

    preview.stop();

    expect(context?.oscillators[0]?.stopCount).toBe(1);
    expect(context?.closeCount).toBe(1);
  });

  it("lets a preview handle cancel playback while context resume is pending", async () => {
    const service = new AudioService();
    const preview = service.playPreview(70);
    const context = FakeAudioContext.instances[0];

    preview.stop();

    expect(context?.closeCount).toBe(1);
    expect(context?.oscillators).toHaveLength(0);
    context?.resumeDeferred.resolve(undefined);
    await expect(preview.started).resolves.toBe(false);
    expect(context?.closeCount).toBe(1);
  });

  it("does not let an old preview handle stop a newer alert", async () => {
    const service = new AudioService();
    const preview = service.playPreview(50);
    const previewContext = FakeAudioContext.instances[0];
    previewContext?.resumeDeferred.resolve(undefined);
    await expect(preview.started).resolves.toBe(true);

    const alerting = service.play(80);
    const alertContext = FakeAudioContext.instances[1];
    alertContext?.resumeDeferred.resolve(undefined);
    await expect(alerting).resolves.toBe(true);

    preview.stop();

    expect(previewContext?.oscillators[0]?.stopCount).toBe(1);
    expect(alertContext?.oscillators[0]?.stopCount).toBe(0);
    expect(alertContext?.closeCount).toBe(0);
  });

  it("isolates Web Audio cleanup failures", async () => {
    const service = new AudioService();
    const playing = service.play(70);
    const context = FakeAudioContext.instances[0];
    context?.resumeDeferred.resolve(undefined);
    await expect(playing).resolves.toBe(true);
    if (context !== undefined) {
      const oscillator = context.oscillators[0];
      const gain = context.gains[0];
      if (oscillator !== undefined) oscillator.throwOnDisconnect = true;
      if (gain !== undefined) gain.throwOnDisconnect = true;
      context.throwOnClose = true;
    }

    expect(() => service.stop()).not.toThrow();
    expect(context?.oscillators[0]?.stopCount).toBe(1);
    expect(context?.closeCount).toBe(1);
  });
});
