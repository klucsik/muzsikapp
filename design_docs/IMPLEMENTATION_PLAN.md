# Authentication Implementation Plan

## Current State Analysis

### What Exists
- **Backend**: Express server with 8 route modules (tracks, folders, downloads, collections, playback, scanner, system, audio)
- **Frontend**: Vue 3 SPA with Vite build, axios/fetch-based API client, WebSocket support
- **Database**: SQLite with schema for collections, folders, tracks
- **Configuration**: dotenv-based config system in place
- **Dependencies**: No JWT or Keycloak libraries installed yet

### What's Missing (vs Design Doc)
- ✗ JWT library (jsonwebtoken)
- ✗ Keycloak/OIDC client library
- ✗ Authentication middleware
- ✗ Auth routes (login, logout, status, keycloak-callback)
- ✗ Auth service (token generation, validation)
- ✗ Authorization guards on protected routes
- ✗ Frontend auth service and composable
- ✗ Login UI components (button, modal, redirect)
- ✗ API client auth header injection
- ✗ Auth state management on frontend
- ✗ Environment variable documentation for auth

---

## Implementation Plan

### Phase 1: Backend Setup & Auth Service
**Estimated: 2-3 hours**

#### Task 1.1: Install Dependencies
- Add `jsonwebtoken` for JWT signing/verification
- Add `keycloak-connect` or `openid-client` for Keycloak OIDC (TBD: which library is lighter/simpler)
- Add `dotenv` (already installed)

**File**: `backend/package.json`

#### Task 1.2: Create Auth Service
**File**: `backend/src/services/authService.js` (NEW)

Implement:
- `generateLocalToken(password)` - Create JWT with local auth source
- `validateLocalToken(token)` - Verify JWT signature
- `validateKeycloakToken(token)` - Verify Keycloak token signature
- `validateToken(token)` - Unified validation (try both)
- `getTokenSecret()` - Get or generate JWT secret from env

Config needed:
- `JWT_SECRET` env var (or use a default for development)
- `AUTH_PASSWORD` env var (password)

#### Task 1.3: Create Auth Middleware
**File**: `backend/src/middleware/auth.js` (NEW)

