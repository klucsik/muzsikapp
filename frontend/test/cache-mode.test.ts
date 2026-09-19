/**
 * Cache aggressiveness for the V2 player: soft keeps a window of the next few chunks, hard fills
 * the configured memory budget with the current track and then the queue.
 *
 * The policy is pure (services/cachePolicy.js), so most of this runs without a MediaSource. The
 * last block wires the composable to prove the two modes actually reach different distances into
 * the playlist — and that filling a tight budget never evicts audio that has not been heard.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  DEFAULT_CACHE_MODE, RANK_AHEAD, RANK_BEHIND, RANK_UNLISTED, SOFT_CACHE_CHUNKS,
  chunkKey, evictionRank, normalizeCacheMode, planCacheFill, playlistTrackIds, upcomingTrackIds,
} from '../src/services/cachePolicy.js';
import { ChunkCache } from '../src/services/chunkCache.js';
import { useMseBuffer } from '../src/composables/useMseBuffer.js';

// ── Pure policy ────────────────────────────────────────────────────

describe('cache mode setting', () => {
  it('defaults to soft and rejects anything else', () => {
    expect(DEFAULT_CACHE_MODE).toBe('soft');
    expect(normalizeCacheMode('hard')).toBe('hard');
    expect(normalizeCacheMode('Hard')).toBe('soft');
    expect(normalizeCacheMode(undefined)).toBe('soft');
    expect(normalizeCacheMode('')).toBe('soft');
  });

  it('soft window is six chunks, about three minutes at the 30 s fragment length', () => {
    expect(SOFT_CACHE_CHUNKS).toBe(6);
  });
});

/** Track tables of 64-byte init segments and 64-byte fragments. */
function fixture(lengths: Record<string, number>) {
  const tables: Record<string, any> = {};
  for (const [id, count] of Object.entries(lengths)) {
    tables[id] = {
      initEnd: 64,
      fragments: Array.from({ length: count }, (_, i) => ({
        index: i, offset: 64 + i * 64, size: 64, start: i * 30, end: (i + 1) * 30,
      })),
    };
  }
  return {
    fragmentsOf: (id: string) => tables[id]?.fragments || [],
    initEndOf: (id: string) => tables[id]?.initEnd || 0,
  };
}

const SHORT = fixture({ a: 4, b: 4, c: 4 });   // four fragments: the soft window spans tracks
const LONG = fixture({ a: 12, b: 8, c: 8 });   // a window that fits inside the current track

const keysOf = (plan: any[]) => plan.map((item) => item.key);

describe('planCacheFill — soft', () => {
  const { fragmentsOf, initEndOf } = SHORT;

  it('holds the next six chunks of the timeline, spilling into the next track', () => {
    const plan = planCacheFill({
      mode: 'soft', currentTrackId: 'a', playheadIndex: 0, fragmentsOf, initEndOf,
      upcomingIds: ['b', 'c'],
    });

    // a-1..a-3 is all the current track has left; the rest of the window comes off the successor.
    // The init segment rides along but is overhead, not one of the six.
    expect(keysOf(plan)).toEqual(['a-init', 'a-1', 'a-2', 'a-3', 'b-init', 'b-0', 'b-1', 'b-2']);
    expect(plan.filter((item: any) => item.index >= 0)).toHaveLength(SOFT_CACHE_CHUNKS);
  });

  it('fills the holes of a window it already mostly holds and reaches no further', () => {
    const long = fixture({ a: 12, b: 8, c: 8 });
    const held = new Set(['a-init', 'a-1', 'a-3', 'a-5']);
    const plan = planCacheFill({
      mode: 'soft', currentTrackId: 'a', playheadIndex: 0, fragmentsOf: long.fragmentsOf,
      initEndOf: long.initEndOf, has: (key: string) => held.has(key), upcomingIds: ['b', 'c'],
    });

    // Six chunks are in front of the playhead and three are held, so the other three are the
    // whole job — the successor stays cold because the window is already paid for.
    expect(keysOf(plan)).toEqual(['a-2', 'a-4', 'a-6']);
  });

  it('stops at the byte budget without fetching anything further', () => {
    const plan = planCacheFill({
      mode: 'soft', currentTrackId: 'a', playheadIndex: 3, fragmentsOf, initEndOf,
      has: (key: string) => key === 'a-init', budgetBytes: 200, upcomingIds: ['b', 'c'],
    });

    expect(keysOf(plan)).toEqual(['b-init', 'b-0', 'b-1']);
    expect(plan.reduce((sum: number, item: any) => sum + item.size, 0)).toBeLessThanOrEqual(200);
  });

  it('warms the head it is about to replay under repeat-one', () => {
    const plan = planCacheFill({
      mode: 'soft', currentTrackId: 'a', playheadIndex: 3, fragmentsOf, initEndOf,
      has: (key: string) => key === 'a-init', upcomingIds: ['a'],
    });

    expect(keysOf(plan)).toEqual(['a-0', 'a-1', 'a-2', 'a-3']);
  });
});

