<template>
  <div id="app-content">
    <header class="app-header">
      <h1>🎵 MuzsikApp</h1>
      <div class="header-actions">
        <div class="room-selector">
          <button
            v-for="room in rooms"
            :key="room.id"
            :class="['room-btn', { active: room.id === currentRoomId }]"
            @click="switchRoom(room.id)"
            :title="`${room.clientCount} client(s)`"
          >
            Room {{ room.number }}
            <span class="client-count" v-if="room.clientCount > 0">{{ room.clientCount }}</span>
          </button>
        </div>
        <div class="stats">
          <span class="stat">{{ stats.tracks }} tracks</span>
          <span class="stat">{{ stats.clients }} clients</span>
        </div>
        <LoginButton />
      </div>
    </header>

    <main class="app-main">
      <!-- Top Row: Player and Playlist -->
      <section class="top-row">
        <!-- Left: Audio Player -->
        <div class="player-column">
          <AudioPlayer 
            :current-track-id="currentTrackId"
            :has-next="hasNext"
            :has-previous="hasPrevious"
            @next-track="playNextTrack"
            @previous-track="playPreviousTrack"
          />
        </div>

        <!-- Right: Current Playlist -->
        <div class="playlist-column">
          <PlaylistPanel
            ref="playlistRef"
            :current-track="currentTrack"
            @track-play="onPlayTrack"
          />
        </div>
      </section>

      <!-- Bottom Row: Library and Folders OR Manage Library -->
      <section class="bottom-row" v-if="!showManageLibrary">
        <!-- Left: Music Library -->
        <div class="library-column">
          <MusicLibraryPanel
            ref="libraryRef"
            :current-track="currentTrack"
            :is-authenticated="isAuthenticated"
            @track-play="onAddTrackAndPlay"
            @open-manage-library="openManageLibrary"
          />
        </div>

        <!-- Right: Folder Management -->
        <div class="folders-column">
          <FolderManagerPanel
            ref="folderManagerRef"
            :current-track="currentTrack"
            :is-authenticated="isAuthenticated"
            @track-play="onAddTrackAndPlay"
          />
        </div>
      </section>

      <!-- Manage Library Panel (replaces Library and Folders) -->
      <section class="manage-library-row" v-if="showManageLibrary">
        <ManageLibraryPanel
          ref="manageLibraryRef"
          :current-track="currentTrack"
          :is-authenticated="isAuthenticated"
          @close="closeManageLibrary"
          @refresh="handleRefresh"
          @track-play="onAddTrackAndPlay"
        />
      </section>
    </main>
  </div>
</template>

<script>
import { ref, computed, onMounted, onUnmounted } from 'vue';
import AudioPlayer from './components/AudioPlayer.vue';
import MusicLibraryPanel from './components/MusicLibraryPanel.vue';
import FolderManagerPanel from './components/FolderManagerPanel.vue';
import PlaylistPanel from './components/PlaylistPanel.vue';
import ManageLibraryPanel from './components/ManageLibraryPanel.vue';
import LoginButton from './components/LoginButton.vue';
import api from './services/api';
import websocket from './services/websocket';
import { useAuth } from './composables/useAuth.js';

