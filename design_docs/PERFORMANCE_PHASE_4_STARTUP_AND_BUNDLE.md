# Performance Phase 4: Startup and Bundle Optimization

## Scope
Reduce initial load and improve repeat-load responsiveness using low-risk bundling tactics.

## Out of Scope
- Framework migration
- Major route redesign
- Complex runtime module federation strategies

## Tasks

### 1) Identify heavy initial-load modules
Objective:
- Rank components and dependencies contributing most to first-load cost.

Dependencies:
- Phase 1 startup baseline complete

Optimal context sources:
- Primary: [frontend/src/main.js](../frontend/src/main.js)
- Supporting: [frontend/src/App.vue](../frontend/src/App.vue)
- Supporting: [frontend/package.json](../frontend/package.json)
- Supporting: [frontend/vite.config.js](../frontend/vite.config.js)

Deliverables:
- Ranked list of high-cost startup modules
- Candidate list for lazy loading

### 2) Apply low-risk lazy loading for non-critical UI
Objective:
- Defer infrequently used heavy UI blocks until first use.

Dependencies:
- Task 1

Optimal context sources:
- Primary: [frontend/src/App.vue](../frontend/src/App.vue)
- Supporting: [frontend/src/components/ManageLibraryPanel.vue](../frontend/src/components/ManageLibraryPanel.vue)
- Supporting: [frontend/src/components/YouTubeSearchDialog.vue](../frontend/src/components/YouTubeSearchDialog.vue)
- Supporting: [frontend/src/components/DownloadQueuePanel.vue](../frontend/src/components/DownloadQueuePanel.vue)

Deliverables:
- Lazy-load mapping and trigger points
- First-load vs first-use tradeoff notes

### 3) Validate chunking and cacheability strategy
Objective:
- Improve long-term caching and avoid oversized application chunks.

Dependencies:
- Task 2

Optimal context sources:
- Primary: [frontend/vite.config.js](../frontend/vite.config.js)
- Supporting: [frontend/index.html](../frontend/index.html)
- Supporting: [frontend/package.json](../frontend/package.json)

Deliverables:
- Chunk strategy proposal
- Payload and TTI before/after comparison

## Verification Checklist
- Initial payload size decreases or remains neutral while improving TTI
- No broken lazy-loaded panel/dialog flows
- Repeat-load behavior improves with caching

## Exit Criteria
Startup/bundle changes are validated with measurable gains and no runtime loading regressions.