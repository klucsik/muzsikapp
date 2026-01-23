import jwt from 'jsonwebtoken';
import config from '../config/config.js';
import logger from '../utils/logger.js';

/**
 * Authentication service for handling JWT tokens and Keycloak OIDC
 */

// Cache for Keycloak client
let keycloakClient = null;
let keycloakIssuer = null;
let openidClient = null;

/**
 * Lazy load openid-client
 */
async function getOpenIdClient() {
  if (!openidClient) {
    openidClient = await import('openid-client');
  }
  return openidClient;
}

/**
 * Get JWT secret from config
 */
function getJwtSecret() {
  const secret = config.auth.jwtSecret;
  if (!secret || secret === 'dev-secret-change-in-production') {
    if (config.env === 'production') {
      throw new Error('JWT_SECRET must be set in production');
    }
    logger.warn('Using default JWT secret - not suitable for production');
  }
  return secret;
}

/**
 * Generate a JWT token for local authentication
 * @param {string} password - Password to validate
 * @returns {string|null} JWT token or null if password incorrect
 */
export function generateLocalToken(password) {
  const configPassword = config.auth.password;
  
  if (!configPassword) {
    logger.warn('AUTH_PASSWORD not set - local authentication disabled');
    return null;
  }
  
  if (password !== configPassword) {
    logger.info('Invalid password attempt');
    return null;
  }
  
  const payload = {
    authenticated: true,
    source: 'local',
  };
  
  const secret = getJwtSecret();
  const token = jwt.sign(payload, secret, {
    expiresIn: config.auth.tokenExpiresIn,
  });
  
  logger.info('Generated local authentication token');
  return token;
}

/**
 * Validate a local JWT token
 * @param {string} token - JWT token to validate
 * @returns {object|null} Decoded token payload or null if invalid
 */
export function validateLocalToken(token) {
  try {
    const secret = getJwtSecret();
    const decoded = jwt.verify(token, secret);
    
    // Accept both 'local' and 'keycloak' source tokens
    if ((decoded.source === 'local' || decoded.source === 'keycloak') && decoded.authenticated) {
      return decoded;
    }
    
    return null;
  } catch (error) {
    logger.debug({ error: error.message }, 'Token validation failed');
    return null;
  }
}

/**
 * Get or create Keycloak OIDC client
 */
async function getKeycloakClient() {
  if (keycloakClient) {
    return keycloakClient;
  }
  
  const { url, realm, clientId, clientSecret } = config.auth.keycloak;
  
  if (!url || !realm || !clientId) {
    logger.warn('Keycloak configuration incomplete - Keycloak auth disabled');
    return null;
  }
  
  try {
    // Dynamic import of openid-client
    const oidc = await getOpenIdClient();
    const { Issuer } = oidc;
    
    const issuerUrl = `${url}/realms/${realm}`;
    logger.info({ issuerUrl }, 'Discovering Keycloak OIDC configuration');
    
    keycloakIssuer = await Issuer.discover(issuerUrl);
    keycloakClient = new keycloakIssuer.Client({
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uris: [config.auth.keycloak.redirectUri],
      response_types: ['code'],
    });
    
    logger.info('Keycloak OIDC client initialized');
    return keycloakClient;
  } catch (error) {
    logger.error({ error: error.message, stack: error.stack }, 'Failed to initialize Keycloak client');
    return null;
  }
}

/**
 * Validate a Keycloak token and exchange for app JWT
 * @param {string} keycloakToken - Keycloak JWT token
 * @returns {string|null} App JWT token or null if invalid
 */
