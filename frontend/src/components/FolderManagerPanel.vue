<template>
  <div class="folder-manager-panel">
    <div class="folder-header">
      <h3>Folders</h3>
      <button @click="handleNewFolderClick" class="create-btn">
        + New Folder
      </button>
    </div>

    <div class="folder-tree">
      <FolderNodeSimple
        v-for="folder in rootFolders"
        :key="folder.id"
        :folder="folder"
        :all-folders="folders"
        :expanded-folder-ids="expandedFolderIds"
        :active-folder-id="expandedFolderId"
        :folder-tracks="folderTracks"
        :current-track="currentTrack"
        :loading-tracks="loadingTracks"
        :is-authenticated="isAuthenticated"
        @toggle="toggleFolder"
        @edit="startEditFolder"
        @delete="confirmDeleteFolder"
        @play-folder="playFolder"
        @add-to-playlist="addFolderToPlaylist"
        @track-dblclick="handleTrackDoubleClick"
        @track-drop="handleDropTrack"
        @track-reorder="handleReorderTrack"
        @track-remove="handleRemoveTrack"
      />

      <div v-if="folders.length === 0" class="empty-folders">
        <p>No folders yet</p>
        <p class="empty-hint">Create a folder to organize your music</p>
      </div>
    </div>

    <!-- Create/Edit Folder Dialog -->
    <div v-if="showCreateDialog || showEditDialog" class="dialog-overlay" @click.self="closeDialogs">
      <div class="dialog">
        <h3>{{ showEditDialog ? 'Edit Folder' : 'Create New Folder' }}</h3>
        
        <div class="form-group">
          <label>Folder Name</label>
          <input
            v-model="newFolderName"
            type="text"
            placeholder="Folder name"
            @keyup.enter="showEditDialog ? saveEditFolder() : createFolder()"
            ref="folderNameInput"
          />
        </div>

        <div class="form-group">
          <label>Parent Folder (optional)</label>
          <div class="parent-folder-selector">
            <div 
              class="folder-option root-option"
              :class="{ selected: parentFolderId === null }"
              @click="selectParentFolder(null)"
            >
              <span class="folder-icon">📁</span>
              <span class="folder-name">Root Level</span>
            </div>
            
            <div class="folder-tree-list">
              <div
                v-for="folder in flatFoldersForSelection"
                :key="folder.id"
                class="folder-option"
                :class="{ 
                  selected: parentFolderId === folder.id,
                  disabled: folder.disabled
                }"
                :style="{ paddingLeft: `${folder.depth * 20 + 12}px` }"
                @click="!folder.disabled && selectParentFolder(folder.id)"
              >
                <span class="folder-prefix">{{ folder.prefix }}</span>
                <span class="folder-icon">📁</span>
                <span class="folder-name">{{ folder.name }}</span>
              </div>
            </div>
          </div>
        </div>
        
        <div class="dialog-actions">
          <button @click="closeDialogs" class="cancel-btn">Cancel</button>
          <button 
            @click="showEditDialog ? saveEditFolder() : createFolder()" 
            :disabled="!newFolderName.trim()" 
            class="create-btn"
          >
            {{ showEditDialog ? 'Save' : 'Create' }}
          </button>
        </div>
      </div>
    </div>

    <!-- Delete Confirmation Dialog -->
    <div v-if="showDeleteDialog" class="dialog-overlay" @click.self="showDeleteDialog = false">
      <div class="dialog">
        <h3>Delete Folder?</h3>
        <p>Are you sure you want to delete "{{ folderToDelete?.name }}"?</p>
        
        <div class="dialog-actions">
          <button @click="showDeleteDialog = false" class="cancel-btn">Cancel</button>
          <button @click="deleteFolder" class="delete-btn">Delete</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, watch, nextTick, onMounted, onUnmounted } from 'vue';
import FolderNodeSimple from './FolderNodeSimple.vue';
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

const emit = defineEmits(['track-play']);

// Import toast
import { useToast } from '../composables/useToast.js';
const toast = useToast();

