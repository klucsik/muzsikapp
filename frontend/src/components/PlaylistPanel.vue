<template>
  <div class="playlist-panel">
    <OrderedTrackList
      :tracks="tracks"
      :current-track="currentTrack"
      :allow-reorder="true"
      :allow-remove="true"
      :allow-drop="true"
      :show-position="true"
      :enable-double-click="true"
      :enable-single-click="false"
      @track-dblclick="handleTrackDoubleClick"
      @track-remove="handleRemoveTrack"
      @track-reorder="handleReorderTrack"
      @track-drop="handleDropTrack"
    >
      <template #header>
        <div class="playlist-header">
          <div class="header-row">
            <h3>Current Playlist</h3>
            <div class="playlist-controls">
              <button 
                @click="handleClear" 
                :disabled="isEmpty || loading"
                class="clear-btn"
                title="Clear playlist"
              >
                Clear
              </button>
              <button
                @click="handleShuffle"
                :disabled="isEmpty || loading"
                class="shuffle-btn"
                title="Shuffle playlist"
              >
                🔀 Shuffle
              </button>
              <button
                @click="toggleLoop"
                :disabled="loading"
                class="loop-btn"
                :class="{ active: loopPlaylist }"
                :title="loopPlaylist ? 'Loop Playlist: On' : 'Loop Playlist: Off'"
              >
                🔄 {{ loopPlaylist ? 'Looping' : 'Loop' }}
              </button>
              <button
                @click="handleSaveToFolderClick"
                :disabled="isEmpty || loading"
                class="save-btn"
                title="Save to folder"
              >
                💾 Save to Folder
              </button>
            </div>
            <div class="playlist-stats">
              {{ trackCount }} tracks
              <span v-if="loading">• Loading...</span>
            </div>
          </div>
        </div>
      </template>

      <template #empty>
        <div class="empty-playlist">
          <p>Playlist is empty</p>
          <p class="empty-hint">Double-click tracks from the library or drag them here</p>
        </div>
      </template>
    </OrderedTrackList>

    <!-- Save to Folder Dialog -->
    <div v-if="showSaveDialog" class="dialog-overlay" @click.self="showSaveDialog = false">
      <div class="dialog">
        <h3>Save Playlist to Folder</h3>
        <p>Select a folder to save the current playlist to. This will replace the folder's current contents.</p>
        
        <div class="form-group">
          <label>Select Folder</label>
          <select v-model="selectedFolderId" required>
            <option :value="null" disabled>-- Choose a folder --</option>
            <option v-for="folder in folders" :key="folder.id" :value="folder.id">
              {{ folder.name }}
            </option>
          </select>
        </div>

        <div class="dialog-actions">
          <button @click="showSaveDialog = false" class="cancel-btn">Cancel</button>
          <button 
            @click="saveToFolder" 
            :disabled="!selectedFolderId || savingToFolder"
            class="save-confirm-btn"
          >
            {{ savingToFolder ? 'Saving...' : 'Save' }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, watch, onMounted, onUnmounted } from 'vue';
import OrderedTrackList from './OrderedTrackList.vue';
import { useTrackCollection } from '../composables/useTrackCollection';
import api from '../services/api';
import websocket from '../services/websocket';

const props = defineProps({
  currentTrack: {
    type: Object,
    default: null
  },
  isAuthenticated: {
    type: Boolean,
    default: false
  }
});

const emit = defineEmits([
  'track-play',
  'playlist-updated'
]);

// Import toast
import { useToast } from '../composables/useToast.js';
const toast = useToast();

// Track current room and collection ID
const currentRoomId = ref('room-1');
const playlistCollectionId = computed(() => `current-playlist-${currentRoomId.value}`);

// Use track collection composable with computed collection ID
// The composable will automatically handle changes to the collection ID
const {
  tracks,
  loading,
  error,
  trackCount,
  isEmpty,
  loadCollection,
  refresh,
  removeTrack,
  reorderTrack: reorderTrackInCollection,
  clearTracks,
  handleTrackDrop: handleTrackDropComposable,
  handleTrackReorder: handleTrackReorderComposable
} = useTrackCollection(playlistCollectionId, {
  autoLoad: true,
  enableWebSocket: true,
  webSocketEvents: [
    {
      event: 'playlist_update',
      handler: (data, { refresh }) => {
        console.log('Playlist updated via WebSocket', data);
        // Only refresh if this event is for our current room's playlist
        if (data.collectionId === playlistCollectionId.value) {
          console.log('Refreshing playlist for collection:', data.collectionId);
          refresh();
        }
      }
    }
  ]
});

