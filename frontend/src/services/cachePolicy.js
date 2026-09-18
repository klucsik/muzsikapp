/**
 * cachePolicy — what the V2 chunk cache should hold, and what deserves to go when it cannot hold
 * everything.
 *
 * Surfaced in the player settings as *cache aggressiveness*:
 *
 *  · **soft** (default) — a rolling window of `SOFT_CACHE_CHUNKS` chunks of the playback timeline
 *    (6 fragments ≈ 3 minutes at the 30 s fragment length): the rest of the current track, then
 *    the head of the next playlist item. A handful of MB, and the eviction order barely matters
 *    because the window stays smaller than any sane budget.
 *  · **hard** — the whole current track, then the playlist in order, until the configured byte
 *    budget is full. That is only safe together with `evictionRank`: when the budget runs out the
 *    bytes that go are the ones already played and, failing that, the ones furthest along the
 *    queue — never the audio about to be heard. Ranking by insertion time instead (the soft
 *    default) would evict the next song to buy the twentieth.
 *
 * Pure functions over plain values: the policy gets tested without a MediaSource, and the
 * composable keeps ownership of fetching, appending and reactive state.
 */

export const CACHE_MODES = ['soft', 'hard'];
export const DEFAULT_CACHE_MODE = 'soft';

/** How much of the upcoming timeline soft mode keeps in memory. */
export const SOFT_CACHE_CHUNKS = 6;

/** Where the player settings are persisted, shared with the other V2 settings. */
export const CACHE_SETTINGS_KEY = 'muzsikapp-player-settings-v2';

/**
 * Cache keys are `${trackId}-${index}` (or `-init`). Track ids are UUIDs containing dashes, so
 * the suffix has to be anchored: the id is everything before the *last* dash.
 */
export const CACHE_KEY_RE = /^(.+)-(init|\d+)$/;

/** Fragment index standing in for the init segment (`ftyp` + `moov`). */
export const INIT_INDEX = -1;

// Disposability bands for `evictionRank`, lowest evicted first. The gaps have to stay wide: a
// five-hour track is 600 fragments, and a queue can be long.
export const RANK_UNLISTED = 0;       // warmed bytes of a track nobody queued
export const RANK_BEHIND = 1_000;     // audio that has already been played
export const RANK_AHEAD = 1_000_000;  // audio still to come — nearer ranks *higher*
export const TRACK_STRIDE = 10_000;   // fragment slots reserved per playlist item
export const RANK_FLOOR = RANK_BEHIND + 1;

/** Anything unrecognised falls back to the default rather than switching a listener to hard. */
export function normalizeCacheMode(value) {
  return CACHE_MODES.includes(value) ? value : DEFAULT_CACHE_MODE;
}

export function chunkKey(trackId, index) {
  return `${trackId}-${index === INIT_INDEX ? 'init' : index}`;
}

/** `{ trackId, index }` for a cache key, or null when it is not one. */
export function splitChunkKey(key) {
  const match = typeof key === 'string' ? CACHE_KEY_RE.exec(key) : null;
  if (!match) return null;
  return { trackId: match[1], index: match[2] === 'init' ? INIT_INDEX : Number(match[2]) };
}

/** Playlist entries as a flat list of track ids. */
export function playlistTrackIds(playlist = []) {
  return (playlist || [])
    .map((entry) => (typeof entry === 'string' ? entry : (entry?.id ?? entry?.trackId ?? null)))
    .filter(Boolean);
}

/**
 * Queue items after the current one, in the order they will be played. Wraps only when the queue
 * itself repeats (repeat-all or the room's loop-playlist flag), so the tail of a one-shot queue
 * stays cold instead of downloading the world.
 */
export function upcomingTrackIds({ playlist = [], currentTrackId = null, wrap = false } = {}) {
  const ids = playlistTrackIds(playlist);
  if (!ids.length || !currentTrackId) return [];
  const idx = ids.indexOf(currentTrackId);
  if (idx === -1) return [];
  const steps = wrap ? ids.length - 1 : ids.length - idx - 1;
  const out = [];
  for (let step = 1; step <= steps; step += 1) out.push(ids[(idx + step) % ids.length]);
  return out;
}

/**
 * Which byte ranges would bring the cache up to the mode's idea of "ready".
 *
 * Items come back ready to fetch (`{ trackId, index, key, offset, size }`, `index: -1` being the
 * init segment) in the order they should be requested — nearest first, so a plan that runs out of
 * budget still fetched the parts that matter. `fragmentsOf` returns [] for a track whose manifest
 * was never fetched, which is the caller's cue to widen the horizon.
 *
 * @param {object}   o.mode          'soft' | 'hard'
 * @param {string}   o.currentTrackId
 * @param {number}   o.playheadIndex  fragment index the playhead sits on
 * @param {Function} o.fragmentsOf    trackId -> manifest fragments
 * @param {Function} o.initEndOf      trackId -> init segment length
 * @param {Function} o.has            key -> already cached or in flight
 * @param {number}   o.budgetBytes    how much of the budget this pass may spend
 * @param {number}   o.softChunks     window size for soft mode
 * @param {string[]} o.upcomingIds    queue ahead, from `upcomingTrackIds` (or the current track
 *                                    itself when repeat-one is on)
 */