// Track current room
const currentRoomId = ref('room-1');
const playlistCollectionId = computed(() => `current-playlist-${currentRoomId.value}`);

// Folder management
const folders = ref([]);
const expandedFolderIds = ref(new Set());
const expandedFolderId = ref(null); // Keep for track loading (which folder's tracks are currently shown)
const loadingFolders = ref(false);
const showCreateDialog = ref(false);
const showEditDialog = ref(false);
const showDeleteDialog = ref(false);
const newFolderName = ref('');
const editingFolder = ref(null);
const folderToDelete = ref(null);
const parentFolderId = ref(null);
const folderNameInput = ref(null);

// Track collection for expanded folder
const {
  tracks: folderTracks,
  loading: loadingTracks,
  error: tracksError,
  removeTrack,
  handleTrackDrop: handleTrackDropComposable,
  handleTrackReorder: handleTrackReorderComposable,
  refresh: refreshFolderTracks
} = useTrackCollection(
  computed(() => expandedFolderId.value || null),
  { autoLoad: false }
);

/**
 * Load all folders
 */
const loadFolders = async () => {
  loadingFolders.value = true;
  try {
    const result = await api.getCollections('folder');
    folders.value = result;
  } catch (err) {
    console.error('Failed to load folders:', err);
  } finally {
    loadingFolders.value = false;
  }
};

/**
 * Handle New Folder button click
 */
const handleNewFolderClick = () => {
  if (!props.isAuthenticated) {
    toast.warning('Please log in to create folders');
    return;
  }
  showCreateDialog.value = true;
};

/**
 * Get root folders (folders without parents)
 */
const rootFolders = computed(() => {
  return folders.value.filter(f => !f.parent_id);
});

/**
 * Get all descendant folder IDs for a given folder (recursive)
 */
const getDescendantIds = (folderId) => {
  const descendants = [];
  const children = folders.value.filter(f => f.parent_id === folderId);
  
  for (const child of children) {
    descendants.push(child.id);
    descendants.push(...getDescendantIds(child.id));
  }
  
  return descendants;
};

/**
 * Get folder IDs that should be disabled when editing
 * (the folder itself and all its descendants to prevent circular references)
 */
const disabledFolderIdsForEdit = computed(() => {
  if (!showEditDialog.value || !editingFolder.value) {
    return [];
  }
  
  return [
    editingFolder.value.id,
    ...getDescendantIds(editingFolder.value.id)
  ];
});

/**
 * Flatten folder hierarchy for parent selection display
 */
const flatFoldersForSelection = computed(() => {
  const flattened = [];
  const disabledIds = disabledFolderIdsForEdit.value;
  
  const flattenFolder = (folder, depth = 0, parentPrefix = '') => {
    const prefix = depth > 0 ? parentPrefix + '└─ ' : '';
    
    flattened.push({
      id: folder.id,
      name: folder.name,
      depth,
      prefix,
      disabled: disabledIds.includes(folder.id)
    });
    
    // Find and sort children
    const children = folders.value
      .filter(f => f.parent_id === folder.id)
      .sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
    
    // Recursively add children
    children.forEach((child, index) => {
      const isLast = index === children.length - 1;
      const childPrefix = depth > 0 ? parentPrefix + (isLast ? '   ' : '│  ') : '';
      flattenFolder(child, depth + 1, childPrefix);
    });
  };
  
  // Get root folders (no parent)
  const rootFolders = folders.value
    .filter(f => !f.parent_id)
    .sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
  
  rootFolders.forEach(folder => flattenFolder(folder));
  
  return flattened;
});

/**
 * Select a parent folder
 */
const selectParentFolder = (folderId) => {
  parentFolderId.value = folderId;
};

/**
 * Get track count for a folder
 */
const getTrackCount = (folderId) => {
  if (expandedFolderId.value === folderId) {
    return folderTracks.value.length;
  }
  const folder = folders.value.find(f => f.id === folderId);
  return folder?.track_count || 0;
};

