// Board link card shape: opens another board (or a frame on one). Props and migrations
// come from shared/ so the server schema matches exactly.

import { createElement } from "react";
import { BaseBoxShapeUtil, HTMLContainer, type RecordProps, type TLShape } from "tldraw";
import { LINK_TYPE, type LinkProps, linkDefaults, linkMigrations, linkShapeProps } from "../../../../shared/components/link";
import { LinkRender } from "./Render";

declare module "tldraw" {
  interface TLGlobalShapePropsMap {
    link: LinkProps;
  }
}

export type LinkShape = TLShape<typeof LINK_TYPE>;

export class LinkShapeUtil extends BaseBoxShapeUtil<LinkShape> {
  static override type = LINK_TYPE;
  static override props: RecordProps<LinkShape> = linkShapeProps;
  static override migrations = linkMigrations;

  override getDefaultProps(): LinkProps {
    return linkDefaults();
  }

  override canEdit(): boolean {
    return false;
  }

  override isAspectRatioLocked(): boolean {
    return false;
  }

  override component(shape: LinkShape) {
    return createElement(HTMLContainer, { id: shape.id, style: { width: shape.props.w, height: shape.props.h } }, createElement(LinkRender, { shape }));
  }

  override getIndicatorPath(shape: LinkShape) {
    const p = new Path2D();
    p.roundRect(0, 0, shape.props.w, shape.props.h, 10);
    return p;
  }
}
