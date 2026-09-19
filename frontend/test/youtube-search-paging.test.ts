/**
 * YouTube search used to stop at ten results with no way forward. Paging appends one page per
 * click, keeps the button disabled while a page is in flight, and stops offering more once the
 * backend reports a short page. Driven through the DOM so the wiring is what is under test.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { nextTick } from 'vue';

const searchYouTube = vi.fn();

vi.mock('../src/services/api', () => ({
  default: {
    searchYouTube: (...args) => searchYouTube(...args),
    addDownloadJob: vi.fn(),
    getPlaylistInfo: vi.fn(),
  },
}));

const listeners = new Map();
vi.mock('../src/services/websocket', () => ({
  default: {
    on: (e, cb) => listeners.set(e, cb),
    off: (e) => listeners.delete(e),
    connect: vi.fn(),
    disconnect: vi.fn(),
    isConnected: { value: false },
  },
}));

vi.mock('../src/composables/useToast', () => ({ useToast: () => ({ error: vi.fn(), success: vi.fn(), warning: vi.fn() }) }));

const stubs = { FolderSelector: true };

const { default: YouTubeSearchDialog } = await import('../src/components/YouTubeSearchDialog.vue');

const page = (start, n, hasMore = true) => ({
  results: Array.from({ length: n }, (_, i) => ({
    video_id: `vid-${String(start + i).padStart(3, '0')}`,
    title: `Result ${start + i}`,
    channel: 'Channel',
    duration: 200,
    thumbnail: null,
    url: 'https://youtu.be/x',
  })),
  count: n,
  has_more: hasMore,
});

async function search(wrapper, query = 'queen') {
  await wrapper.find('input.search-input').setValue(query);
  await wrapper.find('button.search-btn').trigger('click');
  await flushPromises();
}

const loadMoreButton = (wrapper) => wrapper.find('button.load-more-btn');

describe('YouTube search paging', () => {
  beforeEach(() => {
    searchYouTube.mockReset();
  });

  afterEach(() => vi.restoreAllMocks());

  const mountDialog = () =>
    mount(YouTubeSearchDialog, { props: { show: true, folders: [] }, global: { stubs } });

  it('shows a load-more button after a full first page', async () => {
    searchYouTube.mockResolvedValue(page(1, 10));
    const wrapper = mountDialog();

    await search(wrapper);

    expect(searchYouTube).toHaveBeenCalledWith('queen', 10, 0);
    expect(wrapper.findAll('.result-item')).toHaveLength(10);
    expect(loadMoreButton(wrapper).exists()).toBe(true);
    expect(loadMoreButton(wrapper).text()).toContain('Load 10 more');
    wrapper.unmount();
  });

  it('appends the next page and asks for the right offset', async () => {
    searchYouTube.mockResolvedValueOnce(page(1, 10)).mockResolvedValueOnce(page(11, 10));
    const wrapper = mountDialog();
    await search(wrapper);

    await loadMoreButton(wrapper).trigger('click');
    await flushPromises();

    expect(searchYouTube).toHaveBeenLastCalledWith('queen', 10, 10);
    const ids = wrapper.findAll('.result-item').map((n) => n.text());
    expect(wrapper.findAll('.result-item')).toHaveLength(20);
    expect(ids[19]).toContain('Result 20');
    wrapper.unmount();
  });

  it('keeps working across several clicks', async () => {
    let call = 0;
    searchYouTube.mockImplementation(async () => {
      call += 1;
      return page(call === 1 ? 1 : (call - 1) * 10 + 1, 10);
    });
    const wrapper = mountDialog();
    await search(wrapper);

    for (let i = 0; i < 3; i++) {
      await loadMoreButton(wrapper).trigger('click');
      await flushPromises();
    }

    expect(wrapper.findAll('.result-item')).toHaveLength(40);
    expect(searchYouTube).toHaveBeenCalledTimes(4);
    expect(searchYouTube).toHaveBeenLastCalledWith('queen', 10, 30);
    wrapper.unmount();
  });

  it('is inert while a page is loading', async () => {
    let resolvePage;
    searchYouTube.mockResolvedValueOnce(page(1, 10));
    const wrapper = mountDialog();
    await search(wrapper);

    searchYouTube.mockImplementationOnce(() => new Promise((r) => { resolvePage = r; }));
    await loadMoreButton(wrapper).trigger('click');
    await nextTick();

    expect(loadMoreButton(wrapper).attributes('disabled')).toBeDefined();
    expect(loadMoreButton(wrapper).text()).toContain('Loading');

    // A second click while pending must not start another request.
    const before = searchYouTube.mock.calls.length;
    await loadMoreButton(wrapper).trigger('click');
    await flushPromises();
    expect(searchYouTube.mock.calls.length).toBe(before);

    resolvePage(page(11, 10, false));
    await flushPromises();
    expect(wrapper.findAll('.result-item')).toHaveLength(20);
    expect(loadMoreButton(wrapper).exists()).toBe(false);
    wrapper.unmount();
  });

  it('hides the button when the backend returns a short page', async () => {
    searchYouTube.mockResolvedValueOnce(page(1, 10));
    const wrapper = mountDialog();
    await search(wrapper);

    searchYouTube.mockResolvedValueOnce(page(11, 4, false));
    await loadMoreButton(wrapper).trigger('click');
    await flushPromises();

    expect(wrapper.findAll('.result-item')).toHaveLength(14);
    expect(loadMoreButton(wrapper).exists()).toBe(false);
    wrapper.unmount();
  });

  it('does not duplicate rows when YouTube repeats one', async () => {
    searchYouTube.mockResolvedValueOnce(page(1, 10));
    const wrapper = mountDialog();
    await search(wrapper);

    // Overlapping page: vid-010 repeated plus one new row.
    searchYouTube.mockResolvedValueOnce({ ...page(10, 2, false), has_more: false });
    await loadMoreButton(wrapper).trigger('click');
    await flushPromises();

    const items = wrapper.findAll('.result-item');
    expect(items).toHaveLength(11);
    wrapper.unmount();
  });

  it('resets paging when the dialog closes', async () => {
    searchYouTube.mockResolvedValue(page(1, 10));
    const wrapper = mountDialog();
    await search(wrapper);
    expect(loadMoreButton(wrapper).exists()).toBe(true);

    await wrapper.setProps({ show: false });
    await flushPromises();
    await wrapper.setProps({ show: true });
    await flushPromises();

    expect(loadMoreButton(wrapper).exists()).toBe(false);
    expect(wrapper.findAll('.result-item')).toHaveLength(0);
    wrapper.unmount();
  });

  it('surfaces a failed page without losing what is already shown', async () => {
    searchYouTube.mockResolvedValueOnce(page(1, 10));
    const wrapper = mountDialog();
    await search(wrapper);

    searchYouTube.mockRejectedValueOnce(new Error('boom'));
    await loadMoreButton(wrapper).trigger('click');
    await flushPromises();

    expect(wrapper.findAll('.result-item')).toHaveLength(10);
    expect(wrapper.text()).toContain('Could not load more results');
    wrapper.unmount();
  });
});
