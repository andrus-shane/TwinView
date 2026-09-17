/**
 * FP2 console binding tables + the two pure rules main.ts/fp2.ts need
 * (node:test in consoles.test.ts — main.ts itself cannot be imported).
 */

/** Shipped model -> gateway link (TabletAutoTest config/fp2_consoles.json). fleet.consoles[unitId] overrides. */
export const DEFAULT_CONSOLE_BY_MODEL: Record<string, string> = {
  NTL17915: 'pm210',
  NTL17624: 'if20',
  PFTL59724: 'if17-xylophone',
  PFTL90924: 'if17-esp',
  // ponytail: EBPF30122V2 -> 'op' (bike, :8891 / TCP 3459) waits for a bike MachineKind
};

/** Renode panel HTTP base per emulator link. Server-side only: the browser never learns these hosts. */
export const LCD_BY_LINK: Record<string, string> = {
  pm210: 'http://127.0.0.1:8889',
  'if17-xylophone': 'http://127.0.0.1:8890',
  op: 'http://127.0.0.1:8891',
  if20: 'http://127.0.0.1:8892',
  'if17-esp': 'http://127.0.0.1:8893',
};

/** config.json fleet.consoles value: a link name, or { link, lcd } to pin the panel URL */
export type ConsoleSpec = string | { link: string; lcd?: string };
export interface ConsoleBinding {
  link: string;
  /** Emulator panel base URL; undefined = no LCD (BLE desk console) */
  lcd?: string;
}

/** fleet.consoles[unitId] ?? DEFAULT_CONSOLE_BY_MODEL[model]; the LCD URL follows the link unless pinned. */
export function resolveConsole(
  unitId: string,
  model: string,
  overrides?: Record<string, ConsoleSpec>,
): ConsoleBinding | undefined {
  const spec = overrides?.[unitId] ?? DEFAULT_CONSOLE_BY_MODEL[model];
  if (!spec) return undefined;
  const { link, lcd } = typeof spec === 'string' ? { link: spec, lcd: undefined } : spec;
  return { link, lcd: lcd ?? LCD_BY_LINK[link] };
}

export interface PanelKeyLike {
  index: number;
  mask: number;
  label: string;
}

/**
 * Name a membrane key from an FP2 KEY_ARRAY<n> byte (byteIndex = n - 1). The
 * keypad ANDs every held key's mask into an idle-high 0xFF byte, so a single
 * press equals that key's mask exactly and a chord clears the union of their
 * low lines. Returns null for the idle/release byte 255.
 */
export function nameKey(keys: PanelKeyLike[], byteIndex: number, value: number): string | null {
  if (value === 255) return null;
  const exact = keys.find((k) => k.index === byteIndex && k.mask === value);
  if (exact) return exact.label;
  // ponytail: subset matching can alias between keys, so the exact hit above wins; chords only on a miss
  const chord = keys.filter((k) => k.index === byteIndex && (value & (~k.mask & 0xff)) === 0);
  return chord.length ? chord.map((k) => k.label).join('+') : `KEY_ARRAY${byteIndex + 1}=${value}`;
}
