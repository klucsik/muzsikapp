import { Server } from 'socket.io';
import logger from '../utils/logger.js';
import config from '../config/config.js';
import SyncController from './syncController.js';
import roomStateManager from './roomState.js';

let io = null;
let syncController = null;
const connectedClients = new Map();

/**
 * Tell a socket which playlist it should load.
 *
 * Deliberately the same shape as the mutation broadcast in routes/collections.js: sending the
 * track rows here capped the playlist at 1000 entries and shipped per-fragment playback metadata
 * to every connection, while the client's handler ignored the array form altogether and refetched
 * over HTTP anyway.
 */
function sendPlaylistSignal(socket, collectionId, roomId) {
  socket.emit('playlist_update', roomId ? { collectionId, roomId } : { collectionId });
}

/**
 * Initialize WebSocket server
 */
export function initWebSocket(httpServer) {
  // Create Socket.io server
  io = new Server(httpServer, {
    cors: {
      origin: '*', // TODO: Configure for production
      methods: ['GET', 'POST'],
    },
    pingInterval: config.wsPingInterval,
    pingTimeout: config.wsPingTimeout,
  });

  // Initialize sync controller
  syncController = new SyncController(io);
  syncController.init();

  // Connection handler
  io.on('connection', (socket) => {
    const clientId = socket.id;
    
    logger.info({ clientId }, 'Client connected');
    
    // Store client info
    connectedClients.set(clientId, {
      id: clientId,
      connectedAt: Date.now(),
      userAgent: socket.handshake.headers['user-agent'],
    });

    // Join default room (room-1)
    const defaultRoom = roomStateManager.getDefaultRoom();
    socket.join(defaultRoom.id);
    roomStateManager.joinRoom(clientId, defaultRoom.id);
    
    logger.info({ clientId, roomId: defaultRoom.id }, 'Client joined default room');

    // Send current state to new client
    socket.emit('state_sync', syncController.getState(defaultRoom.id));
    
    // Point the client at this room's playlist; it loads the rows itself
    sendPlaylistSignal(socket, defaultRoom.playlistCollectionId, defaultRoom.id);
    
    // Send room info
    socket.emit('room_joined', {
      roomId: defaultRoom.id,
      roomNumber: defaultRoom.number,
      clientCount: roomStateManager.getRoomClientCount(defaultRoom.id),
    });
    
    // Send all rooms info
    socket.emit('rooms_info', roomStateManager.getAllRooms());
    
    logger.debug({ clientId, roomId: defaultRoom.id, collectionId: defaultRoom.playlistCollectionId }, 'Sent initial state to new client');

    // Handle room join request
    socket.on('join_room', (data) => {
      const { roomId } = data;
      
      try {
        if (!roomStateManager.roomExists(roomId)) {
          socket.emit('error', { message: `Room ${roomId} does not exist` });
          return;
        }

        // Leave current room
        const oldRoomId = roomStateManager.getClientRoomId(clientId);
        if (oldRoomId) {
          socket.leave(oldRoomId);
        }

        // Join new room
        socket.join(roomId);
        const room = roomStateManager.joinRoom(clientId, roomId);

        logger.info({ clientId, roomId, oldRoomId }, 'Client switched rooms');

        // Send room state to client
        socket.emit('state_sync', syncController.getState(roomId));
        
        // Point the client at the room's playlist
        sendPlaylistSignal(socket, room.playlistCollectionId, roomId);
        
        // Confirm room join
        socket.emit('room_joined', {
          roomId: room.id,
          roomNumber: room.number,
          clientCount: roomStateManager.getRoomClientCount(roomId),
        });

        // Broadcast updated room info to all clients
        io.emit('rooms_info', roomStateManager.getAllRooms());
        
      } catch (error) {
        logger.error({ error, clientId, roomId }, 'Failed to join room');
        socket.emit('error', { message: error.message });
      }
    });

    // Handle client requests for current state
    socket.on('request_state', () => {
      const roomId = roomStateManager.getClientRoomId(clientId) || 'room-1';
      logger.debug({ clientId, roomId }, 'Client requested state');
      socket.emit('state_sync', syncController.getState(roomId));
      
      // Same signal as a mutation broadcast, so reconnecting clients take one code path
      const room = roomStateManager.getRoom(roomId);
      sendPlaylistSignal(socket, room.playlistCollectionId, roomId);
    });

    // Handle position reports from clients
    socket.on('position_report', (data) => {
      const roomId = roomStateManager.getClientRoomId(clientId) || 'room-1';
      syncController.handlePositionReport(clientId, roomId, data);
    });

    // Handle client errors
    socket.on('client_error', (data) => {
      const roomId = roomStateManager.getClientRoomId(clientId) || 'room-1';
      syncController.handleClientError(clientId, roomId, data);
    });

    // Handle track ended event from client
    socket.on('track_ended', () => {
      const roomId = roomStateManager.getClientRoomId(clientId) || 'room-1';
      logger.info({ clientId, roomId }, 'Client reported track ended');
      syncController.handleTrackEnded(clientId, roomId);
    });

    // Handle disconnection
    socket.on('disconnect', (reason) => {
      logger.info({ clientId, reason }, 'Client disconnected');
      
      // Leave room
      const roomId = roomStateManager.leaveRoom(clientId);
      if (roomId) {
        // Broadcast updated room info to all clients
        io.emit('rooms_info', roomStateManager.getAllRooms());
      }
      
      connectedClients.delete(clientId);
    });
  });

  logger.info('WebSocket server initialized');

  return { io, syncController };
}

/**
 * Get Socket.io instance
 */
export function getIO() {
  if (!io) {
    throw new Error('WebSocket not initialized. Call initWebSocket() first.');
  }
  return io;
}

/**
 * Get sync controller instance
 */
export function getSyncController() {
  if (!syncController) {
    throw new Error('WebSocket not initialized. Call initWebSocket() first.');
  }
  return syncController;
}

/**
 * Get connected clients info
 */
export function getConnectedClients() {
  return Array.from(connectedClients.values());
}

/**
 * Get client count
 */
export function getClientCount() {
  return connectedClients.size;
}

/**
 * Broadcast library update event to all clients
 */
export function broadcastLibraryUpdate(event) {
  if (io) {
    io.emit('library_update', event);
    logger.debug({ event }, 'Broadcast library update');
  }
}

/**
 * Close WebSocket server
 */
export function closeWebSocket() {
  if (syncController) {
    syncController.cleanup();
  }
  
  if (io) {
    io.close();
    logger.info('WebSocket server closed');
  }
}

export default {
  initWebSocket,
  getIO,
  getSyncController,
  getConnectedClients,
  getClientCount,
  broadcastLibraryUpdate,
  closeWebSocket,
};