describe('planCacheFill — hard', () => {
  const { fragmentsOf, initEndOf } = SHORT;

  it('takes the whole current track from the top, then the queue in order', () => {
    const held = new Set(['a-init', 'a-0', 'a-1']);
    const plan = planCacheFill({
      mode: 'hard', currentTrackId: 'a', playheadIndex: 1, fragmentsOf, initEndOf,
      has: (key: string) => held.has(key), upcomingIds: ['b', 'c'],
    });

    expect(keysOf(plan)).toEqual([
      'a-2', 'a-3',
      'b-init', 'b-0', 'b-1', 'b-2', 'b-3',
      'c-init', 'c-0', 'c-1', 'c-2', 'c-3',
    ]);
  });

  it('fetches nearest first, so a plan cut short by the budget still covers what plays next', () => {
    const plan = planCacheFill({
      mode: 'hard', currentTrackId: 'a', playheadIndex: 0, fragmentsOf, initEndOf,
      has: (key: string) => key === 'a-init', budgetBytes: 320, upcomingIds: ['b', 'c'],
    });

    expect(keysOf(plan)).toEqual(['a-0', 'a-1', 'a-2', 'a-3', 'b-init']);
  });

  it('plans nothing when the budget is already spent', () => {
    const held = new Set(['a-init', 'a-0', 'a-1', 'a-2', 'a-3', 'b-init', 'b-0', 'b-1', 'b-2', 'b-3']);
    const plan = planCacheFill({
      mode: 'hard', currentTrackId: 'a', playheadIndex: 0, fragmentsOf, initEndOf,
      has: (key: string) => held.has(key), budgetBytes: 0, upcomingIds: ['b', 'c'],
    });

    expect(plan).toEqual([]);
  });

  it('walks a queue item whose fragments are unknown nowhere', () => {
    const { fragmentsOf: known, initEndOf } = fixture({ a: 2, b: 0, c: 2 });
    const plan = planCacheFill({
      mode: 'hard', currentTrackId: 'a', playheadIndex: 1, fragmentsOf: known, initEndOf,
      has: (key: string) => key === 'a-init', upcomingIds: ['b', 'c'],
    });

    // b has no manifest yet: the caller widens the horizon, but the walk still reaches c.
    expect(keysOf(plan)).toEqual(['a-0', 'a-1', 'b-init', 'c-init', 'c-0', 'c-1']);
  });
});

describe('upcomingTrackIds', () => {
  const playlist = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];

  it('reads the queue in the order it will be played', () => {
    expect(playlistTrackIds(playlist)).toEqual(['a', 'b', 'c']);
    expect(upcomingTrackIds({ playlist, currentTrackId: 'a' })).toEqual(['b', 'c']);
    expect(upcomingTrackIds({ playlist, currentTrackId: 'c' })).toEqual([]);
  });

  it('wraps only when the queue itself repeats', () => {
    expect(upcomingTrackIds({ playlist, currentTrackId: 'c', wrap: true })).toEqual(['a', 'b']);
    expect(upcomingTrackIds({ playlist, currentTrackId: 'missing' })).toEqual([]);
    expect(upcomingTrackIds({ playlist: [], currentTrackId: 'a' })).toEqual([]);
  });
});

