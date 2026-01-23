<template>
  <div class="toast-container">
    <transition-group name="toast">
      <div
        v-for="toast in toasts"
        :key="toast.id"
        :class="['toast', `toast-${toast.type}`]"
        @click="removeToast(toast.id)"
      >
        <div class="toast-icon">
          <span v-if="toast.type === 'success'">✓</span>
          <span v-else-if="toast.type === 'error'">✕</span>
          <span v-else-if="toast.type === 'warning'">⚠</span>
          <span v-else>ℹ</span>
        </div>
        <div class="toast-message">{{ toast.message }}</div>
      </div>
    </transition-group>
  </div>
</template>

<script>
import { useToast } from '../composables/useToast.js';

export default {
  name: 'ToastContainer',
  setup() {
    const { toasts, removeToast } = useToast();
    
    return {
      toasts,
      removeToast,
    };
  },
};
</script>

<style scoped>
.toast-container {
  position: fixed;
  top: 1rem;
  right: 1rem;
  z-index: 9999;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  pointer-events: none;
}

.toast {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.75rem 1rem;
  background: var(--bg-secondary, #2d2d2d);
  border-radius: 0.5rem;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
  min-width: 250px;
  max-width: 400px;
  pointer-events: auto;
  cursor: pointer;
  border-left: 4px solid;
}

.toast-success {
  border-left-color: var(--success-color, #27ae60);
}

.toast-error {
  border-left-color: var(--error-color, #e74c3c);
}

.toast-warning {
  border-left-color: var(--warning-color, #f39c12);
}

.toast-info {
  border-left-color: var(--info-color, #3498db);
}

.toast-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 1.5rem;
  height: 1.5rem;
  border-radius: 50%;
  font-weight: bold;
  font-size: 1rem;
  flex-shrink: 0;
}

.toast-success .toast-icon {
  background: var(--success-color, #27ae60);
  color: white;
}

.toast-error .toast-icon {
  background: var(--error-color, #e74c3c);
  color: white;
}

.toast-warning .toast-icon {
  background: var(--warning-color, #f39c12);
  color: white;
}

.toast-info .toast-icon {
  background: var(--info-color, #3498db);
  color: white;
}

.toast-message {
  flex: 1;
  color: var(--text-primary, #fff);
  font-size: 0.9rem;
  line-height: 1.4;
}

/* Animations */
.toast-enter-active,
.toast-leave-active {
  transition: all 0.3s ease;
}

.toast-enter-from {
  opacity: 0;
  transform: translateX(100%);
}

.toast-leave-to {
  opacity: 0;
  transform: translateX(100%) scale(0.8);
}

.toast-move {
  transition: transform 0.3s ease;
}
</style>
