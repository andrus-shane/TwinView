import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  BAY_SIZE_DEFAULT,
  BAY_SIZE_MAX,
  BAY_SIZE_MIN,
  DEFAULT_MODEL_BY_KIND,
  DEVICE_CODE_RE,
  MACHINE_KINDS,
  kindForModel,
  type LabBay,
  type LabConsole,
  type LabLayout,
  type LabRow,
  type MachineKind,
} from '@twinview/shared';

/** Bay ids become unit ids, filenames and DOM keys — keep them tame. */
export const BAY_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,23}$/;
const MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const LAYOUT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 _.-]{0,47}$/;
const MAX_BAYS = 200;

export const bayIdFor = (n: number): string => `u${String(n).padStart(2, '0')}`;
export const bayLabelFor = (n: number): string => `Bay ${String(n).padStart(2, '0')}`;

/** Floor order = row-major: what unit ordinals, tablet fill and the fleet list follow. */
export function baysInOrder(layout: LabLayout): LabBay[] {
  return layout.rows.flatMap((r) => r.bays);
}

/** Identity of a console binding — two bays may never share one (a console takes a single master). */
export const consoleKey = (c: LabConsole): string => (c.kind === 'emulator' ? 'emulator' : `ble:${c.code}`);
export const describeConsole = (c: LabConsole): string =>
  c.kind === 'emulator' ? 'the PM210 emulator' : `BLE console ${c.code}`;

export interface SeedOptions {
  size: number;
  rowers: number;
  ellipticals: number;
  pilates: number;
  /** Per-bay CAD model override (unit id → model id) */
  models?: Record<string, string>;
  /** Real-hardware bays keep the kind their sensor config declares */
  realKinds: Map<string, MachineKind>;
  /** Bays pinned to an FP2 console in config (fleet.consoles keys); a console bay is a treadmill */
  consoles?: Record<string, unknown>;
}

/**
 * The pre-layout floor, reproduced exactly: `size` standard bays in a
 * ceil(sqrt(n))-column grid, non-treadmill kinds spread evenly through the
 * floor (never bay 1, never a real-hardware bay). Runs once when lab.json
 * doesn't exist yet, so an existing install keeps the floor it had.
 */
