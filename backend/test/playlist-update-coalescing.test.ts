import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const emit = vi.fn();
const to = vi.fn(() => ({ emit }));
const io = { emit, to };

vi.mock('../src/websocket/socketServer.js', () => ({
  getIO: () => io,
}));

// Route handlers are not needed here; the module exposes the broadcast helpers.
const collections = await import('../src/routes/collections.js');
const { emitPlaylistUpdate, flushPlaylistUpdates } = collections as unknown as {
  emitPlaylistUpdate: (collectionId: string) => void;
  flushPlaylistUpdates: () => void;
};

describe('playlist update broadcast coalescing', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    emit.mockClear();
    to.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('collapses a burst of mutations into one room broadcast', () => {
    for (let i = 0; i < 300; i++) emitPlaylistUpdate('current-playlist-room-1');
    expect(to.mock.calls.length).toBe(0);

    vi.advanceTimersByTime(200);

    expect(to.mock.calls.length).toBe(1);
    expect(to).toHaveBeenCalledWith('room-1');
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith('playlist_update', { collectionId: 'current-playlist-room-1', roomId: 'room-1' });
  });

  it('collapses a burst on the legacy playlist into one global broadcast', () => {
    for (let i = 0; i < 50; i++) emitPlaylistUpdate('current-playlist');
    vi.advanceTimersByTime(200);
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith('playlist_update', { collectionId: 'current-playlist' });
    expect(to).not.toHaveBeenCalled();
  });

  it('broadcasts each playlist separately', () => {
    emitPlaylistUpdate('current-playlist-room-1');
    emitPlaylistUpdate('current-playlist-room-2');
    vi.advanceTimersByTime(200);
    expect(to.mock.calls.length).toBe(2);
  });

  it('ignores collections that are not playlists', () => {
    emitPlaylistUpdate('bench-folder');
    emitPlaylistUpdate('library');
    vi.advanceTimersByTime(1000);
    expect(emit).not.toHaveBeenCalled();
    expect(to).not.toHaveBeenCalled();
  });

  it('flush sends a pending broadcast immediately and only once', () => {
    emitPlaylistUpdate('current-playlist-room-1');
    flushPlaylistUpdates();
    flushPlaylistUpdates();
    expect(to.mock.calls.length).toBe(1);
    expect(emit).toHaveBeenCalledTimes(1);

    // The already flushed timer must not fire a second time later.
    vi.advanceTimersByTime(1000);
    expect(emit).toHaveBeenCalledTimes(1);
  });
});