/**
 * Toggle folder expansion (show/hide tracks)
 */
const toggleFolder = async (folder) => {
  // Toggle expansion state
  if (expandedFolderIds.value.has(folder.id)) {
    expandedFolderIds.value.delete(folder.id);
    // If this was the folder showing tracks, clear it
    if (expandedFolderId.value === folder.id) {
      expandedFolderId.value = null;
    }
  } else {
    expandedFolderIds.value.add(folder.id);
    // Set this as the active folder for track display
    expandedFolderId.value = folder.id;
    await nextTick();
    await refreshFolderTracks();
  }
  
  // Trigger reactivity by creating a new Set
  expandedFolderIds.value = new Set(expandedFolderIds.value);
};

/**
 * Start editing a folder
 */
const startEditFolder = (folder) => {
  if (!props.isAuthenticated) {
    toast.warning('Please log in to edit folders');
    return;
  }
  editingFolder.value = folder;
  newFolderName.value = folder.name;
  parentFolderId.value = folder.parent_id;
  showEditDialog.value = true;
};

/**
 * Save folder edits
 */
const saveEditFolder = async () => {
  if (!editingFolder.value) return;
  const name = newFolderName.value.trim();
  if (!name) return;

  try {
    await api.updateCollection(editingFolder.value.id, {
      name,
      parent_id: parentFolderId.value
    });
    showEditDialog.value = false;
    editingFolder.value = null;
    newFolderName.value = '';
    parentFolderId.value = null;
    await loadFolders();
  } catch (err) {
    console.error('Failed to update folder:', err);
    toast.error('Failed to update folder');
  }
};

/**
 * Create a new folder
 */
const createFolder = async () => {
  const name = newFolderName.value.trim();
  if (!name) return;

  try {
    await api.createCollection(name, 'folder', parentFolderId.value);
    newFolderName.value = '';
    parentFolderId.value = null;
    showCreateDialog.value = false;
    await loadFolders();
  } catch (err) {
    console.error('Failed to create folder:', err);
    toast.error('Failed to create folder');
  }
};

/**
 * Close all dialogs
 */
const closeDialogs = () => {
  showCreateDialog.value = false;
  showEditDialog.value = false;
  newFolderName.value = '';
  editingFolder.value = null;
  parentFolderId.value = null;
};

/**
 * Confirm folder deletion
 */
const confirmDeleteFolder = (folder) => {
  if (!props.isAuthenticated) {
    toast.warning('Please log in to delete folders');
    return;
  }
  folderToDelete.value = folder;
  showDeleteDialog.value = true;
};

/**
 * Delete a folder
 */
const deleteFolder = async () => {
  if (!folderToDelete.value) return;

  try {
    await api.deleteCollection(folderToDelete.value.id);
    if (expandedFolderId.value === folderToDelete.value.id) {
      expandedFolderId.value = null;
    }
    showDeleteDialog.value = false;
    folderToDelete.value = null;
    await loadFolders();
  } catch (err) {
    console.error('Failed to delete folder:', err);
    toast.error('Failed to delete folder');
  }
};

/**
 * Play all tracks in a folder
 */
const playFolder = async (folder) => {
  try {
    // Clear current room's playlist and add all folder tracks
    const roomPlaylistId = playlistCollectionId.value;
    await api.clearCollectionTracks(roomPlaylistId);
    const folderData = await api.getCollection(folder.id);
    for (const track of folderData.tracks) {
      await api.addTrackToCollection(roomPlaylistId, track.id);
    }
  } catch (err) {
    console.error('Failed to play folder:', err);
  }
};

/**
 * Add folder tracks to playlist
 */
const addFolderToPlaylist = async (folder) => {
  try {
    const roomPlaylistId = playlistCollectionId.value;
    const folderData = await api.getCollection(folder.id);
    for (const track of folderData.tracks) {
      await api.addTrackToCollection(roomPlaylistId, track.id);
    }
  } catch (err) {
    console.error('Failed to add folder to playlist:', err);
  }
};

