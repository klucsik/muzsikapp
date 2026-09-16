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
});
