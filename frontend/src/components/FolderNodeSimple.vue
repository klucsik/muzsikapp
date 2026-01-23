<template>
  <div class="folder-node-simple">
    <!-- Folder Header -->
    <div 
      class="folder-header"
      :class="{ 
        expanded: isExpanded,
        'has-children': hasChildren,
        'drag-over': isDragOver
      }"
      @click="handleClick"
      @dragover.prevent="handleHeaderDragOver"
      @dragleave="handleHeaderDragLeave"
      @drop="handleHeaderDrop"
    >
      <span class="expand-icon" v-if="hasChildren">
        {{ isExpanded ? '▼' : '▶' }}
      </span>
      <span class="folder-icon">📁</span>
      <span class="folder-name">{{ folder.name }}</span>
      <span class="folder-count" v-if="!hasChildren">({{ folder.track_count || 0 }})</span>
      
      <div class="folder-actions" @click.stop>
        <button 
          v-if="!hasChildren"
          @click="$emit('play-folder', folder)" 
          title="Play all tracks"
          class="action-btn"
        >
          ▶
        </button>
        <button 
          v-if="isAuthenticated"
          @click="$emit('edit', folder)" 
          title="Edit folder"
          class="action-btn"
        >
          ✏️
        </button>
        <button 
          v-if="isAuthenticated"
          @click="$emit('delete', folder)" 
          title="Delete folder"
          class="action-btn delete"
        >
          🗑️
        </button>
      </div>
    </div>

    <!-- Tracks (shown when expanded) -->
    <div v-if="isExpanded && !hasChildren && activeFolderId === folder.id" class="folder-tracks">
      <OrderedTrackList
        :tracks="folderTracks"
        :current-track="currentTrack"
        :allow-reorder="true"
        :allow-remove="true"
        :allow-drop="true"
        @track-dblclick="$emit('track-dblclick', $event)"
        @track-drop="handleTrackListDrop"
        @track-reorder="handleTrackListReorder"
        @track-remove="handleTrackListRemove"
      >
        <template #empty>
          <div class="empty-tracks">
            <p>No tracks in this folder</p>
            <p class="empty-hint">Drag tracks from the library to add them</p>
          </div>
        </template>
      </OrderedTrackList>
    </div>

    <!-- Child Folders (shown when expanded) -->
    <div v-if="isExpanded && hasChildren" class="folder-children">
      <FolderNodeSimple
        v-for="child in childFolders"
        :key="child.id"
        :folder="child"
        :all-folders="allFolders"
        :expanded-folder-ids="expandedFolderIds"
        :active-folder-id="activeFolderId"
        :folder-tracks="folderTracks"
        :current-track="currentTrack"
        :loading-tracks="loadingTracks"
        @toggle="$emit('toggle', $event)"
        @edit="$emit('edit', $event)"
        @delete="$emit('delete', $event)"
        @play-folder="$emit('play-folder', $event)"
        @add-to-playlist="$emit('add-to-playlist', $event)"
        @track-dblclick="$emit('track-dblclick', $event)"
        @track-drop="$emit('track-drop', $event)"
        @track-reorder="$emit('track-reorder', $event)"
        @track-remove="$emit('track-remove', $event)"
        :is-authenticated="isAuthenticated"
      />
    </div>
  </div>
</template>

<script setup>
import { computed, ref } from 'vue';
import OrderedTrackList from './OrderedTrackList.vue';

const isDragOver = ref(false);

const props = defineProps({
  folder: {
    type: Object,
    required: true
  },
  allFolders: {
    type: Array,
    default: () => []
  },
  expandedFolderIds: {
    type: Set,
    default: () => new Set()
  },
  activeFolderId: {
    type: String,
    default: null
  },
  folderTracks: {
    type: Array,
    default: () => []
  },
  currentTrack: {
    type: Object,
    default: null
  },
  loadingTracks: {
    type: Boolean,
    default: false
  },
  isAuthenticated: {
    type: Boolean,
    default: false
  }
});

