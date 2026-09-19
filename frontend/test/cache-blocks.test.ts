import { describe, expect, it } from 'vitest';
import { planCacheBlocks } from '../src/composables/useMseBuffer.js';

/**
 * The seek bar used to draw only what the decoder held, so a track whose bytes were all in the
 * fragment cache still showed an unloaded tail — while the playlist row, which counts cached
 * fragments, said 100%. `planCacheBlocks` splits the two layers; these are the cases the two
 * views disagreed in the wild.
 */
const right = (block: { start: number; width: number }) => +(block.start + block.width).toFixed(4);
const D = 150;

describe('seek bar loaded regions', () => {
  it('paints the cached tail the decoder has not been given yet', () => {
    const { loaded, held } = planCacheBlocks({
      buffered: [{ start: 0, end: 120 }],
      cached: [{ start: 0, end: 150 }],
      currentTime: 0,
      duration: D,
    });

    expect(loaded).toEqual([{ start: 0, width: 80 }]);
    // The last chunk is loaded — it just has not been appended. It belongs on the bar.
    expect(held).toHaveLength(1);
    expect(held[0].start).toBeCloseTo(80, 4);
    expect(right(held[0])).toBe(100);
  });

  it('never paints the same second twice', () => {
    const spans = [{ start: 0, end: 150 }];
    expect(planCacheBlocks({ buffered: spans, cached: spans, currentTime: 0, duration: D }).held).toEqual([]);
  });

  it('keeps only what is ahead of the playhead', () => {
    const { loaded, held } = planCacheBlocks({
      buffered: [{ start: 0, end: 120 }],
      cached: [{ start: 0, end: 150 }],
      currentTime: 100,
      duration: D,
    });

    expect(loaded[0].start).toBeCloseTo(66.6667, 3);
    expect(right(loaded[0])).toBeCloseTo(80, 4);
    expect(right(held[0])).toBe(100);
  });

  it('shows a hole where the cache has one', () => {
    const { held } = planCacheBlocks({
      buffered: [],
      cached: [{ start: 0, end: 30 }, { start: 90, end: 120 }],
      currentTime: 0,
      duration: D,
    });

    expect(held.map((b) => b.start.toFixed(1))).toEqual(['0.0', '60.0']);
    expect(held.every((b) => Math.abs(b.width - 20) < 0.001)).toBe(true);
  });

  it('clamps a fragment that runs past the reported duration', () => {
    // Element duration and manifest fragment ends differ by rounding; the bar must not overflow.
    const { loaded } = planCacheBlocks({
      buffered: [{ start: 0, end: 150.4 }],
      cached: [],
      currentTime: 0,
      duration: 149.738333,
    });

    expect(right(loaded[0])).toBe(100);
  });

  it('draws nothing before there is a duration', () => {
    expect(planCacheBlocks({ buffered: [{ start: 0, end: 10 }], cached: [{ start: 0, end: 10 }] }))
      .toEqual({ loaded: [], held: [] });
  });
});
