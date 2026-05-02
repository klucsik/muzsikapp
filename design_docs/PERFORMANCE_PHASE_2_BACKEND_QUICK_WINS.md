# Performance Phase 2: Backend Quick Wins

## Scope
Apply low-risk backend optimizations with measurable impact on API latency and server overhead.

## Out of Scope
- Protocol redesign
- Major schema redesign
- Distributed caching

## Tasks

### 1) Eliminate N+1 position updates in collection ordering
Objective:
- Replace iterative per-row position shifts with set-based SQL updates.

Dependencies:
- Phase 1 baseline complete

Optimal context sources:
- Primary: [backend/src/db/collectionQueries.js](../backend/src/db/collectionQueries.js)
- Supporting: [backend/src/routes/collections.js](../backend/src/routes/collections.js)
- Supporting: [backend/src/db/schema-collections.sql](../backend/src/db/schema-collections.sql)

Deliverables:
- Updated ordering strategy with unchanged API behavior
- Before/after latency comparison for reorder/add/remove operations

### 2) Add or verify high-value indexes
Objective:
- Improve common filters/sorts and relation lookups used in hot paths.

Dependencies:
- Phase 1 DB timing evidence

Optimal context sources:
- Primary: [backend/src/db/schema-base.sql](../backend/src/db/schema-base.sql)
- Supporting: [backend/src/db/schema-collections.sql](../backend/src/db/schema-collections.sql)
- Supporting: [backend/src/db/migrations](../backend/src/db/migrations)
- Supporting: [backend/src/db/database.js](../backend/src/db/database.js)

Deliverables:
- Migration plan for indexes
- Query-path impact summary

### 3) Optimize queue status aggregation
Objective:
- Reduce repeated in-memory filtering overhead.

Dependencies:
- Phase 1 queue status timing

Optimal context sources:
- Primary: [backend/src/services/downloadQueue.js](../backend/src/services/downloadQueue.js)
- Supporting: [backend/src/routes/downloads.js](../backend/src/routes/downloads.js)
- Supporting: [backend/src/db/database.js](../backend/src/db/database.js)

Deliverables:
- Efficient status aggregation path
- Response-time delta for queue endpoints

### 4) Cache hot count and repeated playlist fetch paths
Objective:
- Reduce repeated expensive reads on high-frequency calls.

Dependencies:
- Phase 1 route and websocket telemetry

Optimal context sources:
- Primary: [backend/src/routes/tracks.js](../backend/src/routes/tracks.js)
- Supporting: [backend/src/websocket/socketServer.js](../backend/src/websocket/socketServer.js)
- Supporting: [backend/src/websocket/syncController.js](../backend/src/websocket/syncController.js)
- Supporting: [backend/src/routes/collections.js](../backend/src/routes/collections.js)

Deliverables:
- Cache strategy with clear invalidation rules
- Before/after metrics for affected calls

### 5) Reduce duplicate detection scan cost (low-risk)
Objective:
- Avoid full-library scan in common duplicate checks using indexed prefiltering.

Dependencies:
- Phase 1 duplicate-check timing

Optimal context sources:
- Primary: [backend/src/services/deduplication.js](../backend/src/services/deduplication.js)
- Supporting: [backend/src/db/schema-base.sql](../backend/src/db/schema-base.sql)
- Supporting: [backend/src/db/collectionQueries.js](../backend/src/db/collectionQueries.js)

Deliverables:
- Low-risk duplicate lookup improvement
- Measured time reduction for duplicate checks

## Verification Checklist
- No API contract changes
- p50/p95 improvement on targeted backend paths
- Cache invalidation verified on mutation endpoints
- No functional regression in collections/download flow

## Exit Criteria
Phase 3 and 4 can proceed after backend quick wins show measurable gains and pass regression checks.