Implement:
- `authOptional()` - Extract token if present, attach to `req.user` (don't fail)
- `authRequired()` - Extract and validate token, return 401 if invalid
- `authError(res, message)` - Helper to return standardized auth error

These middleware will:
- Read `Authorization: Bearer <token>` header
- Call `authService.validateToken()`
- Attach decoded token to `req.user`
- Return 401 if validation fails (when required)

#### Task 1.4: Create Auth Routes
**File**: `backend/src/routes/auth.js` (NEW)

Implement endpoints:
- `POST /api/auth/login` - Local password login
  - Request: `{ password: string }`
  - Response: `{ token: string, expiresIn: 604800 }`
  - Return 401 if password incorrect

- `POST /api/auth/keycloak-callback` - Keycloak token exchange
  - Request: `{ token: string }` (Keycloak JWT)
  - Response: `{ token: string, expiresIn: 604800 }` (app JWT)
  - Return 401 if Keycloak token invalid

- `POST /api/auth/logout` - Logout (cleanup/audit)
  - Request: (no body)
  - Response: `{ success: true }`
  - Optional: log the logout event

- `GET /api/auth/status` - Check auth status
  - Request: (no body, reads token from header)
  - Response: `{ authenticated: boolean, expiresIn?: number }`
  - Always returns 200 (not 401) so frontend can check gracefully

#### Task 1.5: Integrate Middleware & Routes
**File**: `backend/src/server.js`

Changes:
- Import auth middleware and routes
- Add `authOptional()` as global middleware (after CORS, before route handlers)
- Add auth routes: `app.use('/api/auth', authRoutes)`
- Add `authRequired()` to protected route handlers (see Task 1.6)

#### Task 1.6: Protect Backend Routes
**Files**: `backend/src/routes/folders.js`, `downloads.js`, `collections.js`, `scanner.js`

Add `authRequired()` middleware to:
- **Folders**:
  - POST (create) 
  - PUT (update)
  - DELETE (delete)
  
- **Downloads**:
  - POST (start download)
  
- **Collections**:
  - POST (create)
  - PUT (update)
  - DELETE (delete)
  
- **Scanner**:
  - POST (all endpoints - scan, stop, etc.)

Leave GET endpoints unprotected.

Example:
```javascript
router.post('/', authRequired(), (req, res) => { ... })
```

#### Task 1.7: Update Configuration
**File**: `backend/src/config/config.js`

Add:
```javascript
auth: {
  password: process.env.AUTH_PASSWORD || '',
  jwtSecret: process.env.JWT_SECRET || 'dev-secret-change-in-production',
  tokenExpiresIn: 604800, // 1 week
  keycloak: {
    url: process.env.AUTH_KEYCLOAK_URL || '',
    realm: process.env.AUTH_KEYCLOAK_REALM || '',
    clientId: process.env.AUTH_KEYCLOAK_CLIENT_ID || '',
    clientSecret: process.env.AUTH_KEYCLOAK_CLIENT_SECRET || '',
    redirectUri: process.env.AUTH_KEYCLOAK_REDIRECT_URI || '',
  },
},
```

---

### Phase 2: Frontend Auth Infrastructure
**Estimated: 2-3 hours**

#### Task 2.1: Create Frontend Auth Service
**File**: `frontend/src/services/authService.js` (NEW)

Implement:
- `async loginLocal(password)` - Call `POST /api/auth/login`, store token
- `async loginKeycloak()` - Redirect to Keycloak login page (construct URL with client credentials)
- `async handleKeycloakCallback(token)` - Call `POST /api/auth/keycloak-callback`, store token
- `async logout()` - Call `POST /api/auth/logout`, clear localStorage token
- `getToken()` - Return stored token string or null
- `isAuthenticated()` - Check if token exists and valid
- `async checkStatus()` - Call `GET /api/auth/status`, return auth status
- `getTokenExpiry()` - Parse exp claim from JWT, return seconds remaining

Storage:
- Key: `auth_token`
- Location: `localStorage`
- No expiry on localStorage, but validate on each API call

#### Task 2.2: Create Auth Composable
**File**: `frontend/src/composables/useAuth.js` (NEW)

Reactive state:
- `isAuthenticated` - boolean ref
- `isLoading` - boolean ref (for login, logout, status check)
- `error` - string ref (error message)
- `tokenExpiresIn` - number ref (seconds remaining)

Methods:
- `loginLocal(password)` - call authService
- `loginKeycloak()` - call authService
- `logout()` - call authService
- `checkStatus()` - call authService, update state
- `clearError()` - clear error message

Watchers:
- Watch `isAuthenticated`, update UI state
- Watch `tokenExpiresIn`, warn if <1 hour remaining

#### Task 2.3: Create Login UI Components
**File**: `frontend/src/components/LoginButton.vue` (NEW)

- Header button that shows "Login" or username/"Logout"
- Click opens LoginModal
- Shows loading state during login

**File**: `frontend/src/components/LoginModal.vue` (NEW)

Modal with two tabs/sections:
- **Keycloak Tab**: Button "Login with Keycloak" → redirects to Keycloak
- **Local Password Tab**: Text input for password + "Login" button

Features:
- Error message display
- Loading state on buttons
- Close button
- Auto-close on success

**File**: `frontend/src/components/KeycloakCallback.vue` (NEW) [Optional]

- Route: `/callback` or `/auth/callback`
- Receive `code` and `state` from Keycloak
- Exchange for token via `authService.handleKeycloakCallback()`
- Redirect to home page on success

Note: May not need separate component if using OAuth2 implicit flow or backend-handled callback.

#### Task 2.4: Integrate Auth into API Service
**File**: `frontend/src/services/api.js`

Modify `request()` method:
- Get token via `authService.getToken()`
- Add to headers if present: `Authorization: Bearer <token>`
- Handle 401 response → clear token, show login, reload
- Handle 403 response → show permission denied message

#### Task 2.5: Integrate Auth into App
**File**: `frontend/src/App.vue`

Changes in `<script>`:
- Import `useAuth()` composable
- Call `checkStatus()` on component mount to validate cached token
- Watch `isAuthenticated` to update UI
- Pass `isAuthenticated` to child components that need it

Changes in `<template>`:
- Add LoginButton to header
- Conditionally show/disable:
  - ManageLibraryPanel (require auth)
  - FolderManagerPanel (require auth)
  - Download buttons (require auth)
  - Show message "Log in to access this feature" if needed

#### Task 2.6: Protect Component Features
**Files**: `frontend/src/components/*.vue`

Update components that modify data:
- `ManageLibraryPanel.vue` - show message if not authenticated
- `FolderManagerPanel.vue` - disable create/delete if not authenticated
- `DownloadQueuePanel.vue` - disable downloads if not authenticated
- `AudioPlayer.vue` - keep playback controls enabled for all

Example:
```vue
<button 
  :disabled="!isAuthenticated" 
  @click="deleteFolder"
  :title="isAuthenticated ? '' : 'Log in to delete folders'"
>
  Delete
</button>
```

---

### Phase 3: Configuration & Documentation
**Estimated: 1 hour**

#### Task 3.1: Create Environment Variable Documentation
**File**: `backend/.env.example` (NEW)

```bash
# Authentication
AUTH_PASSWORD=your_secure_password_here

# JWT Configuration
JWT_SECRET=change-this-in-production

# Keycloak OIDC (optional, required only if using Keycloak)
AUTH_KEYCLOAK_URL=http://keycloak:8080/realms/your-realm
AUTH_KEYCLOAK_REALM=your-realm
AUTH_KEYCLOAK_CLIENT_ID=your-client-id
AUTH_KEYCLOAK_CLIENT_SECRET=your-client-secret
AUTH_KEYCLOAK_REDIRECT_URI=http://localhost:5173/callback

# Rest of config...
```

#### Task 3.2: Update Frontend Environment
**File**: `frontend/.env.example` (NEW)

```
# Keycloak OIDC Configuration (if using Keycloak)
VITE_KEYCLOAK_URL=http://localhost:8080/realms/your-realm
VITE_KEYCLOAK_CLIENT_ID=your-client-id
VITE_KEYCLOAK_REDIRECT_URI=http://localhost:5173/callback

# API Base URL
VITE_API_URL=http://localhost:3000
```

#### Task 3.3: Update README
**File**: `README.md`

Add section "Authentication Setup":
- Overview of two auth methods
- Keycloak setup instructions (if using)
- Local password setup instructions
- How to set environment variables
- Docker deployment with auth variables

#### Task 3.4: Update Docker Setup
**File**: `Dockerfile`, `.env`

- Pass auth env vars to backend container
- Document auth variables in compose/deployment files
- Ensure `JWT_SECRET` and `AUTH_PASSWORD` are set

---

## Implementation Order

**Recommended sequence** (dependencies first):

1. **Task 1.1** - Install dependencies
2. **Task 1.2** - Auth service (foundation)
3. **Task 1.3** - Auth middleware
4. **Task 1.4** - Auth routes
5. **Task 1.5** - Integrate into server
6. **Task 1.6** - Protect routes
7. **Task 1.7** - Update config
   - **At this point: Backend is complete, can test with curl/Postman**
8. **Task 2.1** - Frontend auth service
9. **Task 2.2** - Auth composable
10. **Task 2.3** - UI components (LoginButton, LoginModal)
11. **Task 2.4** - API service integration
12. **Task 2.5** - App.vue integration
13. **Task 2.6** - Protect components
    - **At this point: Full auth flow works**
14. **Task 3.1-3.4** - Documentation

---

## Testing Strategy

### Unit Tests (Optional but Recommended)
- `authService.js` - token generation/validation
- `authMiddleware.js` - token extraction and validation

### Manual Testing
1. **Local Auth Flow**:
   - Click Login → enter password → should get token
   - Verify token in localStorage
   - Refresh page → should stay logged in
   - Wait 1 week or manually expire token → should show login again
   - Logout → token cleared

2. **Protected Routes**:
   - Unauthenticated: GET /api/tracks works, POST /api/downloads returns 401
   - Authenticated: Both work

3. **Keycloak Flow** (if implemented):
   - Click Login → click "Keycloak" → redirects to Keycloak
   - Login in Keycloak → redirects back to app
   - Token received and stored
   - Works like local auth after that

4. **UI**:
   - Login button visible in header
   - ManageLibrary, Folders, Download buttons disabled when not logged in
   - Appropriate messages shown to unauthenticated users

---

## Risk Mitigation

| Risk | Mitigation |
|------|-----------|
| Token in localStorage vulnerable to XSS | Ensure app escapes all user input, use Security headers |
| Hardcoded JWT secret in code | Use env variable, fail loudly if not set in prod |
| Keycloak connectivity issues | Graceful fallback to local auth, clear error messages |
| Token expiry during long sessions | Show warning at 1 hour remaining, force re-login after |
| CORS issues with Keycloak | Pre-test CORS headers, document Keycloak CORS config |
| Accidental exposure of credentials in logs | Ensure passwords/tokens never logged, sanitize logs |

---

## Success Criteria

- [x] All protected endpoints return 401 without valid token
- [x] Local password auth creates and validates JWT correctly
- [x] Frontend stores token and sends it with all requests
- [x] Unauthenticated users can play music but not manage library/folders
- [x] Login modal works with password entry
- [x] Logout clears token and session
- [x] Token expiration after 1 week forces re-login
- [x] Documentation complete and clear
- [x] Docker deployment includes auth env vars
- [x] Keycloak callback flow works (if implemented)

---

## Estimated Total Time
- Backend: 3-4 hours
- Frontend: 3-4 hours
- Configuration & Docs: 1 hour
- **Total: 7-9 hours**
- Testing & Bug Fixes: 2-3 hours (not included above)

---

## Library Recommendations

### JWT Library
**jsonwebtoken** - Most popular, well-maintained, simple API
```javascript
import jwt from 'jsonwebtoken';
jwt.sign({ authenticated: true }, secret, { expiresIn: '7d' });
jwt.verify(token, secret);
```

### Keycloak OIDC (if needed)
**openid-client** - Lighter than keycloak-connect, works with any OIDC server
- Simpler for our use case (we don't need advanced Keycloak features)
- Can validate Keycloak tokens without extra dependencies

Alternative: **keycloak-connect** - More features, heavier, might be overkill

**Recommendation**: Start with **jsonwebtoken** + manual Keycloak token verification via their public key endpoint. Add library later if complexity grows.
