export interface ContentBounds { x: number; y: number; w: number; h: number }

// Search inside the selected frame, never on top of an existing annotation or card.
export function freeTextSlot(w: number, h: number, occupied: ContentBounds[]): ContentBounds | null {
  const width = Math.min(240, w - 40);
  if (width < 40 || h < 80) return null;
  let tried = 0;
  for (let y = 32; y + 40 <= h - 12 && tried < 500; y += 48) {
    for (let x = 20; x + width <= w - 12 && tried++ < 500; x += width + 16) {
      if (!occupied.some((b) => x < b.x + b.w + 8 && x + width + 8 > b.x && y < b.y + b.h + 8 && y + 48 > b.y)) return { x, y, w: width, h: 40 };
    }
  }
  return null;
}
