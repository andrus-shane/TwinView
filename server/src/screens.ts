import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import net from 'node:net';
import { promisify } from 'node:util';

const run = promisify(execFile);

const REMOTE_JAR = '/data/local/tmp/twinview-scrcpy-server.jar';

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
  return devices;
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
    if (!/^[\w.:-]+$/.test(this.serial)) throw new Error('invalid device serial');
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
