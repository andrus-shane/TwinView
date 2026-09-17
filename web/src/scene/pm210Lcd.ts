// Emulated console LCD: PM210 dot-matrix (polygons) and IF17/IF20 segment glass (digits + font), one poller.
import { markCanvasFrame } from './canvasFrames';

/** One LCD element from the Renode panel map: polygon, dot or indicator text, bound to ram[a] & m. */
export type PanelElement = { a: number; m: number } & (
  | { P: [number, number][] }
  | { D: [number, number, number] }
  | { T: string; x: number; y: number; fs: number; al?: CanvasTextAlign }
);
/** IF17/IF20 14-segment digit window; segs[i] is font bit i (already de-scrambled by gen_panel_map.py). */
export interface PanelDigit {
  x: number;
  y: number;
  w: number;
  h: number;
  segs: { a: number; m: number }[];
}
export interface PanelKey {
  index: number;
  mask: number;
  label: string;
  /** PM210: speed|incline|transport|workout; IF17/IF20: speed|incline|transport|media; may be absent */
  sec?: string;
}
export interface PanelMap {
  width: number;
  height: number;
  pixels: PanelElement[];
  keys: PanelKey[];
  /** Segment glass (IF17 + IF20) */
  digits?: PanelDigit[];
  font?: Record<string, number>;
  display?: string;
  /** OP bike map — unsupported here (keys go to POST /gpio; third schema) */
  gpiokeys?: unknown;
  punct?: unknown;
}
export interface PanelFrame {
  frame: number;
  dmk: boolean;
  enabled: boolean;
  contrast: number;
  ram: string;
  beep_edges?: number; // PM210
  bpm?: number; // IF17/IF20
}
export type PanelSchema = 'dots' | 'segments' | 'unsupported';

/** Data-driven, never keyed on `display` (only the IF20 sends it), port or model. */
export function panelSchema(pm: PanelMap): PanelSchema {
  if ('gpiokeys' in pm || 'punct' in pm) return 'unsupported'; // the bike map also has digits+font: test first
  if (Array.isArray(pm.digits)) return 'segments';
  return 'dots';
}
export const PANEL_BG: Record<PanelSchema, string> = { dots: '#0a2b66', segments: '#05070a', unsupported: '#05070a' };

async function errorOf(r: Response): Promise<Error> {
  const body = (await r.json().catch(() => ({}))) as { error?: string };
  return new Error(body.error ?? `HTTP ${r.status}`);
}

// static geometry (~190 KB PM210, ~7 KB IF) — fetched once per unit, shared by the LCD and the key panel
const maps = new Map<string, Promise<PanelMap>>();
export function getPanelMap(unitId: string): Promise<PanelMap> {
  let p = maps.get(unitId);
  if (!p) {
    p = fetch(`/api/units/${encodeURIComponent(unitId)}/lcd/panelmap`).then(async (r) => {
      if (!r.ok) throw await errorOf(r);
      return (await r.json()) as PanelMap;
    });
    p.catch(() => maps.delete(unitId));
    maps.set(unitId, p);
  }
  return p;
}

/** Full press (down / 150 ms / up) done server-side — a closed tab can never leave a key latched. */
export async function pressKey(unitId: string, index: number, mask: number): Promise<void> {
  const r = await fetch(`/api/units/${encodeURIComponent(unitId)}/lcd/press`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ index, mask }),
  });
  if (!r.ok) throw await errorOf(r);
}

/**
 * Verbatim port of the Renode reference viewer (PM210UC1601Panel.cs ViewerHtml).
 * Array order is paint order — never sort, filter or dedupe by (a, m). Unlit
 * elements are drawn as a faint ghost so the glass artwork stays visible.
 * Fixed LCD colours on purpose: this is a physical artefact, not themed UI.
 */
