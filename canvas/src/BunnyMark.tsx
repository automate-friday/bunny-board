// Bunny, the organizer's mascot: a 22×26 pixel-art bunny in the brand's sunset palette
// (the owner picked option 8 of the GPT Image 2 concept sheet, 2026-10-29). Drawn as crisp SVG
// cells so it stays sharp at any size. Moods are frame edits, animated in pixel steps:
// idle blinks, working hops and flops an ear, done shows happy ^ ^ eyes, error droops.

import type { ReactElement } from "react";

export type BunnyMood = "idle" | "working" | "done" | "error";

export const PAL: Record<string, string> = {
  Y: "#FFC65A", // golden hour
  O: "#FF9F7A", // peach
  D: "#FF7F50", // deeper peach (paws)
  P: "#F7A0CA", // blush pink
  V: "#8875F6", // soft violet (shading)
  L: "#FFD3E2", // inner ear
  W: "#FFF8EB", // cream muzzle and belly
  E: "#2E1F16", // espresso eyes and mouth
  H: "#FFFFFF", // eye highlight
  N: "#E8505B", // nose
};

export const BASE = [
  "....YY..........PP....",
  "...YYYO........PPPV...",
  "...YLLO........PLLV...",
  "...YLLO........PLLV...",
  "...YLLO........PLLV...",
  "...YLLO........PLLV...",
  "...YLLO........PLLV...",
  "...YYLO........PLPV...",
  "....YOO........PPV....",
  "....YYO........PPV....",
  ".....YYYYYYYYYYYPP....",
  "....YYYYYYYYYYYYYPP...",
  "...OYYYYYYYYYYYYYYPV..",
  "...OYYYYYYYYYYYYYYPV..",
  "...OYYEHYYYYYYEHYYPV..",
  "...OYYEEYYYYYYEEYYPV..",
  "...OYYEEYWWWWYEEYYPV..",
  "...OPPYWWWNNWWWYPPPV..",
  "...OOYWWWEWWEWWWYYPV..",
  "....OYWWWWEEWWWWYPV...",
  ".....OOYWWWWWWYYPV....",
  "....OOOOWWWWWWPPPVV...",
  "...OOOOWWWWWWWWPPPVV..",
  "...VOODDWWWWWWPPPVVV..",
  "...VVDDDV....VPPPVV...",
  "....VVVV......VVVV....",
];

type Rows = string[];
const set = (rows: Rows, y: number, x: number, s: string): Rows => rows.map((r, i) => (i === y ? r.slice(0, x) + s + r.slice(x + s.length) : r));
const edit = (rows: Rows, cells: Array<[number, number, string]>) => cells.reduce((r, [y, x, s]) => set(r, y, x, s), rows);

// Eyes closed (blink): the two eye columns become fur, with a lash line on the lower row.
const BLINK = edit(BASE, [
  [14, 6, "YY"], [14, 14, "YY"],
  [15, 6, "YY"], [15, 14, "YY"],
  [16, 6, "EE"], [16, 14, "EE"],
]);
// Happy ^ ^ eyes.
const HAPPY = edit(BASE, [
  [14, 6, "EE"], [14, 14, "EE"],
  [15, 5, "EYYE"], [15, 13, "EYYE"],
  [16, 6, "YY"], [16, 14, "YY"],
]);
// One ear flopped forward (working frame B): the right ear's top folds over.
const FLOP = edit(BASE, [
  [0, 16, ".."], [1, 15, "...."], [2, 15, "...."],
  [1, 17, "PP"], [2, 17, "PPV"], [3, 15, "PLLPV"],
]);
// Droopy ears (short and tipped outward) and small worried eyes, for error / needs you.
const DROOP = edit(
  BASE.map((r, i) => (i < 3 ? "......................" : r)),
  [
    [3, 0, "..YYO.........PPV....."],
    [4, 2, "Y"], [4, 19, "V"],
    [14, 6, "YY"], [14, 14, "YY"],
    [15, 6, "YE"], [15, 14, "EY"],
    [16, 6, "YE"], [16, 14, "EY"],
  ],
);

function Cells({ rows }: { rows: Rows }) {
  const out: ReactElement[] = [];
  rows.forEach((r, y) => {
    // Merge horizontal runs of one colour into a single rect.
    let x = 0;
    while (x < r.length) {
      const c = r[x];
      let w = 1;
      while (x + w < r.length && r[x + w] === c) w++;
      if (c !== ".") out.push(<rect key={`${y}-${x}`} x={x} y={y} width={w} height={1} fill={PAL[c]} />);
      x += w;
    }
  });
  return <>{out}</>;
}

export const BUNNY_CSS = `
@keyframes bny-hop { 0%,100% { transform: translateY(0) } 50% { transform: translateY(-1px) } }
@keyframes bny-hop-once { 0%,100% { transform: translateY(0) } 30% { transform: translateY(-2px) } 60% { transform: translateY(0) } 80% { transform: translateY(-1px) } }
@keyframes bny-swap-a { 0%,49.9% { opacity: 1 } 50%,100% { opacity: 0 } }
@keyframes bny-swap-b { 0%,49.9% { opacity: 0 } 50%,100% { opacity: 1 } }
@keyframes bny-blink-open { 0%,93.9% { opacity: 1 } 94%,97% { opacity: 0 } 97.1%,100% { opacity: 1 } }
@keyframes bny-blink-shut { 0%,93.9% { opacity: 0 } 94%,97% { opacity: 1 } 97.1%,100% { opacity: 0 } }
.bny { image-rendering: pixelated; }
.bny .open { animation: bny-blink-open 4.6s steps(1) infinite; }
.bny .shut { animation: bny-blink-shut 4.6s steps(1) infinite; }
.bny.working .body { animation: bny-hop .36s steps(1) infinite; }
.bny.working .fa { animation: bny-swap-a .72s steps(1) infinite; }
.bny.working .fb { animation: bny-swap-b .72s steps(1) infinite; }
.bny.done .body { animation: bny-hop-once .7s steps(4) 1; }
@media (prefers-reduced-motion: reduce) { .bny * { animation: none !important; } .bny .shut, .bny .fb { opacity: 0; } }
`;

export function BunnyMark({ size = 40, mood = "idle" }: { size?: number; mood?: BunnyMood }) {
  // 22×26 cells, centred in a square viewBox with a little headroom for the hop.
  return (
    <svg width={size} height={size} viewBox="-3 -2 28 28" className={`bny ${mood}`} shapeRendering="crispEdges" aria-hidden="true">
      <g className="body">
        {mood === "idle" ? (
          <>
            <g className="open"><Cells rows={BASE} /></g>
            <g className="shut"><Cells rows={BLINK} /></g>
          </>
        ) : mood === "working" ? (
          <>
            <g className="fa"><Cells rows={BASE} /></g>
            <g className="fb"><Cells rows={FLOP} /></g>
          </>
        ) : mood === "done" ? (
          <Cells rows={HAPPY} />
        ) : (
          <Cells rows={DROOP} />
        )}
      </g>
    </svg>
  );
}
