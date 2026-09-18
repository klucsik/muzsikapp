/**
 * chunkCache — Memory-bounded pool of audio segments.
 *
 * Manages an in-memory pool of ArrayBuffers (audio chunks). By default the oldest non-protected
 * chunk goes when the memory budget is exceeded, which is all a small lookahead window needs.
 * `evictionRank` replaces that order with a caller-supplied disposability score — the hard
 * cache-aggressiveness mode packs the budget with the queue, where insertion order would throw
 * away the next song to keep the twentieth (see services/cachePolicy.js).
 */

export class ChunkCache {
  /**
   * @param {number} maxBytes - Maximum allowed cache size in bytes (default ~50MB)
   */
  constructor(maxBytes = 50 * 1024 * 1024) {
    this.maxCacheBytes = maxBytes;
    /** @type {Map<number, {buffer: ArrayBuffer, timestamp: number}>} */
    this.cacheMap = new Map();
    this.totalSize = 0;
    /** @type {Set<number>} Indices of chunks that are protected from eviction (e.g., loop regions) */
    this.protectedPool = new Set();
    /** @type {Set<number>} Indices currently being fetched via network */
    this.pendingIndices = new Set();
    /**
     * Optional `(key) => number` disposability score: eviction takes the lowest rank first and
     * falls back to insertion order on ties. Null keeps the timestamp behaviour.
     * @type {((key: any) => number)|null}
     */
    this.evictionRank = null;
  }

  /**
   * Gets the cached buffer for a given index.
   * @param {*} key - Cache key (string or number)
   * @returns {ArrayBuffer|undefined} The cached buffer, or undefined if not found
   */
  get(key) {
    const entry = this.cacheMap.get(key);
    return entry ? entry.buffer : undefined;
  }

  /**
   * Checks if a chunk is currently in cache or being downloaded.
   * @param {number} index - Zero-based chunk index (or string key)
   * @returns {boolean} true if cached OR currently downloading
   */
  has(index) {
    return this.cacheMap.has(index) || this.pendingIndices.has(index);
  }

  /**
   * Marks a chunk as being in-flight (currently downloading).
   * @param {number} index - Zero-based chunk index
   */
  markPending(index) {
    this.pendingIndices.add(index);
  }

  /**
   * Removes an index from the pending set.
   * @param {number} index - Zero-based chunk index
   */
  unmarkPending(index) {
    this.pendingIndices.delete(index);
  }

  /**
   * Adds a chunk to the cache, triggering eviction if necessary.
   * @param {number} index - Zero-based chunk index
   * @param {ArrayBuffer} buffer - The audio segment data
   */
  put(index, buffer) {
    this.unmarkPending(index);

    if (!(buffer instanceof ArrayBuffer)) {
      throw new Error('Only ArrayBuffers can be cached');
    }

    const size = buffer.byteLength;

    // If the chunk is already in cache, replace it and update size/timestamp
    if (this.cacheMap.has(index)) {
      const oldEntry = this.cacheMap.get(index);
      this.totalSize -= oldEntry.buffer.byteLength;
      this.cacheMap.delete(index);
    }

    // Check if we need to evict before adding new entry
    this._evictIfNeeded(size);

    // Add the new chunk
    this.cacheMap.set(index, {
      buffer: buffer,
      timestamp: Date.now(),
    });
    this.totalSize += size;
  }

  /**
   * Removes a specific chunk from the cache (e.g., on error or manual invalidation).
   * @param {number} index - Zero-based chunk index
   */
  remove(index) {
    this.unmarkPending(index);
    const entry = this.cacheMap.get(index);
    if (entry) {
      this.totalSize -= entry.buffer.byteLength;
      this.cacheMap.delete(index);
    }
  }

  /**
   * Adds an index to the protected pool, preventing its eviction.
   * @param {number} index - Zero-based chunk index
   */
  setProtected(index) {
    this.protectedPool.add(index);
  }

  /**
   * Removes an index from the protected pool.
   * @param {number} index - Zero-based chunk index
   */
  unsetProtected(index) {
    this.protectedPool.delete(index);
  }

  /**
   * Clears all entries in the cache.
   */
  clear() {
    this.cacheMap.clear();
    this.totalSize = 0;
    this.pendingIndices.clear();
    this.protectedPool.clear();
  }

  /** Every key, ordered most disposable first — the order eviction would take them. */
  evictionOrder() {
    return [...this.cacheMap.entries()]
      .map(([key, entry]) => ({
        key,
        rank: this.evictionRank ? this.evictionRank(key) : entry.timestamp,
        timestamp: entry.timestamp,
      }))
      .sort((a, b) => (a.rank - b.rank) || (a.timestamp - b.timestamp))
      .map((item) => item.key);
  }

  /**
   * Bytes that could be freed without touching anything as valuable as `rank` — i.e. what is
   * strictly more disposable. Protected entries never count.
   */
  releasableBelow(rank) {
    if (!this.evictionRank) return this.totalSize; // timestamp order: everything is older than the future
    let bytes = 0;
    for (const [key, entry] of this.cacheMap) {
      if (this.protectedPool.has(key)) continue;
      if (this.evictionRank(key) >= rank) continue;
      bytes += entry.buffer.byteLength;
    }
    return bytes;
  }

  /**
   * Can `bytes` be afforded without evicting audio that is nearer the playhead than a chunk whose
   * rank is `rank`? Callers use this to stop a background fill before it buys a track forty places
   * down the queue with the bytes of the next one.
   */
  fitsAlongside(bytes, rank = null) {
    const room = this.maxCacheBytes - this.totalSize;
    if (room >= bytes || rank === null) return true; // no policy installed: `put` falls back to oldest-first
    return this.releasableBelow(rank) >= bytes - room;
  }

  /**
   * Internal method to evict the most disposable unprotected chunks if budget is exceeded.
   * @private
   * @param {number} incomingSize - Size of the new chunk being added
   */
  _evictIfNeeded(incomingSize) {
    if (this.totalSize + incomingSize <= this.maxCacheBytes) return;

    for (const key of this.evictionOrder()) {
      if (this.totalSize + incomingSize <= this.maxCacheBytes) break;
      if (this.protectedPool.has(key)) continue;
      this.remove(key);
    }
  }
}
