import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import net from 'node:net';
import { promisify } from 'node:util';

const run = promisify(execFile);

const REMOTE_JAR = '/data/local/tmp/twinview-scrcpy-server.jar';

/** adb serials: USB serials plus host:port network endpoints */
export const SERIAL_RE = /^[\w.:-]+$/;

/**
 * Encoder settings per stream use. Fixed server-side profiles rather than
 * client-supplied numbers, so a page can't ask 20 devices for full-rate video.
 */
export const STREAM_PROFILES = {
  /** Focused unit: readable and fluid (scrcpy's default 8 Mbps bitrate). */
  unit: { maxSize: 1024, maxFps: 30, bitRate: 0 },
  /** Lab wall: ~20 concurrent consoles at glance fidelity — H.264 deltas at
   * this size/fps make an idle screen nearly free. */
  lab: { maxSize: 480, maxFps: 2, bitRate: 300_000 },
} as const;

export type StreamProfileId = keyof typeof STREAM_PROFILES;

export function isStreamProfile(v: string): v is StreamProfileId {
  return v in STREAM_PROFILES;
}

export interface ScreenDevice {
  serial: string;
  product: string;
  model: string;
  /** Hardware serial, resolved for network (host:port) transports like the Pi USB bridge */
  hwSerial?: string;
}

interface ScrcpyInstall {
  adb: string;
  server: string;
  version: string;
}

let install: ScrcpyInstall | null | undefined;

/** Locate scrcpy-server + adb: explicit config dir, PATH, then the winget install. */
async function findScrcpy(configDir?: string): Promise<ScrcpyInstall | null> {
  const dirs: string[] = [];
  if (configDir) dirs.push(configDir);
  try {
    const { stdout } = await run(process.platform === 'win32' ? 'where.exe' : 'which', ['scrcpy']);
    const exe = stdout.split(/\r?\n/)[0].trim();
    if (exe) dirs.push(dirname(exe));
  } catch {
    /* not on PATH */
  }
  const winget = join(homedir(), 'AppData', 'Local', 'Microsoft', 'WinGet', 'Packages');
  if (existsSync(winget)) {
    for (const pkg of readdirSync(winget).filter((d) => d.startsWith('Genymobile.scrcpy'))) {
      for (const sub of readdirSync(join(winget, pkg))) dirs.push(join(winget, pkg, sub));
    }
  }

  for (const dir of dirs) {
    const server = join(dir, 'scrcpy-server');
    if (!existsSync(server)) continue;
    // adb: prefer PATH (matches the adb server the user's devices are on), else scrcpy's own
    let adb = 'adb';
    try {
      await run(adb, ['version']);
    } catch {
      adb = join(dir, process.platform === 'win32' ? 'adb.exe' : 'adb');
      if (!existsSync(adb)) continue;
    }
    // the server jar refuses to start unless argv[0] matches its build version
    let version = /scrcpy-\w+-v([\d.]+)/.exec(dir)?.[1];
    if (!version) {
      try {
        const { stdout } = await run(join(dir, process.platform === 'win32' ? 'scrcpy.exe' : 'scrcpy'), ['--version']);
        version = /scrcpy ([\d.]+)/.exec(stdout)?.[1];
      } catch {
        /* fall through */
      }
    }
    if (version) return { adb, server, version };
  }
  return null;
}

export async function initScreens(configDir?: string): Promise<boolean> {
  install = await findScrcpy(configDir);
  if (!install) console.warn('screens: scrcpy-server not found; live console streaming disabled');
  return !!install;
}

export async function listScreenDevices(): Promise<ScreenDevice[]> {
  if (!install) return [];
  const { stdout } = await run(install.adb, ['devices', '-l']);
  const devices: ScreenDevice[] = [];
  for (const line of stdout.split(/\r?\n/).slice(1)) {
    const m = /^(\S+)\s+device\s+(.*)$/.exec(line.trim());
    if (!m) continue;
    const attr = (key: string) => new RegExp(`${key}:(\\S+)`).exec(m[2])?.[1] ?? '';
    devices.push({ serial: m[1], product: attr('product'), model: attr('model') });
  }
  // A network transport's adb serial is just host:port, which hides the
  // hardware serial the UI labels devices by — ask the device for it.
  await Promise.all(
    devices
      .filter((d) => d.serial.includes(':'))
      .map(async (d) => {
        try {
          const { stdout: sn } = await run(
            install!.adb,
            ['-s', d.serial, 'shell', 'getprop', 'ro.serialno'],
            { timeout: 3000 },
          );
          if (sn.trim()) d.hwSerial = sn.trim();
        } catch {
          /* device dropped mid-list — keep the endpoint serial */
        }
      }),
  );
  return devices;
}

/** Whether adb + scrcpy-server were found (routes gate tap/stream on this). */
export function screensReady(): boolean {
  return !!install;
}

/** Device panel size per serial; an entry is dropped on tap failure so a
 * swapped or re-provisioned display re-resolves on the next tap. */
const sizeCache = new Map<string, { w: number; h: number }>();

