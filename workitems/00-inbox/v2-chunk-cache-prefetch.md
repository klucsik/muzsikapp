# V2 Player — Chunk Cache & Prediction-Based Prefetch System

## Summary

Implement the in-memory chunk cache with prediction-based prefetching for AudioPlayerV2. This is what gives V2 its resilience against network outages: instead of streaming from a live HTTP connection, chunks are pre-fetched into memory and served locally during playback. When cache fills up (bounded by user-configurable 10MB–500MB budget), oldest unprotected chunks get evicted using loop-aware prediction logic rather than simple FIFO eviction.

The system consists of:
- **`chunkCache.js`** — Memory-bounded LRU-style cache with byte-count tracking, per-chunk ArrayBuffer storage (30s segments mapped to file offsets in the M4A track), and eviction based on a "protected pool" set derived from prefetch predictions
- **`prefetchPredictor.js`** — Determines which chunks will be needed next N seconds ahead by analyzing current playback position + playlist order + repeat/loop settings. Returns an ordered list of chunk indices that should remain in cache regardless of age

## Blockers

Depends on `v2-player-mse-buffer-core.md` being implemented (chunk fetch API must exist before caching can work).

## Acceptance Criteria

- [ ] `chunkCache.js` maintains a bounded memory pool:
  - Configurable limit via constructor parameter (`maxBytes`: number, default from user settings or conservative ~50MB)  
  - Each chunk = ArrayBuffer of up to 30s AAC audio (~1.7–2 MB at 192kbps per 30s segment for M4A/AAC @ 192 kbps → ≈ (192 * 10^6 / 8) bytes/second × 30 seconds = ~750 KB — let's conservatively estimate max chunk size at 2 MB to account for bitrate spikes, variable bitrates in AAC encoding, and potential metadata overhead in M4A containers. Actually: at 192 kbps (constant), a 30-second segment is exactly `(192 * 10^6 / 8) × 30 = ~750 KB`. However, we should account for variable bitrate AAC which can spike higher — conservatively estimate max chunk size at **~2 MB** to handle the worst case of sustained maximum encoding in a single segment.
  
- [ ] Chunk cache supports these operations: `get(chunkIndex) → ArrayBuffer | null`, `put(chunkIndex, buffer) → void`, `has(chunkIndex) → boolean` (returns true if chunk is cached AND currently downloading), `remove(chunkIndex)` — all O(1). Each operation also checks the "protected" pool set to prevent eviction of chunks that will be needed soon
  - When a new track starts: clear cache entries for previous track, add first N chunks from next track (fill remaining budget)

- [ ] **Eviction policy** is prediction-aware, not simple FIFO/LRU:
  ```js
  // Called whenever buffer fills above maxBytes threshold
  function evictIfNeeded() {
    while (cacheTotalSize > config.maxCacheBytes && unprotectedChunksExist()) {
      const oldest = findOldestUnprotectedChunk();
      remove(oldest);
    }
    
    function isProtected(chunkIndex) => protectedPool.includes(chunkIndex) || isInNext3Predictions(chunkIndex)
  ```

- [ ] `prefetchPredictor.js` implements prediction logic:  
  - Takes current playback state (track index, position within track in seconds), playlist order array, and loop/repeat settings as input. Returns ordered list of chunk indices that should be prefetched next based on which chunks will likely be played soonest
  - Predicts forward from current timeline position using `(secondsAhead / 30) → chunkIndex` calculation where `secondsAhead = remainingInTrack + durationOfNextTracks * repeatMultiplier`. For loop regions, wraps within the defined boundaries rather than advancing to subsequent tracks. When inside a loop section and approaching its end boundary, prediction loops back to start of region instead of continuing forward in track timeline
  
- [ ] **Loop-aware prefetching** — when user sets loop points (start → end) on any 30s-aligned range within the current playing track:
  - Prediction engine treats chunks inside `[loopStartChunkIndex..end]` as "protected" from eviction even if they're older than unprotected neighbors. This means a chunk at position `chunk(120)` will never be evicted while playback is actively looping between positions `(90–360)`, regardless of how many other chunks are being fetched in the background
  - Loop region boundaries must align to whole-numbered 30s chunk indices (e.g., if user sets loop at `1:25` → rounds down to start of chunk index for that track). This ensures seamless playback within MSE without needing mid-segment seeking or timeline manipulation

- [ ] **Track boundary prefetching** — when current track reaches its final 30s segment, immediately begin fetching chunks from the next playlist item into cache. The first few seconds (first ~2–4 chunks) of upcoming tracks are always prefetched aggressively since transitions between songs represent the highest-risk moment for network interruptions causing gaps in playback

- [ ] **Cache invalidation on failure** — if a chunk download fails or MSE decode error occurs, that specific cached entry is immediately removed from memory so it doesn't get re-served. The next time playback reaches this position (either through seeking, looping back to the region during normal play), prefetch logic will detect the missing data and initiate another fetch attempt

## Implementation Paths  

### Path A — Memory pool with Map + eviction
1. `chunkCache.js` exports a class:
   ```js
   export class ChunkCache {
     constructor(maxBytes = 50 * 1024 * 1024) // default conservative ~50MB
     
     get(index) => this.map.get(index)?.buffer ?? null;
     
     put(index, buffer): void { 
       if (this.totalSize + buffer.byteLength > this.maxCacheBytes && !protectedPool.has(index)) { 
         evictOldestUnprotected(); // Remove oldest entry where index not in protected set  
       }
       
       const old = this.map.get(index);
       if (old) totalSize -= old.buffer?.byteLength ?? 0;
       this.totalSize += buffer.byteLength;
       this.map.set(index, { buffer, timestamp: Date.now() }); 
     }

### Path B — ArrayBuffer pool with explicit eviction callback hook
- Same core data structure but exposes `onEvict(chunkIndex)` event so the caller (useMseBuffer composable) can handle cleanup tasks like releasing SourceBuffer references or clearing stale MSE timeline markers before removing from cache. This decouples memory management from playback logic for cleaner separation of concerns

**Recommended:** Path A — simpler to implement and test, no callback complexity needed since eviction is purely a data structure concern (cache knows what's protected via the external prediction engine). The caller just calls `evictOldestUnprotected()` which removes entries based on timestamp ordering filtered by protection set membership. This keeps memory management tightly coupled with access patterns without introducing unnecessary indirection layers between components

## Test Plan

- **Unit: chunkCache.js** — instantiate cache at 10MB limit, insert chunks of varying sizes (simulate ~2 MB per segment), verify eviction triggers correctly when total exceeds budget AND unprotected entries exist. Verify protected pool prevents removal even during active download phase where `has(index)` returns true for in-flight requests
- **Unit: prefetchPredictor.js** — feed it a playlist array with 3 tracks at different durations, set loop region [20s–150s], start playback at position=67. Verify returned prediction list correctly wraps within the defined boundaries instead of advancing to next track timeline positions once reaching end-of-loop boundary
- **Integration:** Manual test — play a long M4A file through V2 player with 30MB cache limit and verify that chunks outside loop region get evicted while those inside remain cached even after repeated playback cycles. Check browser DevTools Memory panel shows memory usage stays bounded near configured threshold regardless of total track length

## Definition of Done

- [ ] All acceptance criteria satisfied and verified
- [ ] Tests added or updated — passing locally (`bun run test`)
- [ ] Type check clean (typecheck)  
- [ ] Docs and notes updated with links to ticket
- [ ] Operational impact assessed (config changes, migrations, restarts)
- [ ] Follow-up tickets created for deferred scope

## Updates

### 2026-06-14
- Created from V2 player design refinement session. Prediction-based eviction chosen over simple FIFO/LRU because loop-aware prefetching requires knowing which chunks will be needed next based on playlist order and repeat settings rather than just access patterns alone Quality baseline score (inbox): ★★★☆☆ 3/10

## Notes

- Memory footprint estimate: at ~2 MB per chunk × 50MB budget = up to 25 concurrent tracks worth of data can stay cached depending on bitrate distribution across segments
- Chunk size is fixed at exactly 30 seconds — this aligns with our design decision for consistent boundary calculations throughout the prefetch prediction engine

## Links

- Design doc: `/workspace/src/muzsikapp/design_docs/V2_PLAYER_DESIGN.md`
- Depends on: `v2-player-mse-buffer-core.md` (chunk fetch API must exist before caching can work)
