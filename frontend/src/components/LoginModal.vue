<template>
  <div class="modal-overlay" @click.self="$emit('close')">
    <div class="modal-content">
      <div class="modal-header">
        <h2>Login</h2>
        <button class="close-btn" @click="$emit('close')">✕</button>
      </div>
      
      <div class="modal-body">
        <div class="error-message" v-if="error">
          {{ error }}
        </div>
        
        <form @submit.prevent="handleLocalLogin" class="login-form">
          <div class="form-group">
            <label for="password">Password</label>
            <input
              id="password"
              type="password"
              v-model="password"
              placeholder="Enter password"
              :disabled="isLoading"
              autocomplete="current-password"
            />
          </div>
          
          <button 
            type="submit"
            class="login-btn primary"
            :disabled="isLoading || !password"
          >
            {{ isLoading ? 'Logging in...' : 'Login with Password' }}
          </button>
          
          <div class="divider">or</div>
          
          <button 
            type="button"
            class="login-btn keycloak"
            @click="handleKeycloakLogin"
            :disabled="isLoading"
          >
            {{ isLoading ? 'Redirecting...' : 'Login with Keycloak' }}
          </button>
        </form>
      </div>
    </div>
  </div>
</template>

<script>
import { ref } from 'vue';
import { useAuth } from '../composables/useAuth.js';

export default {
  name: 'LoginModal',
  emits: ['close', 'login-success'],
  setup(props, { emit }) {
    const { isLoading, error, loginLocal, loginKeycloak, clearError } = useAuth();
    
    const password = ref('');
    
    const handleLocalLogin = async () => {
      clearError();
      
      try {
        await loginLocal(password.value);
        emit('login-success');
        emit('close');
      } catch (err) {
        // Error is handled by composable
        console.error('Login failed:', err);
      }
    };
    
    const handleKeycloakLogin = async () => {
      clearError();
      
      try {
        await loginKeycloak();
        // This will redirect, so we won't reach here
      } catch (err) {
        // Error is handled by composable
        console.error('Keycloak login failed:', err);
      }
    };
    
    return {
      password,
      isLoading,
      error,
      handleLocalLogin,
      handleKeycloakLogin,
    };
  },
};
</script>

<style scoped>
.modal-overlay {
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

.modal-content {
  background: var(--bg-secondary, #2d2d2d);
  border-radius: 0.5rem;
  width: 90%;
  max-width: 400px;
  box-shadow: 0 4px 6px rgba(0, 0, 0, 0.3);
}

.modal-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 1rem 1.5rem;
  border-bottom: 1px solid var(--border-color, #444);
}

.modal-header h2 {
  margin: 0;
  font-size: 1.5rem;
  color: var(--text-primary, #fff);
}

.close-btn {
  background: none;
  border: none;
  font-size: 1.5rem;
  cursor: pointer;
  color: var(--text-secondary, #aaa);
  padding: 0;
  width: 2rem;
  height: 2rem;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 0.25rem;
}

.close-btn:hover {
  background: var(--hover-bg, #444);
}

.modal-body {
  padding: 1.5rem;
}

.error-message {
  background: var(--error-bg, #c0392b);
  color: white;
  padding: 0.75rem;
  border-radius: 0.25rem;
  margin-bottom: 1rem;
  font-size: 0.9rem;
}

.login-form {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.form-group {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.form-group label {
  color: var(--text-primary, #fff);
  font-size: 0.9rem;
  font-weight: 500;
}

.form-group input {
  width: 100%;
  padding: 0.75rem;
  background: var(--bg-tertiary, #1a1a1a);
  border: 1px solid var(--border-color, #444);
  border-radius: 0.25rem;
  color: var(--text-primary, #fff);
  font-size: 0.9rem;
}

.form-group input:focus {
  outline: none;
  border-color: var(--primary-color, #4a90e2);
}

.form-group input:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.login-btn {
  width: 100%;
  padding: 0.75rem;
  border: none;
  border-radius: 0.25rem;
  font-size: 1rem;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s;
}

.login-btn.primary {
  background: var(--primary-color, #4a90e2);
  color: white;
}

.login-btn.primary:hover:not(:disabled) {
  background: var(--primary-hover, #357abd);
}

.login-btn.keycloak {
  background: var(--bg-tertiary, #1a1a1a);
  color: var(--text-primary, #fff);
  border: 1px solid var(--border-color, #444);
}

.login-btn.keycloak:hover:not(:disabled) {
  background: var(--hover-bg, #333);
  border-color: var(--primary-color, #4a90e2);
}

.login-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.divider {
  text-align: center;
  color: var(--text-secondary, #aaa);
  font-size: 0.9rem;
  position: relative;
  margin: 0.5rem 0;
}

.divider::before,
.divider::after {
  content: '';
  position: absolute;
  top: 50%;
  width: 40%;
  height: 1px;
  background: var(--border-color, #444);
}

.divider::before {
  left: 0;
}

.divider::after {
  right: 0;
}


.login-submit-btn:disabled,
.keycloak-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.keycloak-info {
  color: var(--text-secondary, #aaa);
  font-size: 0.9rem;
  margin-bottom: 1rem;
  line-height: 1.5;
}
</style>
