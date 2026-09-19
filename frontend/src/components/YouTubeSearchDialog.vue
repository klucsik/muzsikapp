<template>
  <div v-if="show" class="dialog-overlay">
    <div class="dialog-box">
      <div class="dialog-header">
        <h3>{{ title }}</h3>
        <button class="close-btn" @click="close" title="Close">&times;</button>
      </div>
      
      <div class="dialog-body">
        <!-- Folder Selection -->
        <div class="folder-selection">
          <FolderSelector
            v-model="selectedFolderIds"
            :folders="folders"
            label="Add downloads to folders (optional, hold Ctrl/Cmd to select multiple)"
            :show-track-counts="false"
            :multiple="true"
          />
        </div>

        <!-- Search Input -->
        <div class="search-section">
          <input
            ref="searchInput"
            v-model="searchQuery"
            type="text"
            placeholder="Search YouTube or paste a video/playlist link..."
            @keyup.enter="handleSearch"
            class="search-input"
          />
          <button 
            @click="handleSearch" 
            :disabled="searching || !searchQuery.trim()"
            class="search-btn"
          >
            {{ searching ? 'Searching...' : 'Search' }}
          </button>
        </div>

        <!-- Loading State -->
        <div v-if="searching" class="loading">
          <div class="spinner"></div>
          <p>{{ isPlaylistUrl(searchQuery) ? 'Loading playlist...' : 'Searching YouTube...' }}</p>
        </div>

        <!-- Error Message -->
        <div v-if="error" class="error-message">
          <p>{{ error }}</p>
          <button @click="error = null" class="dismiss-btn">Dismiss</button>
        </div>

        <!-- Success Message -->
        <div v-if="successMessage" class="success-message">
          <p>{{ successMessage }}</p>
          <button @click="successMessage = null" class="dismiss-btn">Dismiss</button>
        </div>

        <!-- Search Results -->
        <div v-if="results.length > 0 && !searching" class="results-section">
          <h4>Results ({{ results.length }})</h4>
          <div class="results-list">
            <div 
              v-for="result in results" 
              :key="result.video_id"
              class="result-item"
              :class="{ 'already-downloaded': isAlreadyDownloaded(result.video_id) }"
            >
              <!-- Thumbnail -->
              <div class="result-thumbnail">
                <img 
                  v-if="result.thumbnail" 
                  :src="result.thumbnail" 
                  :alt="result.title"
                  @error="handleImageError"
                />
                <div v-else class="thumbnail-placeholder">🎵</div>
              </div>

              <!-- Info -->
              <div class="result-info">
                <div class="result-title" :title="result.title">
                  {{ result.title }}
                </div>
                <div class="result-meta">
                  <span v-if="result.channel" class="result-channel">
                    {{ result.channel }}
                  </span>
                  <span v-if="result.duration" class="result-duration">
                    • {{ formatDuration(result.duration) }}
                  </span>
                </div>
              </div>

              <!-- Action Button -->
              <div class="result-action">
                <button 
                  v-if="isAlreadyDownloaded(result.video_id)"
                  class="downloaded-badge"
                  disabled
                  title="This video has already been downloaded"
                >
                  ✓ Downloaded
                </button>
                <button 
                  v-else-if="isDownloading(result.video_id)"
                  class="downloading-btn"
                  disabled
                >
                  ⏳ Downloading...
                </button>
                <button 
                  v-else
                  @click="handleDownload(result)"
                  class="download-btn"
                  :disabled="downloadingIds.has(result.video_id)"
                >
                  ⬇ Download
                </button>
              </div>
            </div>
          </div>

          <!-- Next page: stays clickable until YouTube runs out, disabled while in flight -->
          <button
            v-if="hasMoreResults"
            class="load-more-btn"
            :disabled="loadingMore || searching"
            @click="loadMoreResults"
          >
            <span v-if="loadingMore" class="loading-spinner"></span>
            {{ loadingMore ? 'Loading…' : `Load 10 more (${results.length} shown)` }}
          </button>
        </div>

        <!-- Empty State -->
        <div v-if="!searching && !error && results.length === 0 && hasSearched" class="empty-state">
          <p>No results found for "{{ lastSearchQuery }}"</p>
          <p class="hint">Try different keywords or check your spelling</p>
        </div>

        <!-- Initial State -->
        <div v-if="!searching && !error && !hasSearched" class="initial-state">
          <p>🔍 Search YouTube or paste a link</p>
          <p class="hint">Enter keywords to search, or paste a YouTube video/playlist URL to download</p>
        </div>
      </div>

      <div class="dialog-footer">
        <button @click="close" class="cancel-btn">Close</button>
      </div>
    </div>

    <!-- Playlist Confirmation Dialog -->
    <div v-if="showPlaylistConfirm" class="dialog-overlay">
      <div class="dialog-box playlist-confirm-dialog">
        <div class="dialog-header">
          <h3>Confirm Playlist Download</h3>
          <button class="close-btn" @click="cancelPlaylistConfirm" title="Close">&times;</button>
        </div>
        
        <div class="dialog-body">
          <div class="playlist-info">
            <h4>{{ playlistPreview.playlist_title || 'Unknown Playlist' }}</h4>
            <p class="playlist-meta">
              {{ playlistPreview.video_count }} video{{ playlistPreview.video_count !== 1 ? 's' : '' }}
              <span v-if="playlistPreview.channel"> • {{ playlistPreview.channel }}</span>
            </p>
          </div>

          <div class="playlist-tracks-preview">
            <div class="tracks-header">
              <h5>Tracks to download:</h5>
              <div class="selection-controls">
                <button @click="selectAll" class="select-btn" v-if="!allSelected">Select All</button>
                <button @click="deselectAll" class="select-btn" v-else>Deselect All</button>
              </div>
            </div>
            <div class="tracks-list">
              <div 
                v-for="(video, index) in playlistPreview.videos" 
                :key="video.video_id"
                class="track-preview-item"
                :class="{
                  'already-downloaded': isAlreadyDownloaded(video.video_id),
                  'selected': isSelected(video.video_id),
                  'deselected': !isSelected(video.video_id)
                }"
                @click="toggleSelection(video.video_id)"
              >
                <div class="checkbox-container">
                  <input 
                    type="checkbox"
                    :checked="isSelected(video.video_id)"
                    @click.stop
                    @change="toggleSelection(video.video_id)"
                  />
                </div>
                <span class="track-number">{{ index + 1 }}.</span>
                <div class="track-thumbnail-small">
                  <img 
                    v-if="video.thumbnail" 
                    :src="video.thumbnail" 
                    :alt="video.title"
                    @error="handleImageError"
                  />
                  <div v-else class="thumbnail-placeholder-small">🎵</div>
                </div>
                <div class="track-info-small">
                  <div class="track-title-small" :title="video.title">
                    {{ video.title }}
                    <span v-if="isAlreadyDownloaded(video.video_id)" class="downloaded-indicator">✓ Downloaded</span>
                  </div>
                  <div class="track-meta-small">
                    <span v-if="video.channel">{{ video.channel }}</span>
                    <span v-if="video.duration"> • {{ formatDuration(video.duration) }}</span>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div class="confirmation-summary">
            <p>
              <strong>{{ selectedNewTracksCount }}</strong> new track{{ selectedNewTracksCount !== 1 ? 's' : '' }} will be added to the download queue
              <span v-if="selectedTracksCount !== selectedNewTracksCount"> ({{ selectedTracksCount - selectedNewTracksCount }} already downloaded)</span>
            </p>
          </div>
        </div>

        <div class="dialog-footer">
          <button @click="cancelPlaylistConfirm" class="cancel-btn">Cancel</button>
          <button 
            @click="confirmPlaylistDownload" 
            class="confirm-btn"
            :disabled="selectedNewTracksCount === 0"
          >
            Add {{ selectedNewTracksCount }} Track{{ selectedNewTracksCount !== 1 ? 's' : '' }} to Queue
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, watch, onMounted, onUnmounted, nextTick, computed } from 'vue';
import api from '../services/api';
import websocket from '../services/websocket';
import FolderSelector from './FolderSelector.vue';

