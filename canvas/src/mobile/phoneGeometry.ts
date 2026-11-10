// Phone shell: shape geometry without DOM text measurement (bench/phone.ts profile).
// tldraw builds its spatial index for culling on the first frame, which asks every shape for
// its geometry; notes and text shapes measure their rich text in the DOM for that (~2.5 s for
// a live board's ~600 notes and text shapes at 4x CPU throttle, before the tiles respond).
// On the phone:
// - a note's body does not depend on its text (200 x (200 + growY) x scale); only its label's
//   hit area does, so the whole note stands in for it;
// - a frame's heading is measured only for its label's hit area: estimated from the name;
// - a geo shape's outline does not depend on its label: tldraw's own geometry for the same
//   shape without text;
// - a text shape's size comes from meta.measuredTextBounds when its signature matches the
//   current text and style (shared/text-bounds.ts: written by desktop browsers as they
//   measure), else tldraw measures as usual.
// Off the phone (and until setPhoneGeometry(true)) both utils are tldraw's own.

import { FrameShapeUtil, GeoShapeUtil, Group2d, NoteShapeUtil, Rectangle2d, type TLFrameShape, type TLGeoShape, type TLNoteShape, type TLTextShape, TextShapeUtil, toRichText } from "tldraw";
import { createElement } from "react";
import { measuredTextBounds } from "../../../shared/text-bounds";
import { BlockPlaceholder, NOTE_FILL, phoneLod } from "./lod";

let phone = false;
export function setPhoneGeometry(on: boolean) {
  phone = on;
}
// The phone does not write text measurements (App: installTextBoundsMeasurements): its
// geometry is the fast path above, and desktop browsers keep the measurements current.
export const phoneGeometryOn = () => phone;

const NOTE = 200;

export class PhoneNoteShapeUtil extends NoteShapeUtil {
  override getGeometry(shape: TLNoteShape) {
    if (!phone) return super.getGeometry(shape);
    const { scale, growY } = shape.props;
    const w = NOTE * scale;
    const h = (NOTE + growY) * scale;
    return new Group2d({ children: [new Rectangle2d({ width: w, height: h, isFilled: true }), new Rectangle2d({ width: w, height: h, isFilled: true, isLabel: true, excludeFromShapeBounds: true })] });
  }
  // Board overview, or off screen: the note's square in its colour, without its label (mobile/lod.tsx).
  override component(shape: TLNoteShape) {
    const { scale, growY, color } = shape.props;
    return phoneLod(shape, true, () => createElement(BlockPlaceholder, { w: NOTE * scale, h: (NOTE + growY) * scale, fill: NOTE_FILL[color] ?? NOTE_FILL.yellow }), () => super.component(shape));
  }
}

export class PhoneTextShapeUtil extends TextShapeUtil {
  override getMinDimensions(shape: TLTextShape) {
    if (phone) {
      const m = measuredTextBounds(shape as never);
      const s = shape.props.scale || 1;
      if (m) return { width: m.w / s, height: m.h / s };
    }
    return super.getMinDimensions(shape);
  }
  // Board overview, or off screen: a faint bar where the text is (mobile/lod.tsx).
  override component(shape: TLTextShape) {
    return phoneLod(shape, true, () => {
      const b = this.editor.getShapeGeometry(shape).bounds;
      return createElement(BlockPlaceholder, { w: b.w, h: b.h, fill: "light-dark(rgba(29,29,29,.18), rgba(237,240,247,.22))" });
    }, () => super.component(shape));
  }
}

const EMPTY = toRichText("");

export class PhoneGeoShapeUtil extends GeoShapeUtil {
  override getGeometry(shape: TLGeoShape) {
    if (!phone || !shape.props.richText?.content?.length) return super.getGeometry(shape);
    return super.getGeometry({ ...shape, props: { ...shape.props, richText: EMPTY } });
  }
}

// The board's frames (FrameShapeUtil with status colours), with the phone's heading estimate.
export class PhoneFrameShapeUtil extends FrameShapeUtil.configure({ showColors: true }) {
  override getGeometry(shape: TLFrameShape) {
    if (!phone || shape.rotation) return super.getGeometry(shape);
    const z = this.editor.getEfficientZoomLevel();
    const { w, h, name } = shape.props;
    const labelW = Math.min(w + 1, (Math.max(5, (name || "Frame").length) * 7 + 32) / z);
    const labelH = 24 / z;
    return new Group2d({
      children: [new Rectangle2d({ width: w, height: h, isFilled: false }), new Rectangle2d({ x: -1 / z, y: -(labelH + 4 / z), width: labelW, height: labelH, isFilled: true, isLabel: true, excludeFromShapeBounds: true })],
    });
  }
}
