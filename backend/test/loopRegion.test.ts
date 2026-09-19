/**
 * The room's in-track loop region: who owns it, and what it may do to a position.
 *
 * Loop points live in the room state, but they describe a slice of *one* track. Both players
 * mirror the region from `play_track`, and `getCurrentPosition()` wraps expected positions
 * inside it, so a region that outlives its track makes the server argue with every client in
 * the room — and a degenerate region turns those positions into NaN.
 */
import { describe, it, expect } from 'vitest';
import { SessionState } from '../src/websocket/sessionState.js';

const track = (id: string, duration = 100) => ({ id, duration, title: id });

/** Put the state where a client would leave it mid-track, without waiting on wall-clock time. */
function playingAt(state: any, position: number, secondsAgo = 30) {
  state.playbackState = 'playing';
  state.position = position;
  state.lastUpdateTime = Date.now() - secondsAgo * 1000;
}

describe('in-track loop region', () => {
  it('keeps the region when repeat replays the same track', () => {
    const state = new SessionState();
    state.playTrack(track('a'));
    state.setLoopPoints(10, 20);
    state.repeatMode = true;

    state.playTrack(track('a'), 10, 0); // the server's replay on `track_ended`

    expect(state.loopStart).toBe(10);
    expect(state.loopEnd).toBe(20);
  });

  it('drops the region when playback moves to a different track', () => {
    const state = new SessionState();
    state.playTrack(track('a'));
    state.setLoopPoints(10, 20);

    state.playTrack(track('b'), 0, 1);

    expect(state.loopStart).toBeNull();
    expect(state.loopEnd).toBeNull();
    // Nothing left for the position wrapper to wrap through.
    playingAt(state, 80);
    expect(state.getCurrentPosition()).toBeGreaterThanOrEqual(80);
  });

  it('clamps a region that reaches past the loaded track', () => {
    const state = new SessionState();
    state.playTrack(track('a', 60));

    state.setLoopPoints(10, 300);

    expect(state.loopStart).toBe(10);
    expect(state.loopEnd).toBe(60);
  });

  it('keeps a usable span when the clamp runs into the start', () => {
    const state = new SessionState();
    state.playTrack(track('a', 30));

    state.setLoopPoints(50, 55); // a region from a longer track

    expect(state.loopEnd).toBe(30);
    expect(state.loopStart).toBeCloseTo(29.5, 5);
    expect(state.loopEnd).toBeGreaterThan(state.loopStart);
  });

  it('re-clamps a region left from a longer track', () => {
    const state = new SessionState();
    state.playTrack(track('long', 300));
    state.setLoopPoints(100, 240);

    // Repeat is still on and the room moved to a shorter track: the replay keeps the region
    // only while the track is the same, and any later write has to fit the new duration.
    state.playTrack(track('short', 30));
    state.setLoopPoints(100, 240);

    expect(state.loopStart).toBe(29.5);
    expect(state.loopEnd).toBe(30);
  });

  it('ignores a region that is not a real range', () => {
    const state = new SessionState();
    state.playTrack(track('a'));
    state.setLoopPoints(10, 20);

    state.setLoopPoints(Number.NaN, 40);
    state.setLoopPoints(40, Number.NaN);
    state.setLoopPoints(Infinity, 40);
    state.setLoopPoints(20, 20); // zero length
    state.setLoopPoints(30, 20); // inverted
    state.setLoopPoints(-5, 20);

    expect(state.loopStart).toBe(10);
    expect(state.loopEnd).toBe(20);
  });

  it('wraps the expected position inside the region while repeating', () => {
    const state = new SessionState();
    state.playTrack(track('a'));
    state.repeatMode = true;
    state.setLoopPoints(10, 20);
    playingAt(state, 50); // 80s by now: three full loops past 20s

    expect(state.getCurrentPosition()).toBeGreaterThanOrEqual(10);
    expect(state.getCurrentPosition()).toBeLessThan(10.5);
  });

  it('never wraps through a zero-length region', () => {
    const state = new SessionState();
    state.playTrack(track('a'));
    state.repeatMode = true;
    state.loopStart = 20; // written straight to the field: a region the route would reject
    state.loopEnd = 20;
    playingAt(state, 50);

    expect(Number.isFinite(state.getCurrentPosition())).toBe(true);
  });

  it('leaves the position alone while paused', () => {
    const state = new SessionState();
    state.playTrack(track('a'));
    state.repeatMode = true;
    state.setLoopPoints(10, 20);
    state.playbackState = 'paused';
    state.position = 17;

    expect(state.getCurrentPosition()).toBe(17);
  });
});