async function getDeviceSize(serial: string): Promise<{ w: number; h: number }> {
  const cached = sizeCache.get(serial);
  if (cached) return cached;
  const { stdout } = await run(install!.adb, ['-s', serial, 'shell', 'wm', 'size'], { timeout: 3000 });
  // "Physical size: 1280x800", optionally overridden by "Override size: WxH"
  const m = /Override size:\s*(\d+)x(\d+)/.exec(stdout) ?? /Physical size:\s*(\d+)x(\d+)/.exec(stdout);
  if (!m) throw new Error(`unparseable wm size: ${stdout.trim().slice(0, 80)}`);
  const size = { w: parseInt(m[1], 10), h: parseInt(m[2], 10) };
  sizeCache.set(serial, size);
  return size;
}

/** One in-flight input chain per serial, shallow cap — a stale gesture landing
 * seconds after a rage-click is worse than a dropped one. */
const inputQueues = new Map<string, { chain: Promise<unknown>; pending: number }>();
const INPUT_QUEUE_MAX = 4;

/** `input swipe` duration bounds: below ~50 ms Android tends to drop the
 * gesture; above 2 s it's a press-and-hold-drag nobody meant to send. */
const SWIPE_DUR_MIN = 50;
const SWIPE_DUR_MAX = 2000;

async function queueInput<T>(serial: string, fn: () => Promise<T>): Promise<T> {
  if (!install) throw new Error('adb not available');
  if (!SERIAL_RE.test(serial)) throw new Error('invalid device serial');
  const q = inputQueues.get(serial) ?? { chain: Promise.resolve(), pending: 0 };
  if (q.pending >= INPUT_QUEUE_MAX) throw new Error('too many inputs in flight');
  q.pending++;
  inputQueues.set(serial, q);
  const task = q.chain.then(fn);
  q.chain = task.catch(() => {});
  try {
    return await task;
  } catch (err) {
    sizeCache.delete(serial); // device may have vanished or rotated
    throw err;
  } finally {
    q.pending--;
  }
}

/** Device pixel space for input coordinates. `frame` is the streamed video's
 * dimensions: `wm size` reports the panel's natural orientation while `input`
 * (and the scrcpy frame) follow the current rotation, so when the frame's
 * aspect matches the swapped panel better, the input space is the rotated one. */
async function inputSpace(serial: string, frame?: { w: number; h: number }): Promise<{ w: number; h: number }> {
  let { w, h } = await getDeviceSize(serial);
  if (frame && frame.w > 0 && frame.h > 0) {
    const fr = frame.w / frame.h;
    if (Math.abs(fr - h / w) < Math.abs(fr - w / h)) [w, h] = [h, w];
  }
  return { w, h };
}

const toPx = (n: number, extent: number) => Math.round(Math.min(Math.max(n, 0), 1) * (extent - 1));

/**
 * Send a real tap to a device at a normalized screen position (u,v in [0,1],
 * origin top-left; see inputSpace for the rotation handling of `frame`).
 */
export async function tapDevice(
  serial: string,
  u: number,
  v: number,
  frame?: { w: number; h: number },
): Promise<{ x: number; y: number }> {
  if (!Number.isFinite(u) || !Number.isFinite(v)) throw new Error('u/v must be finite');
  return queueInput(serial, async () => {
    const { w, h } = await inputSpace(serial, frame);
    const x = toPx(u, w);
    const y = toPx(v, h);
    // `input` cold-starts a Java shell on the device — generous timeout
    await run(install!.adb, ['-s', serial, 'shell', 'input', 'tap', String(x), String(y)], {
      timeout: 5000,
    });
    return { x, y };
  });
}

/**
 * Send a real swipe from (u1,v1) to (u2,v2) in normalized screen space,
 * interpolated over durMs. Short durations read as flings, long ones as
 * drags — callers pass the on-screen gesture's real duration to keep the
 * device's momentum behavior matching what the user did.
 */
export async function swipeDevice(
  serial: string,
  u1: number,
  v1: number,
  u2: number,
  v2: number,
  durMs: number,
  frame?: { w: number; h: number },
): Promise<{ x1: number; y1: number; x2: number; y2: number; durMs: number }> {
  if (![u1, v1, u2, v2].every(Number.isFinite)) throw new Error('u/v must be finite');
  const dur = Math.round(Math.min(Math.max(Number.isFinite(durMs) ? durMs : 300, SWIPE_DUR_MIN), SWIPE_DUR_MAX));
  return queueInput(serial, async () => {
    const { w, h } = await inputSpace(serial, frame);
    const args = [toPx(u1, w), toPx(v1, h), toPx(u2, w), toPx(v2, h), dur];
    // `input swipe` blocks for the gesture's duration on top of shell cold-start
    await run(install!.adb, ['-s', serial, 'shell', 'input', 'swipe', ...args.map(String)], {
      timeout: 5000 + dur,
    });
    const [x1, y1, x2, y2] = args;
    return { x1, y1, x2, y2, durMs: dur };
  });
}

type OnData = (chunk: Buffer) => void;
type OnEnd = (reason: string) => void;

/**
 * One raw H.264 stream from scrcpy-server on the device to one consumer.
 * Each viewer gets its own session (own scid/port/encoder) so a fresh
 * SPS/PPS + keyframe always leads the stream — required for mid-run joins.
 */