const props = defineProps({
  show: {
    type: Boolean,
    default: false
  },
  title: {
    type: String,
    default: 'Search YouTube Music'
  },
  downloadedVideoIds: {
    type: Set,
    default: () => new Set()
  },
  folders: {
    type: Array,
    default: () => []
  }
});

const emit = defineEmits(['close', 'download-started']);

// State
const searchQuery = ref('');
const lastSearchQuery = ref('');
const results = ref([]);
const searching = ref(false);
// Paging state for "load more": the query stays put and each page appends to `results`.
const loadingMore = ref(false);
const hasMoreResults = ref(false);
const resultOffset = ref(0);
const SEARCH_PAGE_SIZE = 10;
const error = ref(null);
const successMessage = ref(null);
const hasSearched = ref(false);
const searchInput = ref(null);
const downloadingIds = ref(new Set());
const selectedFolderIds = ref([]);

// Playlist confirmation state
const showPlaylistConfirm = ref(false);
const playlistPreview = ref({
  playlist_title: '',
  channel: '',
  video_count: 0,
  videos: []
});
const pendingPlaylistUrl = ref('');
const selectedVideoIds = ref(new Set());

/**
 * Check if input is a YouTube URL
 */
const isYouTubeUrl = (text) => {
  const patterns = [
    /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([^&\s?]+)/,
    /^[a-zA-Z0-9_-]{11}$/, // Direct video ID
  ];
  return patterns.some(pattern => pattern.test(text));
};

