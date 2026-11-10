// The one generic plugin widget shape. Props and migrations come from shared/widgets so
// the server schema matches exactly; which widget it is lives in props.widgetId.

import { createElement } from "react";
import { BaseBoxShapeUtil, HTMLContainer, type RecordProps, type TLShape } from "tldraw";
import { WIDGET_TYPE, type WidgetProps, widgetManifest, widgetMigrations, widgetShapeProps } from "../../../../shared/widgets";
import { WidgetRender } from "./Render";
import { CardPlaceholder, phoneLod } from "../../mobile/lod";

declare module "tldraw" {
  interface TLGlobalShapePropsMap {
    widget: WidgetProps;
  }
}

export type WidgetShape = TLShape<typeof WIDGET_TYPE>;

export class WidgetShapeUtil extends BaseBoxShapeUtil<WidgetShape> {
  static override type = WIDGET_TYPE;
  static override props: RecordProps<WidgetShape> = widgetShapeProps;
  static override migrations = widgetMigrations;

  override getDefaultProps(): WidgetProps {
    return { widgetId: "hello", config: {}, w: 280, h: 160 };
  }

  override canEdit(): boolean {
    return false;
  }

  override isAspectRatioLocked(): boolean {
    return false;
  }

  override component(shape: WidgetShape) {
    // Phone overview / off screen: a placeholder, no polling (mobile/lod.tsx).
    return phoneLod(shape, true, () => createElement(CardPlaceholder, { w: shape.props.w, h: shape.props.h, title: widgetManifest(shape.props.widgetId)?.label ?? "Widget", tone: "light-dark(#e5f4ea, var(--bunny-raised))" }), () => createElement(HTMLContainer, { id: shape.id, style: { width: shape.props.w, height: shape.props.h } }, createElement(WidgetRender, { shape })));
  }

  override getIndicatorPath(shape: WidgetShape) {
    const p = new Path2D();
    p.roundRect(0, 0, shape.props.w, shape.props.h, 12);
    return p;
  }
}
