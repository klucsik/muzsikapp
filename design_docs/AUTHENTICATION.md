# Authentication Design Document

## Overview

This document outlines the authentication and authorization strategy for the RPG Music application. The system will support two authentication methods: local password-based auth and Keycloak SSO (OIDC), with a unified permission model that doesn't distinguish between authentication methods.

## Goals

- Protect sensitive operations: folder writes, library management, and download initiation
- Support both local login (password) and Keycloak SSO
- Maintain simple permission model: authenticated vs. unauthenticated
- Provide seamless login experience with optional Keycloak auto-login
- Implement with minimal complexity

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│ Frontend (Vue.js)                                            │
├─────────────────────────────────────────────────────────────┤
│ • Login/Logout button in header                              │
│ • Login modal (Keycloak | Local Password)                    │
│ • Auto-detect Keycloak token on app load                     │
│ • Store JWT token in localStorage                            │
│ • Send token in Authorization header                         │
└────────────────┬────────────────────────────────────────────┘
                 │ HTTP + JWT Token
┌────────────────▼────────────────────────────────────────────┐
│ Backend (Node.js)                                             │
├─────────────────────────────────────────────────────────────┤
│ • Authentication middleware                                  │
│ • Route-level authorization guards                           │
│ • JWT validation (local or Keycloak)                         │
│ • OIDC integration point                                     │
└─────────────────────────────────────────────────────────────┘
```

## Authentication Methods

### 1. Local Password Authentication

**Storage**: Environment variable `AUTH_PASSWORD`

**Token Type**: JWT (simple bearer token)

**Endpoint**: `POST /api/auth/login`
- Request: `{ password: string }`
- Response: `{ token: string, expiresIn: number }`
- Token contains: `{ authenticated: true, source: 'local', iat, exp }`

**Token Lifespan**: 1 week (604800 seconds)

**Validation**: Compare provided password against `AUTH_PASSWORD` env var

### 2. Keycloak OIDC Authentication

**Configuration**:
- Realm: Single realm (configured via env vars)
- Client: OIDC client credentials from Keycloak
- Client ID: `AUTH_KEYCLOAK_CLIENT_ID`
- Client Secret: `AUTH_KEYCLOAK_CLIENT_SECRET`
- Realm URL: `AUTH_KEYCLOAK_URL`
- Redirect URI: `http://localhost:5173/callback` (development) or configured via env

**Token Type**: JWT from Keycloak

**Auto-Login Flow**:
1. Frontend app loads
2. Check if `Authorization` header still has valid Keycloak token (from previous session)
3. If valid and present, auto-login (skip login page)
4. If expired or absent, user must manually initiate login

**Manual Login Flow**:
1. User clicks "Login" button → modal appears
2. User clicks "Keycloak" → redirects to Keycloak login page
3. After auth, Keycloak redirects back to app with token
4. Frontend exchanges Keycloak token for app JWT via `POST /api/auth/keycloak-callback`

**Endpoint**: `POST /api/auth/keycloak-callback`
- Request: `{ token: string }` (from Keycloak)
- Response: `{ token: string, expiresIn: number }` (app JWT)
- Token contains: `{ authenticated: true, source: 'keycloak', iat, exp, keycloakToken: ... }`

**Token Validation**: 
- Verify Keycloak token signature using Keycloak's public key
- Store minimal info in app JWT (authentication fact only, ignore username/groups)

## Token Management

### Storage
- **Location**: Browser `localStorage` under key `auth_token`
- **Scope**: Per origin/app instance
- **Expiration**: Client-side check before API calls + server-side validation

### Sending Tokens
- **Header**: `Authorization: Bearer <token>`
- Applied to all API requests from frontend

### Refresh Strategy
- **No auto-refresh**: After 1 week, user must re-login
- **Validation**: Backend validates token signature and expiration
- **Expired Response**: `401 Unauthorized` → Frontend clears token, shows login

### Logout
- **Action**: Delete `auth_token` from localStorage
- **Endpoint**: `POST /api/auth/logout` (optional, mainly for cleanup/audit)
- **Effect**: Immediate, no server session needed