/**
 * Check if input is a YouTube playlist URL
 */
const isPlaylistUrl = (text) => {
  const playlistPatterns = [
    /[?&]list=([a-zA-Z0-9_-]+)/,
    /youtube\.com\/playlist\?list=([a-zA-Z0-9_-]+)/,
  ];
  return playlistPatterns.some(pattern => pattern.test(text));
};

/**
 * Handle search or URL download
 */
const handleSearch = async () => {
  if (!searchQuery.value.trim()) {
    return;
  }

  const query = searchQuery.value.trim();
  
  // Check if it's a playlist URL
  if (isPlaylistUrl(query)) {
    await handlePlaylistUrl(query);
  } else if (isYouTubeUrl(query)) {
    // Check if it's a regular video URL
    await handleDirectUrl(query);
  } else {
    // It's a search query
    await handleYouTubeSearch(query);
  }
};

/**
 * Handle direct URL download
 */
const handleDirectUrl = async (url) => {
  searching.value = true;
  error.value = null;
  results.value = [];
  lastSearchQuery.value = url;

  try {
    // For single video URLs, we can add directly without confirmation
    // (user explicitly pasted a single video, not a playlist)
    const response = await api.addDownloadJob(
      url, 
      selectedFolderIds.value && selectedFolderIds.value.length > 0 
        ? selectedFolderIds.value 
        : null
    );
    
    // Show success message
    successMessage.value = 'Download started! Check the download queue for progress.';
    emit('download-started', response.job);
    
    // Clear the input and close after a short delay
    setTimeout(() => {
      successMessage.value = null;
      close();
    }, 2000);
    
  } catch (err) {
    console.error('Direct download failed:', err);
    
    if (err.message && err.message.includes('already')) {
      error.value = 'This video is already downloaded or in the queue';
    } else if (err.message && err.message.includes('Invalid')) {
      error.value = 'Invalid YouTube URL. Please check the link and try again.';
    } else {
      error.value = 'Failed to start download. Please check the URL and try again.';
    }
  } finally {
    searching.value = false;
  }
};

/**
 * Handle playlist URL download
 */
