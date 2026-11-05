// The favicon: the head and ears of the Bunny mark (BunnyMark.tsx's BASE frame, rows 0-20,
// without the body and paws so it still reads at 16px). tools/make-favicons.ts writes it
// to canvas/public/favicon.svg and renders the PNG fallbacks from it; a unit test keeps
// the committed SVG in step with the mark.

import { BASE, PAL } from "./BunnyMark";

const HEAD_ROWS = 21;

export function bunnyFaviconSvg(): string {
  const rows = BASE.slice(0, HEAD_ROWS);
  const rects: string[] = [];
  let minX = Infinity;
  let maxX = -Infinity;
  rows.forEach((r, y) => {
    let x = 0;
    while (x < r.length) {
      const c = r[x];
      let w = 1;
      while (x + w < r.length && r[x + w] === c) w++;
      if (c !== ".") {
        rects.push(`<rect x="${x}" y="${y}" width="${w}" height="1" fill="${PAL[c]}"/>`);
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x + w);
      }
      x += w;
    }
  });
  // Square viewBox, the head centred horizontally.
  const side = Math.max(HEAD_ROWS, maxX - minX);
  const left = minX - (side - (maxX - minX)) / 2;
  const top = -(side - HEAD_ROWS) / 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${left} ${top} ${side} ${side}" shape-rendering="crispEdges">${rects.join("")}</svg>\n`;
}
