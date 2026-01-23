/**
 * Authentication Service
 * Handles local password and Keycloak authentication
 */

const TOKEN_KEY = 'auth_token';
const API_BASE_URL = import.meta.env.VITE_API_URL || '';

/**
 * Store token in localStorage
 */
function storeToken(token) {
  localStorage.setItem(TOKEN_KEY, token);
}

/**
 * Get token from localStorage
 */
export function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}

/**
 * Clear token from localStorage
 */
function clearToken() {
  localStorage.removeItem(TOKEN_KEY);
}

/**
 * Check if user is authenticated (has token)
 */
export function isAuthenticated() {
  return !!getToken();
}

/**
 * Parse JWT token to get claims (without validation)
 */
function parseToken(token) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) {
      return null;
    }
    const payload = JSON.parse(atob(parts[1]));
    return payload;
  } catch (error) {
    console.error('Failed to parse token:', error);
    return null;
  }
}

/**
 * Get token expiry time in seconds
 */
export function getTokenExpiry() {
  const token = getToken();
  if (!token) {
    return null;
  }
  
  const payload = parseToken(token);
  if (!payload || !payload.exp) {
    return null;
  }
  
  const now = Math.floor(Date.now() / 1000);
  const expiresIn = payload.exp - now;
  
  return expiresIn > 0 ? expiresIn : 0;
}

/**
 * Login with local password
 */
export async function loginLocal(password) {
  try {
    const response = await fetch(`${API_BASE_URL}/api/auth/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ password }),
    });
    
    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.message || 'Login failed');
    }
    
    const data = await response.json();
    storeToken(data.token);
    
    return {
      success: true,
      expiresIn: data.expiresIn,
    };
  } catch (error) {
    console.error('Login failed:', error);
    throw error;
  }
}

/**
 * Get Keycloak configuration from backend
 */
async function getKeycloakConfig() {
  try {
    const response = await fetch(`${API_BASE_URL}/api/auth/keycloak-config`);
    if (!response.ok) {
      throw new Error('Failed to get Keycloak config');
    }
    return await response.json();
  } catch (error) {
    console.error('Failed to get Keycloak config:', error);
    return { enabled: false };
  }
}

/**
 * Redirect to Keycloak login page
 */
export async function loginKeycloak() {
  try {
    const config = await getKeycloakConfig();
    
    if (!config.enabled) {
      throw new Error('Keycloak authentication is not configured');
    }
    
    const { url, realm, clientId, redirectUri } = config;
    
    // Construct Keycloak auth URL
    const authUrl = new URL(`${url}/realms/${realm}/protocol/openid-connect/auth`);
    authUrl.searchParams.set('client_id', clientId);
    authUrl.searchParams.set('redirect_uri', redirectUri || window.location.origin + '/callback');
    authUrl.searchParams.set('response_type', 'token'); // Implicit flow
    authUrl.searchParams.set('scope', 'openid');
    
    // Store current location to return after login
    sessionStorage.setItem('auth_return_url', window.location.pathname);
    
    // Redirect to Keycloak
    window.location.href = authUrl.toString();
  } catch (error) {
    console.error('Keycloak login failed:', error);
    throw error;
  }
}

/**
 * Handle Keycloak callback (exchange token)
 */
export async function handleKeycloakCallback(keycloakToken) {
  try {
    const response = await fetch(`${API_BASE_URL}/api/auth/keycloak-callback`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ token: keycloakToken }),
    });
    
    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.message || 'Keycloak authentication failed');
    }
    
    const data = await response.json();
    storeToken(data.token);
    
    // Return to original location
    const returnUrl = sessionStorage.getItem('auth_return_url') || '/';
    sessionStorage.removeItem('auth_return_url');
    
    return {
      success: true,
      expiresIn: data.expiresIn,
      returnUrl,
    };
  } catch (error) {
    console.error('Keycloak callback failed:', error);
    throw error;
  }
}

/**
 * Logout (clear token)
 */
export async function logout() {
  try {
    const token = getToken();
    
    if (token) {
      // Notify backend of logout
      await fetch(`${API_BASE_URL}/api/auth/logout`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
      });
    }
  } catch (error) {
    console.error('Logout request failed:', error);
    // Continue with local logout even if backend fails
  } finally {
    clearToken();
  }
}

/**
 * Check authentication status with backend
 */
export async function checkStatus() {
  try {
    const token = getToken();
    
    if (!token) {
      return { authenticated: false };
    }
    
    const response = await fetch(`${API_BASE_URL}/api/auth/status`, {
      headers: {
        'Authorization': `Bearer ${token}`,
      },
    });
    
    if (!response.ok) {
      clearToken();
      return { authenticated: false };
    }
    
    const data = await response.json();
    
    if (!data.authenticated) {
      clearToken();
    }
    
    return data;
  } catch (error) {
    console.error('Status check failed:', error);
    clearToken();
    return { authenticated: false };
  }
}

export default {
  getToken,
  isAuthenticated,
  getTokenExpiry,
  loginLocal,
  loginKeycloak,
  handleKeycloakCallback,
  logout,
  checkStatus,
};
