// Cloud session card shape: one cloud builder run, pinned by bin/cloud-task and kept
// current by the board server (server/cloud-sessions.ts). Props and migrations come from
// shared/ so the server schema matches exactly.

import { createElement } from "react";
import { BaseBoxShapeUtil, HTMLContainer, type RecordProps, type TLShape } from "tldraw";
import { CLOUD_SESSION_TYPE, type CloudSessionProps, cloudSessionDefaults, cloudSessionMigrations, cloudSessionShapeProps } from "../../../../shared/components/cloud-session";
import { CloudSessionRender } from "./Render";
import { CardPlaceholder, phoneLod } from "../../mobile/lod";

declare module "tldraw" {
  interface TLGlobalShapePropsMap {
    "cloud-session": CloudSessionProps;
  }
}

export type CloudSessionShape = TLShape<typeof CLOUD_SESSION_TYPE>;

export class CloudSessionShapeUtil extends BaseBoxShapeUtil<CloudSessionShape> {
  static override type = CLOUD_SESSION_TYPE;
  static override props: RecordProps<CloudSessionShape> = cloudSessionShapeProps;
  static override migrations = cloudSessionMigrations;

  override getDefaultProps(): CloudSessionProps {
    return cloudSessionDefaults();
  }

  override canEdit(): boolean {
    return false;
  }

  override isAspectRatioLocked(): boolean {
    return false;
  }

  override component(shape: CloudSessionShape) {
    // Phone overview / off screen: a placeholder, no timers (mobile/lod.tsx).
    return phoneLod(shape, true, () => createElement(CardPlaceholder, { w: shape.props.w, h: shape.props.h, title: shape.props.title || "Cloud session", tone: "#e3eefb" }), () => createElement(HTMLContainer, { id: shape.id, style: { width: shape.props.w, height: shape.props.h } }, createElement(CloudSessionRender, { shape })));
  }

  override getIndicatorPath(shape: CloudSessionShape) {
    const p = new Path2D();
    p.roundRect(0, 0, shape.props.w, shape.props.h, 10);
    return p;
  }
}
