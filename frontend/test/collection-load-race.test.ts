/**
 * Collection loads overlap in practice: switching selection while a fetch is in flight, or a
 * WebSocket refresh landing during a folder expand. Without a guard the slowest response wins,
 * which shows the wrong collection's tracks. These tests drive the overlap deliberately.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const queued = [];

vi.mock('../src/services/api', () => ({ default: { request: vi.fn() } }));
vi.mock('../src/services/websocket', () => ({ default: null }));

const { useTrackCollection } = await import('../src/composables/useTrackCollection.js');
const api = (await import('../src/services/api')).default;
const { ref, nextTick } = await import('vue');

/** Resolve manual promises in an arbitrary order; records every signal passed in. */
const deferredRequests = () => {
  const calls = [];
  api.request.mockImplementation((url, options) => new Promise((resolve, reject) => {
    const call = {
      url,
      signal: options?.signal,
      resolve: (body) => {
        if (options?.signal?.aborted) return reject(abortError());
        resolve({ id: url, name: url, tracks: body ?? [{ id: `track-of-${url}` }] });
      },
    };
    calls.push(call);
  }));
  return calls;
};

const abortError = () => Object.assign(new Error('Aborted'), { name: 'AbortError' });
const settleAll = async () => { await nextTick(); await new Promise((r) => setTimeout(r, 0)); };

describe('useTrackCollection load races', () => {
  beforeEach(() => {
    queued.length = 0;
    vi.clearAllMocks();
  });

  it('keeps the newest selection when an older response lands last', async () => {
    const calls = deferredRequests();
    const id = ref('folder-a');
    const { tracks, loading, loadCollection } = useTrackCollection(id, { autoLoad: false });

    const stale = loadCollection();          // folder-a
    id.value = 'folder-b';                   // selection moves on
    const current = loadCollection();        // folder-b asked for explicitly

    await settleAll();
    // Every load asks for the list projection: rows never need per-fragment playback metadata.
    expect(calls.map((c) => c.url)).toEqual([
      '/api/collections/folder-a?fields=list&order_by=title&order_dir=asc',
      '/api/collections/folder-b?fields=list&order_by=title&order_dir=asc',
      '/api/collections/folder-b?fields=list&order_by=title&order_dir=asc', // the id watcher reloads too
    ]);

    // Newest first, oldest last: the shape that overwrites state without a guard.
    calls[2].resolve();
    calls[1].resolve();
    calls[0].resolve();               // already aborted, so this rejects and must be ignored
    await Promise.all([stale, current]);
    await settleAll();

    expect(tracks.value.map((t) => t.id)).toEqual(['track-of-/api/collections/folder-b?fields=list&order_by=title&order_dir=asc']);
    expect(loading.value).toBe(false);
  });

  it('aborts the previous request when a new load starts', async () => {
    const calls = deferredRequests();
    const { loadCollection } = useTrackCollection('folder-a', { autoLoad: false });

    const first = loadCollection();
    const second = loadCollection();
    await settleAll();

    expect(calls).toHaveLength(2);
    expect(calls[0].signal.aborted).toBe(true);
    expect(calls[1].signal.aborted).toBe(false);

    calls.forEach((c) => c.resolve([]));
    await Promise.all([first, second]);
  });

  it('can be asked for full track rows where the extra columns are needed', async () => {
    const calls = deferredRequests();
    const { loadCollection, tracks } = useTrackCollection('library', { autoLoad: false, listFields: false });

    const load = loadCollection();
    await settleAll();
    expect(calls).toHaveLength(1);
    expect(calls[0].url).not.toContain('fields=list');

    calls[0].resolve([{ id: 'full-row', filepath: '/music/t0.m4a' }]);
    await load;
    expect(tracks.value[0].filepath).toBe('/music/t0.m4a');
  });

  it('reports real failures but stays quiet about aborted loads', async () => {
    const { error, loadCollection } = useTrackCollection('folder-a', { autoLoad: false });

    api.request.mockRejectedValueOnce(new Error('network down'));
    await loadCollection();
    expect(error.value).toContain('network down');

    api.request.mockRejectedValueOnce(abortError());
    await loadCollection();
    expect(error.value).toBe(null);
  });
});
