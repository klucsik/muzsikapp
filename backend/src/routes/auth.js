import express from 'express';
import { generateLocalToken, validateKeycloakToken, validateToken } from '../services/authService.js';
import logger from '../utils/logger.js';
import config from '../config/config.js';

const router = express.Router();

/**
 * POST /api/auth/login
 * Local password authentication
 */
router.post('/login', async (req, res) => {
  try {
    const { password } = req.body;
    
    if (!password) {
      return res.status(400).json({
        error: 'Bad request',
        message: 'Password is required',
      });
    }
    
    const token = generateLocalToken(password);
    
    if (!token) {
      return res.status(401).json({
        error: 'Authentication failed',
        message: 'Invalid password',
      });
    }
    
    logger.info('User authenticated via local password');
    
    res.json({
      token,
      expiresIn: config.auth.tokenExpiresIn,
    });
  } catch (error) {
    logger.error({ error: error.message }, 'Login error');
    res.status(500).json({
      error: 'Internal server error',
      message: 'Authentication failed',
    });
  }
});

/**
 * POST /api/auth/keycloak-callback
 * Exchange Keycloak token for app token
 */
router.post('/keycloak-callback', async (req, res) => {
  try {
    const { token: keycloakToken } = req.body;
    
    if (!keycloakToken) {
      return res.status(400).json({
        error: 'Bad request',
        message: 'Keycloak token is required',
      });
    }
    
    const appToken = await validateKeycloakToken(keycloakToken);
    
    if (!appToken) {
      return res.status(401).json({
        error: 'Authentication failed',
        message: 'Invalid or expired Keycloak token',
      });
    }
    
    logger.info('User authenticated via Keycloak');
    
    res.json({
      token: appToken,
      expiresIn: config.auth.tokenExpiresIn,
    });
  } catch (error) {
    logger.error({ error: error.message }, 'Keycloak callback error');
    res.status(500).json({
      error: 'Internal server error',
      message: 'Keycloak authentication failed',
    });
  }
});

/**
 * POST /api/auth/logout
 * Logout (cleanup/audit)
 */
router.post('/logout', (req, res) => {
  // Token is client-side only, so just log the event
  logger.info('User logged out');
  
  res.json({
    success: true,
  });
});

/**
 * GET /api/auth/status
 * Check authentication status
 */
router.get('/status', (req, res) => {
  const authHeader = req.headers.authorization;
  
  if (!authHeader) {
    return res.json({
      authenticated: false,
    });
  }
  
  const parts = authHeader.split(' ');
  if (parts.length !== 2 || parts[0] !== 'Bearer') {
    return res.json({
      authenticated: false,
    });
  }
  
  const token = parts[1];
  const decoded = validateToken(token);
  
  if (!decoded) {
    return res.json({
      authenticated: false,
    });
  }
  
  // Calculate time until expiration
  const now = Math.floor(Date.now() / 1000);
  const expiresIn = decoded.exp ? decoded.exp - now : null;
  
  res.json({
    authenticated: true,
    expiresIn,
    source: decoded.source,
  });
});

/**
 * GET /api/auth/keycloak-config
 * Get Keycloak configuration for frontend
 */
router.get('/keycloak-config', (req, res) => {
  const { url, realm, clientId, redirectUri } = config.auth.keycloak;
  
  if (!url || !realm || !clientId) {
    return res.json({
      enabled: false,
    });
  }
  
  res.json({
    enabled: true,
    url,
    realm,
    clientId,
    redirectUri,
  });
});

export default router;
