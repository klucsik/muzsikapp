<template>
  <div class="ordered-track-list">
    <!-- Header Slot -->
    <div v-if="$slots.header" class="track-list-header">
      <slot name="header"></slot>
    </div>

    <!-- Empty State with Drop Zone -->
    <div v-if="tracks.length === 0" class="empty-state-container">
      <div 
        v-if="allowDrop"
        class="empty-drop-zone"
        :class="{ 'drag-over': dragOverBottom }"
        @dragover.prevent="dragOverBottom = true"
        @dragleave="dragOverBottom = false"
        @drop="handleDropAtEnd($event)"
      >
        <slot name="empty">
          <p>Drop tracks here</p>
        </slot>
      </div>
      <div v-else class="empty-state">
        <slot name="empty">
          <p>No tracks</p>
        </slot>
      </div>
    </div>

    <!-- Track List -->
    <div 
      v-else 
      class="track-list-container"
      @dragover.prevent="allowDrop && handleContainerDragOver($event)"
      @drop="allowDrop && handleContainerDrop($event)"
    >
      <div
        v-for="(track, index) in tracks"
        :key="track.id"
        :class="[
          'track-item',
          { 
            'playing': isPlaying(track),
            'dragging': draggedTrack === track.id,
            'drag-over': dragOverIndex === index
          }
        ]"
        :draggable="allowReorder"
        @dragstart="handleDragStart(track, index, $event)"
        @dragend="handleDragEnd"
        @dragover.prevent="handleDragOver(index, $event)"
        @dragleave="handleDragLeave"
        @drop="handleDrop(index, $event)"
        @click="handleClick(track)"
        @dblclick="handleDoubleClick(track, index)"
      >
        <!-- Drag Handle -->
        <div v-if="allowReorder" class="drag-handle">
          <span>☰</span>
        </div>

        <!-- Position/Index -->
        <div v-if="showPosition" class="track-position">
          {{ track.position !== undefined ? track.position + 1 : index + 1 }}
        </div>

        <!-- Track Content (Default Slot) -->
        <div class="track-content">
          <slot name="track" :track="track" :index="index">
            <!-- Default track rendering -->
            <div class="track-info">
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
                <div class="track-title" :title="track.title">{{ track.title || 'Unknown' }}</div>
                <div class="track-meta" :title="track.artist">
                  {{ track.artist || 'Unknown Artist' }}
                  <span v-if="track.duration"> • {{ formatDuration(track.duration) }}</span>
                </div>
              </div>
            </div>
          </slot>
        </div>

        <!-- Actions Slot -->
        <div v-if="$slots.actions" class="track-actions">
          <slot name="actions" :track="track" :index="index"></slot>
        </div>

        <!-- Default Remove Button -->
        <button
          v-if="allowRemove && !$slots.actions"
          class="remove-btn"
          @click.stop="handleRemove(track, index)"
          title="Remove track"
        >
          ×
        </button>

        <!-- How much of this track the browser still holds; shrinks back when bytes are evicted -->
        <div
          v-if="cacheBars[index]"
          class="cache-progress"
          :style="{ width: cacheBars[index].width }"
          :title="cacheBars[index].title"
        ></div>
      </div>

      <!-- Drop indicator for end of list -->
      <div v-if="dragOverBottom" class="drop-indicator-bottom"></div>
    </div>

    <!-- Footer Slot -->
    <div v-if="$slots.footer" class="track-list-footer">
      <slot name="footer"></slot>
    </div>
  </div>
</template>

<script setup>
import { ref, computed } from 'vue';

const props = defineProps({
  tracks: {
    type: Array,
    required: true
  },
  currentTrack: {
    type: Object,
    default: null
  },
  allowReorder: {
    type: Boolean,
    default: false
  },
  allowRemove: {
    type: Boolean,
    default: false
  },
  allowDrop: {
    type: Boolean,
    default: false
  },
  showPosition: {
    type: Boolean,
    default: false
  },
  enableDoubleClick: {
    type: Boolean,
    default: true
  },
  enableSingleClick: {
    type: Boolean,
    default: false
  },
  // `{ [trackId]: { cached, total, bytes } }` from useMseBuffer; omitted where there is no
  // fragment cache to report on (V1, folders), and those lists simply draw no strip.
  cacheCoverage: {
    type: Object,
    default: () => ({})
  }
});

const emit = defineEmits([
  'track-click',
  'track-dblclick',
  'track-remove',
  'track-reorder',
  'track-drop'
]);

// Drag and drop state
const draggedTrack = ref(null);
const draggedIndex = ref(null);
const dragOverIndex = ref(null);
const dragOverBottom = ref(false);

/**
 * Cache strip geometry per visible track, in list order. Tracks with no known fragment count —
 * never fetched, or a V1-only library — stay out of here so the item renders untouched rather
 * than with an empty bar.
 */