const handlePlaylistUrl = async (url) => {
  searching.value = true;
  error.value = null;
  results.value = [];
  lastSearchQuery.value = url;

  try {
    // Fetch playlist info first (without adding to queue)
    const playlistData = await api.getPlaylistInfo(url);
    
    if (!playlistData.videos || playlistData.videos.length === 0) {
      error.value = 'This playlist is empty or private.';
      return;
    }
    
    // Store playlist data and URL for confirmation
    playlistPreview.value = playlistData;
    pendingPlaylistUrl.value = url;
    
    // Pre-select all videos that aren't already downloaded
    selectedVideoIds.value = new Set(
      playlistData.videos
        .filter(v => !isAlreadyDownloaded(v.video_id))
        .map(v => v.video_id)
    );
    
    // Show confirmation dialog
    showPlaylistConfirm.value = true;
    
  } catch (err) {
    console.error('Playlist fetch failed:', err);
    
    if (err.message && err.message.includes('Invalid')) {
      error.value = 'Invalid playlist URL. Please check the link and try again.';
    } else if (err.message && err.message.includes('empty')) {
      error.value = 'This playlist is empty or private.';
    } else {
      error.value = 'Failed to fetch playlist. Please check the URL and try again.';
    }
  } finally {
    searching.value = false;
  }
};

/**
 * Confirm and execute playlist download
 */
const confirmPlaylistDownload = async () => {
  if (!pendingPlaylistUrl.value || selectedVideoIds.value.size === 0) return;
  
  searching.value = true;
  showPlaylistConfirm.value = false;
  
  try {
    // Filter videos to only include selected ones
    const selectedVideos = playlistPreview.value.videos.filter(v => 
      selectedVideoIds.value.has(v.video_id) && !isAlreadyDownloaded(v.video_id)
    );
    
    // Add selected videos to download queue individually
    const jobs = [];
    let errorCount = 0;
    
    for (const video of selectedVideos) {
      try {
        const metadata = {
          video_id: video.video_id,
          title: video.title,
          channel: video.channel,
          duration: video.duration,
          thumbnail: video.thumbnail,
          url: video.url,
        };
        
        const response = await api.addDownloadFromSearch({
          ...metadata,
          folder_ids: selectedFolderIds.value && selectedFolderIds.value.length > 0 
            ? selectedFolderIds.value 
            : undefined
        });
        
        jobs.push(response.job);
        emit('download-started', response.job);
      } catch (err) {
        console.error('Failed to add video:', video.title, err);
        errorCount++;
      }
    }
    
    // Create response object for success message
    const response = {
      playlist_title: playlistPreview.value.playlist_title,
      added: jobs.length,
      skipped: errorCount
    };
    
    // Show success message with details
    const addedCount = response.added || 0;
    const skippedCount = response.skipped || 0;
    
    let message = `Playlist "${response.playlist_title || 'Unknown'}" processed:\n`;
    message += `${addedCount} video${addedCount !== 1 ? 's' : ''} added to download queue`;
    
    if (skippedCount > 0) {
      message += `\n${skippedCount} video${skippedCount !== 1 ? 's' : ''} skipped (already downloaded or in queue)`;
    }
    
    successMessage.value = message;
    
    // Clear the input and close after a longer delay for playlists
    setTimeout(() => {
      successMessage.value = null;
      close();
    }, 4000);
    
  } catch (err) {
    console.error('Playlist download failed:', err);
    
    if (err.message && err.message.includes('Invalid')) {
      error.value = 'Invalid playlist URL. Please check the link and try again.';
    } else if (err.message && err.message.includes('empty')) {
      error.value = 'This playlist is empty or private.';
    } else {
      error.value = 'Failed to process playlist. Please check the URL and try again.';
    }
  } finally {
    searching.value = false;
    pendingPlaylistUrl.value = '';
    playlistPreview.value = {
      playlist_title: '',
      channel: '',
      video_count: 0,
      videos: []
    };
  }
};

/**
 * Cancel playlist confirmation
 */
const cancelPlaylistConfirm = () => {
  showPlaylistConfirm.value = false;
  pendingPlaylistUrl.value = '';
  playlistPreview.value = {
    playlist_title: '',
    channel: '',
    video_count: 0,
    videos: []
  };
  selectedVideoIds.value.clear();
  searching.value = false;
};

/**
 * Toggle selection of a video
 */
const toggleSelection = (videoId) => {
  if (selectedVideoIds.value.has(videoId)) {
    selectedVideoIds.value.delete(videoId);
  } else {
    selectedVideoIds.value.add(videoId);
  }
  // Trigger reactivity
  selectedVideoIds.value = new Set(selectedVideoIds.value);
};