describe('evictionRank', () => {
  const ctx = { currentTrackId: 'a', playheadIndex: 2, playlistIds: ['a', 'b', 'c'] };

  it('orders disposable bytes: unplayed queue last, already-heard audio first', () => {
    const order = ['d-0', 'a-0', 'c-0', 'b-0', 'a-3'].map((key) => evictionRank(key, ctx));

    expect(order).toEqual([...order].sort((x, y) => x - y));
    expect(evictionRank('d-0', ctx)).toBeLessThan(RANK_BEHIND);   // nobody queued it
    expect(evictionRank('a-0', ctx)).toBeGreaterThanOrEqual(RANK_BEHIND);
    expect(evictionRank('a-3', ctx)).toBeLessThan(RANK_AHEAD);     // next fragment, next to go…
    expect(evictionRank('a-init', ctx)).toBeGreaterThan(RANK_AHEAD); // …but not without its header
  });

  it('drops the furthest track before the nearest one', () => {
    const far = evictionRank('c-0', ctx);
    const near = evictionRank('b-0', ctx);
    const laterInNear = evictionRank('b-3', ctx);

    expect(far).toBeLessThan(near);
    // Inside one track the tail goes before the head, and the init segment outlives them all.
    expect(laterInNear).toBeLessThan(near);
    expect(evictionRank('b-init', ctx)).toBeGreaterThan(near);
  });

  it('keeps a loop region warm behind the playhead', () => {
    const looping = { ...ctx, loopStartIndex: 0, loopEndIndex: 3 };

    // Inside the loop the chunk is coming up again in one pass, so it outranks the whole queue.
    expect(evictionRank('a-0', looping)).toBeGreaterThan(evictionRank('b-0', looping));
    // Ahead of the playhead inside the loop, 3 comes first, then 0, then 1 — so 1 is worth least.
    expect(evictionRank('a-3', looping)).toBeGreaterThan(evictionRank('a-0', looping));
    expect(evictionRank('a-0', looping)).toBeGreaterThan(evictionRank('a-1', looping));
    // Loop region ends at 3: chunk 4 is behind the playhead like any other.
    expect(evictionRank('a-4', looping)).toBeLessThan(RANK_AHEAD);
  });

  it('ranks the wrap-around track as upcoming when the queue loops', () => {
    const wrapped = { ...ctx, currentTrackId: 'c', playlistIds: ['a', 'b', 'c'], playheadIndex: 1 };

    expect(evictionRank('a-0', wrapped)).toBeGreaterThan(evictionRank('b-0', wrapped));
    expect(evictionRank('a-0', wrapped)).toBeLessThan(RANK_AHEAD);
  });

  it('falls back to insertion order with nothing loaded', () => {
    expect(evictionRank('a-0', {})).toBe(evictionRank('a-1', {}));
    expect(evictionRank('not-a-key', ctx)).toBe(RANK_UNLISTED);
  });
});

describe('ChunkCache eviction policy', () => {
  const buf = (bytes: number) => new ArrayBuffer(bytes);

  it('still evicts oldest first with no policy installed', () => {
    const cache = new ChunkCache(100);
    cache.put('older', buf(60));
    cache.put('newer', buf(60));

    expect(cache.get('older')).toBeUndefined();
    expect(cache.get('newer')).toBeDefined();
  });

  it('evicts the lowest rank even when it is the newest byte in the pool', () => {
    const cache = new ChunkCache(100);
    cache.evictionRank = (key: string) => ({ near: 10, near2: 11, far: 1 } as Record<string, number>)[key];
    cache.put('near', buf(60));
    cache.put('far', buf(30));
    cache.put('near2', buf(30));

    expect(cache.get('far')).toBeUndefined();
    expect(cache.get('near')).toBeDefined();
    expect(cache.get('near2')).toBeDefined();
    expect(cache.evictionOrder()).toEqual(['near', 'near2']);
  });

  it('refuses to buy a distant chunk with a near one', () => {
    const cache = new ChunkCache(100);
    cache.evictionRank = (key: string) => (key === 'far' ? 1 : 10);
    cache.put('near', buf(90));

    expect(cache.releasableBelow(5)).toBe(0);
    expect(cache.fitsAlongside(20, 5)).toBe(false);
    // A chunk worth more than `near` may pay for itself the usual way.
    expect(cache.releasableBelow(20)).toBe(90);
    expect(cache.fitsAlongside(20, 20)).toBe(true);
    // With no policy there is nothing to refuse: `put` falls back to oldest-first.
    expect(cache.fitsAlongside(90, null)).toBe(true);
  });

  it('never counts protected bytes as releasable', () => {
    const cache = new ChunkCache(100);
    cache.evictionRank = () => 1;
    cache.put('looped', buf(90));
    cache.setProtected('looped');

    expect(cache.releasableBelow(50)).toBe(0);
    expect(cache.fitsAlongside(20, 50)).toBe(false);
  });
});

