<template>
  <div class="music-library-panel">
    <OrderedTrackList
      :tracks="tracks"
      :current-track="currentTrack"
      :allow-reorder="false"
      :allow-remove="false"
      :allow-drop="false"
      :show-position="false"
      :enable-double-click="true"
      :enable-single-click="false"
      @track-dblclick="handleTrackDoubleClick"
    >
      <template #header>
        <div class="library-header">
          <div class="header-row">
            <h3>Library</h3>
            <button
              @click="handleManageLibraryClick"
              class="manage-library-btn"
              title="Manage library and download music"
            >
              ⚙️ Manage
            </button>
            <div class="order-controls">
              <select v-model="orderBy" class="order-select" title="Sort by">
                <option value="title">Name</option>
                <option value="artist">Artist</option>
                <option value="album">Album</option>
                <option value="created_at">Date Added</option>
              </select>
              <button 
                @click="orderDir = orderDir === 'asc' ? 'desc' : 'asc'" 
                class="order-direction-btn"
                :title="orderDir === 'asc' ? 'Ascending' : 'Descending'"
              >
                {{ orderDir === 'asc' ? '↑' : '↓' }}
              </button>
            </div>
            <div class="library-search">
              <input
                v-model="searchQuery"
                type="text"
                placeholder="Search tracks..."
                @input="handleSearch"
              />
            </div>
            <div class="library-stats">
              {{ trackCount }} tracks
              <span v-if="loading">• Loading...</span>
            </div>
          </div>
        </div>
      </template>

      <template #track="{ track }">
        <div 
          class="track-info"
          draggable="true"
          @dragstart="handleDragStart(track, $event)"
        >
          <!-- Thumbnail -->
          <div v-if="track.youtube_thumbnail" class="track-thumbnail">
            <img 
              :src="track.youtube_thumbnail" 
              :alt="track.title"
              @error="handleImageError"
            />
          </div>
          <div v-else class="track-thumbnail-placeholder">
            🎵
          </div>
          
          <div class="track-text">
            <div class="track-title" :title="track.title">
              {{ track.title || 'Unknown' }}
              <span v-if="track.youtube_video_id" class="youtube-badge" title="Downloaded from YouTube">
                ▶️
              </span>
            </div>
            <div class="track-meta" :title="track.artist">
              {{ track.artist || 'Unknown Artist' }}
              <span v-if="track.duration"> • {{ formatDuration(track.duration) }}</span>
            </div>
          </div>
        </div>
      </template>

      <template #empty>
        <div class="empty-library">
          <p>No tracks in library</p>
          <p class="empty-hint">Add music files to the music directory and scan</p>
        </div>
      </template>

      <template #footer>
        <div class="library-footer" v-if="hasMore">
          <button @click="loadMore" :disabled="loading">
            Load More
          </button>
        </div>
      </template>
    </OrderedTrackList>

    <!-- Add Music Dialog -->
    <SimpleDialog
      :show="showAddMusicDialog"
      title="Add Music"
      :message="addMusicText"
      :continue-url="addMusicUrl"
      @close="handleDialogClose"
      @continue="handleDialogClose"
    />

    <!-- YouTube Search Dialog -->
    <YouTubeSearchDialog
      :show="showYouTubeSearchDialog"
      :downloaded-video-ids="downloadedVideoIds"
      :folders="folders"
      @close="handleYouTubeSearchClose"
      @download-started="handleDownloadStarted"
    />
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted, watch } from 'vue';
import OrderedTrackList from './OrderedTrackList.vue';
import SimpleDialog from './SimpleDialog.vue';
import YouTubeSearchDialog from './YouTubeSearchDialog.vue';
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

const emit = defineEmits(['track-play', 'open-manage-library']);

// Import toast
import { useToast } from '../composables/useToast.js';
const toast = useToast();

// Ordering state
const orderBy = ref(localStorage.getItem('library-order-by') || 'title');
const orderDir = ref(localStorage.getItem('library-order-dir') || 'asc');

// Search functionality
const searchQuery = ref('');
const searchTimeout = ref(null);

// Use the collection composable for the library
const {
  tracks,
  loading,
  error,
  trackCount,
  loadCollection,
  refresh
} = useTrackCollection('library', {
  autoLoad: true,
  enableWebSocket: false,
  orderBy,
  orderDir,
  searchQuery
});

// Watch for order changes and reload
watch([orderBy, orderDir], () => {
  localStorage.setItem('library-order-by', orderBy.value);
  localStorage.setItem('library-order-dir', orderDir.value);
  loadCollection();
});

// Add Music Dialog
const showAddMusicDialog = ref(false);
const showYouTubeSearchDialog = ref(false);
const addMusicUrl = ref('');
const addMusicText = ref('');
const downloadedVideoIds = ref(new Set());
const folders = ref([]);