/**
 * Check if a video is selected
 */
const isSelected = (videoId) => {
  return selectedVideoIds.value.has(videoId);
};

/**
 * Select all non-downloaded videos
 */
const selectAll = () => {
  selectedVideoIds.value = new Set(
    playlistPreview.value.videos
      .filter(v => !isAlreadyDownloaded(v.video_id))
      .map(v => v.video_id)
  );
};

/**
 * Deselect all videos
 */
const deselectAll = () => {
  selectedVideoIds.value.clear();
  selectedVideoIds.value = new Set();
};

/**
 * Check if all selectable videos are selected
 */
const allSelected = computed(() => {
  const selectableVideos = playlistPreview.value.videos?.filter(v => !isAlreadyDownloaded(v.video_id)) || [];
  if (selectableVideos.length === 0) return false;
  return selectableVideos.every(v => selectedVideoIds.value.has(v.video_id));
});

/**
 * Count selected tracks
 */
const selectedTracksCount = computed(() => {
  return selectedVideoIds.value.size;
});

/**
 * Count selected tracks that will be newly downloaded
 */
const selectedNewTracksCount = computed(() => {
  if (!playlistPreview.value.videos) return 0;
  return playlistPreview.value.videos.filter(v => 
    selectedVideoIds.value.has(v.video_id) && !isAlreadyDownloaded(v.video_id)
  ).length;
});

/**
 * Handle YouTube search
 */
const handleYouTubeSearch = async (query) => {
  searching.value = true;
  error.value = null;
  results.value = [];
  resultOffset.value = 0;
  hasMoreResults.value = false;
  lastSearchQuery.value = query;

  try {
    const response = await api.searchYouTube(query, SEARCH_PAGE_SIZE, 0);
    results.value = response.results || [];
    resultOffset.value = results.value.length;
    hasMoreResults.value = !!response.has_more;
    hasSearched.value = true;
    
    if (results.value.length === 0) {
      error.value = 'No results found. Try different keywords.';
    }
  } catch (err) {
    console.error('Search failed:', err);
    error.value = 'Search failed. Please try again.';
  } finally {
    searching.value = false;
  }
};

/**
 * Fetch the next page of results for the last query and append it.
 */
const loadMoreResults = async () => {
  if (loadingMore.value || searching.value || !hasMoreResults.value) return;

  loadingMore.value = true;
  error.value = null;
  try {
    const response = await api.searchYouTube(lastSearchQuery.value, SEARCH_PAGE_SIZE, resultOffset.value);
    const page = response.results || [];

    // The backend pages by slicing a longer ytsearch, so a repeated row is possible when
    // YouTube reshuffles between calls.
    const seen = new Set(results.value.map((r) => r.video_id));
    const fresh = page.filter((r) => !seen.has(r.video_id));
    results.value = [...results.value, ...fresh];
    resultOffset.value += page.length;
    hasMoreResults.value = !!response.has_more && page.length > 0;
  } catch (err) {
    console.error('Load more failed:', err);
    error.value = 'Could not load more results. Please try again.';
  } finally {
    loadingMore.value = false;
  }
};

/**
 * Handle download button click
 */
const handleDownload = async (result) => {
  try {
    downloadingIds.value.add(result.video_id);
    
    const downloadData = {
      video_id: result.video_id,
      title: result.title,
      channel: result.channel,
      duration: result.duration,
      thumbnail: result.thumbnail,
      url: result.url,
    };
    
    // Add folder_ids if selected
    if (selectedFolderIds.value && selectedFolderIds.value.length > 0) {
      downloadData.folder_ids = selectedFolderIds.value;
    }
    
    const response = await api.addDownloadFromSearch(downloadData);

    successMessage.value = `"${result.title}" added to download queue`;
    emit('download-started', response.job);

    // Clear success message after 3 seconds
    setTimeout(() => {
      successMessage.value = null;
    }, 3000);

  } catch (err) {
    console.error('Download failed:', err);
    downloadingIds.value.delete(result.video_id);
    
    if (err.message && err.message.includes('already')) {
      error.value = 'This video is already downloaded or in the queue';
    } else {
      error.value = 'Failed to start download. Please try again.';
    }
  }
};

