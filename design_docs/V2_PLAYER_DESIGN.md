# V2 Player Design — Buffered Audio with MSE

**Created:** 2026-06-13  
**Status:** Approved, pending implementation planning

---

## Overview

A second audio player (V2) that uses MediaSource Extensions to buffer audio from disk into memory in chunks, providing uninterrupted playback during brief network outages. V1 remains untouched as the default. Users can switch between players instantly via a toggle.

---

## Architecture

```
┌─────────────────────────────────────────────┐
│                   App.vue                    │
│                                              │
│  Player Toggle: [◉ V2] ○ V1                  │
│                                              │
│  ┌── AudioPlayer (selected) ──────────────┐  │
│  │                                         │  │
│  │   Visualizer / Progress Bar             │  │
│  │   Controls                              │  │
│  │                                         │  │
│  │  ┌── Settings/Telemetry Panel (hideable)─┐│  │
│  │  │ Cache: [====████░░░░] 200MB / 500MB  ││  │
│  │  │ Speed: ▁▂█▃▅ sparkline               ││  │
│  │  │ Buffer health, stalls, track size     ││  │
│  │  └──────────────────────────────────────┘│  │
│  └─────────────────────────────────────────┘  │
└─────────────────────────────────────────────┘

V2 Player Components:
  AudioPlayerV2.vue          — Vue component, MSE audio element + controls
  useMseBuffer.js            — Core buffer manager (fetch → decode → feed MSE)
  chunkCache.js              — In-memory cache with eviction policy
  prefetchPredictor.js       — Predicts which chunks to load next from playlist/loop state
```

---

## Design Decisions Summary