export function seedLayout(opts: SeedOptions): LabLayout {
  const size = Math.max(1, Math.min(MAX_BAYS, Math.floor(opts.size)));
  const realIdx = new Set<number>();
  // real-hardware, console and model-pinned bays keep their kind: the specials go elsewhere
  for (const id of [...opts.realKinds.keys(), ...Object.keys(opts.consoles ?? {}), ...Object.keys(opts.models ?? {})]) {
    const n = Number.parseInt(id.replace(/^u/, ''), 10);
    if (Number.isInteger(n) && n >= 1 && n <= size) realIdx.add(n - 1);
  }
  const kindAt = new Map<number, MachineKind>();
  const specials: MachineKind[] = [
    ...Array<MachineKind>(Math.max(0, opts.rowers)).fill('rower'),
    ...Array<MachineKind>(Math.max(0, opts.ellipticals)).fill('elliptical'),
    ...Array<MachineKind>(Math.max(0, opts.pilates)).fill('pilates'),
  ].slice(0, size - 1);
  specials.forEach((kind, k) => {
    let idx = Math.floor(((k + 1) * size) / (specials.length + 1));
    for (let guard = 0; (kindAt.has(idx) || idx === 0 || realIdx.has(idx)) && guard < size; guard++) {
      idx = (idx + 1) % size || 1;
    }
    if (!kindAt.has(idx) && idx !== 0 && !realIdx.has(idx)) kindAt.set(idx, kind);
  });

  const cols = Math.ceil(Math.sqrt(size));
  const rows: LabRow[] = [];
  for (let i = 0; i < size; i++) {
    const id = bayIdFor(i + 1);
    // a pinned model fixes the kind (fleet.models treadmills never land on a rower slot); the
    // console binding itself is derived from the placed model at run time, not stamped here
    const model = opts.models?.[id];
    const kind =
      opts.realKinds.get(id) ??
      (model ? kindForModel(model) : opts.consoles?.[id] ? 'treadmill' : undefined) ??
      kindAt.get(i) ??
      'treadmill';
    const bay: LabBay = {
      id,
      label: bayLabelFor(i + 1),
      ...BAY_SIZE_DEFAULT,
      machine: { kind, model: model ?? DEFAULT_MODEL_BY_KIND[kind] },
    };
    const r = Math.floor(i / cols);
    if (!rows[r]) rows[r] = { id: `r${r + 1}`, bays: [] };
    rows[r].bays.push(bay);
  }
  return { version: 1, align: 'center', rows };
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * Validate + normalize a client-supplied layout. Returns the clean layout or
 * an error string. Real-hardware bays are coerced to their declared kind —
 * the plant behind a Pi rig is whatever is bolted to it, not a dropdown pick.
 */
export function normalizeLayout(
  input: unknown,
  realKinds: Map<string, MachineKind>,
): { layout: LabLayout } | { error: string } {
  const raw = input as Partial<LabLayout> | null;
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.rows)) {
    return { error: 'layout.rows must be an array' };
  }
  const align = raw.align === 'left' ? 'left' : 'center';
  const bayIds = new Set<string>();
  const rowIds = new Set<string>();
  const consoleOwners = new Map<string, string>(); // console key -> bay id
  const rows: LabRow[] = [];
  let count = 0;
  for (const r of raw.rows as Partial<LabRow>[]) {
    if (!r || typeof r !== 'object' || !Array.isArray(r.bays)) return { error: 'every row needs a bays array' };
    const rowId = typeof r.id === 'string' && BAY_ID_RE.test(r.id) ? r.id : `r${rows.length + 1}`;
    if (rowIds.has(rowId)) return { error: `duplicate row id: ${rowId}` };
    rowIds.add(rowId);
    const bays: LabBay[] = [];
    for (const b of r.bays as Partial<LabBay>[]) {
      if (!b || typeof b !== 'object' || typeof b.id !== 'string' || !BAY_ID_RE.test(b.id)) {
        return { error: 'every bay needs an id (letters, digits, - or _)' };
      }
      if (bayIds.has(b.id)) return { error: `duplicate bay id: ${b.id}` };
      if (++count > MAX_BAYS) return { error: `at most ${MAX_BAYS} bays` };
      bayIds.add(b.id);
      let machine: LabBay['machine'] = null;
      const realKind = realKinds.get(b.id);
      if (b.machine) {
        const m = b.machine as { kind?: unknown; model?: unknown };
        let model = typeof m.model === 'string' && MODEL_ID_RE.test(m.model) ? m.model : '';
        let kind: MachineKind = MACHINE_KINDS.includes(m.kind as MachineKind)
          ? (m.kind as MachineKind)
          : model
            ? kindForModel(model)
            : 'treadmill';
        if (realKind && realKind !== kind) {
          kind = realKind;
          model = '';
        }
        if (!model) model = DEFAULT_MODEL_BY_KIND[kind];
        machine = { kind, model };
      }
      // FP2 console binding: the emulator, or a BLE console by its device code.
      // A console is a treadmill console and takes one master — no sharing.
      let con: LabConsole | null = null;
      const rawCon = (b as { console?: unknown }).console;
      if (rawCon) {
        const c = rawCon as { kind?: unknown; code?: unknown };
        if (c.kind === 'emulator') {
          con = { kind: 'emulator' };
        } else if (c.kind === 'ble') {
          const code = typeof c.code === 'string' ? c.code.trim().toUpperCase() : '';
          if (!DEVICE_CODE_RE.test(code)) {
            return { error: `${b.id}: a BLE device code is 2–8 letters or digits (as shown on the console)` };
          }
          con = { kind: 'ble', code };
        } else {
          return { error: `${b.id}: console kind must be "emulator" or "ble"` };
        }
        if (machine && machine.kind !== 'treadmill') {
          return { error: `${b.id}: an FP2 console drives a treadmill, not a ${machine.kind}` };
        }
        const owner = consoleOwners.get(consoleKey(con));
        if (owner) return { error: `${b.id}: ${describeConsole(con)} is already bound to ${owner}` };
        consoleOwners.set(consoleKey(con), b.id);
      }
      const width = Number(b.width);
      const depth = Number(b.depth);
      bays.push({
        id: b.id,
        label:
          typeof b.label === 'string' && b.label.trim() ? b.label.trim().slice(0, 32) : b.id.toUpperCase(),
        width: Number.isFinite(width)
          ? clamp(Math.round(width * 100) / 100, BAY_SIZE_MIN.width, BAY_SIZE_MAX.width)
          : BAY_SIZE_DEFAULT.width,
        depth: Number.isFinite(depth)
          ? clamp(Math.round(depth * 100) / 100, BAY_SIZE_MIN.depth, BAY_SIZE_MAX.depth)
          : BAY_SIZE_DEFAULT.depth,
        machine,
        ...(con ? { console: con } : {}),
        // display unit of the machine's console/tablet (international unit); mph when absent
        ...((b as { units?: unknown }).units === 'kph' ? { units: 'kph' as const } : {}),
      });
    }
    const row: LabRow = { id: rowId, bays };
    if (typeof r.label === 'string' && r.label.trim()) row.label = r.label.trim().slice(0, 32);
    rows.push(row);
  }
  return { layout: { version: 1, align, rows } };
}