/**
 * Check if video is already downloaded
 */
const isAlreadyDownloaded = (videoId) => {
  return props.downloadedVideoIds.has(videoId);
};

/**
 * Check if video is currently downloading
 */
const isDownloading = (videoId) => {
  return downloadingIds.value.has(videoId);
};

/**
 * Format duration from seconds to MM:SS
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
};

/**
 * Close dialog
 */
const close = () => {
  emit('close');
};

/**
 * Focus search input when dialog opens
 */
watch(() => props.show, async (newVal) => {
  if (newVal) {
    await nextTick();
    searchInput.value?.focus();
  } else {
    // Reset state when closing
    searchQuery.value = '';
    results.value = [];
    resultOffset.value = 0;
    hasMoreResults.value = false;
    loadingMore.value = false;
    error.value = null;
    successMessage.value = null;
    hasSearched.value = false;
    downloadingIds.value.clear();
    selectedFolderIds.value = [];
  }
});

/**
 * Handle download job completed event
 */
const handleDownloadCompleted = (data) => {
  if (data.job && data.job.youtube_video_id) {
    downloadingIds.value.delete(data.job.youtube_video_id);
  }
};

/**
 * Handle download job failed event
 */
const handleDownloadFailed = (data) => {
  if (data.youtube_video_id) {
    downloadingIds.value.delete(data.youtube_video_id);
  }
};

// Listen to WebSocket events
onMounted(() => {
  websocket.on('download_job_completed', handleDownloadCompleted);
  websocket.on('download_job_failed', handleDownloadFailed);
});

onUnmounted(() => {
  websocket.off('download_job_completed', handleDownloadCompleted);
  websocket.off('download_job_failed', handleDownloadFailed);
});
</script>

<style scoped>
.dialog-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.75);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
  padding: 20px;
}

.dialog-box {
  background: #2a2a2a;
  border-radius: 8px;
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.5);
  max-width: 700px;
  width: 100%;
  max-height: 80vh;
  display: flex;
  flex-direction: column;
}

.dialog-header {
  padding: 20px;
  border-bottom: 1px solid #444;
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.dialog-header h3 {
  margin: 0;
  font-size: 1.2em;
  color: white;
}

.close-btn {
  background: none;
  border: none;
  color: #999;
  font-size: 2em;
  cursor: pointer;
  padding: 0;
  width: 32px;
  height: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 4px;
  transition: all 0.2s;
}

.close-btn:hover {
  background: #444;
  color: white;
}

.dialog-body {
  padding: 20px;
  overflow-y: auto;
  flex: 1;
}

.folder-selection {
  margin-bottom: 20px;
  padding-bottom: 20px;
  border-bottom: 1px solid #333;
}

.search-section {
  display: flex;
  gap: 10px;
  margin-bottom: 20px;
}

.search-input {
  flex: 1;
  padding: 12px;
  background: #1a1a1a;
  border: 1px solid #444;
  border-radius: 4px;
  color: white;
  font-size: 1em;
}

.search-input:focus {
  outline: none;
  border-color: #42b983;
}

.search-btn {
  padding: 12px 24px;
  background: #42b983;
  border: none;
  border-radius: 4px;
  color: white;
  font-size: 1em;
  cursor: pointer;
  transition: all 0.2s;
  white-space: nowrap;
}

.search-btn:hover:not(:disabled) {
  background: #35a372;
}

.search-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.loading {
  text-align: center;
  padding: 40px 20px;
}

.spinner {
  border: 4px solid #333;
  border-top: 4px solid #42b983;
  border-radius: 50%;
  width: 50px;
  height: 50px;
  animation: spin 1s linear infinite;
  margin: 0 auto 20px;
}

@keyframes spin {
  0% { transform: rotate(0deg); }
  100% { transform: rotate(360deg); }
}

.error-message,
.success-message {
  padding: 12px 16px;
  border-radius: 4px;
  margin-bottom: 20px;
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 10px;
}

.error-message p,
.success-message p {
  margin: 0;
  white-space: pre-line;
  flex: 1;
}

.error-message {
  background: #ff4444;
  color: white;
}

.success-message {
  background: #4CAF50;
  color: white;
}

.dismiss-btn {
  background: rgba(0, 0, 0, 0.2);
  border: none;
  padding: 4px 12px;
  border-radius: 4px;
  color: white;
  cursor: pointer;
  font-size: 0.9em;
}

.dismiss-btn:hover {
  background: rgba(0, 0, 0, 0.4);
}

.results-section h4 {
  margin: 0 0 15px 0;
  color: #999;
  font-size: 0.9em;
  text-transform: uppercase;
  letter-spacing: 1px;
}

.results-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.load-more-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  width: 100%;
  margin-top: 12px;
  padding: 10px 16px;
  background: #2a2a2a;
  border: 1px solid #444;
  border-radius: 4px;
  color: #eee;
  font-size: 0.9em;
  cursor: pointer;
  transition: all 0.2s;
}

