import type { ChannelId, ConsoleStatus } from '@twinview/shared';
import { nameKey, type PanelKeyLike } from './consoles.js';
import { panelmap } from './pm210.js';
import type { TwinEngine } from './twin.js';
import type { Sample, TelemetrySource } from './sources/types.js';

/**
 * FP2 console bound to a bay, through the TabletAutoTest FP2 gateway
 * (services/fp2_gateway, :8102) — the only FP2 master on the host. TypeScript
 * never speaks FP2 itself: the gateway decodes features/keys into labels.
 *
 * Gateway wire (frozen with the Python side):
 *   WS  ${gateway}/ws/links/${link}
 *     hello {type, name, transport, values, subscribed, product_info}
 *     tick  {type, t (unix s), values, changed: [{feature, value, prev, origin: 'echo'|'console', label}]}
 *     down  {type, error}
 *   POST ${gateway}/v1/links/${link}/write {feature, value}
 *     -> {feature, value, echoed, unchanged, latency_s, final_value, errors}; 409 when the link is not open
 *        (errors = board rejections such as DATA_OUT_OF_RANGE / WRITE_NOT_ALLOWED)
 * Features: TARGET_KPH kph, TARGET_GRADE %, CURRENT_GRADE %, WORKOUT_STATE 0..6,
 * KEY_COOKED int (PM210 + BLE only, labelled by the gateway), KEY_ARRAY1..4 raw bytes
 * (idle 255; named here from the bound panelmap when the console has no KEY_COOKED),
 * SYSTEM_ERROR int, MAX_KPH_LIMIT kph, MAX_GRADE %.
 */

const KPH_PER_MPH = 1.609344;
/** Setpoint change below this (mph / %) is not worth an FP2 write */
const DEADBAND = 0.05;
/** WS reconnect pause after a drop (same as NetSource) */
const RETRY_MS = 3000;
/** Echo differing from the written value by more than this = the console clamped it */
const TOL = 0.02;
const WORKOUT_LABELS = ['none', 'ready', 'warmup', 'running', 'cooldown', 'paused', 'results'];
/** WORKOUT_STATE values in which the console is executing a workout */
const ACTIVE_STATES = [2, 3, 4];
/** A desk-panel target change is a human's intent only this soon after a key edge */
const KEY_INTENT_MS = 3000;
/** Console floats are float32 (14.48 arrives as 14.479999542236328): log them at 2 decimals */
const fmt = (v: number): string => String(Math.round(v * 100) / 100);

interface GatewayChange {
  feature: string;
  value: number;
  prev: number | null;
  origin: 'echo' | 'console';
  label: string | null;
}

type GatewayMessage =
  | {
      type: 'hello';
      name: string;
      transport: string;
      values: Record<string, number>;
      subscribed: string[];
      product_info: Record<string, string>;
    }
  | { type: 'tick'; t: number; values: Record<string, number>; changed: GatewayChange[] }
  | { type: 'down'; error: string };

interface WriteReply {
  echoed: boolean;
  unchanged: boolean;
  latency_s: number | null;
  final_value: number | null;
  errors: { code: number; error: string; data: unknown }[];
}

/**
 * Telemetry source AND commander for one FP2 console. As a source it feeds
 * only `incline` (CURRENT_GRADE). As a commander it mirrors the engine's
 * setpoints out over FP2 and folds console-originated changes back in.
 *
 * ponytail: exclusive source; a bay with both a Pi tach and a console gets this
 * class commander-only (see main.ts) — no merged source.
 */
export class Fp2Console implements TelemetrySource {
  readonly kind = 'fp2' as const;

  private engine!: TwinEngine;
  private ws: WebSocket | null = null;
  private stopped = false;
  private state: ConsoleStatus['link'] = 'connecting';
  private transport: string | null = null;
  private values: Record<string, number> = {};
  private incline: Sample | null = null;
  /** Console targets adopted after hello; outbound writes are gated on this */
  private synced = false;
  private lastSent = { speed: NaN, incline: NaN };
  private wasRunning = false;
  private busy = false;
  private lastKey: string | null = null;
  private lastEchoMs: number | null = null;
  private unreachableLogged = false;
  private connectWarned = false;
  private lastCloseReason: string | null = null;
  private unsub: (() => void) | null = null;
  /** The console publishes KEY_COOKED (PM210, BLE): raw KEY_ARRAY bytes are then redundant */
  private hasCooked = false;
  /** The other panel of a machine/desk pair (see `role`) */
  private peer: Fp2Console | null = null;
  /** WORKOUT_STATE mirrored from the peer panel, written on the next push (serialized with the targets) */
  private wantWorkout: number | null = null;
  /** Our in-flight writes (feature -> value, deadline): their echoes are ours, any other echo is another gateway client's */
  private ownWrites = new Map<string, { value: number; until: number }>();
  /** Last membrane key edge seen on this panel (desk role: target changes count only right after one) */
  private lastKeyAt = 0;

