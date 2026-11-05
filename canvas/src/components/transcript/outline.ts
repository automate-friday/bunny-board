// How board_read describes a transcript card to agents. The serializer itself lives in
// shared/ so the board server (which cannot import tldraw or React) uses the same code;
// server/outline.ts calls it through shared/components.
export { transcriptOutline } from "../../../../shared/components/transcript";
