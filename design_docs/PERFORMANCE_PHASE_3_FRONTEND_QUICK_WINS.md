# Performance Phase 3: Frontend Quick Wins

## Scope
Apply low-risk rendering and state-management improvements to reduce unnecessary UI work.

## Out of Scope
- Full list virtualization rewrite
- Major UX redesign
- Route architecture overhaul

## Tasks

### 1) Remove deep watcher hotspots on large arrays
Objective:
- Reduce deep reactive traversal and unnecessary refresh work.

Dependencies:
- Phase 1 frontend profiling baseline

Optimal context sources:
- Primary: [frontend/src/components/PlaylistPanel.vue](../frontend/src/components/PlaylistPanel.vue)
- Supporting: [frontend/src/components/MusicLibraryPanel.vue](../frontend/src/components/MusicLibraryPanel.vue)
- Supporting: [frontend/src/components/ManageLibraryPanel.vue](../frontend/src/components/ManageLibraryPanel.vue)
- Supporting: [frontend/src/composables/useTrackCollection.js](../frontend/src/composables/useTrackCollection.js)

Deliverables:
- Watcher strategy update and regression-safe behavior notes
- Before/after render cost measurements

### 2) Lazy-load thumbnails and improve image fallback behavior
Objective:
- Reduce initial image request burst and layout instability.

Dependencies:
- Phase 1 network/render baseline

Optimal context sources:
- Primary: [frontend/src/components/OrderedTrackList.vue](../frontend/src/components/OrderedTrackList.vue)
- Supporting: [frontend/src/components/MusicLibraryPanel.vue](../frontend/src/components/MusicLibraryPanel.vue)
- Supporting: [frontend/src/components/ManageLibraryPanel.vue](../frontend/src/components/ManageLibraryPanel.vue)
- Supporting: [frontend/src/style.css](../frontend/src/style.css)

Deliverables:
- Lazy thumbnail loading strategy
- Image failure fallback behavior definition

### 3) Reduce panel remount churn on view switches
Objective:
- Preserve component state and lower toggle latency.

Dependencies:
- Phase 1 panel toggle timing

Optimal context sources:
- Primary: [frontend/src/App.vue](../frontend/src/App.vue)
- Supporting: [frontend/src/components/ManageLibraryPanel.vue](../frontend/src/components/ManageLibraryPanel.vue)
- Supporting: [frontend/src/components/MusicLibraryPanel.vue](../frontend/src/components/MusicLibraryPanel.vue)
- Supporting: [frontend/src/components/FolderManagerPanel.vue](../frontend/src/components/FolderManagerPanel.vue)

Deliverables:
- Toggle strategy decision and expected UX behavior
- Before/after panel switch timing

### 4) Normalize websocket listener lifecycle
Objective:
- Prevent listener accumulation across mount/unmount cycles.

Dependencies:
- Phase 1 session stability observations

Optimal context sources:
- Primary: [frontend/src/services/websocket.js](../frontend/src/services/websocket.js)
- Supporting: [frontend/src/App.vue](../frontend/src/App.vue)
- Supporting: [frontend/src/components/AudioPlayer.vue](../frontend/src/components/AudioPlayer.vue)
- Supporting: [frontend/src/components/PlaylistPanel.vue](../frontend/src/components/PlaylistPanel.vue)

Deliverables:
- Listener lifecycle conventions
- Memory stability check after repeated toggles

### 5) Reduce unnecessary polling load
Objective:
- Lower background request frequency while preserving useful freshness.

Dependencies:
- Phase 1 API frequency baseline

Optimal context sources:
- Primary: [frontend/src/App.vue](../frontend/src/App.vue)
- Supporting: [frontend/src/services/api.js](../frontend/src/services/api.js)
- Supporting: [backend/src/routes/system.js](../backend/src/routes/system.js)

Deliverables:
- Polling strategy update with rationale
- Before/after request-rate comparison

## Verification Checklist
- UI behavior remains functionally equivalent
- Render timings improve in targeted views
- No websocket duplicate-handler side effects
- No new stale-data issues from polling changes

## Exit Criteria
Frontend quick wins produce measurable improvements without UX regressions.