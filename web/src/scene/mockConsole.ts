import type { TwinState } from '@twinview/shared';

/**
 * Client-rendered stand-in for the tablet console screen. Later this swaps for
 * an MJPEG <img> fed by TabletAutoTest's LiveView service (:8093) — the canvas
 * is still used as the texture source either way.
 */
export class MockConsole {
  readonly canvas: HTMLCanvasElement;
  private g: CanvasRenderingContext2D;

  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.width = 640;
    this.canvas.height = 384;
    this.g = this.canvas.getContext('2d')!;
    this.drawIdle();
  }

  private bg(): void {
    const { g, canvas } = this;
    const grad = g.createLinearGradient(0, 0, 0, canvas.height);
    grad.addColorStop(0, '#0d1420');
    grad.addColorStop(1, '#111a2a');
    g.fillStyle = grad;
    g.fillRect(0, 0, canvas.width, canvas.height);
    g.fillStyle = '#e8443a';
    g.fillRect(0, 0, canvas.width, 4);
    g.font = 'bold 20px system-ui';
    g.fillStyle = '#5b6b85';
    g.textAlign = 'left';
    g.fillText('iFIT', 20, 34);
    g.font = '12px system-ui';
    g.fillStyle = '#44506a';
    g.fillText('QA MOCK CONSOLE', 20, 52);
  }

  drawIdle(): void {
    this.bg();
    const { g, canvas } = this;
    g.textAlign = 'center';
    g.font = '600 30px system-ui';
    g.fillStyle = '#8fa2c4';
    g.fillText('Ready', canvas.width / 2, 180);
    g.font = '15px system-ui';
    g.fillStyle = '#5b6b85';
    g.fillText('Start a scenario or set speed/incline', canvas.width / 2, 214);
  }

  draw(state: TwinState): void {
    this.bg();
    const { g, canvas } = this;
    const cx = canvas.width / 2;

    // Big speed readout (what the console commands)
    g.textAlign = 'center';
    g.font = '700 96px system-ui';
    g.fillStyle = '#f2f6ff';
    g.fillText(state.setpoints.speed.toFixed(1), cx, 190);
    g.font = '600 22px system-ui';
    g.fillStyle = '#7688a8';
    g.fillText('MPH', cx, 222);

    // Incline (left) and elapsed (right)
    g.font = '700 44px system-ui';
    g.fillStyle = '#dbe4f5';
    g.textAlign = 'center';
    g.fillText(`${state.setpoints.incline.toFixed(1)}%`, cx - 210, 180);
    g.font = '600 15px system-ui';
    g.fillStyle = '#7688a8';
    g.fillText('INCLINE', cx - 210, 205);

    const mins = Math.floor(state.elapsed / 60);
    const secs = Math.floor(state.elapsed % 60);
    g.font = '700 44px system-ui';
    g.fillStyle = '#dbe4f5';
    g.fillText(`${mins}:${secs.toString().padStart(2, '0')}`, cx + 210, 180);
    g.font = '600 15px system-ui';
    g.fillStyle = '#7688a8';
    g.fillText('ELAPSED', cx + 210, 205);

    // Status strip
    const running = state.running || state.setpoints.speed > 0;
    g.fillStyle = running ? '#123524' : '#1a2233';
    g.beginPath();
    g.roundRect(cx - 160, 270, 320, 54, 12);
    g.fill();
    g.font = '600 22px system-ui';
    g.fillStyle = running ? '#4ade80' : '#8fa2c4';
    g.fillText(
      state.scenario ? `SCENARIO: ${state.scenario.toUpperCase()}` : running ? 'MANUAL RUN' : 'STOPPED',
      cx,
      304,
    );
  }
}
