// Dev helper: pretend to be a Raspberry Pi rig streaming rig-monitor lines over
// TCP, so the TwinView `net` source can be tested without real hardware.
//
//   node tools/fake-rig.mjs [port]      (default 5000)
//
// It's a TCP *server* (Pi-as-server model): TwinView's NetSource dials in and
// this streams `incline.pitch: <deg>`, `incline.grade: <%>` (100*tan(pitch),
// like the Pi firmware) and `tach.mph: <mph>` at 10 Hz, matching the patterns
// in network_sensors.json. Point that config's host at 127.0.0.1
// (or "localhost") while testing, then back to the Pi's .local name for real.

import { createServer } from 'node:net';

const port = Number(process.argv[2] ?? 5000);

const server = createServer((sock) => {
  const peer = `${sock.remoteAddress}:${sock.remotePort}`;
  console.log(`client connected: ${peer}`);
  let t = 0;
  const timer = setInterval(() => {
    t += 0.1;
    const pitchDeg = 2 + 1.5 * Math.sin(t / 3); // slow incline sweep, deg
    const grade = 100 * Math.tan((pitchDeg * Math.PI) / 180); // percent, like the Pi
    const mph = (3 + 2 * Math.sin(t / 5 + 1)).toFixed(2); // belt speed, mph
    // one channel per line, exactly like the rig-monitor sketch / Pi program
    sock.write(`incline.pitch: ${pitchDeg.toFixed(2)}\n`);
    sock.write(`incline.grade: ${grade.toFixed(2)}\n`);
    sock.write(`tach.mph: ${mph}\n`);
  }, 100);
  const done = () => clearInterval(timer);
  sock.on('close', () => {
    done();
    console.log(`client disconnected: ${peer}`);
  });
  sock.on('error', done);
});

server.listen(port, () => console.log(`fake-rig streaming on tcp:${port} (Ctrl+C to stop)`));