export function planCacheFill({
  mode = DEFAULT_CACHE_MODE,
  currentTrackId = null,
  playheadIndex = 0,
  fragmentsOf = () => [],
  initEndOf = () => 0,
  has = () => false,
  budgetBytes = Number.POSITIVE_INFINITY,
  softChunks = SOFT_CACHE_CHUNKS,
  upcomingIds = [],
} = {}) {
  const plan = [];
  if (!currentTrackId) return plan;
  const hard = normalizeCacheMode(mode) === 'hard';

  let bytes = 0;
  const queued = new Set();

  /** @returns {'queued'|'skip'|'full'} nothing to do, already in hand, or out of budget */
  const add = (trackId, index, offset, size) => {
    if (!(size > 0)) return 'skip';
    const key = chunkKey(trackId, index);
    if (queued.has(key) || has(key)) return 'skip';
    if (bytes + size > budgetBytes) return 'full';
    queued.add(key);
    plan.push({ trackId, index, key, offset, size });
    bytes += size;
    return 'queued';
  };

  // The init segment first: without it every fragment behind it is undecodable.
  if (add(currentTrackId, INIT_INDEX, 0, initEndOf(currentTrackId)) === 'full') return plan;

  const current = fragmentsOf(currentTrackId) || [];
  const to = hard ? current.length : Math.min(current.length, playheadIndex + softChunks + 1);
  for (let i = hard ? 0 : playheadIndex + 1; i < to; i += 1) {
    if (add(currentTrackId, i, current[i].offset, current[i].size) === 'full') return plan;
  }

  // Soft measures its window on the playback timeline, so whatever the current track cannot cover
  // comes off the head of the next item. Hard has no window: it walks the queue until the budget
  // says stop.
  const covered = Math.max(0, to - (playheadIndex + 1));
  let need = hard ? Infinity : Math.max(0, softChunks - covered);
  for (const trackId of upcomingIds || []) {
    if (need <= 0) break;
    // Under repeat-one the queue ahead *is* the current track, which hard just planned in full.
    if (hard && trackId === currentTrackId) continue;
    if (add(trackId, INIT_INDEX, 0, initEndOf(trackId)) === 'full') break;
    const fragments = fragmentsOf(trackId) || [];
    if (!fragments.length) continue; // manifest unknown — widen the horizon and try again
    const limit = hard ? fragments.length : Math.min(fragments.length, need);
    for (let i = 0; i < limit; i += 1) {
      if (add(trackId, i, fragments[i].offset, fragments[i].size) === 'full') return plan;
    }
    need -= limit; // fetched or already in hand: the window covers those positions either way
  }
  return plan;
}

/**
 * How disposable a cached key is — eviction takes the lowest rank first.
 *
 * The scale is "least likely to be needed again" first: bytes of a track nobody queued, then
 * audio that has already been heard, then the queue *backwards*, so the furthest upcoming track
 * is dropped before the one about to play. A loop region is the exception that proves the rule:
 * chunks behind the playhead inside it are as good as upcoming, so they are ranked by how soon
 * the loop reaches them again. Inside any queued track the later fragments go before the earlier
 * ones, and the init segment goes last — it unlocks all of them.
 *
 * @param {string} key
 * @param {object} ctx
 * @param {string} ctx.currentTrackId
 * @param {number} ctx.playheadIndex
 * @param {string[]} ctx.playlistIds
 * @param {number|null} ctx.loopStartIndex loop region, in fragment indices
 * @param {number|null} ctx.loopEndIndex
 */
export function evictionRank(key, {
  currentTrackId = null,
  playheadIndex = 0,
  playlistIds = [],
  loopStartIndex = null,
  loopEndIndex = null,
} = {}) {
  const parts = splitChunkKey(key);
  if (!parts) return RANK_UNLISTED;
  const { trackId, index } = parts;

  // Nothing loaded: every key lands on one rank, so eviction falls back to insertion order.
  if (!currentTrackId) return RANK_AHEAD;

  if (trackId === currentTrackId) {
    if (index === INIT_INDEX) return RANK_AHEAD + 1;
    const looping = loopStartIndex !== null && loopEndIndex !== null
      && loopEndIndex > loopStartIndex
      && playheadIndex >= loopStartIndex && playheadIndex <= loopEndIndex;
    if (looping && index >= loopStartIndex && index <= loopEndIndex) {
      const span = loopEndIndex - loopStartIndex + 1;
      return RANK_AHEAD - ((index - playheadIndex + span) % span);
    }
    if (index < playheadIndex) return RANK_BEHIND + index;
    return RANK_AHEAD - (index - playheadIndex);
  }

  const ids = playlistIds || [];
  const offset = ids.indexOf(trackId);
  if (offset === -1) return RANK_UNLISTED + Math.max(index, 0);

  const current = ids.indexOf(currentTrackId);
  const lap = current === -1 ? offset + 1 : (offset - current + ids.length) % ids.length;
  // `- index` does double duty: inside one track the later fragments go first, and the init
  // segment (index -1) survives every fragment it unlocks.
  return Math.max(RANK_FLOOR, RANK_AHEAD - (lap || ids.length) * TRACK_STRIDE - index);
}
