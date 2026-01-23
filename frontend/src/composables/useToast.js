import { ref } from 'vue';

// Global toast state
const toasts = ref([]);
let toastId = 0;

/**
 * Toast composable for showing notifications
 */
export function useToast() {
  /**
   * Show a toast notification
   * @param {string} message - Toast message
   * @param {string} type - Toast type: 'success', 'error', 'warning', 'info'
   * @param {number} duration - Duration in ms (0 = persistent)
   */
  const showToast = (message, type = 'info', duration = 3000) => {
    const id = toastId++;
    const toast = {
      id,
      message,
      type,
      visible: true,
    };
    
    toasts.value.push(toast);
    
    if (duration > 0) {
      setTimeout(() => {
        removeToast(id);
      }, duration);
    }
    
    return id;
  };
  
  /**
   * Remove a toast by ID
   */
  const removeToast = (id) => {
    const index = toasts.value.findIndex(t => t.id === id);
    if (index !== -1) {
      toasts.value.splice(index, 1);
    }
  };
  
  /**
   * Convenience methods
   */
  const success = (message, duration = 3000) => showToast(message, 'success', duration);
  const error = (message, duration = 5000) => showToast(message, 'error', duration);
  const warning = (message, duration = 4000) => showToast(message, 'warning', duration);
  const info = (message, duration = 3000) => showToast(message, 'info', duration);
  
  return {
    toasts,
    showToast,
    removeToast,
    success,
    error,
    warning,
    info,
  };
}
