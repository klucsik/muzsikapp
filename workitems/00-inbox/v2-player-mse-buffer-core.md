# V2 Player — MSE Buffer Core (AudioPlayerV2.vue + useMseBuffer.js)

## Summary

Implement the core MediaSource Extensions audio player component. This is the foundational piece that fetches 30-second M4A chunks from disk via HTTP Range requests and feeds them into an MSE SourceBuffer for continuous playback. V1's existing `AudioPlayer.vue` remains untouched — this creates a parallel `AudioPlayerV2.vue`.

The buffer manager handles:
- Creating and configuring the MediaSource + Audio element pipeline
- Fetching 30s M4A segments via Range requests from `/audio-v2/:trackId?range=...`
- Decoding AAC audio natively through MSE (no JS codec workarounds needed)
- Feeding decoded buffers into SourceBuffer at correct media timeline positions

## Blockers

None — relies only on browser-native MSE + native AAC decode in SourceBuffer, both supported by all modern browsers.

## Acceptance Criteria

- [ ] `AudioPlayerV2.vue` component renders with identical visual controls to V1 (play/pause/next/prev/repeat/volume/progress bar)
  - Progress bar shows green fill for played content and solid grey blocks for cached regions ahead of playhead
- [ ] `useMseBuffer.js` composable manages full MSE lifecycle: create MediaSource → attach SourceBuffer with AAC codec config → append chunk data → handle end-of-stream on track completion → reset cleanly when switching tracks or players
  - Exposes reactive state: `{ playing, bufferedRanges, error }` via Vue ref/computed
- [ ] Chunk fetching uses `GET /audio-v2/:trackId?range=30s..60s` format — server returns byte range of the M4A file corresponding to a single chunk boundary (see separate ticket for V1/V2 unified serving)
  - For now, implement client-side Range header calculation: each 30s chunk = `bytes=startByte-endByte` where positions are computed from track duration and total size via `(chunkIndex / numChunks) * fileSize` approximation
- [ ] MSE pipeline handles AAC decoding natively — no custom decoder or JS codec layer needed. If SourceBuffer creation fails (unsupported format), logs error and falls back gracefully to V1 `<audio>` element as a safety net
- [ ] Track switching: when next track starts, current MediaSource is reset (`mediaSource.endOfStream()` called then `currentTime = 0` on new media source). No gaps between tracks during playlist playback

## Implementation Paths

### Path A (recommended) — MSE with Range requests from existing audio endpoint
1. Create `/audio-v2/:trackId` route that serves the same file as V1 but accepts a custom query parameter for chunk boundaries: `GET /audio-v2/abc123?chunk=0&totalChunks=45` → returns bytes `(0/45)*size .. (1/45)*size`, etc.
   - Or simpler: use standard HTTP Range header on the existing `/audio/:trackId` endpoint with a V2 flag in Accept header or query param
2. `useMseBuffer.js`: 
   ```js
   export function useMseBuffer() {
     const mediaSource = ref(null)
     const sourceBuffer = ref(null)
     
     async function init(trackUrl, trackDuration) {
       // Create MediaSource → attach to <audio> element → create SourceBuffer with 'mp4a.40.2' (AAC codec string for M4A/AAC in MP4 container)
       const ms = new MediaSource()
       sourceBuffer.value = await addSourceBuffer(ms, 'mp4a.40.2') // AAC codec ID for ISO Base Media File Format
     }
     
     async function appendChunk(chunkUrl) {
       // Fetch chunk → decode via MSE (automatic when appending to SourceBuffer with correct config)
       const resp = await fetch(chunkUrl)
       sourceBuffer.value.appendBuffer(await resp.arrayBuffer())
     }
   ```

### Path B — Pre-download all chunks into ArrayBuffer pool, then feed sequentially from memory
- Fetches entire track upfront in 30s segments and stores them as ArrayBuffers. MSE only appends data that's already been downloaded to disk (via Range requests). This is essentially the V2 caching approach described in design doc but without a separate cache layer — everything lives in this composable's internal buffer pool.
- **Pros:** Simplest implementation, no network during playback once preloaded  
- **Cons:** No bounded memory usage for long tracks; defeats purpose of chunked loading since we'd need to download the entire track before playing

**Recommended:** Path A with a separate caching layer (see `v2-chunk-cache-prefetch` ticket) — this ticket focuses purely on getting MSE working end-to-end. The cache optimization is added in Phase 3/4 below.

## Test Plan

- **Unit: useMseBuffer.js
** - Mock MediaSource API (`new Blob()`, `URL.createObjectURL()`), verify SourceBuffer creation with correct AAC codec string, test appendChunk sequence fires at expected timeline positions (using mocked Date.now())
- **Integration:** Manual browser test — open AudioPlayerV2.vue in dev mode playing a real M4A track. Verify: playback starts within 1 second of clicking play; seek works to any buffered position without re-fetching; pause/resume maintains buffer state across multiple toggle cycles

## Definition of Done

- [ ] All acceptance criteria satisfied and verified
- [ ] Tests added or updated — passing locally (`bun run test`)  
- [ ] Type check clean (typecheck)
- [ ] Docs and notes updated with links to ticket
- [ ] Operational impact assessed (config changes, migrations, restarts)
- [ ] Follow-up tickets created for deferred scope
- [ ] Update history complete with evidence

## Updates

### 2026-06-14
- Created from V2 player design refinement session. MSE transport chosen as the core mechanism — no JS codec workarounds needed since AAC in M4A container is natively supported by all modern browsers via SourceBuffer('mp4a.40.2'). Quality baseline score (inbox): ★★★☆☆ 3/10

## Notes

- Codec string for AAC audio: `mp4a.40.2` — this works across Chrome, Firefox, Safari
- The existing V1 AudioPlayer.vue must remain completely untouched; no shared base component or mixin between V1 and V2 at this stage to prevent accidental regression coupling
- Progress bar grey blocks are a visual enhancement added in the SettingsPanel ticket below

## Links

- Design doc: `/workspace/src/muzsikapp/design_docs/V2_PLAYER_DESIGN.md`
- Existing player (reference only, do not modify): `frontend/src/components/AudioPlayer.vue`
