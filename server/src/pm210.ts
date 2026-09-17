import type { FastifyInstance, FastifyReply } from 'fastify';

/**
 * Renode LCD proxy (PM210 dot-matrix and IF17/IF20 segment glasses). The
 * emulators (http://127.0.0.1:8889..8893, see consoles.ts LCD_BY_LINK) serve no
 * CORS headers, so the browser reaches them through these routes, keyed by
 * unit id — the client can never aim the proxy at a host of its own choosing.
 * Schema-agnostic JSON passthrough; the web picks the renderer from the map.
 *
 *   GET  /api/units/:id/lcd/panelmap
 *     PM210:      {width 560, height 330, pixels:[{a, m, P|D|T, ...}], keys:[{index, mask, label, sec}]}
 *     IF17/IF20:  {width 1262, height 292, display?: 'IF20', digits[4]:{x, y, w, h, segs[14]:{a, m}},
 *                  font:{char -> 14-bit mask}, pixels:[{a, m, D|T, al?}], keys:[{index, mask, label, sec}]}
 *   GET  /api/units/:id/lcd/frame
 *     PM210:      {frame, beep_edges, dmk, enabled, contrast, ram: <1320 hex chars>}
 *     IF17/IF20:  {frame, bpm, dmk, enabled, contrast, ram: <64 hex chars>}
 *     (a lit element is ram[a] & m in both)
 *   POST /api/units/:id/lcd/press {index, mask} -> {ok} (down, 150 ms, up — always released)
 *     index 0..4 covers PM210 (0..3), IF20 (0), IF17 xylophone (0..1) and IF17 esp (0..2)
 */

/** How long a proxied key press is held before release */
const PRESS_MS = 150;

/** Static geometry (~187 KB): one fetch per emulator URL per process; dropped on failure so it retries */
const panelmaps = new Map<string, Promise<unknown>>();

async function fetchJson(url: string): Promise<unknown> {
  const r = await fetch(url);
  // the emulator's 404 body is text/plain naming the bad PanelMapPath
  if (!r.ok) throw new Error((await r.text()).slice(0, 200) || `HTTP ${r.status}`);
  return r.json();
}

/** Memoized /panelmap for an emulator base URL; fp2.ts reuses it to name KEY_ARRAY presses. */
export function panelmap(url: string): Promise<unknown> {
  let p = panelmaps.get(url);
  if (!p) {
    p = fetchJson(`${url}/panelmap`);
    p.catch(() => panelmaps.delete(url));
    panelmaps.set(url, p);
  }
  return p;
}

/**
 * @param lcdUrlFor unit id -> emulator base URL; undefined = unit has no LCD, null = unknown unit
 */
export function registerLcdRoutes(
  app: FastifyInstance,
  lcdUrlFor: (unitId: string) => string | undefined | null,
): void {
  const resolve = (reply: FastifyReply, id: string): string | FastifyReply => {
    const url = lcdUrlFor(id);
    if (url === null) return reply.code(404).send({ error: `unknown unit: ${id}` });
    if (!url) return reply.code(503).send({ error: 'no LCD bound to this unit' });
    return url;
  };
  const errText = (e: unknown): string => String((e as Error).message ?? e).slice(0, 200);

  app.get<{ Params: { id: string } }>('/api/units/:id/lcd/panelmap', async (req, reply) => {
    const url = resolve(reply, req.params.id);
    if (typeof url !== 'string') return url;
    try {
      const map = await panelmap(url);
      return reply.header('cache-control', 'public, max-age=3600').send(map);
    } catch (e) {
      return reply.code(502).send({ error: errText(e) });
    }
  });

  app.get<{ Params: { id: string } }>('/api/units/:id/lcd/frame', async (req, reply) => {
    const url = resolve(reply, req.params.id);
    if (typeof url !== 'string') return url;
    try {
      return await fetchJson(`${url}/frame`);
    } catch (e) {
      return reply.code(502).send({ error: errText(e) });
    }
  });

  app.post<{ Params: { id: string }; Body: { index?: number; mask?: number } }>(
    '/api/units/:id/lcd/press',
    async (req, reply) => {
      const url = resolve(reply, req.params.id);
      if (typeof url !== 'string') return url;
      // A missing key parses as 0 on the emulator = every key on that byte pressed — validate hard.
      const { index, mask } = req.body ?? {};
      if (!Number.isInteger(index) || (index as number) < 0 || (index as number) > 4) {
        return reply.code(400).send({ error: 'index must be an integer 0..4' });
      }
      if (!Number.isInteger(mask) || (mask as number) < 0 || (mask as number) > 255) {
        return reply.code(400).send({ error: 'mask must be an integer 0..255' });
      }
      // Hand-built body: the emulator string-scans it for "true"; never
      // JSON.stringify an object that might carry other booleans.
      const post = (down: boolean) =>
        fetch(`${url}/key`, {
          method: 'POST',
          body: `{"index":${index},"mask":${mask},"down":${down ? 'true' : 'false'}}`,
        });
      try {
        const first = (await (await post(true)).json()) as { ok: boolean; error?: string };
        try {
          await new Promise((r) => setTimeout(r, PRESS_MS));
        } finally {
          await post(false); // release ALWAYS: held masks latch until an explicit down:false
        }
        return first.ok ? { ok: true } : reply.code(502).send({ ok: false, error: first.error ?? 'key rejected' });
      } catch (e) {
        return reply.code(502).send({ error: errText(e) });
      }
    },
  );
}
