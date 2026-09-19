/**
 * MediaSource lifecycle tests for the V2 player.
 *
 * Chromium caps how many SourceBuffer objects a page may hold, so every `loadTrack` that
 * leaves one attached to its MediaSource leaks a decoder. The room used to die with
 * "this MediaSource has reached the limit of SourceBuffer objects" after enough track
 * changes; these tests pin the release and the tail-seek path that used to trigger a reload.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useMseBuffer } from '../src/composables/useMseBuffer.js';

const MANIFEST = {
  url: '/audio/a',
  mime: 'audio/mp4; codecs="mp4a.40.2"',
  durationSec: 90,
  initEnd: 3208,
  fragmentSize: 1024,
  fragmentCount: 9,
  fragmentTemplate: 'frag-$Number$.m4s',
  startTime: 0,
  endTime: 90,
};

// SourceBuffer objects that the code under test created vs. explicitly released.
const live = { created: 0, removed: 0 };

class FakeSourceBuffer {
  updating = false;
  mode = 'segments';
  _h: Record<string, Array<() => void>> = {};
  addEventListener(name: string, fn: () => void) { (this._h[name] ||= []).push(fn); }
  removeEventListener(name: string, fn: () => void) { this._h[name] = (this._h[name] || []).filter((f) => f !== fn); }
  abort() {}
  remove() {}
  appendBuffer() {}
  fire(name: string) { (this._h[name] || []).forEach((fn) => fn()); }
}

const instances: FakeMediaSource[] = [];

class FakeMediaSource {
  static isTypeSupported = () => true;
  readyState = 'open';
  sb: FakeSourceBuffer | null = null;
  _d = 0;
  _h: Record<string, Array<() => void>> = {};
  constructor() { instances.push(this); }
  addEventListener(name: string, fn: () => void) {
    (this._h[name] ||= []).push(fn);
    if (name === 'sourceopen') queueMicrotask(() => this.fire('sourceopen'));
  }
  removeEventListener() {}
  addSourceBuffer() { live.created++; this.sb = new FakeSourceBuffer(); return this.sb; }
  removeSourceBuffer() { live.removed++; }
  endOfStream() { this.readyState = 'ended'; }
  fire(name: string) { (this._h[name] || []).forEach((fn) => fn()); }
  get duration() { return this._d; }
  set duration(v: number) {
    this._d = v;
    if (this.readyState === 'ended') this.readyState = 'open';
  }
}

function fakeAudioElement(bufferedEnd = 30) {
  return {
    currentTime: 0, duration: 90, volume: 1, src: '',
    buffered: { length: 1, start: () => 0, end: () => bufferedEnd },
    play: async () => {}, pause: () => {}, load: () => {}, removeAttribute: () => {},
    addEventListener: () => {}, removeEventListener: () => {},
  } as any;
}

function installFetch() {
  const calls: Array<{ url: string; headers: any }> = [];
  global.fetch = vi.fn(async (url: string, options: any = {}) => {
    calls.push({ url: String(url), headers: options.headers || {} });
    if (String(url).endsWith('/manifest')) {
      return { ok: true, status: 200, json: async () => MANIFEST };
    }
    return { ok: false, status: 206, arrayBuffer: async () => new ArrayBuffer(64) };
  }) as any;
  return calls;
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

async function load(mse: any, el: any) {
  await mse.loadTrack('a', '', el, 90);
  await tick();
}

describe('MediaSource teardown', () => {
  beforeEach(() => {
    live.created = 0;
    live.removed = 0;
    instances.length = 0;
    vi.stubGlobal('MediaSource', FakeMediaSource);
    URL.createObjectURL = () => 'blob:fake';
    URL.revokeObjectURL = () => {};
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('releases the SourceBuffer when a track is torn down', async () => {
    installFetch();
    const mse = useMseBuffer();

    await load(mse, fakeAudioElement());
    expect(live.created).toBe(1);
    mse.shutdown();

    expect(live.removed).toBe(1);
  });

  it('releases the SourceBuffer an ended stream left behind', async () => {
    installFetch();
    const mse = useMseBuffer();

    await load(mse, fakeAudioElement());
    // Playing to the end closes the stream; the decoder is still held until it is detached.
    instances[instances.length - 1].readyState = 'ended';
    mse.shutdown();

    expect(live.removed).toBe(1);
  });

  it('waits for an in-flight append before detaching', async () => {
    installFetch();
    const mse = useMseBuffer();

    await load(mse, fakeAudioElement());
    const sb = instances[instances.length - 1].sb!;
    sb.updating = true;

    mse.shutdown();
    expect(live.removed).toBe(0);

    sb.updating = false;
    sb.fire('updateend');
    expect(live.removed).toBe(1);
  });

  it('releases the previous SourceBuffer on every track change', async () => {
    installFetch();
    const mse = useMseBuffer();

    // Three loads is all it took to exhaust the page budget once each one leaked an object.
    await load(mse, fakeAudioElement());
    await load(mse, fakeAudioElement());
    await load(mse, fakeAudioElement());
    expect(live.created).toBe(3);
    expect(live.removed).toBe(2);

    mse.shutdown();
    expect(live.removed).toBe(3);
  });
});

describe('seeking near the end of a track', () => {
  beforeEach(() => {
    live.created = 0;
    live.removed = 0;
    vi.stubGlobal('MediaSource', FakeMediaSource);
    URL.createObjectURL = () => 'blob:fake';
    URL.revokeObjectURL = () => {};
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('leaves a fully buffered tail alone instead of re-appending it', async () => {
    const calls = installFetch();
    const mse = useMseBuffer();
    const el = fakeAudioElement(90); // the whole track is buffered, as after playing to the end
    await load(mse, el);
    calls.length = 0;

    mse.seek(89.9);

    await tick();
    expect(calls.length).toBe(0);
    expect(el.currentTime).toBe(89.9);
  });

  it('clamps a position past the end to a playable one', async () => {
    const calls = installFetch();
    const mse = useMseBuffer();
    const el = fakeAudioElement(90);
    await load(mse, el);
    calls.length = 0;

    // The server reports 176.79 for a 176.8s track: that must not become a tail re-append.
    mse.seek(95);

    await tick();
    expect(calls.length).toBe(0);
    expect(el.currentTime).toBeLessThan(90);
    expect(el.currentTime).toBeGreaterThan(89.5);
  });

  it('still seeks to the middle of the track', async () => {
    const calls = installFetch();
    const mse = useMseBuffer();
    const el = fakeAudioElement(90);
    await load(mse, el);
    calls.length = 0;

    mse.seek(42.5);

    expect(el.currentTime).toBe(42.5);
  });
});
