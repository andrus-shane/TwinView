/**
 * Live tablet console: raw H.264 (Annex-B) from scrcpy-server arrives over
 * /ws/screen/:serial, WebCodecs decodes it, and frames paint into a canvas
 * that serves as the 3D console texture — the same contract as MockConsole.
 */
export class AdbScreen {
  readonly canvas: HTMLCanvasElement;
  private g: CanvasRenderingContext2D;
  private ws: WebSocket | null = null;
  private decoder: VideoDecoder | null = null;
  private buf = new Uint8Array(0);
  private params: Uint8Array[] = []; // SPS/PPS/SEI awaiting their slice
  private configured = false;
  private haveKey = false;
  private frames = 0;
  private disposed = false;

  constructor(private serial: string) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = 640;
    this.canvas.height = 384;
    this.g = this.canvas.getContext('2d')!;
    this.banner('connecting…');
  }

  connect(): void {
    if (typeof VideoDecoder === 'undefined') {
      this.banner('WebCodecs not supported in this browser');
      return;
    }
    this.decoder = new VideoDecoder({
      output: (frame) => this.paint(frame),
      error: (e) => {
        this.banner(`decode error: ${e.message}`);
        this.ws?.close();
      },
    });
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    this.ws = new WebSocket(`${proto}://${location.host}/ws/screen/${encodeURIComponent(this.serial)}`);
    this.ws.binaryType = 'arraybuffer';
    this.ws.onmessage = (ev) => this.ingest(new Uint8Array(ev.data as ArrayBuffer));
    this.ws.onclose = (ev) => {
      if (!this.disposed) this.banner(ev.reason || 'stream closed');
    };
  }

  /** Buffer stream bytes and peel off complete NAL units (start code to start code). */
  private ingest(chunk: Uint8Array): void {
    const buf = new Uint8Array(this.buf.length + chunk.length);
    buf.set(this.buf);
    buf.set(chunk, this.buf.length);

    const starts: number[] = [];
    for (let i = 0; i + 3 < buf.length; i++) {
      if (buf[i] !== 0 || buf[i + 1] !== 0) continue;
      if (buf[i + 2] === 1) {
        starts.push(i);
        i += 2;
      } else if (buf[i + 2] === 0 && buf[i + 3] === 1) {
        starts.push(i);
        i += 3;
      }
    }
    if (starts.length === 0) {
      this.buf = buf;
      return;
    }
    // a NAL is only known complete once the next start code shows up
    for (let k = 0; k + 1 < starts.length; k++) this.handleNal(buf.subarray(starts[k], starts[k + 1]));
    this.buf = buf.slice(starts[starts.length - 1]);
  }

  private handleNal(nal: Uint8Array): void {
    if (!this.decoder || this.decoder.state === 'closed') return;
    const off = nal[2] === 1 ? 3 : 4;
    const type = nal[off] & 0x1f;

    if (type === 7 || type === 8 || type === 6) {
      // parameter sets ride along with the next slice
      if (type === 7 && !this.configured) {
        // profile/constraint/level live before any emulation-prevention bytes
        const hex = [nal[off + 1], nal[off + 2], nal[off + 3]]
          .map((b) => b.toString(16).padStart(2, '0'))
          .join('');
        this.decoder.configure({ codec: `avc1.${hex}`, optimizeForLatency: true });
        this.configured = true;
      }
      this.params.push(nal);
      return;
    }
    if (type !== 5 && type !== 1) return; // slices only
    if (!this.configured || (!this.haveKey && type !== 5)) {
      this.params = [];
      return;
    }
    this.haveKey = true;

    let size = nal.length;
    for (const p of this.params) size += p.length;
    const au = new Uint8Array(size);
    let at = 0;
    for (const p of this.params) {
      au.set(p, at);
      at += p.length;
    }
    au.set(nal, at);
    this.params = [];

    this.decoder.decode(
      new EncodedVideoChunk({
        type: type === 5 ? 'key' : 'delta',
        timestamp: this.frames++ * 33_333,
        data: au,
      }),
    );
  }

  private paint(frame: VideoFrame): void {
    if (this.disposed) {
      frame.close();
      return;
    }
    const w = frame.displayWidth;
    const h = frame.displayHeight;
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.g.drawImage(frame, 0, 0, w, h);
    frame.close();
  }

  private banner(text: string): void {
    const { g, canvas } = this;
    g.fillStyle = '#0d1420';
    g.fillRect(0, 0, canvas.width, canvas.height);
    g.font = '600 20px system-ui';
    g.fillStyle = '#8fa2c4';
    g.textAlign = 'center';
    g.fillText(text, canvas.width / 2, canvas.height / 2);
    g.font = '13px system-ui';
    g.fillStyle = '#5b6b85';
    g.fillText(this.serial, canvas.width / 2, canvas.height / 2 + 28);
  }

  dispose(): void {
    this.disposed = true;
    this.ws?.close();
    if (this.decoder && this.decoder.state !== 'closed') this.decoder.close();
  }
}
