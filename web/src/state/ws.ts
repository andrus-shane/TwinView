import type { ServerMessage } from '@twinview/shared';
import { appendHistory, useStore } from './store';

let socket: WebSocket | null = null;
let retryMs = 500;

export function connectWs(): void {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  socket = new WebSocket(`${proto}://${location.host}/ws/twin`);

  socket.onopen = () => {
    retryMs = 500;
    useStore.getState().setConnected(true);
  };

  socket.onmessage = (ev) => {
    const msg = JSON.parse(ev.data) as ServerMessage;
    if (msg.type === 'state') {
      appendHistory(msg.state);
      useStore.getState().setTwin(msg.state);
    } else if (msg.type === 'rig') {
      useStore.getState().setRig(msg.rig);
    }
  };

  socket.onclose = () => {
    useStore.getState().setConnected(false);
    setTimeout(connectWs, retryMs);
    retryMs = Math.min(retryMs * 2, 5000);
  };
}
