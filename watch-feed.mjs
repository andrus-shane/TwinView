// Console view of what the TwinView server is actually publishing for the
// hardware unit (bay 1): the sensor channels after serial ingest + twin engine.
// Usage: node watch-feed.mjs [ws://host:port/ws/twin]
// The raw serial side of the same data is watch-inclinometer.ps1 in the
// Arduino workspace — but COM11 is exclusive, so it only works with the
// TwinView server stopped.
import WebSocket from 'ws';

const URL = process.argv[2] ?? 'ws://127.0.0.1:8720/ws/twin';

function fmt(r) {
  if (!r) return 'n/a';
  return `cmd=${r.cmd?.toFixed(2)} meas=${r.meas?.toFixed(2)}${r.unit} [${r.status}]`;
}

function connect() {
  const ws = new WebSocket(URL);
  let sawOpen = false;

  ws.on('open', () => {
    sawOpen = true;
    console.log(`\nconnected to ${URL} — Ctrl+C quits`);
  });

  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }

    if (msg.type === 'fleet') {
      const u = msg.units?.[0];
      console.log(`bay 1: ${u?.id} ${u?.kind} model=${u?.model} source=${u?.source}`);
    } else if (msg.type === 'states') {
      const s = msg.states;
      const u01 = Array.isArray(s) ? s[0] : (s?.u01 ?? Object.values(s ?? {})[0]);
      const ch = u01?.channels ?? {};
      const ts = new Date(u01?.t ?? Date.now()).toTimeString().slice(0, 8);
      process.stdout.write(
        `\r[${ts}] incline ${fmt(ch.incline)}  |  belt ${fmt(ch.belt_speed)}      `,
      );
    } else if (msg.type === 'event' && JSON.stringify(msg).includes('"u01"')) {
      console.log(`\nEVENT: ${JSON.stringify(msg)}`);
    }
  });

  ws.on('error', (e) => {
    if (!sawOpen) process.stdout.write(`\rwaiting for server... (${e.message})      `);
  });
  ws.on('close', () => {
    if (sawOpen) console.log('\ndisconnected — reconnecting in 2 s');
    setTimeout(connect, 2000);
  });
}

connect();