export interface SavedLayoutInfo {
  name: string;
  bays: number;
  units: number;
  savedAt: number;
}

/**
 * Floor persistence. The live floor is lab.json next to config.json,
 * rewritten on every edit so a restart comes back to the same floor; named
 * snapshots ("save this floor for later") live in layouts/<name>.json.
 */
export class LabStore {
  constructor(
    private readonly livePath: string,
    private readonly layoutsDir: string,
  ) {}

  loadLive(): LabLayout | null {
    if (!existsSync(this.livePath)) return null;
    try {
      return JSON.parse(readFileSync(this.livePath, 'utf-8')) as LabLayout;
    } catch (e) {
      console.warn(`[lab] ${this.livePath} unreadable (${e}) — reseeding from config`);
      return null;
    }
  }

  saveLive(layout: LabLayout): void {
    writeFileSync(this.livePath, JSON.stringify(layout, null, 2) + '\n');
  }

  static validName(name: string): boolean {
    return LAYOUT_NAME_RE.test(name);
  }

  private pathFor(name: string): string {
    return join(this.layoutsDir, `${name}.json`);
  }

  list(): SavedLayoutInfo[] {
    if (!existsSync(this.layoutsDir)) return [];
    const out: SavedLayoutInfo[] = [];
    for (const f of readdirSync(this.layoutsDir, { withFileTypes: true })) {
      if (!f.isFile() || !f.name.endsWith('.json')) continue;
      const name = f.name.slice(0, -5);
      if (!LabStore.validName(name)) continue;
      try {
        const raw = JSON.parse(readFileSync(this.pathFor(name), 'utf-8')) as {
          layout?: LabLayout;
          savedAt?: number;
        };
        const bays = raw.layout ? baysInOrder(raw.layout) : [];
        out.push({
          name,
          bays: bays.length,
          units: bays.filter((b) => b.machine).length,
          savedAt: typeof raw.savedAt === 'number' ? raw.savedAt : 0,
        });
      } catch {
        /* skip unreadable files */
      }
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  save(name: string, layout: LabLayout): void {
    mkdirSync(this.layoutsDir, { recursive: true });
    writeFileSync(this.pathFor(name), JSON.stringify({ savedAt: Date.now(), layout }, null, 2) + '\n');
  }

  load(name: string): LabLayout | null {
    const p = this.pathFor(name);
    if (!existsSync(p)) return null;
    const raw = JSON.parse(readFileSync(p, 'utf-8')) as { layout?: LabLayout };
    return raw.layout ?? null;
  }

  delete(name: string): boolean {
    const p = this.pathFor(name);
    if (!existsSync(p)) return false;
    unlinkSync(p);
    return true;
  }
}
