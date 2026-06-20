# V2 Player — Settings & Telemetry Panel UI (SettingsPanel.vue)

## Summary

Build the hideable panel below AudioPlayerV2 that combines user-configurable settings with real-time telemetry metrics. The panel is collapsed by default and expands via a chevron toggle at its bottom edge when users want to inspect performance or adjust cache limits / download speed caps for testing scenarios (stress-testing, bandwidth management). 

The layout has two side-by-side sections:
- **Left**: Settings tab — Cache size slider (10MB–500MB), max download speed cap dropdown/input field  
- Right: Telemetry tab — Memory usage bar + sparkline chart showing 60-second rolling average of chunk download speeds, stall count/duration counter displaying total stalls and cumulative downtime since last track start

## Blockers

None. This ticket is self-contained from a dependency standpoint but integrates with V2 player component for real-time telemetry data display (chunk cache state available via shared composable pattern).

## Acceptance Criteria

- [ ] `SettingsPanel.vue` renders below AudioPlayerV2 as an optional, collapsible panel (~180px tall when expanded):
  - Chevron icon at bottom edge toggles open/closed. State persisted in localStorage so user's preference survives page reloads (open or collapsed by default). Default is **collapsed** to keep the UI non-distracting during normal listening sessions
  
- [ ] Settings section with two controls side-by-side:  
  - Cache size slider from `min=10` MB to `max=500MB`, step increments of 25, displayed value updates live as user drags. When set below current used cache memory (e.g., user had 300MB cached and lowers setting to 100), immediately trigger eviction until total falls within new budget
  - Max download speed cap dropdown with preset options: "No limit", "5 MB/s", "2 MB/s", "1 MB/s", plus custom input field in KB/s for fine-grained control (e.g., user enters `768` → caps at 768KB/s). Applied to all fetch calls made by useMseBuffer composable via AbortController signal or download speed limiter wrapper

- [ ] Telemetry section with these metrics displayed side-by-side in a grid layout:
  
| Metric | Display format | Update frequency | 
|--------|---------------|------------------|
| Memory usage | Horizontal progress bar showing used/total cache (e.g., "180MB / 500MB") + percentage text overlay on the fill line itself. Green when <75% full, yellow at 75-90%, red above 90%. Bar height = ~24px for clear readability without taking too much vertical space in collapsed state | Every 1 second during active playback; every 3 seconds otherwise (idle between tracks) |
| Download speed sparkline | Lightweight SVG chart showing last 60s of rolling average chunk transfer rates. X-axis spans exactly the past minute with tick marks at :20 and :45 intervals, Y-axis auto-scales based on current observed range so spikes remain visible without being overwhelming when speeds are generally stable around a consistent baseline value like ~1–3 Mbps for typical WiFi connections or 200-800 kbps for mobile data plans depending on network conditions at time of download | Sparkline redraws every 2 seconds using latest rolling window values from speed observer composable. Each data point represents the average transfer rate over a single chunk's fetch duration (typically ~3–15 seconds per segment)

- [ ] Additional telemetry metrics displayed below sparkline as compact stat cards:
  
| Metric | Display format | 
|--------|---------------|
| Stall count/duration | Number of stalls since last track start OR 0 if none occurred. Format shows "Stalls: N (total Xs)" where X = cumulative time spent in stalled state across all events during this playback session tracking from first pause event through final resume trigger for the current playing item
  
- [ ] Buffer health indicator showing cached chunks count vs downloading chunk count side-by-side with status dots colored green/yellow/red based on whether cache is healthy (≥ 50% full), filling normally, or draining dangerously (<10% remaining). Format: "Cache: N chunks | Downloading: M"

- [ ] Track info display showing total file size in MB and overall download progress as a thin horizontal bar beneath the main metrics section. Progress updates continuously while track is being buffered for first time; once fully cached, displays checkmark icon with label "Fully cached". If partially downloaded (track still playing), shows percentage filled alongside elapsed seconds remaining to reach complete cache coverage based on current average transfer rate calculation