// ── Through the player ─────────────────────────────────────────────

const FRAGMENTS = 12; // 6 minutes, so a six-chunk window never reaches the third track

const MANIFESTS: Record<string, any> = {};
for (const id of ['a', 'b', 'c']) {
  MANIFESTS[id] = {
    url: `/audio/${id}`,
    mime: 'audio/mp4; codecs="mp4a.40.2"',
    durationSec: FRAGMENTS * 30,
    initEnd: 64,
    fragments: Array.from({ length: FRAGMENTS }, (_, i) => ({
      index: i, offset: 64 + i * 64, size: 64, start: i * 30, end: (i + 1) * 30, startSec: i * 30,
    })),
  };
}

class FakeSourceBuffer {
  updating = false;
  mode = 'segments';
  addEventListener() {}
  removeEventListener() {}
  appendBuffer() {}
  remove() {}
}

class FakeMediaSource {
  static isTypeSupported = () => true;
  readyState = 'open';
  sb: FakeSourceBuffer | null = null;
  duration = 0;
  _h: Record<string, Array<() => void>> = {};
  addEventListener(name: string, fn: () => void) {
    (this._h[name] ||= []).push(fn);
    if (name === 'sourceopen') queueMicrotask(() => this.fire('sourceopen'));
  }
  removeEventListener() {}
  addSourceBuffer() { this.sb = new FakeSourceBuffer(); return this.sb; }
  endOfStream() { this.readyState = 'ended'; }
  fire(name: string) { (this._h[name] || []).forEach((fn) => fn()); }
}

function fakeAudioElement(currentTime = 0) {
  return {
    currentTime, duration: FRAGMENTS * 30, volume: 1, src: '',
    buffered: { length: 1, start: () => Math.max(0, currentTime - 30), end: () => currentTime + 30 },
    play: async () => {}, pause: () => {}, load: () => {}, removeAttribute: () => {},
    addEventListener: () => {}, removeEventListener: () => {},
  } as any;
}

function installFetch() {
  const calls: string[] = [];
  global.fetch = vi.fn(async (url: string, options: any = {}) => {
    calls.push(String(url));
    if (String(url).endsWith('/manifest')) {
      const id = /^\/audio\/([a-z]+)/.exec(String(url))?.[1] || 'a';
      return { ok: true, status: 200, json: async () => MANIFESTS[id] };
    }
    return { ok: false, status: 206, arrayBuffer: async () => new ArrayBuffer(64) };
  }) as any;
  return calls;
}