const emit = defineEmits([
  'toggle',
  'edit',
  'delete',
  'play-folder',
  'add-to-playlist',
  'track-dblclick',
  'track-drop',
  'track-reorder',
  'track-remove'
]);

const isExpanded = computed(() => props.expandedFolderIds.has(props.folder.id));

const childFolders = computed(() => {
  return props.allFolders.filter(f => f.parent_id === props.folder.id);
});

const hasChildren = computed(() => childFolders.value.length > 0);

const isPlaying = (track) => {
  return props.currentTrack && props.currentTrack.id === track.id;
};

const handleClick = () => {
  emit('toggle', props.folder);
};

// Handlers for OrderedTrackList events
const handleTrackListDrop = ({ track, position }) => {
  console.log('FolderNodeSimple handleTrackListDrop:', { folderId: props.folder.id, track, position });
  emit('track-drop', {
    folderId: props.folder.id,
    trackId: track.id,
    track: track,
    position: position
  });
};

const handleTrackListReorder = ({ track, oldIndex, newIndex }) => {
  // Emit a reorder event that parent can handle
  emit('track-reorder', {
    folderId: props.folder.id,
    track: track,
    oldIndex: oldIndex,
    newIndex: newIndex
  });
};

const handleTrackListRemove = ({ track, index, position }) => {
  emit('track-remove', {
    folderId: props.folder.id,
    track: track,
    index: index,
    position: position
  });
};

const handleHeaderDragOver = (event) => {
  console.log('Drag over folder header:', props.folder.name);
  isDragOver.value = true;
};

const handleHeaderDragLeave = (event) => {
  isDragOver.value = false;
};

const handleHeaderDrop = (event) => {
  console.log('FolderNodeSimple handleHeaderDrop triggered');
  isDragOver.value = false;
  try {
    const data = JSON.parse(event.dataTransfer.getData('application/json'));
    console.log('Parsed drop data:', data);
    if (data.id || data.trackId) {
      console.log('Emitting track-drop to parent');
      emit('track-drop', {
        folderId: props.folder.id,
        trackId: data.id || data.trackId,
        track: data,
        position: 0 // Add at the beginning when dropping on folder header
      });
    }
  } catch (err) {
    console.error('Failed to parse drop data:', err);
  }
};
</script>

<style scoped>
.folder-node-simple {
  margin-bottom: 4px;
}

.folder-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  background: #2a2a2a;
  border-radius: 6px;
  cursor: pointer;
  transition: all 0.2s;
  margin-bottom: 4px;
}

.folder-header:hover {
  background: #333;
}

.folder-header.expanded {
  background: #333;
}

.folder-header.drag-over {
  background: rgba(76, 175, 80, 0.2);
  border: 2px dashed #4CAF50;
  padding: 6px 10px;
}

.expand-icon {
  font-size: 0.7em;
  color: #888;
  width: 12px;
  text-align: center;
}

.folder-icon {
  font-size: 1.1em;
}

.folder-name {
  flex: 1;
  font-weight: 500;
}

.folder-count {
  color: #888;
  font-size: 0.9em;
}

.folder-actions {
  display: flex;
  gap: 4px;
}

.action-btn {
  padding: 4px 8px;
  background: #444;
  border: none;
  border-radius: 4px;
  color: white;
  cursor: pointer;
  font-size: 0.85em;
  transition: all 0.2s;
  opacity: 1;
}

.action-btn:hover {
  background: #4CAF50;
}

.action-btn.delete:hover {
  background: #f44336;
}

.folder-tracks,
.folder-children {
  margin-left: 24px;
  margin-top: 4px;
}

.empty-tracks {
  padding: 20px;
  text-align: center;
  color: #888;
  font-size: 0.9em;
}

.empty-hint {
  font-size: 0.85em;
  color: #666;
  margin-top: 4px;
}
</style>
