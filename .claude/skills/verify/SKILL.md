---
name: verify
description: Build, launch, and drive TwinView to verify a change end-to-end
---

# Verifying TwinView changes

Monorepo with npm workspaces: `shared`, `server` (Fastify, port 8720), `web` (Vite + React + three.js, port 5173, proxies `/api`, `/models`, `/ws` to 8720).

## Launch

Run both in the background from the repo root:

```
npm run dev:server   # Fastify on 8720 (tsx watch)
npm run dev:web      # Vite on 5173
```

Wait for `http://localhost:5173/` to respond. The model badge in the header reads `NTL99925 (CAD)` once the GLB has loaded (initially `loading…`).

## Drive

No Playwright in this repo — install `playwright-core` in the scratchpad and launch the system Edge browser (`chromium.launch({ channel: 'msedge', headless: true })`). Headless WebGL renders the three.js scene fine (software rasterizer).

Useful waits: `waitForFunction` on the model badge not containing `loading`, then ~2–3s for the 3D scene and gauge streams to settle before screenshots.

## Gotchas

- Playwright contexts default to emulating `prefers-color-scheme: light`; pass `colorScheme: 'dark'` if you need the OS-dark default path.
- A single 404 console error (`/favicon.ico`) is pre-existing noise, not a regression.
- The server's screen scan shells out to adb (see `server/src/screens.ts`); don't aggressively kill process trees — it can take the host adb daemon down (tablets re-enumerate in seconds, but active scrcpy streams die).
- When driving the 3D scene by projecting a mesh to client coords (via `window.__viewer`), poll until the projection is stable AND `__viewer.camAnim` is null before synthesizing pointer events — the CAD hot-swap and fly-in keep moving meshes for seconds after focus, and a drag at stale coords orbits the camera (or picks a part) instead.
- Multiple bays carry `userData.consoleScreen` meshes; filter by parent chain `unitId === __viewer.focusedId` or you'll project a neighbor's screen.
- Headless Edge decodes the scrcpy H.264 stream via WebCodecs fine — live-console flows (tap/swipe-through with `hasVideo` gates) are fully testable headless.
