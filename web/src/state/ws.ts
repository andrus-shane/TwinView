import type { ServerMessage } from '@twinview/shared';
import { useStore } from './store';

let socket: WebSocket | null = null;
let retryMs = 500;

export function connectWs(): void {
  // StrictMode double-mounts the boot effect — a second live socket would
  // duplicate every event in the lab feed
  if (socket && socket.readyState <= WebSocket.OPEN) return;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  socket = new WebSocket(`${proto}://${location.host}/ws/twin`);

  socket.onopen = () => {
    retryMs = 500;
    useStore.getState().setConnected(true);
  };

  socket.onmessage = (ev) => {
    const msg = JSON.parse(ev.data) as ServerMessage;
    const store = useStore.getState();
    if (msg.type === 'states') store.setStates(msg.states);
    else if (msg.type === 'event') store.addEvent(msg.event);
    else if (msg.type === 'fleet') store.setFleet(msg.units, msg.events);
    else if (msg.type === 'rig') {
      // model-scoped: the store routes it into rigs[model] (and `rig` if selected)
      store.setRig(msg.rig);
    }
  };

  socket.onclose = () => {
    useStore.getState().setConnected(false);
    setTimeout(connectWs, retryMs);
    retryMs = Math.min(retryMs * 2, 5000);
  };
}