- [ ] Settings persist in localStorage under key `muzsikapp-player-settings-v2` and apply immediately when changed without requiring page reload or player restart. Values survive across browser sessions until manually reset by user clearing local storage through devtools interface
  
## Implementation Paths  

### Path A — Single Vue component with reactive state
1. Create `/frontend/src/components/SettingsPanel.vue`:  
   ```vue
    <template> 
      <!-- Collapsible wrapper panel -->
     <div class="settings-panel" :class="{ collapsed: !isOpen }">
       <div v-if="isOpen" class="panel-content">
         <div class="left-section settings-tab">...</div>
         <div class=right-section telemetry-tab">... </div> 
        </div>  
      <!-- Chevron toggle at bottom edge -->
     <button @click="toggle()" class="chevron-toggle">{{ isOpen ? '▲' : '▼' }}</ button>
    </template>
   ```

2. Create `/frontend/src/composables/useTelemetry.js` — singleton composable that observes chunk cache state (used bytes, total allocated), download speed measurements via Fetch API performance timing hooks inside useMseBuffer, stall detection by wrapping MSE append errors and network error handlers:  
  `export function useTelemetry() { const memoryUsage = ref({ used:0, total:50*1024*1024 });`
   - Sparkline data stored as simple array of `{ timestamp, value }` objects with oldest entries pruned every update cycle to maintain exactly the last 60-second window worth of samples (roughly 30–180 points depending on chunk fetch duration)

### Path B — Separate components for each metric type  
- Break out individual sub-components: `CacheSizeSlider.vue`, `SpeedSparklineChart.vue`, etc. Each has its own unit tests and styling scope
**Pros:** Cleaner separation of concerns, easier to test in isolation without needing full SettingsPanel mounted context (can mount just the sparkline chart with mock data props)  
- **Cons**: More files than necessary for what's essentially a single cohesive UI element that users interact with together rather than independently. Would require passing down complex prop interfaces between parent/child layers when all metrics come from same source of truth anyway

**Recommended:** Path A — the SettingsPanel is small enough (~200 lines of Vue template + ~150 JS) to stay maintainable as one component without splitting into sub-components that would add unnecessary indirection through multiple prop drilling levels just for styling purposes when everything shares reactive state from useTelemetry composable anyway

## Test Plan  

- **Unit: SettingsPanel.vue** — mount with test props (isOpen=false by default), verify chevron click toggles to open/closed states correctly and persists chosen preference in localStorage under correct key path `muzsikapp-player-settings-v2`
  - Verify cache size slider emits updated value on input event within expected range boundaries (10–500 MB step increments of exactly twenty-five megabyte units for consistency across all user interface interactions involving this control element)  
- **Unit: useTelemetry.js** — mock fetch performance timing data to simulate download speeds ranging from 200KB/s up through maximum observed rates around three Mbps depending on network conditions at time test runs against different simulated bandwidth profiles. Verify sparkline array updates correctly with latest rolling window values pruned properly every two-second interval so oldest timestamps outside sixty second boundary get removed automatically maintaining accurate historical view without memory leaks or stale data accumulation over extended playback sessions lasting hours
  
- **Manual integration:** Open AudioPlayerV2 in dev mode playing real M4A file, expand SettingsPanel and verify all metrics update live during active streaming phase with correct values matching what DevTools Network tab shows for actual transfer rates at same time period being observed by telemetry system running concurrently alongside user interface displaying those numbers simultaneously on screen

## Definition of Done  

- [ ] All acceptance criteria satisfied and verified  
  - [ ] Tests added or updated — passing locally (`bun run test`)
    - Type check clean (typecheck) 
      - Docs and notes updated with links to ticket    
        - Operational impact assessed (config changes, migrations restarts)          
          - Follow-up tickets created for deferred scope            
            - Update history complete with evidence
