/**
 * chunkCache — Memory-bounded LRU-style cache for audio segments.
 * 
 * Manages an in-memory pool of ArrayBuffers (audio chunks). 
 * Uses timestamp-based eviction to remove oldest non-protected chunks 
 * when the memory budget is exceeded.
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
  }

  /**
   * Checks if a chunk is currently in cache or being downloaded.
   * @param {number} index - Zero-based chunk index
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

  /**
   * Internal method to evict oldest unprotected chunks if budget is exceeded.
   * @private
   * @param {number} incomingSize - Size of the new chunk being added
   */
  _evictIfNeeded(incomingSize) {
    if (this.totalSize + incomingSize <= this.maxCacheBytes) return;

    const sortedEntries = [...this.cacheMap.entries()]
      .map(([index, entry]) => ({ index, ...entry }))
      .sort((a, b) => a.timestamp - b.timestamp);

    for (const entry of sortedEntries) {
      if (this.totalSize + incomingSize <= this.maxCacheBytes) break;
      if (this.protectedPool.has(entry.index)) continue;
      this.remove(entry.index);
    }
  }
}
