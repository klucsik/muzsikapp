## Plan: Mobile Native Audio Player MVP

Build a lightweight native app using Capacitor around the existing Vue client, but with a dedicated player-focused shell and native background audio handling, to solve mobile continuous playback limitations in browsers. Reuse existing backend REST and WebSocket protocols unchanged for v1, and ship Android first with explicit sync/reconnect handling.

**Steps**
1. Phase 1 - Scope lock and architecture baseline.
   Confirm v1 scope as: Android-only, player-focused app with playlist/queue selection, repeat and loop points, volume, and room selection, while keeping backend contracts unchanged. Define non-goals: no offline download/cache, no backend auth hardening in this phase.
2. Phase 2 - Create native shell and runtime wiring. Depends on step 1.
   Add Capacitor to frontend app and create Android project target. Configure app id, build flavor, environment base URLs for REST and Socket endpoint, and secure token persistence strategy for mobile runtime.
3. Phase 3 - Extract player domain logic from Vue component. Depends on step 2.
   Split playback domain from UI by moving event/state orchestration from AudioPlayer into composable or service modules: state sync, play/pause/resume/seek command dispatch, drift handling, loop point updates, reconnect and request_state behavior. Keep current web UI working while making logic reusable in native-focused screens.
4. Phase 4 - Implement native background playback path. Depends on step 3.
   Replace browser-only continuity assumptions with Capacitor-native audio and media control integration suitable for Android background operation. Ensure headset/lockscreen controls map to the same server commands and that foreground service or equivalent Android playback requirements are configured.
5. Phase 5 - Build lightweight native-first player UI. Parallel with late step 4 once playback service interface is stable.
   Build a minimal screen set centered on player flow: now playing with transport controls, queue/playlist selector, repeat and loop controls, volume, room selector, and connection/sync status. Remove unrelated management/admin surfaces from mobile entry flow.
6. Phase 6 - Mobile resilience and sync correctness hardening. Depends on steps 4-5.
   Add app lifecycle handlers for background/foreground transitions, network loss/reconnect, room rejoin, state rehydration, and drift correction re-application after resume. Define retry/backoff and stale-state handling to prevent silent desync.
7. Phase 7 - Verification and rollout readiness. Depends on steps 2-6.
   Execute Android real-device test matrix, collect metrics and logs, and run a staged rollout plan (internal, beta, then production) with rollback criteria.

**Relevant files**
- frontend/src/components/AudioPlayer.vue - primary extraction target for playback orchestration, drift/loop logic, and currently browser-specific controls.
- frontend/src/services/websocket.js - reusable real-time protocol client and server-time offset logic.
- frontend/src/services/api.js - reusable playback command surface and audio URL generation.
- frontend/src/services/authService.js - token and login session flows to adapt for secure mobile persistence.
- frontend/src/App.vue - mobile app shell entry adjustments to restrict to player-focused UX.
- backend/src/routes/playback.js - existing playback endpoints consumed unchanged in v1.
- backend/src/routes/audio.js - stream endpoint behavior and range request compatibility for mobile player.
- backend/src/websocket/socketServer.js - socket connection behavior and room events used by native client.
- backend/src/websocket/syncController.js - authoritative playback scheduling, position checks, repeat/loop behavior.

**Verification**
1. Functional playback continuity tests on Android device.
   Start playback, lock screen, background app for 5/15/30 minutes, and verify uninterrupted audio with expected battery behavior.
2. Protocol and sync validation.
   Verify native client handles events play_track, pause, resume, seek, state_sync, position_check, repeat_mode_change, loop_points_change, room_joined, and request_state after resume/reconnect.
3. Reconnect robustness tests.
   Simulate airplane mode toggles and Wi-Fi/mobile network changes while playing; verify auto-rejoin room, state reconciliation, and no duplicated play actions.
4. Multi-client consistency tests.
   Run desktop web and native Android client in same room and verify synchronized position, repeat behavior, loop points, and track transition semantics.
5. Regression tests for existing web frontend.
   Ensure extracted logic does not break current browser player behavior in desktop and mobile web fallback paths.
6. Release gating.
   Require zero critical playback interruption defects, no severe sync regressions over 24-hour soak tests, and crash-free threshold agreed before beta rollout.

**Decisions**
- Included scope: Android-first Capacitor app, player-focused UI, queue/playlist selection, repeat and loop points, volume, room selection.
- Excluded scope: iOS in v1, offline cache/downloads, backend auth/CORS hardening, backend protocol redesign.
- Backend strategy: keep current API and WebSocket contracts as-is for v1; defer hardening to a follow-up phase.

**Further Considerations**
1. Native audio plugin choice for Capacitor should be decided early based on Android background support and lockscreen control quality. Recommendation: run a short spike with 1-2 plugin candidates before implementation of phase 4.
2. App distribution path should be clarified at planning completion. Recommendation: internal APK distribution first, then Play Console internal testing track.
3. Future iOS phase should be pre-scoped now to avoid architecture dead-ends. Recommendation: preserve platform abstraction boundaries in phase 3 so iOS can be added without rewriting player domain logic.