// State for save to folder dialog
const showSaveDialog = ref(false);
const folders = ref([]);
const selectedFolderId = ref(null);
const savingToFolder = ref(false);

// Loop playlist state
const loopPlaylist = ref(false);

// Watch for track changes and emit update event
watch(tracks, (newTracks) => {
  emit('playlist-updated', newTracks);
}, { deep: true });

/**
 * Handle Save to Folder button click
 */
const handleSaveToFolderClick = () => {
  if (!props.isAuthenticated) {
    toast.warning('Please log in to save playlists to folders');
    return;
  }
  showSaveDialog.value = true;
};

/**
 * Handle room joined event
 */
const handleRoomJoined = (data) => {
  console.log('PlaylistPanel: Room joined', data);
  currentRoomId.value = data.roomId;
  // The computed playlistCollectionId will update automatically
  // Trigger a refresh to load the new room's playlist
  setTimeout(() => {
    loadCollection();
  }, 100);
};

/**
 * Handle loop mode change from WebSocket
 */
const handleLoopModeChange = (data) => {
  console.log('Loop playlist mode change:', data);
  loopPlaylist.value = data.loopPlaylist;
};

/**
 * Handle state sync from WebSocket
 */
const handleStateSync = (data) => {
  if (typeof data.loopPlaylist === 'boolean') {
    loopPlaylist.value = data.loopPlaylist;
  }
};

/**
 * Handle track updated from WebSocket
 */
const handleTrackUpdated = (data) => {
  console.log('Track updated, refreshing playlist:', data);
  // Refresh playlist to get updated track metadata
  refresh();
};

/**
 * Handle track deleted from WebSocket
 */
const handleTrackDeleted = (data) => {
  console.log('Track deleted, refreshing playlist:', data);
  // Refresh playlist to remove deleted track
  refresh();
};

// Set up WebSocket listeners
onMounted(() => {
  websocket.on('loop_mode_change', handleLoopModeChange);
  websocket.on('state_sync', handleStateSync);
  websocket.on('track_updated', handleTrackUpdated);
  websocket.on('track_deleted', handleTrackDeleted);
  websocket.on('room_joined', handleRoomJoined);
  
  // Set initial room from websocket if available
  const initialRoomId = websocket.getCurrentRoomId();
  if (initialRoomId && initialRoomId !== currentRoomId.value) {
    currentRoomId.value = initialRoomId;
  }
  
  // Request current state to sync loop mode
  websocket.requestState();
});

onUnmounted(() => {
  websocket.off('loop_mode_change', handleLoopModeChange);
  websocket.off('state_sync', handleStateSync);
  websocket.off('track_updated', handleTrackUpdated);
  websocket.off('track_deleted', handleTrackDeleted);
  websocket.off('room_joined', handleRoomJoined);
});

/**
 * Handle double-click to play track
 */
const handleTrackDoubleClick = (data) => {
  // data contains { track, index }
  emit('track-play', data.track, data.index);
};

/**
 * Handle removing a track
 */
const handleRemoveTrack = async (data) => {
  try {
    // data contains { track, index, position }
    await removeTrack(data.track.id, data.position);
  } catch (err) {
    console.error('Failed to remove track from playlist:', err);
  }
};

/**
 * Handle reordering tracks
 */
const handleReorderTrack = async ({ track, oldIndex, newIndex }) => {
  try {
    await handleTrackReorderComposable(track, oldIndex, newIndex);
  } catch (err) {
    console.error('Failed to reorder track in playlist:', err);
  }
};

/**
 * Handle dropping a track from library
 */
const handleDropTrack = async ({ track, position }) => {
  try {
    await handleTrackDropComposable(track, position);
  } catch (err) {
    console.error('Failed to add track to playlist:', err);
  }
};

/**
 * Clear the entire playlist
 */
const handleClear = async () => {
  if (!confirm('Clear the entire playlist?')) return;
  
  try {
    await clearTracks();
  } catch (err) {
    console.error('Failed to clear playlist:', err);
  }
};

/**
 * Toggle loop playlist mode
 */
const toggleLoop = async () => {
  try {
    await api.toggleLoop(currentRoomId.value);
    console.log('Loop playlist mode toggle sent to server');
  } catch (err) {
    console.error('Failed to toggle loop playlist mode:', err);
  }
};

/**
 * Shuffle the playlist
 */
