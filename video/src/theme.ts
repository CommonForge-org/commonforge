/**
 * Brand tokens for the demo video. Every colour and font used on screen comes from here
 * (docs/UX-POLISH.md, "Theme tokens"); components derive translucent variants with `alpha()`
 * instead of repeating a literal. Plain module: also imported by Node scripts (placeholders).
 */

const brand = {
  frame: '#0B0F17',
  panel: '#121826',
  text: '#E6EDF3',
  accent: '#38F0D0',
  amber: '#F59E0B',
  success: '#34D399',
  danger: '#F87171',
} as const;

/** `#RRGGBB` → [r, g, b]. */
export function hexToRgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) throw new Error(`not a #RRGGBB colour: ${hex}`);
  return [Number.parseInt(m[1]!, 16), Number.parseInt(m[2]!, 16), Number.parseInt(m[3]!, 16)];
}

/** A `#RRGGBB` token at the given opacity, as a CSS `rgba()` string. */
export function alpha(hex: string, opacity: number): string {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${opacity})`;
}

/** `#RRGGBB` → `0xRRGGBB`, the colour syntax of ffmpeg filters. */
export function ffmpegColour(hex: string): string {
  return `0x${hexToRgb(hex).map((c) => c.toString(16).padStart(2, '0')).join('').toUpperCase()}`;
}

const BLACK = '#000000';

export const theme = {
  color: {
    ...brand,
    /** Muted text, derived from `text` at reduced opacity. */
    muted: alpha(brand.text, 0.6),
    /** Soft 1-px borders and rails. */
    hairline: alpha(brand.text, 0.12),
  },
  shadow: {
    /** Under floating windows (browser frame, terminal pane). */
    window: `0 30px 80px ${alpha(BLACK, 0.55)}`,
    /** Under small chips and badges. */
    chip: `0 4px 18px ${alpha(BLACK, 0.45)}`,
  },
  /** Browser window controls (close, minimise, zoom). */
  windowControls: ['#FF5F57', '#FEBC2E', '#28C840'],
  /**
   * xterm's 16-colour palette for terminal panes, with the brand tokens where they apply
   * (red = danger, green = success, yellow = amber, white = text).
   */
  ansi16: [
    '#3B4252', brand.danger, brand.success, brand.amber, '#60A5FA', '#C084FC', '#22D3EE', brand.text,
    '#6B7280', '#FCA5A5', '#6EE7B7', '#FCD34D', '#93C5FD', '#D8B4FE', '#67E8F9', '#FFFFFF',
  ],
  /** Background per scene for generated placeholder media (scripts/make-placeholders.ts). */
  placeholderScenes: ['#1E3A5F', '#3B1F4A', '#1F4A3B', '#4A3B1F', '#1F2F4A', '#4A1F2F', '#2F4A1F', '#1F4A4A', '#3F3F1F', '#2A1F4A'],
  font: {
    /** IBM Plex Sans (UI text), loaded by src/fonts.ts; system fonts if it cannot load. */
    sans: '"IBM Plex Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
    /** IBM Plex Mono (hashes, code, terminal panes). */
    mono: '"IBM Plex Mono", "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
  },
  radius: 14,
} as const;

/**
 * Owner-supplied header logo for dark backgrounds (mark, wordmark, tagline), 1200×220 under
 * `public/`. Never recoloured: its wordmark mint is the brand accent.
 */
export const BRAND_LOGO = { src: 'brand/commonforge-headerlogo-dark.png', aspect: 1200 / 220 } as const;
/** The C-shaped mark alone (512×512), for small sizes where the wordmark is illegible. */
export const BRAND_ICON = { src: 'brand/commonforge-icon-512.png' } as const;

export const VIDEO = {
  width: 1920,
  height: 1080,
  fps: 30,
} as const;
