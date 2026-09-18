import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useMseBuffer } from '../src/composables/useMseBuffer.js';

const MANIFEST = {
  url: '/audio/b',
  mime: 'audio/mp4; codecs="mp4a.40.2"',
  durationSec: 90,
  initEnd: 3209,
  fragments: [
    { offset: 3209, size: 1000, startSec: 0 },
    { offset: 4209, size: 1000, startSec: 30 },
    { offset: 5209, size: 1000, startSec: 60 },
  ],
};

function installFetch(responses = []) {
  const calls = [];
  global.fetch = vi.fn(async (url, options = {}) => {
    calls.push({ url: String(url), headers: options.headers || {} });
    if (String(url).endsWith('/manifest')) {
      return { ok: true, status: 200, json: async () => MANIFEST };
    }
    return { ok: false, status: 206, arrayBuffer: async () => new ArrayBuffer(64) };
  });
  return calls;
}

class FakeSourceBuffer {
  updating = false;
  mode = 'segments';
  _h: Record<string, Array<() => void>> = {};
  addEventListener(name: string, fn: () => void) { (this._h[name] ||= []).push(fn); }
  removeEventListener() {}
  appendBuffer() {}
  remove() {}
}

class FakeMediaSource {
  static isTypeSupported = () => true;
  readyState = 'open';
  sb: FakeSourceBuffer | null = null;
  _d = 0;
  _h: Record<string, Array<() => void>> = {};
  addEventListener(name: string, fn: () => void) {
    (this._h[name] ||= []).push(fn);
    // readyState is already 'open', so the real API fires sourceopen asynchronously; a
    // microtask keeps that ordering without needing timers.
    if (name === 'sourceopen') queueMicrotask(() => this.fire('sourceopen'));
  }
  removeEventListener() {}
  addSourceBuffer() { this.sb = new FakeSourceBuffer(); return this.sb; }
  endOfStream() { this.readyState = 'ended'; }
  fire(name: string) { (this._h[name] || []).forEach((fn) => fn()); }
  get duration() { return this._d; }
  set duration(v: number) {
    this._d = v;
    // Spec: assigning duration moves an 'ended' MediaSource back to 'open'.
    if (this.readyState === 'ended') this.readyState = 'open';
  }
}

function fakeAudioElement() {
  return {
    currentTime: 0, duration: 90, volume: 1, src: '',
    buffered: { length: 1, start: () => 0, end: () => 30 },
    play: async () => {}, pause: () => {}, load: () => {}, removeAttribute: () => {},
    addEventListener: () => {}, removeEventListener: () => {},
  } as any;
}

