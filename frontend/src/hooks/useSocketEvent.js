import { useEffect, useRef } from 'react';
import { getSocket } from '../services/socket.js';

/** Subscribes to a Socket.IO event for the lifetime of the component. */
export function useSocketEvent(event, handler) {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    const s = getSocket();
    if (!s) return undefined;
    const fn = (...args) => ref.current(...args);
    s.on(event, fn);
    return () => s.off(event, fn);
  }, [event]);
}