function drawDots(g: CanvasRenderingContext2D, pm: PanelMap, ram: string): void {
  g.fillStyle = PANEL_BG.dots;
  g.fillRect(0, 0, pm.width, pm.height);
  for (const px of pm.pixels) {
    const byte = parseInt(ram.substr(px.a * 2, 2), 16);
    const lit = !Number.isNaN(byte) && (byte & px.m) !== 0;
    if (lit) {
      g.fillStyle = '#dff1ff';
      g.shadowColor = '#9cf';
      g.shadowBlur = 5;
    } else {
      g.fillStyle = 'rgba(180,210,255,0.08)';
      g.shadowBlur = 0;
    }
    if ('P' in px) {
      g.beginPath();
      g.moveTo(px.P[0][0], px.P[0][1]);
      for (let i = 1; i < px.P.length; i++) g.lineTo(px.P[i][0], px.P[i][1]);
      g.closePath();
      g.fill();
    } else if ('D' in px) {
      g.beginPath();
      g.arc(px.D[0], px.D[1], px.D[2], 0, 7);
      g.fill();
    } else if ('T' in px) {
      g.shadowBlur = lit ? 4 : 0;
      g.font = `bold ${px.fs}px sans-serif`;
      g.textAlign = 'center';
      g.fillText(px.T, px.x, px.y);
    }
  }
  g.shadowBlur = 0; // leaks into the next draw otherwise
}

// IF17/IF20 reference viewer constants (IF20HT1621Panel.cs / IF17ST7035Panel.cs, identical): fixed LCD colours on purpose
const LIT = '#2fb1ea';
const GHOST = 'rgba(47,177,234,0.07)';
const GLOW = '#59c6f7';
/** 7-segment strokes in a 20x32 unit box (a top, b tr, c br, d bottom, e bl, f tl, g mid) */
const SEGXY: Record<string, [[number, number], [number, number]]> = {
  a: [[5, 3.5], [15, 3.5]],
  b: [[16.5, 5.5], [16.5, 13.5]],
  c: [[16.5, 18.5], [16.5, 26.5]],
  d: [[5, 28.5], [15, 28.5]],
  e: [[3.5, 18.5], [3.5, 26.5]],
  f: [[3.5, 5.5], [3.5, 13.5]],
  g: [[5, 16], [15, 16]],
};
/** char -> 7-seg strokes; chars that need diagonals (M/m) fall back to text */
const SEG7: Record<string, string> = {
  '0': 'abcdef', '1': 'bc', '2': 'abged', '3': 'abgcd', '4': 'fgbc', '5': 'afgcd', '6': 'afgedc', '7': 'abc',
  '8': 'abcdefg', '9': 'abcdfg', A: 'abcefg', b: 'cdefg', C: 'adef', d: 'bcdeg', E: 'adefg', F: 'aefg',
  G: 'acdef', H: 'bcefg', h: 'cefg', I: 'bc', i: 'c', L: 'def', n: 'ceg', o: 'cdeg', P: 'abefg', S: 'afgcd',
  t: 'defg', u: 'cde', '-': 'g',
};
/** 14-seg starburst fallback for patterns outside the driver font (cosmetic; indexed by font bit) */
const SEG14: [[number, number], [number, number]][] = [
  [[2, 0], [18, 0]], [[19, 1], [19, 15]], [[19, 17], [19, 31]], [[2, 32], [18, 32]], [[1, 17], [1, 31]],
  [[1, 1], [1, 15]], [[3, 16], [9, 16]], [[11, 16], [17, 16]], [[4, 2], [9, 14]], [[10, 2], [10, 14]],
  [[16, 2], [11, 14]], [[4, 30], [9, 18]], [[10, 18], [10, 30]], [[16, 30], [11, 18]],
];

const litOf = (ram: string, e: { a: number; m: number }): boolean => {
  const byte = parseInt(ram.substr(e.a * 2, 2), 16);
  return !Number.isNaN(byte) && (byte & e.m) !== 0; // full-byte masks (IF17 uses m=32), NaN = unlit
};