const handleShuffle = async () => {
  if (isEmpty.value) return;
  
  try {
    // Create shuffled array of track IDs
    const shuffled = [...tracks.value]
      .map((track, index) => ({ track, random: Math.random(), originalIndex: index }))
      .sort((a, b) => a.random - b.random);
    
    // Clear and re-add in new order
    await clearTracks();
    
    const roomPlaylistId = playlistCollectionId.value;
    for (const item of shuffled) {
      await api.addTrackToCollection(roomPlaylistId, item.track.id);
    }
    
    await refresh();
  } catch (err) {
    console.error('Failed to shuffle playlist:', err);
  }
};

/**
 * Load folders for save dialog
 */
const loadFolders = async () => {
  try {
    const data = await api.getCollections('folder');
    folders.value = data || [];
  } catch (err) {
    console.error('Failed to load folders:', err);
  }
};

/**
 * Save playlist to folder
 */
const saveToFolder = async () => {
  if (!selectedFolderId.value || isEmpty.value) return;
  
  savingToFolder.value = true;
  try {
    // Clear folder first
    await api.clearCollectionTracks(selectedFolderId.value);
    
    // Add all tracks from playlist
    for (const track of tracks.value) {
      await api.addTrackToCollection(selectedFolderId.value, track.id);
    }
    
    showSaveDialog.value = false;
    selectedFolderId.value = null;
  } catch (err) {
    console.error('Failed to save playlist to folder:', err);
    toast.error('Failed to save playlist to folder');
  } finally {
    savingToFolder.value = false;
  }
};

// Load folders when dialog opens
watch(showSaveDialog, (show) => {
  if (show) {
    loadFolders();
  }
});

// Expose public methods and data
defineExpose({
  refresh,
  tracks
});
</script>

<style scoped>
.playlist-panel {
  height: 100%;
  display: flex;
  flex-direction: column;
  background: #1a1a1a;
  border-radius: 8px;
  overflow: hidden;
}

.playlist-header {
  padding: 12px;
  border-bottom: 1px solid #333;
  background: #222;
}

.header-row {
  display: flex;
  align-items: center;
  gap: 12px;
  justify-content: space-between;
}

.playlist-header h3 {
  margin: 0;
  font-size: 1em;
  color: #e0e0e0;
  white-space: nowrap;
}

.playlist-controls {
  display: flex;
  gap: 6px;
  flex: 1;
}

.playlist-controls button {
  padding: 5px 10px;
  background: #444;
  border: none;
  border-radius: 6px;
  color: white;
  cursor: pointer;
  font-size: 0.85em;
  transition: background 0.2s;
}

.playlist-controls button:hover:not(:disabled) {
  background: #4CAF50;
}

.playlist-controls button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.clear-btn:hover:not(:disabled) {
  background: #f44336 !important;
}

.loop-btn.active {
  background: #4CAF50 !important;
  border-color: #4CAF50 !important;
}

.loop-btn:hover:not(:disabled) {
  background: #4CAF50 !important;
}

.playlist-stats {
  font-size: 0.85em;
  color: #999;
  white-space: nowrap;
}

.empty-playlist {
  text-align: center;
}

.empty-hint {
  font-size: 0.9em;
  color: #666;
  margin-top: 8px;
}

.save-btn {
  background: #4CAF50 !important;
}

.save-btn:hover:not(:disabled) {
  background: #45a049 !important;
}

/* Dialog Styles */
.dialog-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.7);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}

.dialog {
  background: #2a2a2a;
  border-radius: 12px;
  padding: 25px;
  max-width: 500px;
  width: 90%;
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.5);
}

.dialog h3 {
  margin: 0 0 20px 0;
  font-size: 1.2em;
  color: #e0e0e0;
}

.dialog p {
  margin: 0 0 20px 0;
  color: #e0e0e0;
  font-size: 0.95em;
}

.form-group {
  margin-bottom: 20px;
}

.form-group label {
  display: block;
  margin-bottom: 5px;
  color: #999;
  font-size: 0.9em;
}

.form-group select,
.form-group input {
  width: 100%;
  padding: 10px;
  background: #1a1a1a;
  border: 1px solid #444;
  border-radius: 6px;
  color: #e0e0e0;
  font-size: 1em;
}

.form-group select:focus,
.form-group input:focus {
  outline: none;
  border-color: #4CAF50;
}

.dialog-actions {
  display: flex;
  gap: 12px;
  justify-content: flex-end;
}

.dialog-actions button {
  padding: 10px 20px;
  border-radius: 6px;
  border: none;
  cursor: pointer;
  font-size: 0.9em;
  transition: background 0.2s;
}

.cancel-btn {
  background: #444;
  color: white;
}

.cancel-btn:hover {
  background: #555;
}

.save-confirm-btn {
  background: #4CAF50;
  color: white;
}

.save-confirm-btn:hover:not(:disabled) {
  background: #45a049;
}

.save-confirm-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