const cacheBars = computed(() => props.tracks.map((track) => {
  const info = props.cacheCoverage[track.id];
  if (!info || !info.total) return null;
  const percent = Math.min(100, Math.round((info.cached / info.total) * 100));
  if (percent <= 0) return null;
  const mb = (info.bytes / 1048576).toFixed(1);
  return {
    width: `${percent}%`,
    title: `${info.cached}/${info.total} fragments cached (${mb} MB)`,
  };
}));

/**
 * Check if a track is currently playing
 */
const isPlaying = (track) => {
  return props.currentTrack && props.currentTrack.id === track.id;
};

/**
 * Format duration in seconds to MM:SS
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
 * Handle single click on track
 */
const handleClick = (track) => {
  if (props.enableSingleClick) {
    emit('track-click', track);
  }
};

/**
 * Handle double click on track
 */
const handleDoubleClick = (track, index) => {
  if (props.enableDoubleClick) {
    emit('track-dblclick', { track, index });
  }
};

/**
 * Handle remove track
 */
const handleRemove = (track, index) => {
  emit('track-remove', { track, index, position: track.position !== undefined ? track.position : index });
};

/**
 * Handle drag start for reordering
 */
const handleDragStart = (track, index, event) => {
  if (!props.allowReorder) return;
  
  draggedTrack.value = track.id;
  draggedIndex.value = index;
  
  event.dataTransfer.effectAllowed = 'move';
  event.dataTransfer.setData('text/plain', track.id);
  event.dataTransfer.setData('application/json', JSON.stringify(track));
};

/**
 * Handle drag end
 */
const handleDragEnd = () => {
  draggedTrack.value = null;
  draggedIndex.value = null;
  dragOverIndex.value = null;
  dragOverBottom.value = false;
};

/**
 * Handle drag over
 */
const handleDragOver = (index, event) => {
  // Check if this is the last track and we're in the bottom half
  if (index === props.tracks.length - 1) {
    const rect = event.currentTarget.getBoundingClientRect();
    const mouseY = event.clientY;
    const elementMiddle = rect.top + rect.height / 2;
    
    if (mouseY > elementMiddle) {
      // Bottom half of last track - show drop indicator below
      dragOverIndex.value = null;
      dragOverBottom.value = true;
      return;
    }
  }
  
  dragOverIndex.value = index;
  dragOverBottom.value = false;
};

/**
 * Handle drag leave
 */
const handleDragLeave = () => {
  dragOverIndex.value = null;
};

/**
 * Handle drop for reordering
 */
const handleDrop = (index, event) => {
  event.preventDefault();
  event.stopPropagation(); // Prevent container drop handler from firing
  
  if (!props.allowDrop) return;

  try {
    const data = JSON.parse(event.dataTransfer.getData('application/json'));
    
    // Support both formats: full track object or just trackId
    const trackId = data.id || data.trackId;
    
    if (trackId) {
      // If dragOverBottom is true, add to end instead of at the index
      const targetPosition = dragOverBottom.value ? props.tracks.length : index;
      
      emit('track-drop', {
        track: data,
        trackId: trackId,
        position: targetPosition,
        targetPosition: targetPosition
      });
    }
  } catch (e) {
    console.error('Error handling drop:', e);
  }
  
  dragOverIndex.value = null;
  draggedIndex.value = null;
  dragOverBottom.value = false;
};

/**
 * Handle drop at the end of the list
 */
const handleDropAtEnd = (event) => {
  event.preventDefault();
  dragOverBottom.value = false;

  if (props.allowDrop) {
    try {
      const trackData = event.dataTransfer.getData('application/json');
      if (trackData) {
        const track = JSON.parse(trackData);
        emit('track-drop', {
          track,
          position: props.tracks.length
        });
      }
    } catch (error) {
      console.error('Failed to parse dropped track data:', error);
    }
  }

  handleDragEnd();
};

/**
 * Handle drag over the container to allow drops anywhere
 */
const handleContainerDragOver = (event) => {
  event.preventDefault();
  
  // Check if we're in the empty space below all tracks
  if (props.tracks.length > 0) {
    const container = event.currentTarget;
    const lastTrack = container.querySelector('.track-item:last-child');
    
    if (lastTrack) {
      const lastTrackRect = lastTrack.getBoundingClientRect();
      const mouseY = event.clientY;
      
      // If mouse is below the last track, show bottom indicator
      if (mouseY > lastTrackRect.bottom) {
        dragOverBottom.value = true;
        dragOverIndex.value = null;
      }
    }
  }
};

/**
 * Handle drop on the container (when not dropped on a specific track)
 * This handles drops in empty spaces or after the last track
 */
