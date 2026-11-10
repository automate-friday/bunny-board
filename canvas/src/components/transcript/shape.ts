// Transcript card shape: a live chat log of one Paseo agent on the board.
// Props and migrations come from shared/ so the server schema matches exactly.

import { createElement } from "react";
import { BaseBoxShapeUtil, HTMLContainer, type RecordProps, type TLShape } from "tldraw";
import {
  TRANSCRIPT_TYPE,
  type TranscriptProps,
  transcriptDefaults,
  transcriptMigrations,
  transcriptShapeProps,
} from "../../../../shared/components/transcript";
import { TranscriptRender } from "./Render";
import { CardPlaceholder, phoneLod } from "../../mobile/lod";

declare module "tldraw" {
  interface TLGlobalShapePropsMap {
    transcript: TranscriptProps;
  }
}

export type TranscriptShape = TLShape<typeof TRANSCRIPT_TYPE>;

export class TranscriptShapeUtil extends BaseBoxShapeUtil<TranscriptShape> {
  static override type = TRANSCRIPT_TYPE;
  static override props: RecordProps<TranscriptShape> = transcriptShapeProps;
  static override migrations = transcriptMigrations;

  override getDefaultProps(): TranscriptProps {
    return transcriptDefaults();
  }

  override canEdit(): boolean {
    return false;
  }

  override isAspectRatioLocked(): boolean {
    return false;
  }

  override component(shape: TranscriptShape) {
    // Phone overview / off screen: a placeholder, no live agent stream (mobile/lod.tsx).
    return phoneLod(shape, true, () => createElement(CardPlaceholder, { w: shape.props.w, h: shape.props.h, title: `Conversation · ${shape.props.agentId.slice(0, 8)}`, tone: "light-dark(#ece7f8, #393253)" }), () => createElement(HTMLContainer, { id: shape.id, style: { width: shape.props.w, height: shape.props.h } }, createElement(TranscriptRender, { shape })));
  }

  override getIndicatorPath(shape: TranscriptShape) {
    const p = new Path2D();
    p.roundRect(0, 0, shape.props.w, shape.props.h, 10);
    return p;
  }
}