describe('next-track warming', () => {
  let mse;

  beforeEach(() => {
    mse = useMseBuffer();
    mse.playlist.value = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    mse.currentTrackId.value = 'a';
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('picks the following playlist item', () => {
    expect(mse.nextPlaylistTrackId()).toBe('b');
    mse.currentTrackId.value = 'b';
    expect(mse.nextPlaylistTrackId()).toBe('c');
  });

  it('only wraps when the playlist repeats', () => {
    mse.currentTrackId.value = 'c';
    expect(mse.nextPlaylistTrackId()).toBeNull();
    mse.repeatMode.value = 'all';
    expect(mse.nextPlaylistTrackId()).toBe('a');
    mse.repeatMode.value = 'one';
    expect(mse.nextPlaylistTrackId()).toBe('c');
  });

  it('wraps for the room loop-playlist flag as well as for repeat-all', () => {
    mse.currentTrackId.value = 'c';
    mse.playlistLoop.value = true;
    expect(mse.nextPlaylistTrackId()).toBe('a');
    mse.playlistLoop.value = false;
    expect(mse.nextPlaylistTrackId()).toBeNull();
  });

  it('warms the init segment and leading fragments of another track', async () => {
    const calls = installFetch();

    await mse.warmTrackFragments('b', 2);

    const ranges = calls.filter((c) => c.headers.Range).map((c) => c.headers.Range);
    expect(calls.some((c) => c.url === '/audio/b/manifest')).toBe(true);
    expect(ranges).toEqual(['bytes=0-3208', 'bytes=3209-4208', 'bytes=4209-5208']);
  });

  it('does not refetch what the cache already holds', async () => {
    const calls = installFetch();

    await mse.warmTrackFragments('b', 2);
    const first = calls.length;
    await mse.warmTrackFragments('b', 2);

    expect(calls.length).toBe(first);
  });

  it('skips the track that is currently loaded', async () => {
    const calls = installFetch();

    await mse.warmTrackFragments('a', 2);

    expect(calls.length).toBe(0);
  });

  it('does not start a second warm while one is already running', async () => {
    const calls = installFetch();

    await Promise.all([mse.warmTrackFragments('b', 2), mse.warmTrackFragments('b', 2)]);

    expect(calls.filter((c) => c.headers.Range).length).toBe(3);
  });

  it('maps the server repeat boolean onto the predictor modes', () => {
    mse.setRepeatMode(true);
    expect(mse.repeatMode.value).toBe('one');
    expect(mse.nextPlaylistTrackId()).toBe('a'); // repeat replays the current track

    mse.setRepeatMode(false);
    expect(mse.repeatMode.value).toBe('none');
    expect(mse.nextPlaylistTrackId()).toBe('b');
  });

  it('counts cached chunks and groups other tracks by id', async () => {
    installFetch();
    const uuid = '7fd106c7-bdd0-4486-bb70-af763ec87254';

    expect(mse.cachedChunkCount.value).toBe(0);
    await mse.warmTrackFragments(uuid, 1);

    expect(mse.cachedChunkCount.value).toBe(2); // init + 1 fragment
    expect(mse.warmedTracks.value).toEqual([
      { trackId: uuid, init: true, chunks: 1, bytes: 128 },
    ]);
  });

  it('reports per-track coverage for the cache strip on the track list', async () => {
    installFetch();
    const uuid = '7fd106c7-bdd0-4486-bb70-af763ec87254';

    expect(mse.cacheCoverage.value).toEqual({});
    await mse.warmTrackFragments(uuid, 1);

    // `total` comes from the manifest the warm just fetched; `cached` counts fragments only, so
    // the init segment cannot inflate a track to look further along than it is.
    expect(mse.cacheCoverage.value).toEqual({
      [uuid]: { cached: 1, total: MANIFEST.fragments.length, bytes: 128 },
    });
  });

  it('walks coverage back down when the cache limit drops', async () => {
    installFetch();
    const uuid = '7fd106c7-bdd0-4486-bb70-af763ec87254';

    await mse.warmTrackFragments(uuid, 2); // init + 2 fragments = 192 bytes
    expect(mse.cacheCoverage.value[uuid]).toMatchObject({ cached: 2, bytes: 192 });

    // Oldest first: the init segment goes, and it is not counted as audio progress anyway.
    mse.setCacheLimit(128);
    expect(mse.cacheCoverage.value[uuid]).toMatchObject({ cached: 2, bytes: 128 });

    mse.setCacheLimit(64);
    expect(mse.cacheCoverage.value[uuid]).toMatchObject({ cached: 1, bytes: 64 });

    // Down to nothing held — the track leaves the map entirely, so the row draws no strip
    // instead of freezing at whatever width it had.
    mse.setCacheLimit(1);
    expect(mse.cacheCoverage.value[uuid]).toBeUndefined();
    expect(mse.cachedChunkCount.value).toBe(0);
  });

  it('drops coverage of an older track when a newer one evicts it', async () => {
    installFetch();
    const first = '7fd106c7-bdd0-4486-bb70-af763ec87254';
    const second = '11111111-2222-4333-8444-555555555555';

    await mse.warmTrackFragments(first, 1); // 128 bytes
    mse.setCacheLimit(160); // barely room for one warmed track

    await mse.warmTrackFragments(second, 1);

    expect(mse.cacheCoverage.value[second]).toMatchObject({ cached: 1, total: 3 });
    expect(mse.cacheCoverage.value[first]).toBeUndefined();
    expect(mse.cachedChunkCount.value).toBe(2); // init + 1 fragment of the newer track
  });
});


describe('turning the loop on the last track', () => {
  function mountPlayer(calls) {
    vi.stubGlobal('MediaSource', FakeMediaSource);
    vi.stubGlobal('URL', { createObjectURL: () => 'blob:fake', revokeObjectURL: () => {} });
    const player = useMseBuffer();
    player.playlist.value = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    return player.loadTrack('c', '/audio/c', fakeAudioElement(), 90).then(() => {
      player.currentTrackId.value = 'c';
      calls.length = 0; // forget the requests made while loading
      return player;
    });
  }

  it('warms the first track without waiting for the transition', async () => {
    vi.useFakeTimers();
    const calls = installFetch();
    const player = await mountPlayer(calls);

    expect(player.nextPlaylistTrackId()).toBeNull(); // 'c' is last and the playlist does not repeat
    calls.length = 0;

    player.setPlaylistLoop(true); // 🔄 Loop Playlist, as broadcast by the room
    await vi.advanceTimersByTimeAsync(0);

    expect(calls.some((c) => c.url === '/audio/a/manifest')).toBe(true);
    expect(calls.filter((c) => c.headers.Range).length).toBe(3); // init + 2 fragments

    player.shutdown();
    vi.useRealTimers();
  });

  it('does not download the wrap-around track twice when the loop is toggled again', async () => {
    vi.useFakeTimers();
    const calls = installFetch();
    const player = await mountPlayer(calls);
    player.playing.value = true;

    player.repeatMode.value = 'all';
    await vi.advanceTimersByTimeAsync(0);
    const warmed = calls.filter((c) => c.url.startsWith('/audio/a')).length;
    expect(warmed).toBeGreaterThan(0);

    player.repeatMode.value = 'none';
    player.repeatMode.value = 'all';
    await vi.advanceTimersByTimeAsync(0);

    expect(calls.filter((c) => c.url.startsWith('/audio/a')).length).toBe(warmed);

    player.shutdown();
    vi.useRealTimers();
  });

  it('stays quiet when there is no player attached yet', async () => {
    vi.useFakeTimers();
    const calls = installFetch();
    const idle = useMseBuffer();
    idle.playlist.value = [{ id: 'a' }, { id: 'b' }];
    idle.currentTrackId.value = 'b';

    idle.repeatMode.value = 'all';
    await vi.advanceTimersByTimeAsync(0);

    expect(calls.length).toBe(0);
    vi.useRealTimers();
  });
});

/**
 * A MediaSource that only reports `sourceopen` when the test says so, which is how a slow
 * element can hand a load a stream that has already been replaced.
 */
class LateMediaSource {
  static instances = [];
  static isTypeSupported = () => true;
  readyState = 'closed';
  sb = null;
  duration = 0;
  _h = {};
  constructor() { LateMediaSource.instances.push(this); }
  addEventListener(name, fn) { (this._h[name] ||= []).push(fn); }
  removeEventListener() {}
  addSourceBuffer() { this.sb = new FakeSourceBuffer(); return this.sb; }
  endOfStream() { this.readyState = 'ended'; }
  open() {
    this.readyState = 'open';
    (this._h.sourceopen || []).forEach((fn) => fn());
  }
}

describe('switching tracks while the element is still opening a stream', () => {
  beforeEach(() => { LateMediaSource.instances = []; });

  it('never wires a SourceBuffer to a stream the player has moved on from', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('MediaSource', LateMediaSource);
    vi.stubGlobal('URL', { createObjectURL: () => 'blob:fake', revokeObjectURL: () => {} });
    installFetch();
    const player = useMseBuffer();

    const first = player.loadTrack('a', '/audio/a', fakeAudioElement(), 90);
    await vi.advanceTimersByTimeAsync(0);
    expect(LateMediaSource.instances.length).toBe(1);
    expect(LateMediaSource.instances[0].sb).toBeNull(); // still opening

    const second = player.loadTrack('b', '/audio/b', fakeAudioElement(), 90);
    await vi.advanceTimersByTimeAsync(0);
    expect(LateMediaSource.instances.length).toBe(2);

    // The abandoned stream finally opens. Attaching to it would append into an ended
    // MediaSource and Chromium tears the whole pipeline down.
    LateMediaSource.instances[0].open();
    await vi.advanceTimersByTimeAsync(0);

    expect(LateMediaSource.instances[0].sb).toBeNull();
    expect(player.currentTrackId.value).toBe('b');

    await vi.advanceTimersByTimeAsync(5_000); // both abandoned waits time out
    await Promise.allSettled([first, second]);
    player.shutdown();
    vi.useRealTimers();
  });
});

describe('seeking after the stream closed', () => {
  it('reopens the MediaSource so appends can continue after a late seek', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('MediaSource', FakeMediaSource);
    let captured: FakeMediaSource | null = null;
    vi.stubGlobal('URL', {
      createObjectURL: (ms: FakeMediaSource) => { captured = ms; return 'blob:fake'; },
      revokeObjectURL: () => {},
    });
    installFetch();

    const player = useMseBuffer();
    const el = fakeAudioElement();

    await player.loadTrack('t', '/audio/t', el, 90);
    await vi.advanceTimersByTimeAsync(0); // sourceopen → SourceBuffer

    expect(captured).not.toBeNull();
    expect(captured!.sb).not.toBeNull();

    // maybeEndStream() closes the stream once the tail is buffered; the element then fires
    // `ended`. A seek back inside the track must reopen it, or every later append throws.
    captured!.endOfStream();
    expect(captured!.readyState).toBe('ended');

    player.seek(45);

    expect(captured!.readyState).toBe('open');
    expect(el.currentTime).toBe(45);

    // A seek to the very end stays closed — the stream is legitimately over there.
    captured!.endOfStream();
    player.seek(89.95);
    expect(captured!.readyState).toBe('ended');

    player.shutdown();
    vi.useRealTimers();
  });

  it('never touches a MediaSource that is still open', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('MediaSource', FakeMediaSource);
    let captured: FakeMediaSource | null = null;
    vi.stubGlobal('URL', {
      createObjectURL: (ms: FakeMediaSource) => { captured = ms; return 'blob:fake'; },
      revokeObjectURL: () => {},
    });
    installFetch();

    const player = useMseBuffer();
    await player.loadTrack('t', '/audio/t', fakeAudioElement(), 90);
    await vi.advanceTimersByTimeAsync(0);

    const durationBefore = captured!.duration;
    player.seek(60);
    expect(captured!.readyState).toBe('open');
    expect(captured!.duration).toBe(durationBefore);

    player.shutdown();
    vi.useRealTimers();
  });
});