export default {
  name: 'App',
  components: {
    AudioPlayer,
    MusicLibraryPanel,
    FolderManagerPanel,
    PlaylistPanel,
    ManageLibraryPanel,
    LoginButton,
  },
  setup() {
    // Initialize auth
    const { initialize: initializeAuth, isAuthenticated, logout } = useAuth();
    
    const currentTrackId = ref(null);
    const currentTrack = ref(null);
    // Load saved room from localStorage or default to 'room-1'
    const savedRoomId = localStorage.getItem('rpg-music-room-id') || 'room-1';
    const currentRoomId = ref(savedRoomId);
    const rooms = ref([]);
    const libraryRef = ref(null);
    const folderManagerRef = ref(null);
    const playlistRef = ref(null);
    const manageLibraryRef = ref(null);
    const showManageLibrary = ref(false);
    const stats = ref({
      tracks: 0,
      clients: 0,
    });

    let statsInterval = null;

    const loadStats = async () => {
      try {
        const response = await api.getStats();
        stats.value = {
          tracks: response.tracks.total,
          clients: response.clients.connected,
        };
      } catch (error) {
        console.error('Failed to load stats:', error);
      }
    };

    const onPlayTrack = async (track, playlistIndex = null) => {
      try {
        // If index not provided, calculate it
        if (playlistIndex === null && playlistRef.value && playlistRef.value.tracks) {
          playlistIndex = playlistRef.value.tracks.findIndex(t => t.id === track.id);
          playlistIndex = playlistIndex >= 0 ? playlistIndex : null;
        }
        
        await api.playTrack(track.id, 0, currentRoomId.value, playlistIndex);
        currentTrackId.value = track.id;
        currentTrack.value = track;
      } catch (error) {
        console.error('Failed to play track:', error);
        alert('Failed to play track. Check console for details.');
      }
    };

    const onAddTrackAndPlay = async (track) => {
      // Add track to current room's playlist and play it
      try {
        console.log('🎵 onAddTrackAndPlay called with track:', track);
        // Get room playlist collection ID
        const room = rooms.value.find(r => r.id === currentRoomId.value);
        const collectionId = room ? room.playlistCollectionId : `current-playlist-${currentRoomId.value}`;
        
        console.log('📤 Sending track to addTrackToCollection:', { collectionId, trackId: track.id });
        await api.addTrackToCollection(collectionId, track.id);
        // Refresh playlist to show new track
        if (playlistRef.value) {
          await playlistRef.value.refresh();
          // Track is added at the end of the playlist, so use its final index
          const trackIndex = playlistRef.value.tracks.length - 1;
          await onPlayTrack(track, trackIndex);
        } else {
          await onPlayTrack(track);
        }
      } catch (error) {
        console.error('Failed to add and play track:', error);
      }
    };

    const playNextTrack = async () => {
      try {
        await api.next(currentRoomId.value);
        console.log('Next track request sent to server');
      } catch (error) {
        console.error('Failed to play next track:', error);
      }
    };

    const playPreviousTrack = async () => {
      try {
        await api.previous(currentRoomId.value);
        console.log('Previous track request sent to server');
      } catch (error) {
        console.error('Failed to play previous track:', error);
      }
    };

    const handleStateSync = (data) => {
      // Only update if it's for current room or no room specified (backward compatibility)
      if (!data.roomId || data.roomId === currentRoomId.value) {
        if (data.currentTrack) {
          currentTrackId.value = data.currentTrack.id;
          currentTrack.value = data.currentTrack;
        } else {
          currentTrackId.value = null;
          currentTrack.value = null;
        }
      }
    };

    const handlePlayTrack = (data) => {
      // Only update if it's for current room or no room specified
      if (!data.roomId || data.roomId === currentRoomId.value) {
        currentTrackId.value = data.trackId;
        // Fetch full track info if needed
        if (data.trackId) {
          api.getTrack(data.trackId)
            .then(track => {
              currentTrack.value = track;
            })
            .catch(err => console.error('Failed to fetch track info:', err));
        }
      }
    };

    const handleStop = (data) => {
      // Only update if it's for current room or no room specified
      if (!data.roomId || data.roomId === currentRoomId.value) {
        currentTrackId.value = null;
        currentTrack.value = null;
      }
    };

    const handleRoomJoined = (data) => {
      console.log('Room joined:', data);
      currentRoomId.value = data.roomId;
      // Save room to localStorage
      localStorage.setItem('rpg-music-room-id', data.roomId);
      console.log('Room saved to localStorage:', data.roomId);
    };

    const handleRoomsInfo = (data) => {
      console.log('Rooms info updated:', data);
      rooms.value = data;
    };

    const handleConnected = () => {
      console.log('WebSocket connected, joining saved room:', currentRoomId.value);
      // Join the saved room when connection is established
      websocket.joinRoom(currentRoomId.value);
    };

    const switchRoom = (roomId) => {
      if (roomId === currentRoomId.value) return;
      
      console.log('Switching to room:', roomId);
      websocket.joinRoom(roomId);
      // State will be updated via room_joined and state_sync events
    };

    // Computed properties for next/previous track availability
    const hasNext = computed(() => {
      if (!playlistRef.value || !playlistRef.value.tracks) return false;
      if (!currentTrackId.value) return playlistRef.value.tracks.length > 0;
      const currentIndex = playlistRef.value.tracks.findIndex(t => t.id === currentTrackId.value);
      return currentIndex >= 0 && currentIndex < playlistRef.value.tracks.length - 1;
    });
    
    const hasPrevious = computed(() => {
      if (!playlistRef.value || !playlistRef.value.tracks) return false;
      if (!currentTrackId.value) return false;
      const currentIndex = playlistRef.value.tracks.findIndex(t => t.id === currentTrackId.value);
      return currentIndex > 0;
    });

    /**
     * Toggle manage library view
     */
    const toggleManageLibrary = () => {
      showManageLibrary.value = !showManageLibrary.value;
    };

    /**
     * Close manage library view
     */
    const closeManageLibrary = () => {
      showManageLibrary.value = false;
    };

    /**
     * Open manage library view
     */
    const openManageLibrary = () => {
      showManageLibrary.value = true;
    };

    /**
     * Handle refresh after manage library changes
     */
    const handleRefresh = async () => {
      // Refresh library and folders
      if (libraryRef.value) {
        await libraryRef.value.refresh();
      }
      if (folderManagerRef.value) {
        await folderManagerRef.value.refresh();
      }
      // Reload stats
      await loadStats();
    };

    onMounted(async () => {
      // Initialize authentication
      await initializeAuth();
      
      // Setup API auth error handler
      api.onAuthError((status, error) => {
        console.warn('Authentication error:', status, error);
        if (status === 401) {
          // Token expired or invalid - logout
          logout();
          alert('Your session has expired. Please log in again.');
        } else if (status === 403) {
          alert('You do not have permission to perform this action. Please log in.');
        }
      });
      
      // Load initial stats
      loadStats();
      
      // Update stats periodically
      statsInterval = setInterval(loadStats, 10000); // Every 10 seconds
      
      // Listen to WebSocket events for current track updates
      websocket.on('connected', handleConnected);
      websocket.on('state_sync', handleStateSync);
      websocket.on('play_track', handlePlayTrack);
      websocket.on('stop', handleStop);
      websocket.on('room_joined', handleRoomJoined);
      websocket.on('rooms_info', handleRoomsInfo);
      
      // If websocket is already connected, join room immediately
      if (websocket.isConnected()) {
        websocket.joinRoom(currentRoomId.value);
      }
      // Otherwise, it will join when 'connected' event fires
    });

    onUnmounted(() => {
      if (statsInterval) {
        clearInterval(statsInterval);
      }
      
      websocket.off('connected', handleConnected);
      websocket.off('state_sync', handleStateSync);
      websocket.off('play_track', handlePlayTrack);
      websocket.off('stop', handleStop);
      websocket.off('room_joined', handleRoomJoined);
      websocket.off('rooms_info', handleRoomsInfo);
    });

    return {
      currentTrackId,
      currentTrack,
      currentRoomId,
      rooms,
      libraryRef,
      folderManagerRef,
      playlistRef,
      manageLibraryRef,
      showManageLibrary,
      stats,
      isAuthenticated,
      hasNext,
      hasPrevious,
      onPlayTrack,
      onAddTrackAndPlay,
      playNextTrack,
      playPreviousTrack,
      toggleManageLibrary,
      closeManageLibrary,
      openManageLibrary,
      handleRefresh,
      switchRoom,
    };
  },
};
</script>

