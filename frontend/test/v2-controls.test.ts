/**
 * Control-surface tests for the V2 (MSE) player.
 *
 * The point of these is parity with the V1 player's *contract*: controls ask the room through
 * the server, room events drive the element, and the end of a track is reported so the playlist
 * advances. The buffer composable is a scripted fake, so none of this needs a browser that can
 * decode fragmented MP4 — that part lives in the Playwright specs.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils';

const h = vi.hoisted(() => {
  const handlers = new Map<string, (data: any) => void>();
  const api = {
    getTrack: vi.fn(async () => ({ id: 't1', title: 'Song', artist: 'A', album: '', duration: 100 })),
    getAudioUrl: vi.fn(() => '/audio/t1'),
    seek: vi.fn(async () => ({})),
    pause: vi.fn(async () => ({})),
    resume: vi.fn(async () => ({})),
    toggleRepeat: vi.fn(async () => ({})),
    setLoopPoints: vi.fn(async () => ({})),
  };
  const websocket = {
    connect: vi.fn(),
    on: vi.fn((event: string, handler: (data: any) => void) => handlers.set(event, handler)),
    off: vi.fn(),
    getCurrentRoomId: vi.fn(() => 'room-9'),
    reportTrackEnded: vi.fn(),
    reportError: vi.fn(),
    requestState: vi.fn(),
    getServerTime: vi.fn(() => Date.now()),
  };
  return { api, websocket, handlers };
});

vi.mock('../src/services/api', () => ({ default: h.api }));
vi.mock('../src/services/websocket', () => ({ default: h.websocket }));
vi.mock('../src/composables/useTelemetry.js', () => ({
  telemetry: {
    usedMemory: { value: 0 },
    totalMemory: { value: 0 },
    speedHistory: { value: [] },
    stallCount: { value: 0 },
    totalStallDuration: { value: 0 },
    updateMemoryUsage: vi.fn(),
    recordDownload: vi.fn(),
    recordDownloadError: vi.fn(),
    recordStallStart: vi.fn(),
    recordStallEnd: vi.fn(),
  },
}));

// The fake composable has to hand out real refs — the component derives computed state
// (`repeatOn`, `showLoopMarkers`) from them.
let mse: any;
vi.mock('../src/composables/useMseBuffer.js', async () => {
  const { ref } = await import('vue');
  mse = {
    playing: ref(false),
    error: ref(null),
    repeatMode: ref('none'),
    loopRegion: ref(null),
    bufferedRanges: ref([]),
    chunkRows: ref([]),
    cachedChunkCount: ref(0),
    pendingCount: ref(0),
    warmedTracks: ref([]),
    cacheCoverage: ref({}),
    loadProgress: ref(1),
    currentTrackId: ref(null),
    playlist: ref([]),
    needsFallback: ref(false),
    fragments: ref([]),
    fragmentCount: ref(0),
    trackDuration: ref(100),
    mseSupported: ref(true),
    getCurrentTime: vi.fn(() => 0),
    seek: vi.fn(),
    play: vi.fn(async () => {}),
    pause: vi.fn(),
    togglePlayPause: vi.fn(),
    setVolume: vi.fn(),
    shutdown: vi.fn(),
    // Real behaviour worth mimicking: the id only becomes “loaded” once the pipeline starts.
    loadTrack: vi.fn(async () => { mse.currentTrackId.value = 't1'; }),
    bindAudioEvents: vi.fn(),
    updateBufferedRanges: vi.fn(),
    setCacheLimit: vi.fn(),
    setSpeedCap: vi.fn(),
    setRepeatMode: vi.fn(),
    playlistLoop: ref(false),
    setPlaylistLoop: vi.fn((on) => { mse.playlistLoop.value = !!on; }),
    warmTrackFragments: vi.fn(),
    nextPlaylistTrackId: vi.fn(() => null),
  };
  return { useMseBuffer: () => mse, isMseAacSupported: () => true };
});

const DURATION = 100;

/** jsdom lays out nothing, so give the progress bar a geometry the handlers can divide by. */
function stubBarGeometry(wrapper: VueWrapper) {
  const bar = wrapper.find('.progress-bar').element as HTMLElement;
  bar.getBoundingClientRect = () => ({
    left: 0, top: 0, right: 1000, bottom: 8, width: 1000, height: 8, x: 0, y: 0,
    toJSON: () => ({}),
  } as DOMRect);
  return bar;
}

async function mountPlayer() {
  const { default: AudioPlayerV2 } = await import('../src/components/AudioPlayerV2.vue');
  const wrapper = mount(AudioPlayerV2, {
    props: { currentTrackId: 't1', hasNext: true, hasPrevious: true, playlist: [] },
    global: { stubs: { SettingsPanel: true } },
  });
  await flushPromises();
  stubBarGeometry(wrapper);
  return wrapper;
}

const emitRoomEvent = (event: string, data: any) => h.handlers.get(event)?.(data);