// Load folders for YouTube dialog
const loadFolders = async () => {
  try {
    const result = await api.getCollections('folder');
    folders.value = result;
  } catch (err) {
    console.error('Failed to load folders:', err);
  }
};

// Load system config to get add music URL and text
const loadSystemInfo = async () => {
  try {
    const response = await api.getConfig();
    addMusicUrl.value = response.addMusicUrl || '';
    addMusicText.value = response.addMusicText || 'Click "Continue" to open the music source in a new tab.';
    console.log('Add Music config loaded:', { url: addMusicUrl.value, text: addMusicText.value });
  } catch (err) {
    console.error('Failed to load system config:', err);
  }
};

// Load downloaded video IDs
const loadDownloadedVideoIds = () => {
  const ids = new Set();
  tracks.value.forEach(track => {
    if (track.youtube_video_id) {
      ids.add(track.youtube_video_id);
    }
  });
  downloadedVideoIds.value = ids;
};

// Watch tracks for changes to update downloaded video IDs
watch(tracks, () => {
  loadDownloadedVideoIds();
}, { deep: true });

const handleManageLibraryClick = () => {
  if (!props.isAuthenticated) {
    toast.warning('Please log in to manage your library');
    return;
  }
  emit('open-manage-library');
};

const handleAddMusicClick = () => {
  // Always open YouTube search dialog
  showYouTubeSearchDialog.value = true;
};

const handleDialogClose = () => {
  showAddMusicDialog.value = false;
};

const handleYouTubeSearchClose = () => {
  showYouTubeSearchDialog.value = false;
};

const handleDownloadStarted = (job) => {
  console.log('Download started:', job);
  // Could show a notification here
};

const handleSearch = () => {
  clearTimeout(searchTimeout.value);
  searchTimeout.value = setTimeout(() => {
    loadCollection();
  }, 300);
};

// Pagination
const hasMore = computed(() => false); // TODO: Implement pagination

const loadMore = () => {
  // TODO: Implement load more
  console.log('Load more tracks');
};

/**
 * Handle double-click to play track
 */
const handleTrackDoubleClick = ({ track, index }) => {
  emit('track-play', track);
};

/**
 * Handle drag start for dragging tracks to playlist/folders
 */
const handleDragStart = (track, event) => {
  event.dataTransfer.effectAllowed = 'copy';
  event.dataTransfer.setData('application/json', JSON.stringify(track));
  event.dataTransfer.setData('text/plain', track.id);
};

/**
 * Format duration
 */
const formatDuration = (seconds) => {
  if (!seconds) return '';
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
};

/**
 * Handle image loading errors
 */
const handleImageError = (event) => {
  event.target.style.display = 'none';
  event.target.parentElement.classList.add('error');
};

/**
 * Handle track updated from WebSocket
 */
const handleTrackUpdated = (data) => {
  console.log('Track updated, refreshing library:', data);
  refresh();
};

/**
 * Handle track deleted from WebSocket
 */
const handleTrackDeleted = (data) => {
  console.log('Track deleted, refreshing library:', data);
  refresh();
};

// Load system info on mount
onMounted(() => {
  loadSystemInfo();
  loadDownloadedVideoIds();
  websocket.on('track_updated', handleTrackUpdated);
  websocket.on('track_deleted', handleTrackDeleted);
});

onUnmounted(() => {
  websocket.off('track_updated', handleTrackUpdated);
  websocket.off('track_deleted', handleTrackDeleted);
});

// Expose refresh method
defineExpose({
  refresh
});
</script>

<style scoped>
.music-library-panel {
  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--color-bg-dark);
  border-radius: var(--radius-lg);
  overflow: hidden;
}

.library-header {
  padding: var(--spacing-md);
  border-bottom: 1px solid var(--color-border-dark);
  background: #222;
}

.header-row {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
  flex-wrap: wrap;
}

.library-header h3 {
  margin: 0;
  font-size: var(--font-size-base);
  color: var(--color-text-primary);
  white-space: nowrap;
  flex-shrink: 0;
}

.library-search {
  flex: 1;
  min-width: 150px;
}

.library-search input {
  width: 100%;
  padding: var(--spacing-sm) var(--spacing-md);
  background: var(--color-bg-input);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  color: var(--color-text-primary);
  font-size: var(--font-size-sm);
  font-family: inherit;
  transition: var(--transition-quick);
}

.library-search input:focus {
  outline: none;
  border-color: var(--color-primary);
  box-shadow: 0 0 0 2px rgba(76, 175, 80, 0.1);
}

.library-search input::placeholder {
  color: var(--color-text-muted);
}