function strokeSeg(
  g: CanvasRenderingContext2D,
  dg: PanelDigit,
  pts: [[number, number], [number, number]],
  color: string,
  widthU: number,
): void {
  const sx = dg.w / 20;
  const sy = dg.h / 32;
  g.strokeStyle = color;
  g.lineCap = 'round';
  g.lineWidth = widthU * sx;
  g.beginPath();
  g.moveTo(dg.x + pts[0][0] * sx, dg.y + pts[0][1] * sy);
  g.lineTo(dg.x + pts[1][0] * sx, dg.y + pts[1][1] * sy);
  g.stroke();
}

// reverse font (14-bit mask -> char), one per panel map
const fontRevs = new WeakMap<PanelMap, Map<number, string>>();
function fontRevOf(pm: PanelMap): Map<number, string> {
  let rev = fontRevs.get(pm);
  if (!rev) {
    rev = new Map(Object.entries(pm.font ?? {}).map(([ch, mask]) => [mask, ch]));
    fontRevs.set(pm, rev);
  }
  return rev;
}

/** Verbatim port of the IF20/IF17 reference viewer draw(d): icons first, then ghost skeleton + lit glyph per digit. */
function drawSegments(g: CanvasRenderingContext2D, pm: PanelMap, ram: string): void {
  g.fillStyle = PANEL_BG.segments;
  g.fillRect(0, 0, pm.width, pm.height);
  for (const px of pm.pixels) {
    const lit = litOf(ram, px);
    if ('D' in px) {
      g.fillStyle = lit ? LIT : GHOST;
      g.shadowColor = GLOW;
      g.shadowBlur = lit ? 8 : 0;
      g.beginPath();
      g.arc(px.D[0], px.D[1], px.D[2], 0, 7);
      g.fill();
    } else if ('T' in px) {
      g.fillStyle = lit ? '#eef7ff' : 'rgba(255,255,255,0.08)';
      g.shadowColor = '#bfe4ff';
      g.shadowBlur = lit ? 6 : 0;
      g.font = `italic bold ${px.fs}px 'Arial Narrow','Helvetica Neue',sans-serif`;
      g.textAlign = px.al ?? 'left';
      g.fillText(px.T, px.x, px.y);
    }
  }
  g.textAlign = 'left';
  g.shadowBlur = 0;
  const fontRev = fontRevOf(pm);
  for (const dg of pm.digits ?? []) {
    for (const s of Object.keys(SEGXY)) strokeSeg(g, dg, SEGXY[s], GHOST, 3.4);
    let val = 0;
    for (let i = 0; i < 14; i++) if (litOf(ram, dg.segs[i])) val |= 1 << i; // segs[i] IS font bit i
    if (val === 0) continue;
    const ch = fontRev.get(val);
    g.shadowColor = GLOW;
    g.shadowBlur = 10;
    if (ch !== undefined && SEG7[ch] !== undefined) {
      for (const s of SEG7[ch]) strokeSeg(g, dg, SEGXY[s], LIT, 3.4);
    } else if (ch !== undefined) {
      // char with no 7-seg shape (M/m): text in the digit window
      g.fillStyle = LIT;
      g.font = `bold ${Math.round(dg.h * 0.8)}px monospace`;
      g.textAlign = 'center';
      g.fillText(ch, dg.x + dg.w / 2, dg.y + dg.h * 0.82);
      g.textAlign = 'left';
    } else {
      for (let i = 0; i < 14; i++) if ((val >> i) & 1) strokeSeg(g, dg, SEG14[i], LIT, 1.6);
    }
    g.shadowBlur = 0;
  }
  g.shadowBlur = 0; // leaks into the next draw otherwise
}

/** Paint one frame at the map's native size; the caller owns background + letterbox. */
export function drawPanel(g: CanvasRenderingContext2D, pm: PanelMap, ram: string): void {
  if (panelSchema(pm) === 'segments') drawSegments(g, pm, ram);
  else drawDots(g, pm, ram);
}

/**
 * Emulated console LCD as a console-screen producer (same duck type as
 * AdbScreen/MockConsole): polls the server's LCD proxy and repaints the canvas
 * only when the emulator frame counter moved.
 */
