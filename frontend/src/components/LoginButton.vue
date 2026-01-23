<template>
  <div class="login-button-container">
    <button 
      v-if="!isAuthenticated"
      class="login-btn"
      @click="showLoginModal = true"
      :disabled="isLoading"
    >
      🔒 Login
    </button>
    <button 
      v-else
      class="logout-btn"
      @click="handleLogout"
      :disabled="isLoading"
      :title="`Expires in ${formatExpiry()}`"
    >
      ✅ Authenticated
    </button>
    
    <LoginModal
      v-if="showLoginModal"
      @close="showLoginModal = false"
      @login-success="handleLoginSuccess"
    />
  </div>
</template>

<script>
import { ref } from 'vue';
import { useAuth } from '../composables/useAuth.js';
import LoginModal from './LoginModal.vue';

export default {
  name: 'LoginButton',
  components: {
    LoginModal,
  },
  setup() {
    const { isAuthenticated, isLoading, tokenExpiresIn, logout } = useAuth();
    const showLoginModal = ref(false);
    
    const handleLogout = async () => {
      try {
        await logout();
      } catch (error) {
        console.error('Logout failed:', error);
      }
    };
    
    const handleLoginSuccess = () => {
      showLoginModal.value = false;
    };
    
    const formatExpiry = () => {
      if (!tokenExpiresIn.value) {
        return 'unknown';
      }
      
      const seconds = tokenExpiresIn.value;
      if (seconds < 60) {
        return `${seconds}s`;
      } else if (seconds < 3600) {
        return `${Math.floor(seconds / 60)}m`;
      } else if (seconds < 86400) {
        return `${Math.floor(seconds / 3600)}h`;
      } else {
        return `${Math.floor(seconds / 86400)}d`;
      }
    };
    
    return {
      isAuthenticated,
      isLoading,
      showLoginModal,
      handleLogout,
      handleLoginSuccess,
      formatExpiry,
    };
  },
};
</script>

<style scoped>
.login-button-container {
  display: flex;
  align-items: center;
}

.login-btn,
.logout-btn {
  padding: 0.5rem 1rem;
  border: none;
  border-radius: 0.5rem;
  cursor: pointer;
  font-size: 0.9rem;
  font-weight: 500;
  transition: all 0.2s;
}

.login-btn {
  background: var(--primary-color, #4a90e2);
  color: white;
}

.login-btn:hover:not(:disabled) {
  background: var(--primary-dark, #357abd);
}

.logout-btn {
  background: var(--success-color, #27ae60);
  color: white;
}

.logout-btn:hover:not(:disabled) {
  background: var(--success-dark, #1e8449);
}

.login-btn:disabled,
.logout-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
