/**
 * A 5×7 bitmap font and RGB canvas for burning labels into placeholder media.
 * Exists because common ffmpeg builds (including Homebrew's) ship without the
 * freetype-backed `drawtext` filter; this needs nothing but Node.
 */

type Rgb = readonly [number, number, number];

/** Each glyph is seven rows; each row is five bits, most significant bit leftmost. */
const GLYPHS: Record<string, readonly number[]> = {
  A: [14, 17, 17, 31, 17, 17, 17], B: [30, 17, 17, 30, 17, 17, 30], C: [14, 17, 16, 16, 16, 17, 14],
  D: [28, 18, 17, 17, 17, 18, 28], E: [31, 16, 16, 30, 16, 16, 31], F: [31, 16, 16, 30, 16, 16, 16],
  G: [14, 17, 16, 23, 17, 17, 15], H: [17, 17, 17, 31, 17, 17, 17], I: [14, 4, 4, 4, 4, 4, 14],
  J: [7, 2, 2, 2, 2, 18, 12], K: [17, 18, 20, 24, 20, 18, 17], L: [16, 16, 16, 16, 16, 16, 31],
  M: [17, 27, 21, 21, 17, 17, 17], N: [17, 17, 25, 21, 19, 17, 17], O: [14, 17, 17, 17, 17, 17, 14],
  P: [30, 17, 17, 30, 16, 16, 16], Q: [14, 17, 17, 17, 21, 18, 13], R: [30, 17, 17, 30, 20, 18, 17],
  S: [15, 16, 16, 14, 1, 1, 30], T: [31, 4, 4, 4, 4, 4, 4], U: [17, 17, 17, 17, 17, 17, 14],
  V: [17, 17, 17, 17, 17, 10, 4], W: [17, 17, 17, 21, 21, 21, 10], X: [17, 17, 10, 4, 10, 17, 17],
  Y: [17, 17, 17, 10, 4, 4, 4], Z: [31, 1, 2, 4, 8, 16, 31],
  '0': [14, 17, 19, 21, 25, 17, 14], '1': [4, 12, 4, 4, 4, 4, 14], '2': [14, 17, 1, 2, 4, 8, 31],
  '3': [31, 2, 4, 2, 1, 17, 14], '4': [2, 6, 10, 18, 31, 2, 2], '5': [31, 16, 30, 1, 1, 17, 14],
  '6': [6, 8, 16, 30, 17, 17, 14], '7': [31, 1, 2, 4, 8, 8, 8], '8': [14, 17, 17, 14, 17, 17, 14],
  '9': [14, 17, 17, 15, 1, 2, 12],
  ' ': [0, 0, 0, 0, 0, 0, 0], '-': [0, 0, 0, 31, 0, 0, 0], '.': [0, 0, 0, 0, 0, 12, 12],
  ':': [0, 12, 12, 0, 12, 12, 0], '/': [0, 1, 2, 4, 8, 16, 0], _: [0, 0, 0, 0, 0, 0, 31],
  '?': [14, 17, 1, 2, 4, 0, 4],
};

const GLYPH_W = 5;
const GLYPH_H = 7;

export class Canvas {
  readonly data: Buffer;

  constructor(
    readonly width: number,
    readonly height: number,
    background: Rgb,
  ) {
    this.data = Buffer.alloc(width * height * 3);
    this.fillRect(0, 0, width, height, background);
  }

  fillRect(x: number, y: number, w: number, h: number, color: Rgb): void {
    const x0 = Math.max(0, Math.floor(x));
    const y0 = Math.max(0, Math.floor(y));
    const x1 = Math.min(this.width, Math.floor(x + w));
    const y1 = Math.min(this.height, Math.floor(y + h));
    for (let py = y0; py < y1; py += 1) {
      for (let px = x0; px < x1; px += 1) {
        const i = (py * this.width + px) * 3;
        this.data[i] = color[0];
        this.data[i + 1] = color[1];
        this.data[i + 2] = color[2];
      }
    }
  }

  /** Draws upper-cased text horizontally centred at `centerY`, shrinking `scale` to fit the width. */
  textCentered(text: string, centerY: number, scale: number, color: Rgb): void {
    const label = text.toUpperCase();
    const cell = GLYPH_W + 1;
    const s = Math.max(1, Math.min(scale, Math.floor((this.width * 0.92) / (label.length * cell))));
    let x = Math.round((this.width - (label.length * cell * s - s)) / 2);
    const y = Math.round(centerY - (GLYPH_H * s) / 2);
    for (const ch of label) {
      const rows = GLYPHS[ch] ?? GLYPHS['?']!;
      rows.forEach((bits, row) => {
        for (let col = 0; col < GLYPH_W; col += 1) {
          if (bits & (1 << (GLYPH_W - 1 - col))) this.fillRect(x + col * s, y + row * s, s, s, color);
        }
      });
      x += cell * s;
    }
  }

  /** Binary PPM (P6), which ffmpeg reads natively. */
  toPpm(): Buffer {
    return Buffer.concat([Buffer.from(`P6\n${this.width} ${this.height}\n255\n`), this.data]);
  }
}