  constructor(
    readonly unitId: string,
    readonly link: string,
    private gateway: string,
    /** Emulator panel base URL when the console is an emulator (names KEY_ARRAY presses); undefined for BLE */
    private lcd: string | undefined,
    private engineOf: () => TwinEngine,
    private automationRunning: () => boolean,
    /** Catalog entry to register with the gateway before connecting; null = in its static catalog */
    private catalog: Record<string, unknown> | null = null,
    /**
     * 'machine' = the console on the treadmill (telemetry + commands). 'desk' = the model's
     * emulator standing in for a real BLE panel: its LCD shows on the unit and its membrane
     * keys drive the machine — key presses become console-origin target/workout changes here,
     * fold into the twin, and the machine console pushes them out. It follows the machine the
     * other way (targets via the twin, START/STOP mirrored directly) and feeds no telemetry.
     */
    private role: 'machine' | 'desk' = 'machine',
  ) {}

  /** Pair this panel with the other half of a machine/desk console pair. */
  setPeer(peer: Fp2Console): void {
    this.peer = peer;
  }

  /** The board's WORKOUT_STATE while the link is up; undefined before hello. */
  workoutState(): number | undefined {
    return this.synced ? this.values.WORKOUT_STATE : undefined;
  }

  /** Queue a WORKOUT_STATE write (START/STOP mirrored from the peer panel). */
  requestWorkoutState(value: number): void {
    this.wantWorkout = value;
  }

  private get tag(): string {
    return this.role === 'desk' ? 'Desk console' : 'Console';
  }

  /** Returns immediately: never delay app.listen on a 46 s BLE connect. */
  async start(): Promise<void> {
    this.engine = this.engineOf();
    // The disarm is correct (twin.ts watchdogTick early-returns without belt_speed) but must not be silent.
    if (this.role === 'machine' && !('belt_speed' in this.engine.getState().channels)) {
      this.engine.logEvent(
        'system',
        'warn',
        'no independent tach on this bay: unattended-motion watchdog disarmed until a net source owns belt_speed',
      );
    }
    this.unsub = this.engine.onState((s) => void this.push(s.running));
    void this.connect();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.unsub?.();
    this.ws?.close();
  }

  /**
   * belt_speed is deliberately never produced: CURRENT_KPH is 0 on the
   * motor-less consoles (desk unit and emulator) and would both fail against
   * the reference plant and disarm the unattended-motion watchdog.
   */
  latest(ch: ChannelId): Sample | null {
    // a desk console is an emulator: nothing it measures is the machine's
    return this.role === 'machine' && ch === 'incline' ? this.incline : null;
  }