/**
 * Handle remove track event from FolderNode
 */
const handleRemoveTrackFromFolder = async (data) => {
  // data contains { folderId, track, index, position }
  if (!data.folderId) return;
  
  try {
    await api.removeTrackFromCollection(data.folderId, data.track.id, data.position);
    // Refresh if it's the expanded folder
    if (expandedFolderId.value === data.folderId) {
      await refreshFolderTracks();
    }
    // Reload folders to update counts
    await loadFolders();
  } catch (err) {
    console.error('Failed to remove track from folder:', err);
  }
};

/**
 * Handle double-click to play track
 */
const handleTrackDoubleClick = ({ track, index }) => {
  emit('track-play', track);
};

/**
 * Handle removing a track from folder
 */
const handleRemoveTrack = async (data) => {
  if (!data.folderId) return;
  
  try {
    // data contains { folderId, track, index, position }
    await removeTrack(data.track.id, data.position);
  } catch (err) {
    console.error('Failed to remove track from folder:', err);
  }
};

/**
 * Handle reordering tracks in folder
 */
const handleReorderTrack = async ({ folderId, track, oldIndex, newIndex }) => {
  // Only allow reorder in the currently expanded folder
  if (!folderId || folderId !== expandedFolderId.value) return;
  
  try {
    // Use the composable's reorder function
    await handleTrackReorderComposable(track, oldIndex, newIndex);
  } catch (err) {
    console.error('Failed to reorder track in folder:', err);
  }
};

/**
 * Handle dropping a track from library or another list
 */
const handleDropTrack = async ({ folderId, trackId, track, position }) => {
  if (!folderId) {
    console.error('No folderId provided to handleDropTrack');
    return;
  }
  
  try {
    console.log('Dropping track:', { folderId, trackId, position, expandedFolderId: expandedFolderId.value });
    
    // If dropping on the currently expanded folder, use the composable
    if (folderId === expandedFolderId.value) {
      console.log('Using composable for expanded folder');
      await handleTrackDropComposable(track, position);
    } else {
      // Otherwise, add directly via API
      console.log('Using API for non-expanded folder');
      await api.addTrackToCollection(folderId, trackId, position);
      // Reload folder list to update track counts
      await loadFolders();
    }
  } catch (err) {
    console.error('Failed to add track to folder:', err);
  }
};

// Watch for dialog open to focus input
watch(showCreateDialog, (isOpen) => {
  if (isOpen) {
    nextTick(() => {
      folderNameInput.value?.focus();
    });
  }
});

/**
 * Handle track updated from WebSocket
 */
const handleTrackUpdated = (data) => {
  console.log('Track updated, refreshing folders:', data);
  // Refresh expanded folder tracks if any
  if (expandedFolderId.value) {
    refreshFolderTracks();
  }
  // Reload folder list to update track counts
  loadFolders();
};

/**
 * Handle track deleted from WebSocket
 */
const handleTrackDeleted = (data) => {
  console.log('Track deleted, refreshing folders:', data);
  // Refresh expanded folder tracks if any
  if (expandedFolderId.value) {
    refreshFolderTracks();
  }
  // Reload folder list to update track counts
  loadFolders();
};

/**
 * Handle room joined event
 */
const handleRoomJoined = (data) => {
  console.log('FolderManagerPanel: Room joined', data);
  currentRoomId.value = data.roomId;
};

// Load folders on mount
loadFolders();

// Set up WebSocket listeners
onMounted(() => {
  websocket.on('track_updated', handleTrackUpdated);
  websocket.on('track_deleted', handleTrackDeleted);
  websocket.on('room_joined', handleRoomJoined);
  
  // Get initial room ID
  const initialRoomId = websocket.getCurrentRoomId();
  if (initialRoomId) {
    currentRoomId.value = initialRoomId;
  }
});

onUnmounted(() => {
  websocket.off('track_updated', handleTrackUpdated);
  websocket.off('track_deleted', handleTrackDeleted);
  websocket.off('room_joined', handleRoomJoined);
});

