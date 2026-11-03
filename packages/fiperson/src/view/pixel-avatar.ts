import { personStream, pickIndex } from "./guest-name.js";

/** Deterministic 6x8 pixel avatar: continues the guest-name xoshiro128++ stream (name draws first, so names never change). */
export interface PixelAvatar {
  /** 8 rows x 6 columns, left half mirrored to the right (no shared center column). */
  pixels: boolean[][];
  fg: string;
  bg: string;
}

export const PIXEL_MIN_CONTRAST = 4.5;

function hslToHex(h: number, s: number, l: number): string {
  const sat = s / 100;
  const lig = l / 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = sat * Math.min(lig, 1 - lig);
  const f = (n: number) => lig - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return "#" + [f(0), f(8), f(4)].map((x) => Math.round(x * 255).toString(16).padStart(2, "0")).join("");
}

function luminance(hex: string): number {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
}

/** WCAG 2 contrast ratio. */
export function contrastRatio(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)].sort((m, n) => n - m) as [number, number];
  return (x + 0.05) / (y + 0.05);
}

function color(next: () => number): string {
  // hue 0..359, saturation 35..85, lightness 10..90 — each an unbiased draw.
  return hslToHex(pickIndex(next, 360), 35 + pickIndex(next, 51), 10 + pickIndex(next, 81));
}

export function pixelAvatar(seedText: string): PixelAvatar {
  const { next } = personStream(seedText);
  const bits = next() >>> 8; // 24 bits
  const pixels: boolean[][] = [];
  for (let r = 0; r < 8; r++) {
    const half = [0, 1, 2].map((c) => ((bits >>> (r * 3 + c)) & 1) === 1);
    pixels.push([...half, ...[...half].reverse()]);
  }
  let fg = color(next);
  let bg = color(next);
  // Rejection sampling: redraw both until the pair is readable.
  while (contrastRatio(fg, bg) < PIXEL_MIN_CONTRAST) {
    fg = color(next);
    bg = color(next);
  }
  return { pixels, fg, bg };
}

/** Inline SVG (crisp pixels, any size). Square output: the 6x8 art is centered on its background. */
export function pixelAvatarSvg(seedText: string, size = 28): string {
  const a = pixelAvatar(seedText);
  let rects = "";
  a.pixels.forEach((row, y) => row.forEach((on, x) => (on ? (rects += `<rect x="${x + 1}" y="${y}" width="1" height="1"/>`) : undefined)));
  return `<svg xmlns="http://www.w3.org/2000/svg" class="fiperson-pixel" width="${size}" height="${size}" viewBox="0 0 8 8" shape-rendering="crispEdges" aria-hidden="true" style="display:block"><rect width="8" height="8" fill="${a.bg}"/><g fill="${a.fg}">${rects}</g></svg>`;
}