  /**
   * Open the gateway stream. A console outside the gateway's static catalog
   * (a BLE console by device code) is registered first — idempotent, so a
   * restarted gateway relearns it on the next retry.
   */
  private async connect(): Promise<void> {
    if (this.stopped) return;
    if (this.catalog) {
      try {
        const r = await fetch(`${this.gateway}/v1/links/${this.link}`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(this.catalog),
        });
        if (!r.ok) {
          const hint = r.status === 405 ? ' — this gateway predates PUT /v1/links; update TabletAutoTest' : '';
          this.connectWarn(`FP2 gateway refused link ${this.link}: HTTP ${r.status}${hint}`);
          this.retryLater();
          return;
        }
      } catch (e) {
        this.connectWarn(`FP2 gateway unreachable: ${String((e as Error).message ?? e)}`);
        this.retryLater();
        return;
      }
    }
    if (this.stopped) return;
    const url = this.gateway.replace(/^http/, 'ws') + `/ws/links/${this.link}`;
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.addEventListener('open', () => console.log(`[fp2] ${this.unitId} -> ${this.link} ws connected`));
    ws.addEventListener('message', (ev) => this.onMessage(JSON.parse(String(ev.data))));
    ws.addEventListener('error', () => {
      /* 'close' always follows */
    });
    ws.addEventListener('close', (ev) => {
      this.state = 'down';
      this.synced = false;
      // 4404/4503: the gateway could not open the link and says why (device not
      // found, fp2_utils missing in its venv...) — surface each new reason once.
      const { code, reason } = ev as { code?: number; reason?: string };
      if (code !== undefined && code >= 4000 && reason && reason !== this.lastCloseReason) {
        this.lastCloseReason = reason;
        this.connectWarned = false;
        this.connectWarn(`FP2 link ${this.link} could not open: ${reason}`);
      }
      this.retryLater();
    });
  }

  private retryLater(): void {
    if (!this.stopped) setTimeout(() => void this.connect(), RETRY_MS);
  }

  /** One warn event per outage, not one per 3 s retry. */
  private connectWarn(msg: string): void {
    this.state = 'down';
    if (this.connectWarned) return;
    this.connectWarned = true;
    this.engine.logEvent('system', 'warn', msg);
  }

  /**
   * Complexity: Input n: FP2 features (<= 18), k: panelmap keys (<= 41). Time
   * O(n) per 100 ms tick, O(k) per raw key edge (nameKey scan); Space O(n)
   * (latest values; the panelmap memo lives in pm210.ts). Tradeoff: onState
   * subscription instead of a second timer. Note: gateway HTTP dominates
   * (write awaits the 2 s echo window).
   */
  private onMessage(m: GatewayMessage): void {
    if (m.type === 'hello') {
      this.state = 'up';
      this.connectWarned = false;
      this.lastCloseReason = null;
      this.transport = m.transport;
      this.values = m.values;
      this.hasCooked = m.subscribed.includes('KEY_COOKED');
      if (this.role === 'machine') {
        // Adopt the console's targets: the machine is the source of truth at
        // connect (a server restart must never write the boot-time {0,0} over a
        // running belt).
        this.engine.setSetpoints({
          speed: (m.values.TARGET_KPH ?? 0) / KPH_PER_MPH,
          incline: m.values.TARGET_GRADE ?? 0,
        });
        // post-clamp, so the first onState tick emits no corrective write
        this.lastSent = { ...this.engine.setpoints };
      } else {
        // Desk console: the emulator's boot-time {0,0} must never reach the machine. Follow
        // the machine instead — its workout state now, its targets on the next push
        // (-Infinity forces that first write; NaN would compare false and never sync).
        const pw = this.peer?.workoutState();
        if (pw !== undefined && pw !== m.values.WORKOUT_STATE) this.wantWorkout = pw;
        this.lastSent = { speed: Number.NEGATIVE_INFINITY, incline: Number.NEGATIVE_INFINITY };
      }
      this.synced = true;
      const info = m.product_info ?? {};
      this.engine.logEvent(
        'system',
        'info',
        `FP2 link ${this.link} up (${m.transport}) ${info.MODEL_NAME ?? ''} ${info.DISPLAY_TYPE ?? ''}`.trim(),
      );
      return;
    }
    if (m.type === 'down') {
      this.state = 'down';
      this.synced = false;
      this.engine.logEvent('system', 'warn', `FP2 link ${this.link} down: ${m.error}`);
      return;
    }
    if (m.type !== 'tick') return;
    this.values = m.values;
    const now = Date.now();
    // Refreshed every gateway tick while the link is up -> fresh; a dead
    // link/gateway goes stale within STALE_MS (staleness == link health).
    if (typeof m.values.CURRENT_GRADE === 'number') {
      this.incline = { t: now, tHost: now, value: m.values.CURRENT_GRADE };
    }
    // A membrane key edge anywhere in this tick (the firmware may list it after the target it changed)
    const keyEdge = m.changed.some(
      (c) =>
        c.origin !== 'echo' &&
        ((c.feature === 'KEY_COOKED' && c.value !== 0) || (/^KEY_ARRAY\d$/.test(c.feature) && c.value !== 255)),
    );
    if (keyEdge) this.lastKeyAt = now;
    for (const c of m.changed) {
      // The gateway tags EVERY write it relayed as an echo, ours or another client's (the FP2
      // matrix run). Ours are already logged by the write reply; anyone else's is a real
      // change of the console's targets and is folded in like a key press, so the twin and the
      // desk console follow an automation run live.
      let via = '';
      if (c.origin === 'echo') {
        const own = this.ownWrites.get(c.feature);
        if (own && Math.abs(own.value - c.value) <= TOL && Date.now() <= own.until) {
          this.ownWrites.delete(c.feature);
          continue;
        }
        via = ' (written through the gateway)';
      }
      const isTarget = c.feature === 'TARGET_KPH' || c.feature === 'TARGET_GRADE';
      // The desk emulator's firmware also changes targets on its own (zeroes them when its
      // workout ends, snaps to steps). Only a human key press on that panel may steer the
      // machine, and never while an automation run owns it — anything else is ignored and the
      // emulator is re-mirrored from the twin on the next push.
      if (isTarget && this.role === 'desk' && (now - this.lastKeyAt > KEY_INTENT_MS || this.automationRunning())) {
        this.lastSent = { speed: Number.NEGATIVE_INFINITY, incline: Number.NEGATIVE_INFINITY };
        this.engine.logEvent('system', 'info', `${this.tag} ${c.feature} changed to ${fmt(c.value)} on its own — ignored`);
        continue;
      }
      if (c.feature === 'TARGET_KPH') {
        const mph = c.value / KPH_PER_MPH;
        this.engine.setSetpoints({ speed: mph });
        this.lastSent.speed = this.engine.setpoints.speed;
        this.engine.logEvent('system', 'info', `${this.tag} set speed ${this.engine.formatSpeed(mph)} (TARGET_KPH ${fmt(c.value)})${via}`);
      } else if (c.feature === 'TARGET_GRADE') {
        this.engine.setSetpoints({ incline: c.value });
        this.lastSent.incline = this.engine.setpoints.incline;
        this.engine.logEvent('system', 'info', `${this.tag} set incline ${fmt(c.value)} %${via}`);
      } else if (c.feature === 'WORKOUT_STATE') {
        this.engine.logEvent('system', 'info', `${this.tag} workout ${c.label ?? c.value}${via}`);
        // Machine <-> desk mirror: START/STOP pressed on either panel reaches the other
        // (its write comes back as an echo there, so this cannot ping-pong).
        this.peer?.requestWorkoutState(c.value);
        // A human STOP on the console aborts the twin's scenario: console-origin only (our own
        // end-of-scenario 5 arrives as an echo and was skipped above), 5 paused / 0 none only —
        // never 6 results, or a run that just finished on its own would be reported as aborted.
        if ((c.value === 5 || c.value === 0) && ACTIVE_STATES.includes(c.prev ?? -1) && this.engine.getState().running) {
          this.engine.stopScenario(); // real bays have auto=false, so Fleet.takeOver would be a no-op here
          this.engine.logEvent('system', 'warn', 'Console stopped workout - scenario aborted');
        }
      } else if (c.feature === 'KEY_COOKED' && c.value !== 0) {
        this.lastKey = c.label ?? String(c.value);
        this.engine.logEvent('system', 'info', `${this.tag} key ${this.lastKey}`);
      } else if (!this.hasCooked && /^KEY_ARRAY\d$/.test(c.feature) && c.value !== 255) {
        void this.nameRawKey(Number(c.feature.slice(9)) - 1, c.value);
      } else if (c.feature === 'SYSTEM_ERROR' && c.value !== 0) {
        this.engine.logEvent('system', 'warn', `Console SYSTEM_ERROR ${c.value}`);
      }
    }
  }

  /** IF17/IF20 consoles have no KEY_COOKED: name the membrane byte from the bound emulator's panel map. */
  private async nameRawKey(byteIndex: number, value: number): Promise<void> {
    const pm = this.lcd ? ((await panelmap(this.lcd).catch(() => null)) as { keys?: PanelKeyLike[] } | null) : null;
    const label = nameKey(pm?.keys ?? [], byteIndex, value);
    if (label === null) return;
    this.lastKey = label;
    this.engine.logEvent('system', 'info', `${this.tag} key ${label}`);
  }

  /**
   * Outbound mirror. onState fires at the end of every 100 ms tick, AFTER
   * scenario playback replaced engine.setpoints, so all four setpoint write
   * sites (operator API, playback, scenario stop, scenario complete) are seen.
   *
   * Complexity: Input n: FP2 features (<= 14). Time O(1) per tick (two axis
   * compares); Space O(1). Tradeoff: onState subscription instead of a second
   * timer. Note: gateway HTTP dominates (each write awaits the 2 s echo window,
   * `busy` drops ticks meanwhile).
   */
  private async push(running: boolean): Promise<void> {
    if (!this.synced || this.busy || this.ws?.readyState !== WebSocket.OPEN) return;
    // An automation run already drives the machine (taps or FP2): never two masters. The
    // desk console has no machine behind it, so it keeps mirroring what the run commands.
    if (this.role === 'machine' && this.automationRunning()) return;
    this.busy = true;
    try {
      let ws = this.values.WORKOUT_STATE ?? 0;
      // START/STOP mirrored from the peer panel goes first: targets need an active workout
      if (this.wantWorkout !== null) {
        const want = this.wantWorkout;
        this.wantWorkout = null;
        if (want !== ws) {
          await this.write('WORKOUT_STATE', want);
          ws = want;
        }
      }
      if (running && !this.wasRunning && !ACTIVE_STATES.includes(ws)) {
        await this.write('WORKOUT_STATE', 3);
        ws = 3;
      }
      // ponytail: WORKOUT_STATE 5 (pause) on scenario end; change to 0 if the demo wants results
      if (!running && this.wasRunning && ACTIVE_STATES.includes(ws)) {
        await this.write('WORKOUT_STATE', 5);
        ws = 5;
      }
      this.wasRunning = running;
      // A board rejects targets outside a workout. The desk console mirrors them only while
      // active (silently); the machine console keeps writing — a slider moved against an
      // idle machine is worth the warn event.
      if (this.role === 'desk' && !ACTIVE_STATES.includes(ws)) return;
      const sp = this.engine.setpoints; // read fresh: playback replaces the object every tick
      if (Math.abs(sp.speed - this.lastSent.speed) > DEADBAND) {
        this.lastSent.speed = sp.speed;
        await this.write('TARGET_KPH', this.clampKph(sp.speed * KPH_PER_MPH));
      }
      if (Math.abs(sp.incline - this.lastSent.incline) > DEADBAND) {
        this.lastSent.incline = sp.incline;
        await this.write('TARGET_GRADE', this.clampGrade(sp.incline));
      }
    } finally {
      this.busy = false;
    }
  }

  private clampKph(kph: number): number {
    const max = this.values.MAX_KPH_LIMIT ?? 0;
    if (max > 0 && kph > max) {
      this.engine.logEvent('system', 'warn', `FP2 TARGET_KPH ${kph.toFixed(2)} clamped to console MAX_KPH_LIMIT ${max}`);
      kph = max;
    }
    return Math.round(kph * 100) / 100;
  }

  private clampGrade(g: number): number {
    const max = this.values.MAX_GRADE ?? 0;
    if (max > 0 && g > max) {
      this.engine.logEvent('system', 'warn', `FP2 TARGET_GRADE ${g} clamped to console MAX_GRADE ${max}`);
      g = max;
    }
    return Math.round(g * 100) / 100;
  }

  private async write(feature: string, value: number): Promise<void> {
    // the gateway's echo window is 5 s; a little longer here so a late tick still matches
    this.ownWrites.set(feature, { value, until: Date.now() + 6000 });
    try {
      const r = await fetch(`${this.gateway}/v1/links/${this.link}/write`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ feature, value }),
      });
      if (!r.ok) {
        this.engine.logEvent('system', 'warn', `FP2 ${feature}=${value} rejected: HTTP ${r.status}`);
        return;
      }
      const j = (await r.json()) as WriteReply;
      this.unreachableLogged = false;
      if (j.errors?.length) {
        this.engine.logEvent(
          'system',
          'warn',
          `FP2 ${feature}=${value} rejected by console: ${j.errors.map((e) => e.error).join(', ')}`,
        );
        return;
      }
      if (j.echoed) {
        this.lastEchoMs = Math.round((j.latency_s ?? 0) * 1000);
        const clamped = j.final_value !== null && Math.abs(j.final_value - value) > TOL;
        this.engine.logEvent(
          'system',
          clamped ? 'warn' : 'info',
          clamped
            ? `FP2 ${feature}=${value} echoed as ${j.final_value} (console clamped)`
            : `FP2 ${feature}=${value} echoed in ${this.lastEchoMs} ms`,
        );
      } else if (j.unchanged) {
        this.engine.logEvent('system', 'info', `FP2 ${feature}=${value} unchanged (console already there)`);
      } else {
        this.engine.logEvent(
          'system',
          'warn',
          `FP2 ${feature}=${value} not echoed in 2 s (console reads ${j.final_value}; workout ${
            this.values.WORKOUT_STATE ?? '?'
          })`,
        );
      }
    } catch (e) {
      if (!this.unreachableLogged) {
        this.unreachableLogged = true;
        this.engine.logEvent('system', 'warn', `FP2 gateway unreachable: ${String((e as Error).message ?? e)}`);
      }
    }
  }

  /** Decorated into TwinState.console by main.ts (10 Hz states batch + /api/units/:id/state). */
  status(): ConsoleStatus {
    const w = this.values.WORKOUT_STATE;
    const kph = this.values.TARGET_KPH;
    return {
      link: this.state,
      transport: this.transport,
      workoutState: w ?? null,
      workoutLabel: w === undefined ? null : WORKOUT_LABELS[w] ?? `state ${w}`,
      targetMph: kph === undefined ? null : Math.round((kph / KPH_PER_MPH) * 100) / 100,
      targetGrade: this.values.TARGET_GRADE ?? null,
      lastKey: this.lastKey,
      lastEchoMs: this.lastEchoMs,
    };
  }
}