<style>
/* =====================================================
   CSS VARIABLES - THEME & LAYOUT CONFIGURATION
   ===================================================== */
:root {
  /* === Colors === */
  --color-primary: #4CAF50;
  --color-primary-hover: #45a049;
  --color-bg-dark: #1a1a1a;
  --color-bg-panel: #2a2a2a;
  --color-bg-input: #333;
  --color-text-primary: #e0e0e0;
  --color-text-secondary: #999;
  --color-text-muted: #666;
  --color-border: #444;
  --color-border-light: #555;

  /* === Typography === */
  --font-family-base: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto',
    'Oxygen', 'Ubuntu', 'Cantarell', 'Fira Sans', 'Droid Sans', 'Helvetica Neue',
    sans-serif;
  --font-size-base: 1em;
  --font-size-sm: 0.85em;
  --font-size-lg: 1.3em;
  --font-weight-normal: 500;
  --font-weight-bold: 600;

  /* === Spacing === */
  --spacing-xs: 4px;
  --spacing-sm: 6px;
  --spacing-md: 10px;
  --spacing-lg: 12px;
  --spacing-xl: 15px;
  --spacing-2xl: 20px;

  /* === Layout - Desktop === */
  --layout-header-height: 50px;
  --layout-gap: 10px;
  --layout-row-height-top: 40%;
  --layout-row-height-bottom: 60%;

  /* === Breakpoints === */
  --breakpoint-tablet: 1024px;
  --breakpoint-mobile: 768px;

  /* === Border Radius === */
  --radius-sm: 4px;
  --radius-md: 6px;
  --radius-lg: 10px;

  /* === Transitions === */
  --transition-quick: all 0.2s;
}

