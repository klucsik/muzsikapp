// API base URL - defaults to current origin for bundled deployment
const API_BASE_URL = import.meta.env.VITE_API_URL || '';

// Import auth service for token retrieval
import { getToken } from './authService.js';

/**
 * API client for backend communication
 */
class ApiClient {
  constructor(baseUrl) {
    this.baseUrl = baseUrl;
    this.authErrorCallback = null;
  }
  
  /**
   * Set callback for auth errors (401/403)
   */
  onAuthError(callback) {
    this.authErrorCallback = callback;
  }

  async request(endpoint, options = {}) {
    const url = `${this.baseUrl}${endpoint}`;
    
    // Add auth token if available
    const token = getToken();
    const headers = {
      'Content-Type': 'application/json',
      ...options.headers,
    };
    
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }
    
    const config = {
      headers,
      ...options,
    };

    try {
      const response = await fetch(url, config);
      
      // Handle authentication errors
      if (response.status === 401 || response.status === 403) {
        const errorData = await response.json().catch(() => ({ error: 'Authentication required' }));
        
        if (this.authErrorCallback) {
          this.authErrorCallback(response.status, errorData);
        }
        
        throw new Error(errorData.message || errorData.error || 'Authentication required');
      }
      
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      // Handle 204 No Content and other empty responses
      if (response.status === 204 || response.headers.get('content-length') === '0') {
        return null;
      }

      return await response.json();
    } catch (error) {
      console.error('API request failed:', error);
      throw error;
    }
  }

  // Tracks
  async getTracks(params = {}) {
    const queryString = new URLSearchParams(params).toString();
    return this.request(`/api/tracks${queryString ? `?${queryString}` : ''}`);
  }

  async getTrack(id) {
    return this.request(`/api/tracks/${id}`);
  }

  async searchTracks(query) {
    return this.getTracks({ search: query });
  }

  async updateTrack(id, updates) {
    return this.request(`/api/tracks/${id}`, {
      method: 'PUT',
      body: JSON.stringify(updates),
    });
  }

  async deleteTrack(id) {
    return this.request(`/api/tracks/${id}`, {
      method: 'DELETE',
    });
  }

  // Collections (Unified API)
  async getCollections(type = null, parentId = null) {
    const params = {};
    if (type) params.type = type;
    if (parentId !== null) params.parent_id = parentId;
    const queryString = new URLSearchParams(params).toString();
    return this.request(`/api/collections${queryString ? `?${queryString}` : ''}`);
  }

  async getCollection(collectionId) {
    return this.request(`/api/collections/${collectionId}`);
  }

  async getCollectionTracks(collectionId, limit = 50, offset = 0) {
    return this.request(`/api/collections/${collectionId}/tracks?limit=${limit}&offset=${offset}`);
  }

  async createCollection(name, type, parentId = null, sortOrder = 0, isOrdered = true) {
    return this.request('/api/collections', {
      method: 'POST',
      body: JSON.stringify({
        name,
        type,
        parent_id: parentId,
        sort_order: sortOrder,
        is_ordered: isOrdered ? 1 : 0
      }),
    });
  }

  async updateCollection(collectionId, updates) {
    return this.request(`/api/collections/${collectionId}`, {
      method: 'PUT',
      body: JSON.stringify(updates),
    });
  }

  async deleteCollection(collectionId) {
    return this.request(`/api/collections/${collectionId}`, {
      method: 'DELETE',
    });
  }

  async addTrackToCollection(collectionId, trackId, position = null) {
    return this.request(`/api/collections/${collectionId}/tracks`, {
      method: 'POST',
      body: JSON.stringify({ track_id: trackId, position }),
    });
  }

  async removeTrackFromCollection(collectionId, trackId, position = null) {
    const url = position !== null 
      ? `/api/collections/${collectionId}/tracks/${trackId}?position=${position}`
      : `/api/collections/${collectionId}/tracks/${trackId}`;
    
    return this.request(url, {
      method: 'DELETE',
    });
  }

  async reorderTrackInCollection(collectionId, trackId, position) {
    return this.request(`/api/collections/${collectionId}/tracks/${trackId}/position`, {
      method: 'PUT',
      body: JSON.stringify({ position }),
    });
  }

  async clearCollectionTracks(collectionId) {
    return this.request(`/api/collections/${collectionId}/tracks`, {
      method: 'DELETE',
    });
  }

  // Playback
  async playTrack(trackId, startPosition = 0, roomId = 'room-1', playlistIndex = null) {
    return this.request('/api/playback/play', {
      method: 'POST',
      body: JSON.stringify({ trackId, startPosition, roomId, playlistIndex }),
    });
  }

  async pause(roomId = 'room-1') {
    return this.request('/api/playback/pause', { 
      method: 'POST',
      body: JSON.stringify({ roomId }),
    });
  }

  async resume(roomId = 'room-1') {
    return this.request('/api/playback/resume', { 
      method: 'POST',
      body: JSON.stringify({ roomId }),
    });
  }

  async stop(roomId = 'room-1') {
    return this.request('/api/playback/stop', { 
      method: 'POST',
      body: JSON.stringify({ roomId }),
    });
  }

  async next(roomId = 'room-1') {
    return this.request('/api/playback/next', { 
      method: 'POST',
      body: JSON.stringify({ roomId }),
    });
  }

  async previous(roomId = 'room-1') {
    return this.request('/api/playback/previous', { 
      method: 'POST',
      body: JSON.stringify({ roomId }),
    });
  }

  async seek(position, roomId = 'room-1') {
    return this.request('/api/playback/seek', {
      method: 'POST',
      body: JSON.stringify({ position, roomId }),
    });
  }

  async toggleRepeat(roomId = 'room-1') {
    return this.request('/api/playback/repeat', { 
      method: 'POST',
      body: JSON.stringify({ roomId }),
    });
  }

  async toggleLoop(roomId = 'room-1') {
    return this.request('/api/playback/loop', { 
      method: 'POST',
      body: JSON.stringify({ roomId }),
    });
  }

  async setLoopPoints(loopStart, loopEnd, roomId = 'room-1') {
    return this.request('/api/playback/loop-points', {
      method: 'POST',
      body: JSON.stringify({ loopStart, loopEnd, roomId }),
    });
  }

  async clearLoopPoints(roomId = 'room-1') {
    return this.request('/api/playback/loop-points', {
      method: 'DELETE',
      body: JSON.stringify({ roomId }),
    });
  }

  async getPlaybackState(roomId = 'room-1') {
    return this.request(`/api/playback/state?roomId=${roomId}`);
  }

  // System
  async getConfig() {
    return this.request('/api/config');
  }

  async getStats() {
    return this.request('/api/stats');
  }

  async getClients() {
    return this.request('/api/clients');
  }

  // Audio stream URL
  getAudioUrl(trackId) {
    // If baseUrl is empty, use relative path
    const base = this.baseUrl || '';
    return `${base}/audio/${trackId}`;
  }

  // YouTube Downloads
  async searchYouTube(query, limit = 10) {
    const params = new URLSearchParams({ q: query, limit: limit.toString() });
    return this.request(`/api/downloads/search?${params}`);
  }

  async getPlaylistInfo(playlistUrl) {
    const params = new URLSearchParams({ url: playlistUrl });
    return this.request(`/api/downloads/playlist?${params}`);
  }

  async addPlaylistDownload(playlistUrl, folderIds = null) {
    const body = { playlistUrl };
    if (folderIds && folderIds.length > 0) {
      body.folder_ids = folderIds;
    }
    return this.request('/api/downloads/playlist', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }

  async addDownloadJob(youtubeUrl, folderIds = null) {
    const body = { youtubeUrl };
    if (folderIds && folderIds.length > 0) {
      body.folder_ids = folderIds;
    }
    return this.request('/api/downloads', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }

  async addDownloadFromSearch(searchResult) {
    return this.request('/api/downloads/from-search', {
      method: 'POST',
      body: JSON.stringify(searchResult),
    });
  }

  async getDownloadJobs(limit = 50, offset = 0, status = null) {
    const params = { limit: limit.toString(), offset: offset.toString() };
    if (status) params.status = status;
    const queryString = new URLSearchParams(params).toString();
    return this.request(`/api/downloads?${queryString}`);
  }

  async getDownloadJob(jobId) {
    return this.request(`/api/downloads/${jobId}`);
  }

  async getDownloadQueueStatus() {
    return this.request('/api/downloads/queue/status');
  }

  async cancelDownloadJob(jobId) {
    return this.request(`/api/downloads/${jobId}`, {
      method: 'DELETE',
    });
  }

  async retryDownloadJob(jobId) {
    return this.request(`/api/downloads/${jobId}/retry`, {
      method: 'POST',
    });
  }

  async deleteDownloadJob(jobId) {
    return this.request(`/api/downloads/${jobId}/delete`, {
      method: 'POST',
    });
  }

  async clearCompletedJobs() {
    return this.request('/api/downloads/clear/completed', {
      method: 'POST',
    });
  }

  async clearAllJobs() {
    return this.request('/api/downloads/clear/all', {
      method: 'POST',
    });
  }
}

export const api = new ApiClient(API_BASE_URL);
export default api;
