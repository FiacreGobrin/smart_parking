import { io } from 'socket.io-client';
import { getAccessToken } from './api.js';

let socket = null;

export function connectSocket() {
  if (socket) return socket;
  const url = import.meta.env.VITE_SOCKET_URL || (import.meta.env.VITE_API_BASE_URL || 'http://localhost:5000/api/v1').replace(/\/api\/v1\/?$/, '');
  socket = io(url, {
    // A function so reconnects always present the latest (refreshed) token.
    auth: (cb) => cb({ token: getAccessToken() }),
    transports: ['websocket', 'polling'],
    reconnectionDelayMax: 10000,
  });
  return socket;
}

export function disconnectSocket() {
  socket?.disconnect();
  socket = null;
}

export const getSocket = () => socket;
