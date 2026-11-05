// Downscaled board images (server/image-variants.ts serves them at /api/assets/<file>?w=<px>).
// Shared so the canvas asks only for widths the server makes.

export const VARIANT_WIDTHS = [256, 512, 1024, 2048] as const;

// The variant width for a wanted width in device pixels: the smallest at or above it.
export function variantWidth(wanted: number): number | null {
  if (!Number.isFinite(wanted) || wanted <= 0) return null;
  return VARIANT_WIDTHS.find((w) => w >= wanted) ?? null;
}

// `src` at the width it will be drawn (device px, at most 2048), when it is a board-served PNG
// or JPEG wider than that; otherwise `src` unchanged (`naturalW` 0: unknown, ask anyway).
export function variantUrl(src: string, wantedPx: number, naturalW: number): string {
  const m = src.match(/^(.*\/api\/assets\/[a-f0-9]{32}\.(?:png|jpg))(?:\?.*)?$/);
  if (!m) return src;
  // Never wider than the largest variant: a phone (pixel ratio capped at 2) gains little from
  // more, and a 2868-px original is 15+ MB decoded.
  const w = variantWidth(wantedPx) ?? VARIANT_WIDTHS[VARIANT_WIDTHS.length - 1];
  if (naturalW && w >= naturalW) return m[1];
  return `${m[1]}?w=${w}`;
}
