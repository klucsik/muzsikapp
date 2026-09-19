/**
 * Composable for managing track collections
 * Provides reactive state and methods for collection operations
 */

import { ref, computed, watch, onMounted, onUnmounted } from 'vue';
import api from '../services/api';
import websocket from '../services/websocket';

export function useTrackCollection(collectionId, options = {}) {
  const {
    autoLoad = true,
    enableWebSocket = false,
    webSocketEvents = [],
    orderBy = ref('title'),
    orderDir = ref('asc'),
    searchQuery = ref('')
  } = options;

  // State
  const collection = ref(null);
  const tracks = ref([]);
  const loading = ref(false);
  const error = ref(null);

  // In-flight load guard. Selection changes and WebSocket refreshes can overlap; without
  // this a slow response for the previously selected collection lands last and overwrites
  // the one the user is actually looking at.
  let loadSequence = 0;
  let inflightLoad = null;

  /**
   * Get the actual collection ID value (handles computed refs)
   */
  const getCollectionId = () => {
    // Handle computed refs
    if (collectionId && typeof collectionId === 'object' && 'value' in collectionId) {
      return collectionId.value;
    }
    return collectionId;
  };

  /**
   * Load collection data from API
   */
  const loadCollection = async () => {
    const actualId = getCollectionId();
    
    if (!actualId) {
      error.value = 'No collection ID provided';
      return;
    }

    const sequence = ++loadSequence;
    inflightLoad?.abort();
    const controller = new AbortController();
    inflightLoad = controller;

    loading.value = true;
    error.value = null;

    try {
      // Build query params for ordering (library only) and search
      const params = new URLSearchParams();
      if (orderBy.value) params.append('order_by', orderBy.value);
      if (orderDir.value) params.append('order_dir', orderDir.value);
      if (searchQuery.value) params.append('search', searchQuery.value);
      
      const queryString = params.toString();
      const url = `/api/collections/${actualId}${queryString ? `?${queryString}` : ''}`;
      
      const data = await api.request(url, { signal: controller.signal });
      if (sequence !== loadSequence) return; // superseded by a newer load
      collection.value = data;
      tracks.value = data.tracks || [];
    } catch (err) {
      if (err?.name === 'AbortError' || sequence !== loadSequence) return;
      console.error('Failed to load collection:', err);
      error.value = err.message || 'Failed to load collection';
      tracks.value = [];
    } finally {
      if (inflightLoad === controller) inflightLoad = null;
      if (sequence === loadSequence) loading.value = false;
    }
  };

  /**
   * Refresh collection data
   */
  const refresh = () => {
    return loadCollection();
  };

  /**
   * Add a track to the collection
   */
  const addTrack = async (trackId, position = null) => {
    const actualId = getCollectionId();
    if (!actualId) return;
    
    try {
      const data = await api.addTrackToCollection(actualId, trackId, position);
      collection.value = data;
      tracks.value = data.tracks || [];
      return data;
    } catch (err) {
      console.error('Failed to add track:', err);
      error.value = err.message || 'Failed to add track';
      throw err;
    }
  };

  /**
   * Remove a track from the collection
   */
  const removeTrack = async (trackId, position = null) => {
    const actualId = getCollectionId();
    if (!actualId) return;
    
    try {
      const data = await api.removeTrackFromCollection(actualId, trackId, position);
      collection.value = data;
      tracks.value = data.tracks || [];
      return data;
    } catch (err) {
      console.error('Failed to remove track:', err);
      error.value = err.message || 'Failed to remove track';
      throw err;
    }
  };

  /**
   * Reorder a track within the collection
   */
  const reorderTrack = async (trackId, newPosition) => {
    const actualId = getCollectionId();
    if (!actualId) return;
    
    try {
      const data = await api.reorderTrackInCollection(actualId, trackId, newPosition);
      collection.value = data;
      tracks.value = data.tracks || [];
      return data;
    } catch (err) {
      console.error('Failed to reorder track:', err);
      error.value = err.message || 'Failed to reorder track';
      throw err;
    }
  };

  /**
   * Clear all tracks from the collection
   */
  const clearTracks = async () => {
    const actualId = getCollectionId();
    if (!actualId) return;
    
    try {
      const data = await api.clearCollectionTracks(actualId);
      collection.value = data;
      tracks.value = [];
      return data;
    } catch (err) {
      console.error('Failed to clear tracks:', err);
      error.value = err.message || 'Failed to clear tracks';
      throw err;
    }
  };

  /**
   * Update collection metadata
   */
  const updateCollection = async (updates) => {
    const actualId = getCollectionId();
    if (!actualId) return;
    
    try {
      const data = await api.updateCollection(actualId, updates);
      collection.value = data;
      tracks.value = data.tracks || [];
      return data;
    } catch (err) {
      console.error('Failed to update collection:', err);
      error.value = err.message || 'Failed to update collection';
      throw err;
    }
  };

  /**
   * Handle drag and drop - add track at specific position
   */
  const handleTrackDrop = async (track, position = null) => {
    try {
      return await addTrack(track.id, position);
    } catch (err) {
      console.error('Failed to drop track:', err);
      throw err;
    }
  };

  /**
   * Handle reorder from drag and drop indices
   */
  const handleTrackReorder = async (track, oldIndex, newIndex) => {
    // Optimistic update
    const oldTracks = [...tracks.value];
    const newTracks = [...tracks.value];
    const [movedTrack] = newTracks.splice(oldIndex, 1);
    newTracks.splice(newIndex, 0, movedTrack);
    tracks.value = newTracks;

    try {
      await reorderTrack(track.id, newIndex);
    } catch (err) {
      // Revert on error
      tracks.value = oldTracks;
      throw err;
    }
  };

  // WebSocket event handlers
  const handleWebSocketEvent = (eventName, handler) => {
    if (enableWebSocket && websocket) {
      websocket.on(eventName, handler);
      return () => websocket.off(eventName, handler);
    }
    return () => {};
  };

  // Setup WebSocket listeners
  const socketCleanup = ref([]);

  if (enableWebSocket && webSocketEvents.length > 0) {
    onMounted(() => {
      webSocketEvents.forEach(({ event, handler }) => {
        const cleanup = handleWebSocketEvent(event, (data) => {
          handler(data, { collection, tracks, refresh });
        });
        socketCleanup.value.push(cleanup);
      });
    });

    onUnmounted(() => {
      socketCleanup.value.forEach(cleanup => cleanup());
      socketCleanup.value = [];
    });
  }

  // Auto-load on mount
  if (autoLoad) {
    onMounted(() => {
      loadCollection();
    });
  }

  // Switching selection must not leave the previous collection's rows on screen while the
  // new one loads; the id is reactive here only when the caller passes a ref or computed.
  if (collectionId && typeof collectionId === 'object' && 'value' in collectionId) {
    watch(collectionId, (next, prev) => {
      if (next === prev) return;
      loadSequence++; // discard any response for the collection we just left
      inflightLoad?.abort();
      collection.value = null;
      tracks.value = [];
      error.value = null;
      loadCollection();
    });
  }

  // Computed properties
  const trackCount = computed(() => tracks.value.length);
  const isEmpty = computed(() => tracks.value.length === 0);
  const isOrdered = computed(() => collection.value?.is_ordered === 1);
  const collectionName = computed(() => collection.value?.name || '');
  const collectionType = computed(() => collection.value?.type || '');

  return {
    // State
    collection,
    tracks,
    loading,
    error,

    // Computed
    trackCount,
    isEmpty,
    isOrdered,
    collectionName,
    collectionType,

    // Methods
    loadCollection,
    refresh,
    addTrack,
    removeTrack,
    reorderTrack,
    clearTracks,
    updateCollection,
    handleTrackDrop,
    handleTrackReorder
  };
}