.add-music-btn,
.manage-library-btn {
  padding: var(--spacing-sm) var(--spacing-md);
  background: var(--color-primary);
  border: 1px solid var(--color-primary);
  border-radius: var(--radius-md);
  color: white;
  text-decoration: none;
  font-size: var(--font-size-sm);
  white-space: nowrap;
  transition: var(--transition-quick);
  display: inline-flex;
  align-items: center;
  gap: var(--spacing-xs);
  cursor: pointer;
  font-family: inherit;
  font-weight: var(--font-weight-normal);
  flex-shrink: 0;
}

.add-music-btn:hover,
.manage-library-btn:hover {
  background: var(--color-primary-hover);
  border-color: var(--color-primary-hover);
}

.add-music-btn:active,
.manage-library-btn:active {
  transform: scale(0.98);
}

.order-controls {
  display: flex;
  align-items: center;
  gap: var(--spacing-xs);
  flex-shrink: 0;
}

.order-select {
  padding: var(--spacing-sm) var(--spacing-md);
  background: var(--color-bg-input);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  color: var(--color-text-primary);
  font-size: var(--font-size-sm);
  font-family: inherit;
  cursor: pointer;
  transition: var(--transition-quick);
}

.order-select:hover {
  border-color: var(--color-primary);
}

.order-select:focus {
  outline: none;
  border-color: var(--color-primary);
}

.order-direction-btn {
  padding: var(--spacing-sm) var(--spacing-md);
  background: var(--color-bg-input);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  color: var(--color-text-primary);
  font-size: var(--font-size-base);
  cursor: pointer;
  transition: var(--transition-quick);
  min-width: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.order-direction-btn:hover {
  background: #333;
  border-color: var(--color-primary);
}

.order-direction-btn:active {
  background: var(--color-primary);
}

.library-stats {
  font-size: var(--font-size-sm);
  color: var(--color-text-secondary);
  white-space: nowrap;
  flex-shrink: 0;
}

/* Track Item Styles */
.track-info {
  display: flex;
  align-items: center;
  gap: var(--spacing-md);
  flex: 1;
  min-width: 0;
  cursor: grab;
}

.track-info:active {
  cursor: grabbing;
}

.track-thumbnail {
  width: 71px;
  height: 40px;
  flex-shrink: 0;
  border-radius: var(--radius-sm);
  overflow: hidden;
  background: var(--color-bg-input);
}

.track-thumbnail img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.track-thumbnail-placeholder {
  width: 71px;
  height: 40px;
  flex-shrink: 0;
  border-radius: var(--radius-sm);
  background: var(--color-bg-input);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 1.2em;
  color: var(--color-text-muted);
  flex-shrink: 0;
}

.track-text {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-xs);
  min-width: 0;
  flex: 1;
}

.track-title {
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-normal);
  color: var(--color-text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  display: flex;
  align-items: center;
  gap: var(--spacing-xs);
}

.youtube-badge {
  font-size: var(--font-size-xs);
  opacity: 0.7;
  flex-shrink: 0;
}

.track-meta {
  font-size: var(--font-size-xs);
  color: var(--color-text-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* Empty State */
.empty-library {
  text-align: center;
  padding: var(--spacing-xl);
  color: var(--color-text-muted);
}

.empty-library p {
  margin: 0;
}

.empty-hint {
  font-size: var(--font-size-sm);
  color: var(--color-text-secondary);
  margin-top: var(--spacing-md);
}

/* Footer */
.library-footer {
  padding: var(--spacing-md);
  text-align: center;
  border-top: 1px solid var(--color-border-dark);
}

.library-footer button {
  padding: var(--spacing-sm) var(--spacing-lg);
  background: var(--color-primary);
  border: 1px solid var(--color-primary);
  border-radius: var(--radius-md);
  color: white;
  cursor: pointer;
  font-size: var(--font-size-sm);
  font-family: inherit;
  transition: var(--transition-quick);
}

.library-footer button:hover:not(:disabled) {
  background: var(--color-primary-hover);
  border-color: var(--color-primary-hover);
}

.library-footer button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* Responsive */
@media (max-width: 1024px) {
  .header-row {
    flex-direction: column;
    align-items: stretch;
  }

  .library-search {
    min-width: unset;
  }

  .order-controls {
    width: 100%;
  }

  .library-stats {
    width: 100%;
    text-align: center;
  }
}

@media (max-width: 768px) {
  .library-header {
    padding: var(--spacing-sm);
  }

  .header-row {
    gap: var(--spacing-xs);
  }

  .track-thumbnail {
    width: 60px;
    height: 36px;
  }

  .track-thumbnail-placeholder {
    width: 60px;
    height: 36px;
  }
}
</style>