.load-more-btn:hover:not(:disabled) {
  background: #333;
  border-color: #42b983;
}

.load-more-btn:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.loading-spinner {
  width: 14px;
  height: 14px;
  border: 2px solid #555;
  border-top-color: #42b983;
  border-radius: 50%;
  animation: spin 1s linear infinite;
}

.result-item {
  display: flex;
  gap: 12px;
  padding: 12px;
  background: #1a1a1a;
  border-radius: 6px;
  border: 1px solid #333;
  transition: all 0.2s;
}

.result-item:hover {
  border-color: #42b983;
  background: #222;
}

.result-item.already-downloaded {
  opacity: 0.6;
  border-color: #666;
}

.result-thumbnail {
  width: 120px;
  height: 68px;
  flex-shrink: 0;
  border-radius: 4px;
  overflow: hidden;
  background: #333;
  display: flex;
  align-items: center;
  justify-content: center;
}

.result-thumbnail img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.thumbnail-placeholder {
  font-size: 2em;
  color: #666;
}

.result-info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  justify-content: center;
}

.result-title {
  font-size: 1em;
  font-weight: 500;
  margin-bottom: 6px;
  overflow: hidden;
  text-overflow: ellipsis;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  color: white;
}

.result-meta {
  font-size: 0.85em;
  color: #999;
}

.result-channel {
  color: #aaa;
}

.result-duration {
  color: #777;
}

.result-action {
  display: flex;
  align-items: center;
  flex-shrink: 0;
}

.download-btn {
  padding: 8px 16px;
  background: #4CAF50;
  border: none;
  border-radius: 4px;
  color: white;
  cursor: pointer;
  font-size: 0.9em;
  transition: all 0.2s;
  white-space: nowrap;
}

.download-btn:hover:not(:disabled) {
  background: #45a049;
  transform: translateY(-1px);
}

.download-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.downloaded-badge {
  padding: 8px 16px;
  background: #666;
  border: none;
  border-radius: 4px;
  color: white;
  cursor: not-allowed;
  font-size: 0.9em;
  opacity: 0.7;
  white-space: nowrap;
}

.downloading-btn {
  padding: 8px 16px;
  background: #FF9800;
  border: none;
  border-radius: 4px;
  color: white;
  cursor: not-allowed;
  font-size: 0.9em;
  white-space: nowrap;
}

.empty-state,
.initial-state {
  text-align: center;
  padding: 60px 20px;
  color: #999;
}

.empty-state p:first-child,
.initial-state p:first-child {
  font-size: 1.2em;
  margin-bottom: 10px;
}

.hint {
  font-size: 0.9em;
  color: #666;
}

.dialog-footer {
  padding: 16px 20px;
  border-top: 1px solid #444;
  display: flex;
  justify-content: flex-end;
  gap: 10px;
}

.cancel-btn {
  padding: 10px 20px;
  background: #444;
  border: none;
  border-radius: 4px;
  color: white;
  cursor: pointer;
  font-size: 0.95em;
  transition: all 0.2s;
}

.cancel-btn:hover {
  background: #555;
}

/* Scrollbar styling */
.dialog-body::-webkit-scrollbar {
  width: 8px;
}

.dialog-body::-webkit-scrollbar-track {
  background: #1a1a1a;
}