export async function validateKeycloakToken(keycloakToken) {
  try {
    const client = await getKeycloakClient();
    if (!client) {
      return null;
    }
    
    // Introspect the token to validate it
    const tokenSet = await client.introspect(keycloakToken);
    
    if (!tokenSet.active) {
      logger.info('Keycloak token is not active');
      return null;
    }
    
    // Token is valid, generate our own JWT
    const payload = {
      authenticated: true,
      source: 'keycloak',
      sub: tokenSet.sub, // Keycloak user ID (but we don't use it for permissions)
    };
    
    const secret = getJwtSecret();
    const appToken = jwt.sign(payload, secret, {
      expiresIn: config.auth.tokenExpiresIn,
    });
    
    logger.info({ sub: tokenSet.sub }, 'Generated app token from Keycloak token');
    return appToken;
  } catch (error) {
    logger.error({ error: error.message }, 'Keycloak token validation failed');
    return null;
  }
}

/**
 * Exchange Keycloak authorization code for tokens and generate app JWT
 * @param {string} code - Authorization code from Keycloak
 * @param {string} redirectUri - Redirect URI used in the auth request
 * @returns {string|null} App JWT token or null if invalid
 */
export async function exchangeKeycloakCode(code, redirectUri) {
  const { url, realm, clientId, clientSecret } = config.auth.keycloak;
  
  if (!url || !realm || !clientId) {
    logger.warn('Keycloak configuration incomplete - cannot exchange code');
    return null;
  }
  
  try {
    logger.info({ code: code.substring(0, 10) + '...', redirectUri }, 'Exchanging authorization code for tokens');
    
    // Build token endpoint URL directly
    const tokenEndpoint = `${url}/realms/${realm}/protocol/openid-connect/token`;
    
    // Exchange code for tokens using standard OAuth 2.0
    const params = new URLSearchParams({
      grant_type: 'authorization_code',
      code: code,
      redirect_uri: redirectUri,
      client_id: clientId,
      client_secret: clientSecret,
    });
    
    const tokenResponse = await fetch(tokenEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    });
    
    if (!tokenResponse.ok) {
      const errorText = await tokenResponse.text();
      logger.error({ status: tokenResponse.status, error: errorText }, 'Token exchange failed');
      return null;
    }
    
    const tokenSet = await tokenResponse.json();
    
    if (!tokenSet || !tokenSet.access_token) {
      logger.warn('No access token received from Keycloak');
      return null;
    }
    
    // Decode the token to get claims (without verification, just for info)
    const tokenParts = tokenSet.access_token.split('.');
    const claims = JSON.parse(Buffer.from(tokenParts[1], 'base64').toString());
    
    // Token is valid, generate our own JWT
    const payload = {
      authenticated: true,
      source: 'keycloak',
      sub: claims.sub, // Keycloak user ID (but we don't use it for permissions)
    };
    
    const secret = getJwtSecret();
    const appToken = jwt.sign(payload, secret, {
      expiresIn: config.auth.tokenExpiresIn,
    });
    
    logger.info({ sub: claims.sub }, 'Generated app token from Keycloak code');
    return appToken;
  } catch (error) {
    logger.error({ error: error.message, stack: error.stack }, 'Keycloak code exchange failed');
    return null;
  }
}

/**
 * Validate a token (try local first, then Keycloak format)
 * @param {string} token - JWT token to validate
 * @returns {object|null} Decoded token payload or null if invalid
 */
export function validateToken(token) {
  if (!token) {
    return null;
  }
  
  // Try local token validation first
  const localResult = validateLocalToken(token);
  if (localResult) {
    return localResult;
  }
  
  // If token format suggests it's from our app (has 'source' claim), it's invalid
  try {
    const decoded = jwt.decode(token);
    if (decoded && decoded.source) {
      // It's our token but validation failed - expired or invalid signature
      return null;
    }
  } catch (error) {
    // Ignore decode errors
  }
  
  // Not our token format, don't try Keycloak validation here
  // (Keycloak tokens are exchanged via the callback endpoint)
  return null;
}

export default {
  generateLocalToken,
  validateLocalToken,
  validateKeycloakToken,
  exchangeKeycloakCode,
  validateToken,
};
