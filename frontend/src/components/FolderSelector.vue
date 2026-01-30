<template>
  <div class="folder-selector">
    <label v-if="label" class="folder-label">{{ label }}</label>
    <select 
      v-model="selectedFolderId" 
      @change="handleChange" 
      class="folder-select"
      :multiple="multiple"
      :size="multiple ? Math.min(flatFolders.length + 1, 10) : undefined"
    >
      <option v-if="!multiple" :value="null">{{ nullOptionText }}</option>
      <option
        v-for="folder in flatFolders"
        :key="folder.id"
        :value="folder.id"
        :style="{ paddingLeft: `${folder.depth * 16 + 8}px` }"
        :disabled="disabledFolderIds.includes(folder.id)"
      >
        {{ folder.prefix }}{{ folder.name }}{{ folder.trackCount !== undefined ? ` (${folder.trackCount})` : '' }}
      </option>
    </select>
    <div v-if="multiple && selectedFolderId && selectedFolderId.length > 0" class="selected-count">
      {{ selectedFolderId.length }} folder{{ selectedFolderId.length !== 1 ? 's' : '' }} selected
    </div>
  </div>
</template>

<script setup>
import { ref, computed, watch } from 'vue';

const props = defineProps({
  folders: {
    type: Array,
    default: () => []
  },
  modelValue: {
    type: [String, Array],
    default: null
  },
  label: {
    type: String,
    default: ''
  },
  nullOptionText: {
    type: String,
    default: '-- No folder --'
  },
  showTrackCounts: {
    type: Boolean,
    default: false
  },
  multiple: {
    type: Boolean,
    default: false
  },
  disabledFolderIds: {
    type: Array,
    default: () => []
  }
});

const emit = defineEmits(['update:modelValue', 'change']);

const selectedFolderId = ref(props.modelValue);

// Watch for external changes
watch(() => props.modelValue, (newValue) => {
  selectedFolderId.value = newValue;
});

// Flatten folder hierarchy for display
const flatFolders = computed(() => {
  const flattened = [];
  
  const flattenFolder = (folder, depth = 0, parentPrefix = '') => {
    const prefix = depth > 0 ? parentPrefix + '└─ ' : '';
    
    flattened.push({
      id: folder.id,
      name: folder.name,
      depth,
      prefix,
      trackCount: props.showTrackCounts ? folder.track_count : undefined
    });
    
    // Find and sort children
    const children = props.folders
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
  const rootFolders = props.folders
    .filter(f => !f.parent_id)
    .sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
  
  rootFolders.forEach(folder => flattenFolder(folder));
  
  return flattened;
});

const handleChange = () => {
  emit('update:modelValue', selectedFolderId.value);
  emit('change', selectedFolderId.value);
};
</script>

<style scoped>
.folder-selector {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.folder-label {
  font-size: 0.9em;
  color: #aaa;
  font-weight: 500;
}

.folder-select {
  width: 100%;
  padding: 10px 12px;
  background: #1a1a1a;
  border: 1px solid #444;
  border-radius: 4px;
  color: white;
  font-size: 0.95em;
  cursor: pointer;
  transition: all 0.2s;
}

.folder-select:hover {
  border-color: #666;
}

.folder-select:focus {
  outline: none;
  border-color: #42b983;
  box-shadow: 0 0 0 2px rgba(66, 185, 131, 0.1);
}

.folder-select option {
  background: #1a1a1a;
  color: white;
  padding: 8px;
}

.folder-select option:hover {
  background: #2a2a2a;
}

.folder-select option:disabled {
  color: #666;
  cursor: not-allowed;
}

.folder-select[multiple] {
  height: auto;
  min-height: 150px;
}

.folder-select[multiple] option {
  padding: 6px 8px;
  margin: 2px 0;
}

.folder-select[multiple] option:checked {
  background: #42b983;
  color: white;
}

.selected-count {
  margin-top: 8px;
  font-size: 0.85em;
  color: #42b983;
  font-weight: 500;
}
</style>
