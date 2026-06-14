# V2 Player — Integration, Toggle & Sync Behavior (App.vue + WebSocket)

## Summary

Wire up final integration pieces: toggle switch in App.vue for instant switching between players, sync behavior when users change tracks or seek while using MSE-based playback, room-wide state propagation with both player modes simultaneously. Also handles cache exhaustion handling and graceful V1↔V2 transitions mid-playback.

## Blockers  

Depends on `v2-player-mse-buffer-core.md` (MSE buffer composable) and `v2-chunk-cache-prefetch.md` (chunk cache + prediction engine).

## Acceptance Criteria

### 1. V1/V2 toggle in App.vue header area
- Radio-style switch: `[V2] [V1]` with smooth visual transition between modes  
- Instant switching — current track immediately reloads in newly selected player; brief spinner overlay on progress bar until first chunk finishes downloading/decoding into SourceBuffer when re-buffering needed (switching mid-playback)
- Preference persists via localStorage key `muzsikapp-player-mode`; default `"v1"`

### 2. Sync behavior between V2 players in same room
- Leader-follower model: explicit commands (`play_track`, `pause`, `resume`) become authoritative state changes broadcast via existing WebSocket events (same as V1)  
- Other clients apply same command locally; for MSE this means setting currentTime directly or triggering new chunk fetch sequence depending on whether target position falls within cached range
- Drift up to ~40s acceptable during continuous passive listening without user interaction — only explicit commands trigger tight sync requiring all players align immediately regardless of current playback state differences across devices in same room

### 3. Cache exhaustion handling (when network prevents fetching new chunks fast enough)
- Pause playback + show buffering spinner overlay on progress bar; continues spinning until sufficient data fetched into cache that MSE can safely continue without risking another stall event during subsequent minutes based on current download speed trend analysis  
- On user resume tap: attempt to fetch next needed chunk with exponential backoff starting at initial delay, doubling each retry up to 30s cap before returning error state requiring manual intervention (refresh page or switch temporarily use older V1 player mode which uses simpler HTTP Range request streaming instead of complex MSE pipeline)
- Clear visual distinction between "initial loading" spinner and ongoing buffering caused by slow connection during active playback

### 4. Track boundary prefetching coordination  
- As soon as playback enters final chunk (~30s segment before reaching zero remainder seconds left until next song begins automatically following immediately after previous one finishes without any gap whatsoever), trigger automatic transition to next track in playlist order
- If user has loop enabled on current track, predict this and protect relevant cache entries from eviction per `v2-chunk-cache-prefetch.md` requirements

### 5. Graceful degradation fallback when MSE fails for any reason (unsupported codec, browser bug, out of memory during SourceBuffer append)
- Log error to console with full stack trace + context about what triggered failure plus current playback state at time incident occurred recorded alongside timestamp UTC ISO format string representing exact moment event happened inside system log file stored permanently available later