export class ScreenStream {
  private proc: ChildProcess | null = null;
  private sock: net.Socket | null = null;
  private port = 0;
  private scid = '';
  private closed = false;
  private retried = false;
  private cancelAttempt: (() => void) | null = null;

  constructor(
    private serial: string,
    private profile: StreamProfileId = 'unit',
  ) {}

  async start(onData: OnData, onEnd: OnEnd): Promise<void> {
    if (!install) throw new Error('scrcpy-server not found on this machine (install scrcpy)');
    if (!SERIAL_RE.test(this.serial)) throw new Error('invalid device serial');
    await this.attempt(onData, onEnd);
  }

  private async attempt(onData: OnData, onEnd: OnEnd): Promise<void> {
    const { adb, server, version } = install!;
    // every session: the running server unlinks its own jar at startup
    await run(adb, ['-s', this.serial, 'push', server, REMOTE_JAR]);

    this.scid = Math.floor(Math.random() * 0x7fffffff)
      .toString(16)
      .padStart(8, '0');
    // tcp:0 lets adb pick a free port (it prints the choice) — no collision tracking
    const { stdout } = await run(adb, ['-s', this.serial, 'forward', 'tcp:0', `localabstract:scrcpy_${this.scid}`]);
    this.port = parseInt(stdout.trim(), 10);
    if (!this.port) throw new Error(`adb forward failed: ${stdout}`);

    let cancelled = false;
    this.cancelAttempt = () => (cancelled = true);
    let errTail = '';
    const { maxSize, maxFps, bitRate } = STREAM_PROFILES[this.profile];
    const proc = spawn(adb, [
      '-s', this.serial, 'shell',
      `CLASSPATH=${REMOTE_JAR} app_process / com.genymobile.scrcpy.Server ${version}`,
      `scid=${this.scid}`, 'tunnel_forward=true', 'video=true', 'audio=false', 'control=false',
      'cleanup=true', 'raw_stream=true', 'video_codec=h264',
      `max_size=${maxSize}`, `max_fps=${maxFps}`,
      ...(bitRate > 0 ? [`video_bit_rate=${bitRate}`] : []),
    ]);
    this.proc = proc;
    const tail = (d: Buffer) => {
      const line = d.toString().trim();
      if (line && (!errTail || /ERROR|Exception|Abort/i.test(line))) errTail = line.slice(0, 200);
    };
    proc.stdout?.on('data', tail);
    proc.stderr?.on('data', tail);
    proc.on('exit', () => {
      if (!cancelled && !this.sock && !this.closed) {
        this.fail(onData, onEnd, errTail || 'scrcpy-server exited before streaming');
      }
    });

    // The forward is live immediately, but adb drops the connection until the
    // device-side socket exists; retry until the first video bytes arrive.
    const deadline = Date.now() + 8000;
    const tryConnect = () => {
      if (cancelled || this.closed) return;
      const s = net.connect({ port: this.port, host: '127.0.0.1' });
      let got = false;
      s.once('data', (chunk) => {
        got = true;
        this.sock = s;
        onData(chunk);
        s.on('data', onData);
        s.on('close', () => {
          if (!this.closed) {
            this.closed = true;
            this.cleanup();
            onEnd(errTail || 'device stream ended');
          }
        });
      });
      s.on('error', () => {
        /* handled via close */
      });
      s.on('close', () => {
        if (got || cancelled || this.closed) return;
        if (Date.now() > deadline) this.fail(onData, onEnd, errTail || 'timed out waiting for video stream');
        else setTimeout(tryConnect, 200);
      });
    };
    tryConnect();
  }

  /** An attempt died before streaming. A stale scrcpy-server stuck in accept()
   * on the device makes every new session abort — sweep it and retry once. */
  private fail(onData: OnData, onEnd: OnEnd, reason: string): void {
    if (this.closed) return;
    this.cleanup();
    if (!this.retried) {
      this.retried = true;
      execFile(install!.adb, ['-s', this.serial, 'shell', 'pkill -f com.genymobile.scrcpy'], () => {
        if (this.closed) return;
        this.attempt(onData, onEnd).catch((e: Error) => {
          this.closed = true;
          onEnd(String(e.message).slice(0, 120));
        });
      });
      return;
    }
    this.closed = true;
    onEnd(reason);
  }

  private cleanup(): void {
    this.cancelAttempt?.();
    // killing the local adb process does NOT kill the server on the device; a
    // never-connected server blocks in accept() forever — kill it by its scid
    if (install && !this.sock && this.scid) {
      execFile(install.adb, ['-s', this.serial, 'shell', `pkill -f scid=${this.scid}`], () => {});
    }
    this.sock?.destroy();
    this.sock = null;
    this.proc?.kill();
    this.proc = null;
    if (install && this.port) {
      execFile(install.adb, ['-s', this.serial, 'forward', '--remove', `tcp:${this.port}`], () => {});
      this.port = 0;
    }
  }

  stop(): void {
    if (this.closed) return;
    this.closed = true;
    this.cleanup();
  }
}