## Authorization Model

### Access Levels

```
UNAUTHENTICATED:
  ✓ GET /api/tracks               (list all tracks)
  ✓ GET /api/tracks/:id          (get track details)
  ✓ POST /api/playback/*         (playback state, queue management)
  ✓ GET /api/websocket (join room, listen to events)
  
AUTHENTICATED:
  ✓ All unauthenticated endpoints
  ✓ POST/PUT/DELETE /api/folders/* (folder operations)
  ✓ POST/PUT/DELETE /api/collections/* (library management)
  ✓ POST /api/downloads (initiate downloads)
  ✓ POST /api/system/* (scanner control, library refresh)
```

### Protected Routes

| Endpoint | Method | Auth Required | Reason |
|----------|--------|---------------|--------|
| `/api/folders` | POST | Yes | Create folder |
| `/api/folders/:id` | PUT | Yes | Rename/modify folder |
| `/api/folders/:id` | DELETE | Yes | Delete folder |
| `/api/collections` | POST | Yes | Create collection |
| `/api/collections/:id` | PUT | Yes | Edit collection |
| `/api/collections/:id` | DELETE | Yes | Delete collection |
| `/api/downloads` | POST | Yes | Start download |
| `/api/scanner/*` | POST | Yes | Control scanner |

### Implementation

**Backend Middleware**:
```javascript
// Middleware: optional auth (decode if present, don't fail if absent)
authOptional()

// Middleware: require auth (fail with 401 if absent/invalid)
authRequired()

// Route example:
router.post('/folders', authRequired(), createFolder)
router.get('/tracks', authOptional(), getTracks)
```

## Implementation Plan

### Phase 1: Backend Authentication

1. **Create authentication service** (`src/services/authService.js`)
   - `generateLocalToken(password)` → JWT
   - `validateLocalToken(token)` → object | null
   - `validateKeycloakToken(token)` → object | null
   - `validateToken(token)` → object | null (unified)

2. **Setup authentication routes** (`src/routes/auth.js`)
   - `POST /api/auth/login` - local password login
   - `POST /api/auth/keycloak-callback` - Keycloak token exchange
   - `POST /api/auth/logout` - logout (cleanup)
   - `GET /api/auth/status` - check current auth status

3. **Add authentication middleware** (`src/middleware/auth.js`)
   - `authOptional()` - attach user to req if token valid
   - `authRequired()` - reject if token invalid/absent

4. **Integrate middleware**:
   - Apply `authOptional()` globally to extract tokens
   - Apply `authRequired()` to protected routes

5. **Update environment configuration**:
   - `AUTH_PASSWORD` - local password
   - `AUTH_KEYCLOAK_URL` - Keycloak realm URL
   - `AUTH_KEYCLOAK_CLIENT_ID` - OIDC client ID
   - `AUTH_KEYCLOAK_CLIENT_SECRET` - OIDC client secret
   - `AUTH_KEYCLOAK_REDIRECT_URI` - callback URL

### Phase 2: Frontend Integration

1. **Create auth service** (`src/services/authService.js`)
   - `loginLocal(password)` → store token
   - `loginKeycloak()` → redirect to Keycloak
   - `handleKeycloakCallback()` → exchange token
   - `logout()` → clear token
   - `isAuthenticated()` → boolean
   - `getToken()` → token string | null

2. **Add login UI components**
   - `LoginButton.vue` - header button
   - `LoginModal.vue` - modal with Keycloak/Password options
   - `KeycloakRedirect.vue` - handle Keycloak callback

3. **Integrate with API service** (`src/services/api.js`)
   - Attach token to all outgoing requests
   - Handle `401` responses → show login, clear token

4. **Add auth check on app load** (`src/App.vue`)
   - Call `/api/auth/status` or validate cached token
   - Auto-login if valid Keycloak token exists
   - Initialize auth state in composable

5. **Hide/disable protected UI**
   - Hide "Manage Library", "Download" buttons if not authenticated
   - Disable folder operations if not authenticated
   - Show message prompting login

### Phase 3: Configuration & Deployment