| Decision | Choice | Rationale |
|----------|--------|-----------|
| **Chunk size** | 30 seconds per chunk | Balance between memory efficiency and HTTP request overhead |
| **Transport** | MediaSource Extensions (MSE) | Full control over buffer, seamless chunk injection/extraction |
| **Cache model** | Memory-only, no IndexedDB/IndexedDB persistence for v1 | Simpler implementation, cache is session-scoped only |
| **Max download speed config** | Yes — user-settable cap + rolling 60s average measurement | Stress testing scenarios + production bandwidth management |
| **Prefetch strategy** | Prediction-based from playlist/repeat/loop state; fill allocated budget with next track chunks when space allows | Predictable usage patterns (playlist runs) make this highly effective |
| **Eviction policy** | Drop oldest chunk unless it's in the predicted-next pool (based on loop/predicted positions, not fixed "next 3") | Loop-aware without special-casing; always maximizes cache utilization within budget |
| **Track boundaries** | Keep current track chunks + prefetch next track's first few chunks as space allows | Next-track transition is when buffering matters most — prevents gap between songs |
| **Loop handling** | Treat loop regions as part of the prediction pool (not special-cased) | Prediction engine already knows a loop region will be replayed; keeps those chunks protected naturally |
| **Cache size range** | 10MB – 500MB, user-settable slider | Covers low-RAM mobile users up to high-end desktops. ~2-3 min of MP3 per 100MB |
| **Default settings (new V2 users)** | Conservative — small cache (~50MB), adaptive speed detection from first track load | Safe starting point; user can increase once they see how it works and what performance looks like |
| **Telemetry panel** | Hideable layer below player, combined with settings. Sparkline charts for metrics. Solid grey blocks on progress bar show cached regions | Non-distracting: always accessible but collapsed by default; details only when needed |
| **Cache persistence across reloads?** | No — session-only cache | Simplest approach, no stale data concerns. User just re-buffered from scratch after refresh |
| **Multiple tracks in cache** | Yes — fill allocated budget with current track + next track chunks as space permits | Maximizes utility of every MB; smoothest transitions between songs |
| **Cache exhaustion behavior** | Pause playback + show buffering spinner | Honest feedback to user that they need more cache or better connection. No silent failure, no fallback confusion |
| **Progress bar cached indicator** | Solid grey blocks on progress bar | Clear visual mapping of what's buffered vs not; doesn't compete with the main green playhead fill |
| **Telemetry metrics collected** | Memory usage (used/total cache), download speed + sparkline, stall count/duration, buffer health (# chunks cached/# downloading), track size + overall download progress | Covers all operational visibility needs without being overwhelming |
| **Download speed measurement** | Rolling average over last 60 seconds of chunk downloads | Responsive to changing conditions (e.g., other traffic on the network) while smooth enough not to jitter |
| **Settings scope** | Per-user (per browser instance), persisted in localStorage | Each user's connection/RAM profile is different; no need for room-level sync |
| **V1/V2 transition behavior** | Instant switch — current track reloads immediately in the new player mode | No handoff delay. User picks a mode and it takes effect right away. If switching mid-playback, V2 fetches/re-buffers from start of current chunk position; user sees brief spinner if re-buffering is needed |
| **UI design goal** | Non-distracting — settings/telemetry panel hides by default, metrics use compact sparklines and grey cached blocks on progress bar. Main controls remain unchanged between V1/V2 | Playback experience stays primary; diagnostics are there when you need them but don't compete for attention during listening sessions |

---

## Cache Eviction Algorithm (Prediction-Based)

```
Every time a chunk boundary is crossed:
  1. Predict which chunks will be needed next N seconds ahead
     - Look at current track position → remaining chunks in this track
     - Check playlist order → first few tracks after current one
     - Apply repeat/loop settings (repeat entire track, loop section)
       * If looping a section: predict within the loop region only
  2. Mark predicted-to-be-needed chunks as "protected"
  3. Count total bytes of cached + downloading chunks
  4. While cache_size > allocated_limit AND unprotected_chunks exist:
     - Drop oldest unprotected chunk (release ArrayBuffer from memory)
```

### Example — Looping a section within a track:

```
Track is 10h long, loop region = [2:30:00 → 2:45:00] (15 min loop)
Cache budget = 100MB (~6 chunks of MP3 at ~17MB each)

Predicted pool for next few minutes:
- Current position chunk + next 5 chunks ahead in the track
- If within loop region, wrap back to start of loop region when reaching end of it

Eviction never drops any chunk that falls inside [2:30:00 → 2:45:00] 
or is predicted to be needed based on current playback state.
```

---

## V1 vs V2 Comparison

| Aspect | V1 (current) | V2 (new, MSE-based) |
|--------|-------------|---------------------|
| **Transport** | Single HTTP stream (`GET /audio/:trackId`) | Chunked fetch + MediaSource Extensions feeding buffer directly |
| **Network during playback** | Required continuously | Only for fetching new chunks; brief outages absorbed by cache |
| **Buffer management** | Browser's opaque internal buffer (~few seconds) | Explicit 30s chunk boundaries, user-configurable budget (10-500MB), prediction-based prefetching |
| **Memory usage during play** | Near-zero beyond browser internals | Proportional to allocated cache + current track size in chunks |
| **Initial load delay** | None — starts playing immediately from stream | Brief spinner while first chunk(s) are fetched and fed into MSE buffer |
| **Seek behavior** | Server-driven (API call → server broadcasts seek event) | Local within cached data; if seeking to uncached region, fetch required chunks with brief spinner |
| **Pause/stop latency** | Near-instant (browser handles it) | Near-instant — just stop MSE appending. Cached data retained for resume. |
| **Track transitions** | Server-driven: next track API call → server broadcasts play_track event to all clients | Local prefetch of next chunk(s); seamless if cached, brief spinner if not yet loaded |
| **Sync with other players in room** | Tight — server authoritative position tracking via wall-clock math; `position_check` every 3s corrects drift | Loose during smooth playback (drift up to ~40s acceptable). Tight on user-initiated events: seek, new track start. Server broadcasts state changes from the "leader" client. Followers load same chunks and play independently. Reconnection: compare local MSE position vs server position; sync only if needed. |
| **Offline resilience** | None — playback stops when network drops | Up to allocated cache duration of uninterrupted playback during outages |
| **Loop support (section loops)** | Server-side loop point enforcement, client seeks locally on overlap detection | Prediction engine knows about loop boundaries; keeps loop-region chunks in memory and re-feeds them seamlessly without seeking or gaps. Loop points enforced at chunk boundary level via MSE timeline manipulation if needed for precision. |

---

## UI Components (V2)

### AudioPlayerV2.vue
- Same visual appearance as V1 player controls (play/pause/next/prev/repeat/volume/progress bar)
- Progress bar with solid grey cached blocks + green playhead fill
- Loading/buffering spinner overlay when MSE buffer needs data that isn't yet available

### SettingsPanel.vue (hideable, below AudioPlayerV2)
**Settings tab:**
- Cache size slider: 10MB → 500MB (displayed as MB with a visual bar showing current allocation vs limit)
- Max download speed cap: [dropdown/text input] KB/s or unlimited

**Telemetry tab:**
- Memory usage: "Used / Total" progress bar + percentage
- Download speed sparkline chart (60s rolling window, updates every 2s)
- Buffer health display showing chunks cached vs downloading with status dots
- Current track info including total file size and overall download progress indicator

**Panel behavior:**
- Collapsed by default (toggled open/closed via a small chevron or gear icon at the bottom edge of the player area)
- When expanded, reveals tabs for Settings and Telemetry side-by-side in a compact layout (~200px tall max when visible)
- Metrics update every 1–2 seconds; sparklines render as lightweight SVG paths

### Player Toggle (in App.vue header or near AudioPlayer component)
Simple toggle switch between V1 and V2: `[◉ V2] ○ V1` with smooth transition. Settings preference persisted in localStorage so the user's choice survives page reloads, but cache data itself is not persisted across sessions — it rebuilds fresh each time a track loads for the first session after refresh.

---

## Server Changes (Minimal)

- **No new endpoints needed**
- Existing WebSocket events (`play_track`, `seek`, `pause`, `resume`, `stop`) work unchanged — V2 listens to same event types as V1, just handles them differently internally
- `getState()` still returns server-tracked position for reconnection sync (V2 compares this against its MSE buffer position)
- `position_check` interval can be kept or disabled; V2 doesn't rely on it for smooth playback but uses it only during initial state-sync after reconnect

---

## File Structure (New Files Only)

```
frontend/src/
├── components/
│   ├── AudioPlayerV2.vue              # MSE-based audio player component
│   └── SettingsPanel.vue               # Hideable settings + telemetry panel
├── composables/
│   ├── useMseBuffer.js                 # Core buffer lifecycle: init MSE, fetch chunks, feed decoder
│   ├── chunkCache.js                   # In-memory LRU-style cache with prediction-aware eviction
│   └── prefetchPredictor.js            # Predict next N seconds of content from playlist/repeat/loop state
├── services/
│   └── mseDecoder.js                   # MSE codec handling: create SourceBuffer for audio format, handle decode errors
```

---

## Implementation Phases (Proposed)

1. **Phase 1 — Core buffer**  
   `useMseBuffer` + basic V2 component that plays a single track end-to-end via MSE chunks. No cache yet. Just fetch → feed → play. Verify MSE pipeline works for all supported formats (MP3, FLAC, OGG).

2. **Phase 2 — Chunk caching & eviction**  
   Add `chunkCache` with prediction-based prefetching and the sliding window eviction algorithm described above. Test loop regions, track transitions, cache exhaustion scenarios.

3. **Phase 3 — Settings + telemetry UI**  
   Build `SettingsPanel`, wire up sliders to buffer config, add sparkline charts for speed/memory metrics, grey cached blocks on progress bar.

4. **Phase 4 — Integration & toggle**  
   Wire V1/V2 switch in App.vue. Sync behavior between players (leader-follower model). Reconnection handling. Polish and edge cases.

5. **Phase 5 — Testing + polish**  
   Stress test with various connection speeds, track lengths (30s to 10h), loop patterns, rapid seek operations, room sync across multiple clients simultaneously.

---

## Open Items / Questions for Later

- MSE codec support: need to verify which audio formats browsers can decode natively in SourceBuffer (MP4/M4A is universally supported; MP3/FLAC may require transcoding or container wrapping)
- Should we transcode on-the-fly via backend, or rely purely on browser-native decoding? This affects the server-side design significantly.
- Volume control: V2 MSE pipeline needs to handle volume changes without breaking buffer continuity
