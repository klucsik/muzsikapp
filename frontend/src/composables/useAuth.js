import { ref, computed, watch, onMounted } from 'vue';
import * as authService from '../services/authService.js';

// Global state (shared across all components using this composable)
const isAuthenticated = ref(false);
const isLoading = ref(false);
const error = ref(null);
const tokenExpiresIn = ref(null);

// Check if already initialized
let initialized = false;

/**
 * Auth composable for managing authentication state
 */
export function useAuth() {
  /**
   * Initialize auth state (check if user is already logged in)
   */
  const initialize = async () => {
    if (initialized) {
      return;
    }
    
    initialized = true;
    isLoading.value = true;
    
    try {
      const status = await authService.checkStatus();
      isAuthenticated.value = status.authenticated;
      tokenExpiresIn.value = status.expiresIn || null;
    } catch (err) {
      console.error('Auth initialization failed:', err);
      isAuthenticated.value = false;
      tokenExpiresIn.value = null;
    } finally {
      isLoading.value = false;
    }
  };
  
  /**
   * Login with local password
   */
  const loginLocal = async (password) => {
    isLoading.value = true;
    error.value = null;
    
    try {
      const result = await authService.loginLocal(password);
      isAuthenticated.value = true;
      tokenExpiresIn.value = result.expiresIn;
      return { success: true };
    } catch (err) {
      error.value = err.message || 'Login failed';
      isAuthenticated.value = false;
      throw err;
    } finally {
      isLoading.value = false;
    }
  };
  
  /**
   * Login with Keycloak (redirects to Keycloak)
   */
  const loginKeycloak = async () => {
    isLoading.value = true;
    error.value = null;
    
    try {
      await authService.loginKeycloak();
      // This will redirect, so we won't reach here
    } catch (err) {
      error.value = err.message || 'Keycloak login failed';
      isLoading.value = false;
      throw err;
    }
  };
  
  /**
   * Handle Keycloak callback
   */
  const handleKeycloakCallback = async (keycloakToken) => {
    isLoading.value = true;
    error.value = null;
    
    try {
      const result = await authService.handleKeycloakCallback(keycloakToken);
      isAuthenticated.value = true;
      tokenExpiresIn.value = result.expiresIn;
      return result;
    } catch (err) {
      error.value = err.message || 'Keycloak authentication failed';
      isAuthenticated.value = false;
      throw err;
    } finally {
      isLoading.value = false;
    }
  };
  
  /**
   * Logout
   */
  const logout = async () => {
    isLoading.value = true;
    error.value = null;
    
    try {
      await authService.logout();
      isAuthenticated.value = false;
      tokenExpiresIn.value = null;
    } catch (err) {
      error.value = err.message || 'Logout failed';
      throw err;
    } finally {
      isLoading.value = false;
    }
  };
  
  /**
   * Check authentication status
   */
  const checkStatus = async () => {
    try {
      const status = await authService.checkStatus();
      isAuthenticated.value = status.authenticated;
      tokenExpiresIn.value = status.expiresIn || null;
      return status;
    } catch (err) {
      console.error('Status check failed:', err);
      isAuthenticated.value = false;
      tokenExpiresIn.value = null;
      return { authenticated: false };
    }
  };
  
  /**
   * Clear error message
   */
  const clearError = () => {
    error.value = null;
  };
  
  /**
   * Check if token is expiring soon (< 1 hour)
   */
  const isExpiringSoon = computed(() => {
    if (!tokenExpiresIn.value) {
      return false;
    }
    return tokenExpiresIn.value < 3600; // Less than 1 hour
  });
  
  /**
   * Check if token is expired
   */
  const isExpired = computed(() => {
    if (!tokenExpiresIn.value) {
      return !isAuthenticated.value;
    }
    return tokenExpiresIn.value <= 0;
  });
  
  // Watch for token expiration
  watch(isExpired, (expired) => {
    if (expired && isAuthenticated.value) {
      console.warn('Authentication token expired');
      isAuthenticated.value = false;
      tokenExpiresIn.value = null;
    }
  });
  
  // Update token expiry every minute
  let expiryInterval = null;
  onMounted(() => {
    expiryInterval = setInterval(() => {
      if (tokenExpiresIn.value !== null && tokenExpiresIn.value > 0) {
        tokenExpiresIn.value -= 60;
      }
    }, 60000);
    
    // Cleanup
    return () => {
      if (expiryInterval) {
        clearInterval(expiryInterval);
      }
    };
  });
  
  return {
    // State
    isAuthenticated,
    isLoading,
    error,
    tokenExpiresIn,
    isExpiringSoon,
    isExpired,
    
    // Methods
    initialize,
    loginLocal,
    loginKeycloak,
    handleKeycloakCallback,
    logout,
    checkStatus,
    clearError,
  };
}
