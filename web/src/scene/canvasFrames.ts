/**
 * Frame counters for canvases used as 3D textures. Producers (AdbScreen,
 * MockConsole) bump after painting; RigAnimator re-uploads a console texture
 * only when the count moved. With ~20 lab streams at 1-2 fps, uploading every
 * render tick would cost more GPU bandwidth than the streams themselves.
 */
const frames = new WeakMap<HTMLCanvasElement, number>();

export function markCanvasFrame(canvas: HTMLCanvasElement): void {
  frames.set(canvas, (frames.get(canvas) ?? 0) + 1);
}

/** undefined = untracked canvas; callers should fall back to always-upload. */
export function canvasFrame(canvas: HTMLCanvasElement): number | undefined {
  return frames.get(canvas);
}