/* =====================================================
   RESET & BASE STYLES
   ===================================================== */
* {
  box-sizing: border-box;
}

html,
body {
  margin: 0;
  padding: 0;
  height: 100%;
}

body {
  font-family: var(--font-family-base);
  font-size: var(--font-size-base);
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
  background: var(--color-bg-dark);
  color: var(--color-text-primary);
}

/* =====================================================
   SCROLLBAR STYLING
   ===================================================== */
::-webkit-scrollbar {
  width: 10px;
  height: 10px;
}

::-webkit-scrollbar-track {
  background: var(--color-bg-dark);
}

::-webkit-scrollbar-thumb {
  background: var(--color-primary);
  border-radius: 5px;
}

::-webkit-scrollbar-thumb:hover {
  background: var(--color-primary-hover);
}

::-webkit-scrollbar-corner {
  background: var(--color-bg-dark);
}

* {
  scrollbar-width: thin;
  scrollbar-color: var(--color-primary) var(--color-bg-dark);
}

/* =====================================================
   MAIN LAYOUT
   ===================================================== */
#app-content {
  height: 100vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

/* =====================================================
   HEADER
   ===================================================== */
.app-header {
  background: var(--color-bg-panel);
  padding: var(--spacing-sm) var(--spacing-xl);
  border-bottom: 2px solid var(--color-primary);
  display: flex;
  justify-content: space-between;
  align-items: center;
  flex-shrink: 0;
  height: var(--layout-header-height);
  gap: var(--spacing-xl);
}

.app-header h1 {
  margin: 0;
  font-size: var(--font-size-lg);
  color: var(--color-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  flex-shrink: 1;
  min-width: 0;
}

.header-actions {
  display: flex;
  align-items: center;
  gap: var(--spacing-xl);
  flex-shrink: 0;
  min-width: 0;
}

/* =====================================================
   ROOM SELECTOR
   ===================================================== */
.room-selector {
  display: flex;
  gap: var(--spacing-xs);
  align-items: center;
  flex-wrap: wrap;
  min-width: 0;
}

.room-btn {
  padding: var(--spacing-sm) var(--spacing-md);
  background: var(--color-bg-input);
  border: 2px solid var(--color-border-light);
  border-radius: var(--radius-md);
  color: #ccc;
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-normal);
  cursor: pointer;
  transition: var(--transition-quick);
  white-space: nowrap;
  display: flex;
  align-items: center;
  gap: var(--spacing-xs);
  flex-shrink: 0;
}

.room-btn:hover {
  background: #444;
  border-color: var(--color-primary);
  color: #fff;
}

.room-btn.active {
  background: var(--color-primary);
  border-color: var(--color-primary);
  color: white;
  font-weight: var(--font-weight-bold);
}

.room-btn .client-count {
  background: rgba(0, 0, 0, 0.3);
  padding: var(--spacing-xs) var(--spacing-sm);
  border-radius: var(--radius-lg);
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-bold);
}

.room-btn.active .client-count {
  background: rgba(255, 255, 255, 0.2);
}

/* =====================================================
   STATS
   ===================================================== */
.stats {
  display: flex;
  gap: var(--spacing-lg);
  white-space: nowrap;
  flex-shrink: 0;
}