.dialog-body::-webkit-scrollbar-thumb {
  background: #444;
  border-radius: 4px;
}

.dialog-body::-webkit-scrollbar-thumb:hover {
  background: #555;
}

/* Playlist Confirmation Dialog */
.playlist-confirm-dialog {
  max-width: 800px;
}

.playlist-info {
  padding: 16px;
  background: #1a1a1a;
  border-radius: 8px;
  margin-bottom: 20px;
}

.playlist-info h4 {
  margin: 0 0 8px 0;
  font-size: 1.1em;
  color: white;
}

.playlist-meta {
  margin: 0;
  color: #999;
  font-size: 0.9em;
}

.playlist-tracks-preview {
  margin-bottom: 20px;
}

.tracks-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 12px;
}

.tracks-header h5 {
  margin: 0;
  font-size: 0.95em;
  color: #999;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.selection-controls {
  display: flex;
  gap: 8px;
}

.select-btn {
  padding: 6px 12px;
  background: #333;
  border: 1px solid #444;
  border-radius: 4px;
  color: white;
  cursor: pointer;
  font-size: 0.85em;
  transition: all 0.2s;
}

.select-btn:hover {
  background: #444;
  border-color: #4CAF50;
}

.tracks-list {
  max-height: 400px;
  overflow-y: auto;
  border: 1px solid #333;
  border-radius: 6px;
  background: #1a1a1a;
}

.track-preview-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 12px;
  border-bottom: 1px solid #333;
  transition: all 0.2s;
  cursor: pointer;
  user-select: none;
}

.track-preview-item:last-child {
  border-bottom: none;
}

.track-preview-item:hover {
  background: #222;
}

.track-preview-item.already-downloaded {
  opacity: 0.5;
  cursor: not-allowed;
}

.track-preview-item.deselected {
  opacity: 0.5;
}

.track-preview-item.selected {
  opacity: 1;
  background: rgba(76, 175, 80, 0.1);
}

.track-preview-item.selected:hover {
  background: rgba(76, 175, 80, 0.15);
}

.checkbox-container {
  display: flex;
  align-items: center;
  padding-left: 4px;
}

.checkbox-container input[type="checkbox"] {
  width: 18px;
  height: 18px;
  cursor: pointer;
  accent-color: #4CAF50;
}

.track-number {
  color: #666;
  font-size: 0.85em;
  min-width: 30px;
  text-align: right;
}

.track-thumbnail-small {
  width: 60px;
  height: 34px;
  flex-shrink: 0;
  border-radius: 4px;
  overflow: hidden;
  background: #333;
  display: flex;
  align-items: center;
  justify-content: center;
}

.track-thumbnail-small img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.thumbnail-placeholder-small {
  font-size: 1em;
  color: #666;
}

.track-info-small {
  flex: 1;
  min-width: 0;
}

.track-title-small {
  font-size: 0.9em;
  font-weight: 500;
  color: white;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  margin-bottom: 4px;
}

.downloaded-indicator {
  color: #4CAF50;
  font-size: 0.85em;
  margin-left: 8px;
}

.track-meta-small {
  font-size: 0.8em;
  color: #999;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.confirmation-summary {
  padding: 16px;
  background: #1a1a1a;
  border-radius: 8px;
  border: 1px solid #4CAF50;
}

.confirmation-summary p {
  margin: 0;
  color: white;
  font-size: 0.95em;
}

.confirm-btn {
  padding: 10px 20px;
  background: #4CAF50;
  border: none;
  border-radius: 4px;
  color: white;
  cursor: pointer;
  font-size: 0.95em;
  transition: all 0.2s;
  font-weight: 500;
}

.confirm-btn:hover:not(:disabled) {
  background: #45a049;
}

.confirm-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.tracks-list::-webkit-scrollbar {
  width: 8px;
}

.tracks-list::-webkit-scrollbar-track {
  background: #1a1a1a;
}

.tracks-list::-webkit-scrollbar-thumb {
  background: #444;
  border-radius: 4px;
}

.tracks-list::-webkit-scrollbar-thumb:hover {
  background: #555;
}
</style>
