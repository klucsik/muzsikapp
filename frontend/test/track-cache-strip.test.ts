/**
 * The cache strip on each track row.
 *
 * Coverage arrives as `{ [trackId]: { cached, total, bytes } }` from the MSE cache, and the strip
 * has to disappear rather than lie: no manifest means no fragment count means no bar, otherwise a
 * V1 library or a never-fetched track would read as "0% cached" forever.
 */
import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import OrderedTrackList from '../src/components/OrderedTrackList.vue';

const TRACKS = [
  { id: 'a', title: 'A' },
  { id: 'b', title: 'B' },
  { id: 'c', title: 'C' },
];

const MB = 1048576;

const mountList = (cacheCoverage?: Record<string, { cached: number; total: number; bytes: number }>) =>
  mount(OrderedTrackList, { props: cacheCoverage ? { tracks: TRACKS, cacheCoverage } : { tracks: TRACKS } });

describe('track list cache strip', () => {
  it('sizes the strip by cached fragments over the manifest total', () => {
    const bar = mountList({ a: { cached: 2, total: 8, bytes: 2 * MB } }).find('.cache-progress');

    expect(bar.attributes('style')).toContain('width: 25%');
    expect(bar.attributes('title')).toContain('2/8 fragments cached (2.0 MB)');
    expect(bar.classes()).not.toContain('complete');
  });

  it('turns green once a track is fully local, and never overshoots 100%', () => {
    const bars = mountList({
      a: { cached: 8, total: 8, bytes: 8 * MB },
      b: { cached: 9, total: 8, bytes: 9 * MB }, // init segment counted in by a careless caller
    }).findAll('.cache-progress');

    expect(bars).toHaveLength(2);
    expect(bars[0].classes()).toContain('complete');
    expect(bars[1].attributes('style')).toContain('width: 100%');
    expect(bars[1].classes()).toContain('complete');
  });

  it('draws nothing without a fragment count, so a V1 library stays blank', () => {
    const wrapper = mountList({
      a: { cached: 0, total: 0, bytes: 0 },
      b: { cached: 3, total: 0, bytes: 3 * MB },
    });

    expect(wrapper.findAll('.cache-progress')).toHaveLength(0);
  });

  it('draws nothing when there is no cache to report at all', () => {
    expect(mountList().findAll('.cache-progress')).toHaveLength(0);
  });

  it('keeps each strip on its own track when the list is reordered', async () => {
    const wrapper = mountList({ a: { cached: 4, total: 8, bytes: 4 * MB } });

    await wrapper.setProps({ tracks: [TRACKS[1], TRACKS[0], TRACKS[2]] });
    const items = wrapper.findAll('.track-item');

    expect(items[0].find('.cache-progress').exists()).toBe(false);
    expect(items[1].find('.cache-progress').attributes('style')).toContain('width: 50%');
  });
});