1. **Environment variables** (`.env.example` or docs)
   - Document all `AUTH_*` variables
   - Provide Keycloak setup instructions
   - Include sample values

2. **Docker/deployment**
   - Pass `AUTH_*` vars to backend container
   - Document Keycloak instance requirements
   - Update README with auth setup steps

## API Changes

### New Endpoints

```
POST /api/auth/login
  Request: { password: string }
  Response: { token: string, expiresIn: 604800 }
  Error: 401 if password incorrect

POST /api/auth/keycloak-callback
  Request: { token: string (Keycloak token) }
  Response: { token: string, expiresIn: 604800 }
  Error: 401 if Keycloak token invalid

POST /api/auth/logout
  Request: {}
  Response: { success: true }

GET /api/auth/status
  Request: (no body)
  Response: { authenticated: boolean, expiresIn?: number }
  Error: 200 with { authenticated: false } if not authed
```

### Modified Endpoints

All existing endpoints unchanged in signature. Protected routes will:
- Return `401 Unauthorized` if auth required but absent
- Return `403 Forbidden` if auth invalid
- Otherwise work as before

## Frontend Changes

### New Files
- `src/services/authService.js` - auth logic
- `src/components/LoginButton.vue` - header button
- `src/components/LoginModal.vue` - login modal
- `src/composables/useAuth.js` - auth state composable

### Modified Files
- `src/App.vue` - add auth state, logout button, check status on load
- `src/services/api.js` - attach token to requests, handle 401
- `src/main.js` - setup auth on app init

## Security Considerations

### JWT Implementation
- **Algorithm**: HS256 or RS256 (use consistent secret in env)
- **Secret Management**: Store in env variable, never in code
- **Claims**: Minimal (`authenticated`, `source`, `iat`, `exp`)
- **No sensitive data in token**: No usernames, groups, or permissions

### Keycloak Integration
- **Token Validation**: Always validate signature using Keycloak's public key
- **Audience**: Can ignore (not critical for this use case)
- **Realm**: Single realm only, ignore username/groups/roles
- **Token Format**: Expect standard Keycloak JWT format

### CORS & Headers
- **Credentials**: Token in header, not cookies (simpler for API)
- **CORS**: Configure to allow frontend origin
- **X-Requested-With**: Optional CSRF protection

### Storage
- **localStorage**: XSS-safe if app properly escapes output
- **No httpOnly cookies**: Can't use (requires same-domain, more complex)
- **Token expiry**: 1 week reasonable, user can manually logout

### Environment Variables
- **Never commit secrets**: Use `.env.example` with placeholders
- **Validation**: App should fail loudly if critical vars missing
- **Docs**: Document how to obtain Keycloak credentials

## Deployment Notes

### Local Development
```bash
# .env or start.sh
AUTH_PASSWORD=your_password_here
AUTH_KEYCLOAK_URL=http://keycloak:8080/realms/your-realm
AUTH_KEYCLOAK_CLIENT_ID=your-client-id
AUTH_KEYCLOAK_CLIENT_SECRET=your-client-secret
AUTH_KEYCLOAK_REDIRECT_URI=http://localhost:5173/callback
```

### Production
- Use secure, random password for `AUTH_PASSWORD`
- Use HTTPS for all Keycloak and app communication
- Ensure OIDC client secret is protected
- Set `AUTH_KEYCLOAK_REDIRECT_URI` to production domain

## Future Enhancements

- Multi-user support (store auth info per user, separate permissions)
- Token refresh mechanism (ask Keycloak for fresh token before expiry)
- Audit logging (track login/logout events)
- Permission granularity (different perms for different operations)
- Session management (invalidate all sessions on password change)

## Rollout Strategy

1. **Backend first**: Implement auth service, endpoints, middleware
2. **Non-breaking**: Make auth optional initially, protected routes still accessible
3. **Frontend**: Add login UI, hook up auth service
4. **Testing**: Manual testing in dev, both auth methods
5. **Enable protection**: Flip switch to require auth on protected routes
6. **Documentation**: Update README and deployment docs