describe('AudioPlayerV2 controls', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // jsdom has no media playback at all; these are asserted through the composable instead.
    Object.defineProperty(window.HTMLMediaElement.prototype, 'play', { value: vi.fn(async () => {}), configurable: true });
    Object.defineProperty(window.HTMLMediaElement.prototype, 'pause', { value: vi.fn(), configurable: true });
    vi.clearAllMocks();
    localStorage.clear();
    // The fake composable is created once per file, so its state would leak between tests —
    // most confusingly `currentTrackId`, which tells the player the track is already loaded.
    if (!mse) return; // first test: the fake does not exist until the component is imported
    mse.playing.value = false;
    mse.error.value = null;
    mse.repeatMode.value = 'none';
    mse.loopRegion.value = null;
    mse.currentTrackId.value = null;
    mse.cacheCoverage.value = {};
    mse.getCurrentTime.mockReturnValue(0);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('treats a pause at the end of the track as the track finishing, not as a seek', async () => {
    const wrapper = await mountPlayer();
    mse.trackDuration.value = 176.8;
    mse.getCurrentTime.mockReturnValue(176.79);

    emitRoomEvent('pause', { position: 176.79 });

    expect(mse.pause).toHaveBeenCalledTimes(1);
    // Seeking onto the final frames used to reopen a stream the browser had already closed,
    // which cascaded into a full track reload and killed playback when the room cleared the
    // in-track loop (the pause that ends a track carries its final position).
    expect(mse.seek).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it('still follows a remote pause in the middle of a track', async () => {
    const wrapper = await mountPlayer();
    mse.trackDuration.value = 176.8;

    emitRoomEvent('pause', { position: 42.5 });

    expect(mse.seek).toHaveBeenCalledWith(42.5);
    wrapper.unmount();
  });

  it('lets the room loop flag decide what follows the last track', async () => {
    const wrapper = await mountPlayer();

    emitRoomEvent('loop_mode_change', { loopPlaylist: true });
    expect(mse.playlistLoop.value).toBe(true);

    emitRoomEvent('state_sync', { loopPlaylist: false });
    expect(mse.playlistLoop.value).toBe(false);
    wrapper.unmount();
  });

  it('asks the room to seek and to repeat instead of only touching the element', async () => {
    const wrapper = await mountPlayer();

    await wrapper.find('.progress-bar').trigger('dblclick', { clientX: 250 });
    await flushPromises();
    expect(h.api.seek).toHaveBeenCalledWith(DURATION * 0.25, 'room-9');

    await wrapper.find('button[title="Repeat: Off"]').trigger('click');
    await flushPromises();
    expect(h.api.toggleRepeat).toHaveBeenCalledWith('room-9');
  });

  it('draws loop markers only while repeating and pushes drags to the server', async () => {
    const wrapper = await mountPlayer();

    expect(wrapper.find('.loop-marker.loop-start').exists()).toBe(false);

    mse.repeatMode.value = 'one';
    mse.loopRegion.value = { startSec: 10, endSec: 40 };
    await flushPromises();
    expect(wrapper.find('.loop-marker.loop-start').exists()).toBe(true);
    expect(wrapper.find('.loop-marker.loop-end').exists()).toBe(true);
    expect(wrapper.find('button[title="Repeat: On"]').exists()).toBe(true);

    await wrapper.find('.loop-marker.loop-start').trigger('mousedown');
    document.dispatchEvent(new MouseEvent('mousemove', { clientX: 600 }));
    document.dispatchEvent(new MouseEvent('mouseup'));
    await flushPromises();

    // 600/1000 of 100s, but a loop start may not pass its own end (kept 0.5s clear of it).
    expect(h.api.setLoopPoints).toHaveBeenLastCalledWith(39.5, 40, 'room-9');
    wrapper.unmount();
  });

  it('rewinds at the end of the loop region while repeating', async () => {
    const wrapper = await mountPlayer();
    mse.repeatMode.value = 'one';
    mse.loopRegion.value = { startSec: 10, endSec: 20 };
    mse.playing.value = true;
    mse.getCurrentTime.mockReturnValue(20.4);

    await vi.advanceTimersByTimeAsync(300);
    expect(mse.seek).toHaveBeenCalledWith(10);
    wrapper.unmount();
  });

  it('keeps the region a replaying track carries with it', async () => {
    const wrapper = await mountPlayer();
    mse.repeatMode.value = 'one';
    mse.loopRegion.value = { startSec: 10, endSec: 20 };

    // Repeat past the end of a track is a fresh `play_track` for the same track, and the region
    // belongs to that track — clearing it here silently stopped the section loop the room had
    // just asked for, because the server replays from `loopStart` and still wraps positions.
    emitRoomEvent('play_track', {
      trackId: 't1', title: 'Song', artist: 'A', album: '', duration: 100,
      startPosition: 10, scheduledStartTime: Date.now(), loopStart: 10, loopEnd: 20,
    });
    await flushPromises();

    expect(mse.loopRegion.value).toEqual({ startSec: 10, endSec: 20 });
    wrapper.unmount();
  });

  it('leaves a paused playhead alone at the end of the loop region', async () => {
    const wrapper = await mountPlayer();
    mse.repeatMode.value = 'one';
    mse.loopRegion.value = { startSec: 10, endSec: 20 };
    mse.playing.value = false; // the room paused here
    mse.getCurrentTime.mockReturnValue(24);
    mse.seek.mockClear();

    await vi.advanceTimersByTimeAsync(1000);
    expect(mse.seek).not.toHaveBeenCalled();

    // ...and resumes looping once it is actually playing again.
    mse.playing.value = true;
    await vi.advanceTimersByTimeAsync(300);
    expect(mse.seek).toHaveBeenCalledWith(10);
    wrapper.unmount();
  });

  it('corrects drift from position_check, except right after its own seek', async () => {
    const wrapper = await mountPlayer();
    mse.playing.value = true;
    mse.getCurrentTime.mockReturnValue(0);

    emitRoomEvent('position_check', { expectedPosition: 40, maxDrift: 2 });
    expect(mse.seek).toHaveBeenCalledWith(40);

    mse.seek.mockClear();
    await wrapper.find('.progress-bar').trigger('dblclick', { clientX: 500 });
    await flushPromises();
    emitRoomEvent('position_check', { expectedPosition: 60, maxDrift: 2 });
    expect(mse.seek).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it('reports the track ended so the room can move to the next one', async () => {
    const wrapper = await mountPlayer();
    mse.playing.value = true;
    mse.getCurrentTime.mockReturnValue(DURATION - 0.2);

    await vi.advanceTimersByTimeAsync(300);
    expect(h.websocket.reportTrackEnded).toHaveBeenCalled();
    wrapper.unmount();
  });

  it('hands cache coverage up to the app so the queue can draw its strips', async () => {
    const wrapper = await mountPlayer();

    mse.cacheCoverage.value = { t1: { cached: 1, total: 4, bytes: 1024 } };
    // Coverage moves with every fragment, so the emit is coalesced rather than per chunk.
    await vi.advanceTimersByTimeAsync(300);

    expect(wrapper.emitted('cache-progress')?.at(-1)?.[0]).toEqual({
      t1: { cached: 1, total: 4, bytes: 1024 },
    });
    wrapper.unmount();
  });

  it('drops a stale loop region when a new track starts', async () => {
    const wrapper = await mountPlayer();
    mse.repeatMode.value = 'one';
    mse.loopRegion.value = { startSec: 10, endSec: 20 };

    // The server keeps loop points across a track change; V1 clears them locally on every
    // play_track so the old region cannot hijack the new track while repeat is on.
    emitRoomEvent('play_track', {
      trackId: 't2', title: 'Next', artist: 'B', album: '', duration: 100,
      startPosition: 0, scheduledStartTime: Date.now(),
    });
    await flushPromises();

    expect(mse.loopRegion.value).toBeNull();
    wrapper.unmount();
  });

  it('shows the room connection state and drift, like V1', async () => {
    const wrapper = await mountPlayer();
    expect(wrapper.find('.sync-status.disconnected').exists()).toBe(true);

    emitRoomEvent('connected', { clientId: 'c1' });
    await flushPromises();
    const status = wrapper.find('.sync-status');
    expect(status.classes()).toContain('connected');
    expect(wrapper.find('.drift-line').exists()).toBe(false);

    mse.playing.value = true;
    mse.getCurrentTime.mockReturnValue(0);
    emitRoomEvent('position_check', { expectedPosition: 6.34, maxDrift: 2 });
    await flushPromises();

    const driftLine = wrapper.find('.drift-line');
    expect(driftLine.exists()).toBe(true);
    expect(driftLine.text()).toContain('Drift: 6.34s');
    expect(driftLine.classes()).toContain('drift-warning'); // > 5s
    wrapper.unmount();
  });

  it('snaps the playhead to the loop start when a new region leaves it outside', async () => {
    const wrapper = await mountPlayer();
    mse.repeatMode.value = 'one';
    mse.loopRegion.value = { startSec: 10, endSec: 40 };
    mse.getCurrentTime.mockReturnValue(5); // outside the region
    mse.seek.mockClear();
    await flushPromises();

    await wrapper.find('.loop-marker.loop-end').trigger('mousedown');
    document.dispatchEvent(new MouseEvent('mousemove', { clientX: 450 })); // → 45s
    document.dispatchEvent(new MouseEvent('mouseup'));
    await flushPromises();

    expect(h.api.setLoopPoints).toHaveBeenLastCalledWith(10, 45, 'room-9');
    expect(mse.seek).toHaveBeenLastCalledWith(10);
    wrapper.unmount();
  });

  it('offers the unlock overlay when the browser blocks playback, and retries after it', async () => {
    const wrapper = await mountPlayer();
    expect(wrapper.find('.audio-unlock-overlay').exists()).toBe(false);

    mse.error.value = new DOMException('not allowed', 'NotAllowedError');
    await flushPromises();
    const overlay = wrapper.find('.audio-unlock-overlay');
    expect(overlay.exists()).toBe(true);

    await overlay.trigger('click');
    await flushPromises();
    expect(wrapper.find('.audio-unlock-overlay').exists()).toBe(false);
    expect(h.websocket.requestState).toHaveBeenCalled();
    wrapper.unmount();
  });
});