.stat {
  padding: var(--spacing-sm) var(--spacing-md);
  background: var(--color-bg-dark);
  border-radius: var(--radius-sm);
  font-size: var(--font-size-sm);
  color: var(--color-text-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* =====================================================
   MAIN CONTENT AREA
   ===================================================== */
.app-main {
  flex: 1;
  display: flex;
  flex-direction: column;
  width: 100%;
  padding: var(--layout-gap);
  gap: var(--layout-gap);
  overflow: hidden;
  min-height: 0;
}

/* =====================================================
   TOP ROW: Player (40%) + Playlist (60%) = 50% height
   ===================================================== */
.top-row {
  display: grid;
  grid-template-columns: 1fr 1.5fr;
  gap: var(--layout-gap);
  flex: 0 0 var(--layout-row-height-top);
  min-height: 0;
}

.player-column,
.playlist-column {
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
}

/* =====================================================
   BOTTOM ROW: Library (50%) + Folders (50%) = 50% height
   ===================================================== */
.bottom-row {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--layout-gap);
  flex: 0 0 var(--layout-row-height-bottom);
  min-height: 0;
}

.library-column,
.folders-column {
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
}

/* =====================================================
   MANAGE LIBRARY ROW
   ===================================================== */
.manage-library-row {
  flex: 0 0 var(--layout-row-height-bottom);
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
}

/* =====================================================
   FOOTER
   ===================================================== */
.app-footer {
  background: var(--color-bg-panel);
  padding: var(--spacing-2xl);
  text-align: center;
  border-top: 1px solid var(--color-border);
  font-size: var(--font-size-sm);
  color: var(--color-text-muted);
  flex-shrink: 0;
}

.app-footer p {
  margin: 0;
}

/* =====================================================
   RESPONSIVE: TABLET (1024px and below)
   ===================================================== */
@media (max-width: 1024px) {
  :root {
    --layout-gap: 8px;
  }

  .app-header h1 {
    font-size: 1.2em;
  }

  .top-row {
    grid-template-columns: 1fr;
    flex: 0 0 auto;
    max-height: 45%;
  }

  .playlist-column {
    min-height: 200px;
  }

  .bottom-row,
  .manage-library-row {
    grid-template-columns: 1fr;
    flex: 1;
    min-height: 200px;
  }
}

/* =====================================================
   RESPONSIVE: MOBILE (768px and below)
   ===================================================== */
@media (max-width: 768px) {
  :root {
    --layout-header-height: 60px;
    --layout-gap: 8px;
    --spacing-xl: 10px;
  }

  .top-row {
    max-height: none;
  }

  * {
    max-width: 100vw;
    overflow-x: visible;
  }

  /* Exclude audio controls and dialogs from width constraints */
  .progress-bar,
  .volume-slider,
  .dialog-overlay {
    max-width: none;
    overflow-x: visible;
  }

  #app-content {
    height: 100vh;
    width: 100vw;
    overflow-y: auto;
    overflow-x: hidden;
    flex-direction: column;
  }

  .app-header {
    padding: var(--spacing-md) var(--spacing-lg);
    gap: var(--spacing-md);
    flex-shrink: 0;
    width: 100%;
    justify-content: center;
    overflow: hidden;
  }

  .app-header h1 {
    display: none;
  }

  .header-actions {
    width: 100%;
    flex-direction: row;
    gap: var(--spacing-md);
    justify-content: center;
  }

  .room-selector {
    width: auto;
    justify-content: center;
    flex-wrap: wrap;
    order: 1;
  }

  .stats {
    display: none;
  }

  .app-main {
    flex-direction: column;
    padding: var(--spacing-md);
    overflow: visible;
    height: auto;
    gap: var(--spacing-lg);
    width: 100%;
  }

  .top-row {
    display: flex;
    flex-direction: column;
    flex: 0 0 auto;
    gap: var(--spacing-lg);
    width: 100%;
  }

  .player-column {
    flex: 0 0 auto;
    overflow: hidden;
    width: 100%;
  }

  .playlist-column {
    flex: 0 0 auto;
    min-height: 250px;
    max-height: 360px;
    overflow-y: auto;
    width: 100%;
  }

  .bottom-row {
    display: flex;
    flex-direction: column;
    flex: 0 0 auto;
    gap: var(--spacing-lg);
    width: 100%;
  }

  .library-column {
    flex: 0 0 auto;
    min-height: 250px;
    max-height: 360px;
    overflow-y: auto;
    width: 100%;
  }

  .folders-column {
    flex: 0 0 auto;
    min-height: 250px;
    max-height: 250px;
    overflow-y: auto;
    width: 100%;
  }

  .manage-library-row {
    flex: 0 0 auto;
    display: flex;
    flex-direction: column;
    gap: var(--spacing-lg);
    min-height: auto;
    width: 100%;
    overflow: visible;
  }

  .app-footer {
    flex-shrink: 0;
    width: 100%;
  }
}
</style>