describe('cache aggressiveness in the player', () => {
  let player: any;

  afterEach(() => {
    player?.shutdown();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  async function loaded(atSeconds = 0): Promise<any> {
    vi.useFakeTimers();
    vi.stubGlobal('MediaSource', FakeMediaSource);
    vi.stubGlobal('URL', { createObjectURL: () => 'blob:fake', revokeObjectURL: () => {} });
    const calls = installFetch();
    player = useMseBuffer();
    player.playlist.value = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    player.currentTrackId.value = 'a';
    await player.loadTrack('a', '/audio/a', fakeAudioElement(atSeconds), FRAGMENTS * 30);
    await settle();
    calls.length = 0; // forget what loading the track needed
    return calls;
  }

  /** Let every pending promise chain (and the 5 s ticker) run to completion. */
  async function settle() {
    await vi.advanceTimersByTimeAsync(5000);
    await vi.advanceTimersByTimeAsync(0);
  }

  it('soft tops the window up to the next few chunks and no further', async () => {
    // Parked two fragments from the end, so the six-chunk window is one here plus five next.
    const calls = await loaded((FRAGMENTS - 2) * 30);
    calls.length = 0;

    await settle();

    expect(player.cacheCoverage.value['b']).toMatchObject({ cached: 5, total: FRAGMENTS });
    expect(player.cacheCoverage.value['c']).toBeUndefined();
    expect(calls.filter((url) => url === '/audio/c/manifest').length).toBe(0);
  });

  it('hard caches the current track and then the whole queue', async () => {
    await loaded();

    player.setCacheMode('hard');
    await settle();

    expect(player.cacheMode.value).toBe('hard');
    expect(player.cacheCoverage.value['b']).toMatchObject({ cached: FRAGMENTS, total: FRAGMENTS });
    expect(player.cacheCoverage.value['c']).toMatchObject({ cached: FRAGMENTS, total: FRAGMENTS });
  });

  it('hard stops at the budget instead of evicting audio that has not been heard', async () => {
    await loaded();

    // The loaded track is 13 × 64 bytes; four more chunks is all the budget has room for.
    player.setCacheLimit(13 * 64 + 4 * 64);
    player.setCacheMode('hard');
    await settle();

    expect(player.cacheCoverage.value['b'].cached).toBe(3); // the init segment is overhead, not audio
    expect(player.cacheCoverage.value['c']).toBeUndefined();
    // Every second of the current track is still in memory — the fill paid for itself against the
    // free space, never against the audio in front of the playhead.
    expect(player.cachedSpans.value).toEqual([{ start: 0, end: FRAGMENTS * 30 }]);
  });

  it('goes back to insertion-order eviction when the mode is turned off', async () => {
    await loaded();

    player.setCacheMode('hard');
    await settle();
    player.setCacheMode('soft');

    expect(player.cacheMode.value).toBe('soft');

    // Shrinking the budget still works after a round trip through the modes, and leaves exactly
    // one 64-byte chunk behind — by insertion order now, not by distance from the playhead.
    player.setCacheLimit(64);
    expect(player.cacheSize.value).toBe(64);
    expect(player.cachedChunkCount.value).toBe(1);
  });
});

describe('the settings panel control', () => {
  const STORAGE_KEY = 'muzsikapp-player-settings-v2';

  async function mountPanel(cacheMode: string) {
    localStorage.setItem('muzsikapp-settings-panel-open', 'true');
    const { mount } = await import('@vue/test-utils');
    const { default: SettingsPanel } = await import('../src/components/SettingsPanel.vue');
    return mount(SettingsPanel, { props: { cacheMode } });
  }

  afterEach(() => {
    localStorage.removeItem('muzsikapp-settings-panel-open');
    localStorage.removeItem(STORAGE_KEY);
  });

  it('shows which mode is live and asks for the other one', async () => {
    const wrapper = await mountPanel('soft');
    const segments = wrapper.findAll('.segment');

    expect(segments.map((b) => b.text())).toEqual(['Soft', 'Hard']);
    expect(segments[0].classes()).toContain('active');
    expect(segments[1].attributes('aria-pressed')).toBe('false');

    await segments[1].trigger('click');

    expect(wrapper.emitted('update-cache-mode')).toEqual([['hard']]);
  });

  it('ignores the mode that is already chosen', async () => {
    const wrapper = await mountPanel('hard');

    await wrapper.findAll('.segment')[1].trigger('click');

    expect(wrapper.emitted('update-cache-mode')).toBeUndefined();
  });

  it('explains what each mode spends memory on', async () => {
    const wrapper = await mountPanel('soft');
    const [soft, hard] = wrapper.findAll('.segment');

    expect(soft.attributes('title')).toContain(String(SOFT_CACHE_CHUNKS));
    expect(hard.attributes('title')).toMatch(/budget/i);
  });
});