export class Pm210Lcd {
  readonly canvas: HTMLCanvasElement;
  /** consoleSource id used by App.tsx */
  readonly key: string;
  private g: CanvasRenderingContext2D;
  private pm: PanelMap | null = null;
  private schema: PanelSchema = 'dots';
  private offsetY = 0;
  private lastFrame = -1;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  private generation = 0;

  /** Never true — keeps App's adb tap-through path inert for this source. */
  get hasVideo(): boolean {
    return false;
  }

  constructor(
    readonly unitId: string,
    private hz = 10,
  ) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = 560;
    this.canvas.height = 330;
    this.g = this.canvas.getContext('2d')!;
    this.key = `lcd:${unitId}`;
    this.banner('connecting…');
  }

  /** Re-entrant (StrictMode double-mounts): only the latest generation keeps polling. */
  connect(): void {
    if (this.disposed) return;
    const gen = ++this.generation;
    if (this.timer) clearTimeout(this.timer);
    getPanelMap(this.unitId).then(
      (pm) => {
        if (this.disposed || gen !== this.generation) return;
        this.pm = pm;
        this.schema = panelSchema(pm);
        // Letterbox to ~16:10 BEFORE the first paint: the CAD console quad is sized from the panel
        // bbox (rig.ts) so the 4.3:1 IF glass would be stretched, and GL storage is fixed at the
        // first upload's size (rig.ts reallocates on a canvas resize — once, here).
        const h = Math.max(pm.height, Math.round(pm.width / 1.6));
        this.offsetY = Math.round((h - pm.height) / 2);
        if (this.canvas.width !== pm.width || this.canvas.height !== h) {
          this.canvas.width = pm.width;
          this.canvas.height = h;
        }
        if (this.schema === 'unsupported') {
          this.banner('console not supported (bike)'); // ponytail: third schema + POST /gpio keys, not v1
          return;
        }
        void this.tick(gen);
      },
      (e) => {
        this.banner(`no console: ${(e as Error).message}`);
        if (!this.disposed && gen === this.generation) this.timer = setTimeout(() => this.connect(), 3000);
      },
    );
  }

  /**
   * Complexity: Input n: panel elements (37..1487), k: digits (4), m: segs per digit (14).
   * Time O(n + k*(7 + m)) per changed frame (<= 8 Hz producer, 10 Hz poll, redraw skipped when
   * frame unchanged). Space O(n + |font|) panel map + reverse font cached per unit. Note: canvas
   * fill/stroke dominates. Chained setTimeout after each response (emulator sends
   * Connection: close), never setInterval.
   */
  private async tick(gen: number): Promise<void> {
    if (this.disposed || gen !== this.generation) return;
    try {
      const r = await fetch(`/api/units/${encodeURIComponent(this.unitId)}/lcd/frame`);
      if (!r.ok) {
        this.banner(r.status === 502 ? 'emulator offline' : `no console (HTTP ${r.status})`);
      } else {
        const d = (await r.json()) as PanelFrame;
        if (d.frame !== this.lastFrame) {
          this.lastFrame = d.frame;
          if (!d.enabled) this.banner('display off');
          else {
            this.g.fillStyle = PANEL_BG[this.schema];
            this.g.fillRect(0, 0, this.canvas.width, this.canvas.height);
            this.g.save();
            this.g.translate(0, this.offsetY);
            drawPanel(this.g, this.pm!, d.ram);
            this.g.restore();
            markCanvasFrame(this.canvas);
          }
        }
      }
    } catch {
      /* keep polling */
    }
    if (!this.disposed && gen === this.generation) this.timer = setTimeout(() => void this.tick(gen), 1000 / this.hz);
  }

  private banner(text: string): void {
    const { width: w, height: h } = this.canvas;
    this.g.fillStyle = PANEL_BG[this.schema];
    this.g.fillRect(0, 0, w, h);
    this.g.fillStyle = '#dff1ff';
    this.g.font = 'bold 16px sans-serif';
    this.g.textAlign = 'center';
    this.g.fillText(text, w / 2, h / 2);
    markCanvasFrame(this.canvas);
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
