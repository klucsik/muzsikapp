# Performance Phase 1: Baseline Instrumentation

## Scope
Establish reliable before-state metrics for backend latency, websocket traffic, and frontend rendering on the target profile (1000 tracks, 10 concurrent users).

## Out of Scope
- Query/index changes
- Frontend behavior changes
- Protocol or architecture refactors

## Tasks

### 1) Backend latency and DB timing baseline
Objective:
- Capture p50/p95 latency for hot endpoints and expensive DB-backed operations.

Dependencies:
- None

Optimal context sources:
- Primary: [backend/src/routes/tracks.js](../backend/src/routes/tracks.js)
- Supporting: [backend/src/routes/collections.js](../backend/src/routes/collections.js)
- Supporting: [backend/src/services/downloadQueue.js](../backend/src/services/downloadQueue.js)
- Supporting: [backend/src/services/deduplication.js](../backend/src/services/deduplication.js)
- Supporting: [backend/src/server.js](../backend/src/server.js)
- Supporting: [backend/src/utils/logger.js](../backend/src/utils/logger.js)

Deliverables:
- Endpoint timing report for list/count/collection/queue/dedup paths
- p50/p95 table and baseline timestamp

### 2) WebSocket frequency and payload baseline
Objective:
- Measure events per minute, payload size distribution, and room fanout behavior.

Dependencies:
- None

Optimal context sources:
- Primary: [backend/src/websocket/syncController.js](../backend/src/websocket/syncController.js)
- Supporting: [backend/src/websocket/socketServer.js](../backend/src/websocket/socketServer.js)
- Supporting: [backend/src/websocket/roomState.js](../backend/src/websocket/roomState.js)
- Supporting: [backend/src/websocket/sessionState.js](../backend/src/websocket/sessionState.js)

Deliverables:
- WebSocket event inventory and frequency summary
- Payload-size percentile table

### 3) Frontend render and interaction baseline
Objective:
- Measure first render, playlist render cost, panel toggle latency, and list scroll responsiveness.

Dependencies:
- None

Optimal context sources:
- Primary: [frontend/src/App.vue](../frontend/src/App.vue)
- Supporting: [frontend/src/components/OrderedTrackList.vue](../frontend/src/components/OrderedTrackList.vue)
- Supporting: [frontend/src/components/PlaylistPanel.vue](../frontend/src/components/PlaylistPanel.vue)
- Supporting: [frontend/src/components/MusicLibraryPanel.vue](../frontend/src/components/MusicLibraryPanel.vue)
- Supporting: [frontend/src/components/ManageLibraryPanel.vue](../frontend/src/components/ManageLibraryPanel.vue)

Deliverables:
- Render timing baseline
- Interaction timing baseline for panel switching and list operations

### 4) Baseline acceptance thresholds
Objective:
- Define pass/fail thresholds and common benchmark scenario so later phases are comparable.

Dependencies:
- Tasks 1-3

Optimal context sources:
- Primary: [README.md](../README.md)
- Supporting: [test-docker.sh](../test-docker.sh)
- Supporting: [/memories/session/muzsikapp-frontend-perf.md](/memories/session/muzsikapp-frontend-perf.md)

Deliverables:
- Baseline acceptance sheet with tracked metrics and thresholds

## Verification Checklist
- Same test dataset and concurrency profile used across all baseline runs
- p50 and p95 produced for selected APIs
- WebSocket message frequency and payload sizes captured
- Frontend baseline includes first render, panel toggle, and list interaction metrics

## Exit Criteria
Phase 2 starts only when baseline metrics are recorded and reproducible.