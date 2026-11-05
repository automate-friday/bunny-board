// Board component registry (shadcn-style: each component is a folder with shape.ts,
// Render.tsx, outline.ts and dragSource.tsx). App.tsx registers every shape util from
// here and routes canvas drops through handleComponentDrop.

import { CHECKLIST_TYPE, ChecklistShapeUtil, checklistProps } from "./checklist/shape";
export { ChecklistDragSource } from "./checklist/dragSource";
import type { Editor, TLAnyShapeUtilConstructor, VecLike } from "tldraw";
import { BOARD_ID_RE, FRAME_ID_RE, LINK_TYPE, linkDefaults } from "../../../shared/components/link";
import { TRANSCRIPT_TYPE, type TranscriptMode, transcriptDefaults } from "../../../shared/components/transcript";
import { CLOUD_SESSION_TYPE } from "../../../shared/components/cloud-session";
import { CloudSessionShapeUtil } from "./cloud-session/shape";
import { LinkDragSource } from "./link/dragSource";
import { LinkShapeUtil } from "./link/shape";
import { placeAt, readDrag } from "./place";
import { TranscriptDragSource } from "./transcript/dragSource";
import { TranscriptShapeUtil } from "./transcript/shape";
import { WIDGET_TYPE, widgetProps } from "../../../shared/widgets";
import { WidgetShapeUtil } from "./widget/shape";
import { STAMP_TYPE } from "../../../shared/components/stamp";
import { StampShapeUtil } from "./stamp/shape";
export { WidgetTrayButton } from "./widget/Tray";
export { StampToolButton } from "./stamp/Picker";
export { StampTool, STAMP_TOOL } from "./stamp/tool";

export interface BoardComponent {
  type: string;
  label: string;
  util: TLAnyShapeUtilConstructor;
  // Full props for a new instance from a drag payload, or null if the payload is invalid.
  propsFrom(payload: Record<string, unknown>): ({ w: number; h: number } & Record<string, unknown>) | null;
}

export const checklistComponent: BoardComponent = { type: CHECKLIST_TYPE, label: "Checklist", util: ChecklistShapeUtil, propsFrom: p => { const props = checklistProps(p); return props ? { ...props } : null; } };

export const boardComponents: BoardComponent[] = [
  checklistComponent,
  {
    type: TRANSCRIPT_TYPE,
    label: "Transcript",
    util: TranscriptShapeUtil,
    propsFrom: (p) => {
      if (typeof p.agentId !== "string" || !p.agentId) return null;
      return transcriptDefaults(p.agentId, (p.mode as TranscriptMode) === "full" ? "full" : "compact") as never;
    },
  },
  {
    type: LINK_TYPE,
    label: "Board link",
    util: LinkShapeUtil,
    propsFrom: (p) => {
      const board = typeof p.board === "string" ? p.board : "";
      const frameId = typeof p.frameId === "string" ? p.frameId : "";
      if (!BOARD_ID_RE.test(board) || (frameId && !FRAME_ID_RE.test(frameId))) return null;
      return linkDefaults(board, frameId, typeof p.title === "string" ? p.title.slice(0, 120) : "") as never;
    },
  },
  // Pinned by bin/cloud-task only (no drag source): a card without a session is meaningless.
  { type: CLOUD_SESSION_TYPE, label: "Cloud session", util: CloudSessionShapeUtil, propsFrom: () => null },
  {
    // Every plugin widget (shared/widgets); the payload names which one.
    type: WIDGET_TYPE,
    label: "Widget",
    util: WidgetShapeUtil,
    propsFrom: (p) => {
      try {
        return widgetProps(String(p.widgetId ?? ""), p.config ?? {}) as never;
      } catch {
        return null;
      }
    },
  },
  // Stamps come from the stamp tool (or board_stamp add); there is no drag source.
  { type: STAMP_TYPE, label: "Stamp", util: StampShapeUtil, propsFrom: () => null },
];


export const componentShapeUtils = boardComponents.map((c) => c.util);

export { LinkDragSource, TranscriptDragSource };

// Canvas drop hook: returns true when the drop was a board component.
export function handleComponentDrop(editor: Editor, point: VecLike, event: React.DragEvent | DragEvent): boolean {
  const payload = readDrag(event);
  if (!payload) return false;
  const comp = boardComponents.find((c) => c.type === payload.type);
  const props = comp?.propsFrom(payload.props);
  if (!comp || !props) return false;
  const o = payload.offset;
  const ok = (n: unknown) => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 400;
  placeAt(editor, comp.type, props, o && ok(o.x) && ok(o.y) ? { x: point.x - o.x, y: point.y - o.y } : point);
  return true;
}