const handleContainerDrop = (event) => {
  event.preventDefault();
  
  if (!props.allowDrop) return;

  try {
    const trackData = event.dataTransfer.getData('application/json');
    if (trackData) {
      const track = JSON.parse(trackData);
      
      // Check if we should add at the end based on dragOverBottom
      const position = dragOverBottom.value ? props.tracks.length : props.tracks.length;
      
      // Emit with both formats for compatibility
      emit('track-drop', {
        track,
        trackId: track.id,
        position: position,
        targetPosition: position
      });
    }
  } catch (error) {
    console.error('Failed to parse dropped track data:', error);
  }

  handleDragEnd();
};
</script>

<style scoped>
.ordered-track-list {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
}

.track-list-header,
.track-list-footer {
  flex-shrink: 0;
}

.track-list-container {
  flex: 1;
  overflow-y: auto;
  padding: 4px;
}

.empty-state-container {
  min-height: 100px;
}

.empty-state {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #666;
  padding: 20px;
}

.empty-drop-zone {
  min-height: 100px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 2px dashed #444;
  border-radius: 8px;
  margin: 20px;
  padding: 40px 20px;
  text-align: center;
  color: #888;
  font-style: italic;
  transition: all 0.2s ease;
}

.empty-drop-zone.drag-over {
  border-color: #4CAF50;
  background: rgba(76, 175, 80, 0.1);
  color: #4CAF50;
}

.track-item {
  display: flex;
  align-items: center;
  gap: 6px;
   padding: 1px 1px; 
  margin-bottom: 1px;
  background: transparent;
  border-bottom: 1px solid #333;
  cursor: pointer;
  transition: background-color 0.2s;
  position: relative;
}

.track-item:hover {
  background: rgba(255, 255, 255, 0.05);
}

.track-item.playing {
  background: rgba(76, 175, 80, 0.2);
  border-left: 3px solid #4CAF50;
  padding-left: 5px;
}

.track-item.playing:hover {
  background: rgba(76, 175, 80, 0.3);
}

/* Cache coverage along the bottom edge: the same grey the seek bar uses for buffered audio, so
   "bytes I already have" looks the same in both places. One colour is enough — a full strip is a
   full strip. */
.cache-progress {
  position: absolute;
  left: 0;
  bottom: 0;
  height: 2px;
  background: rgba(158, 158, 158, 0.55);
  border-radius: 0 2px 2px 0;
  pointer-events: none;
  transition: width 0.3s ease;
}

.track-item.dragging {
  opacity: 0.5;
}

.track-item.drag-over {
  border-top: 2px solid #42b983;
}

.drop-indicator-bottom {
  height: 2px;
  background: #42b983;
  margin: 4px 8px;
  border-radius: 1px;
}

.drag-handle {
  cursor: grab;
  color: #666;
  padding: 0 4px;
  user-select: none;
}

.drag-handle:active {
  cursor: grabbing;
}

.track-position {
  min-width: 30px;
  text-align: center;
  color: #999;
  font-size: 0.9em;
}

.track-content {
  flex: 1;
  min-width: 0;
}

.track-info {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.track-thumbnail {
  width: 71px;
  height: 40px;
  flex-shrink: 0;
  border-radius: 4px;
  overflow: hidden;
  background: #333;
}

.track-thumbnail img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.track-thumbnail.error,
.track-thumbnail-placeholder {
  width: 71px;
  height: 40px;
  flex-shrink: 0;
  border-radius: 4px;
  background: #333;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 1.2em;
  color: #666;
}

.track-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  flex: 1;
}

.track-title {
  font-size: 1em;
  font-weight: 400;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  color: #e0e0e0;
}

.track-meta {
  font-size: 0.85em;
  color: #999;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.track-actions {
  display: flex;
  gap: 4px;
  align-items: center;
}

.remove-btn {
  background: transparent;
  border: none;
  color: #999;
  font-size: 1.5em;
  line-height: 1;
  padding: 0 8px;
  cursor: pointer;
  transition: color 0.2s;
  overflow: hidden;
}

.remove-btn:hover {
  color: #ff6b6b;
}

.drop-zone {
  margin-top: 8px;
  padding: 16px;
  border: 2px dashed #444;
  border-radius: 4px;
  text-align: center;
  color: #666;
  transition: all 0.2s;
}

.drop-zone.drag-over {
  border-color: #42b983;
  background: rgba(66, 185, 131, 0.1);
  color: #42b983;
}

/* Scrollbar styling */
.track-list-container::-webkit-scrollbar {
  width: 8px;
}

.track-list-container::-webkit-scrollbar-track {
  background: #1a1a1a;
}

.track-list-container::-webkit-scrollbar-thumb {
  background: #444;
  border-radius: 4px;
}

.track-list-container::-webkit-scrollbar-thumb:hover {
  background: #555;
}
</style>