// Expose refresh method
defineExpose({
  refresh: loadFolders
});
</script>

<style scoped>
.folder-manager-panel {
  background: #2a2a2a;
  border-radius: 8px;
  padding: 12px;
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
}

.folder-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 10px;
  flex-shrink: 0;
}

.folder-header h3 {
  margin: 0;
  font-size: 1em;
  color: #e0e0e0;
}

.create-btn {
  padding: 5px 10px;
  background: #4CAF50;
  border: none;
  border-radius: 4px;
  color: white;
  cursor: pointer;
  font-size: 0.85em;
  transition: background 0.2s;
}

.create-btn:hover {
  background: #45a049;
}

.folder-tree {
  flex: 1;
  overflow-y: auto;
  overflow-x: hidden;
}

.empty-folders {
  text-align: center;
  padding: 20px;
  color: #999;
}

.empty-hint {
  font-size: 0.9em;
  margin-top: 8px;
  color: #666;
}

/* Dialog styles */
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
  min-width: 400px;
  max-width: 90vw;
  max-height: 90vh;
  overflow-y: auto;
}

.dialog h3 {
  margin: 0 0 20px 0;
  font-size: 1.2em;
  color: #e0e0e0;
}

.dialog p {
  margin: 10px 0;
  color: #e0e0e0;
}

.dialog .warning {
  color: #ff9800;
  font-size: 0.9em;
}

.form-group {
  margin-bottom: 15px;
}

.form-group label {
  display: block;
  margin-bottom: 5px;
  color: #999;
  font-size: 0.9em;
}

.form-group input {
  width: 100%;
  padding: 10px;
  background: #1a1a1a;
  border: 1px solid #444;
  border-radius: 6px;
  color: #e0e0e0;
  font-size: 1em;
}

.form-group input:focus {
  outline: none;
  border-color: #4CAF50;
}

.parent-folder-selector {
  background: #1a1a1a;
  border: 1px solid #444;
  border-radius: 6px;
  max-height: 300px;
  overflow-y: auto;
}

.folder-tree-list {
  display: flex;
  flex-direction: column;
}

.folder-option {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  cursor: pointer;
  transition: background 0.2s;
  user-select: none;
}

.folder-option:hover:not(.disabled) {
  background: #2a2a2a;
}

.folder-option.selected {
  background: #2a4a2a;
  border-left: 3px solid #4CAF50;
}

.folder-option.disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.folder-option.root-option {
  border-bottom: 1px solid #444;
  font-weight: 500;
}

.folder-prefix {
  color: #666;
  font-family: monospace;
  flex-shrink: 0;
}

.folder-icon {
  flex-shrink: 0;
  font-size: 0.9em;
}

.folder-name {
  color: #e0e0e0;
  font-size: 0.95em;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.dialog input {
  width: 100%;
  padding: 10px;
  background: #1a1a1a;
  border: 1px solid #444;
  border-radius: 4px;
  color: white;
  font-size: 0.95em;
  margin-bottom: 16px;
}

.dialog input:focus {
  outline: none;
  border-color: #42b983;
}

.dialog-actions {
  display: flex;
  gap: 10px;
  justify-content: flex-end;
  margin-top: 20px;
}

.dialog-actions button {
  padding: 10px 20px;
  border: none;
  border-radius: 6px;
  cursor: pointer;
  font-size: 0.9em;
  transition: background 0.2s;
}

.cancel-btn {
  background: #444;
  color: white;
  transition: background 0.2s;
}

.cancel-btn:hover {
  background: #555;
}

.dialog-actions .create-btn {
  background: #4CAF50;
  color: white;
  transition: background 0.2s;
}

.dialog-actions .create-btn:hover:not(:disabled) {
  background: #45a049;
}

.dialog-actions .create-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.delete-btn {
  background: #f44336;
  color: white;
  transition: background 0.2s;
}

.delete-btn:hover {
  background: #d32f2f;
}
</style>
