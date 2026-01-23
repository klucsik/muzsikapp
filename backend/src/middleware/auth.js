import { validateToken } from '../services/authService.js';
import logger from '../utils/logger.js';

/**
 * Extract token from Authorization header
 * @param {object} req - Express request object
 * @returns {string|null} Token or null if not present
 */
function extractToken(req) {
  const authHeader = req.headers.authorization;
  
  if (!authHeader) {
    return null;
  }
  
  const parts = authHeader.split(' ');
  if (parts.length !== 2 || parts[0] !== 'Bearer') {
    return null;
  }
  
  return parts[1];
}

/**
 * Middleware: Optional authentication
 * Attaches user to req.user if token is valid, but doesn't fail if absent
 */
export function authOptional() {
  return (req, res, next) => {
    const token = extractToken(req);
    
    if (token) {
      const decoded = validateToken(token);
      if (decoded) {
        req.user = decoded;
        logger.debug({ source: decoded.source }, 'Authenticated request');
      }
    }
    
    next();
  };
}

/**
 * Middleware: Required authentication
 * Returns 401 if token is absent or invalid
 */
export function authRequired() {
  return (req, res, next) => {
    const token = extractToken(req);
    
    if (!token) {
      return res.status(401).json({
        error: 'Authentication required',
        message: 'No authentication token provided',
      });
    }
    
    const decoded = validateToken(token);
    
    if (!decoded) {
      return res.status(401).json({
        error: 'Invalid token',
        message: 'Authentication token is invalid or expired',
      });
    }
    
    req.user = decoded;
    logger.debug({ source: decoded.source }, 'Authenticated request');
    next();
  };
}

export default {
  authOptional,
  authRequired,
};
