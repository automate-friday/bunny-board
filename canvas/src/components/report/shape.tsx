import { BookmarkShapeUtil, type Editor, HTMLContainer, Rectangle2d, type TLBookmarkShape, useEditor, useValue } from "tldraw";
import { layoutLockedHere } from "../../locks";
import { Emoji } from "../../Emoji";
import { CardPlaceholder, phoneLod } from "../../mobile/lod";

// Only board-served HTML artifacts qualify. Preserve relative asset URLs while
// normalizing historical board hostnames to this server's origin.
export function reportUrl(raw: string): string | null {
  try {
    const u = new URL(raw, window.location.origin);
    if (!/^https?:$/.test(u.protocol) || !/^\/api\/assets\/(?:files|bundles)\/[a-f0-9]{32}\/[^/]+\.html?$/i.test(u.pathname)) return null;
    return `${window.location.origin}${u.pathname}`;
  } catch { return null; }
}
// A link card's title for its phone placeholder: the page title, else the host.
function bookmarkTitle(editor: Editor, shape: TLBookmarkShape): string {
  const asset = shape.props.assetId ? (editor.getAsset(shape.props.assetId) as { props?: { title?: string } } | undefined) : undefined;
  if (asset?.props?.title) return asset.props.title;
  try {
    return new URL(shape.props.url).host || "Link";
  } catch {
    return "Link";
  }
}
function reportName(src: string): string { const name = src.split("/").at(-1) ?? "Report"; try { return decodeURIComponent(name); } catch { return name; } }
function Report({ shape, src }: { shape: TLBookmarkShape; src: string }) {
  const editor = useEditor();
  const locked = useValue("report-lock", () => layoutLockedHere(editor) || editor.isShapeOrAncestorLocked(shape), [editor, shape]);
  const open = shape.props.h >= 300;
  return <HTMLContainer style={{ width: shape.props.w, height: shape.props.h, border: "1px solid light-dark(#bbb, var(--bunny-line))", borderRadius: 8, background: "light-dark(white, var(--bunny-surface))", overflow: "hidden", display: "flex", flexDirection: "column" }}>
    <div style={{ padding: 8, pointerEvents: "all", font: "12px system-ui", display: "flex", flexWrap: "wrap", gap: 6 }} onPointerDown={e => e.stopPropagation()}>
      <strong>HTML report</strong>
      <button type="button" data-testid="report-toggle" disabled={locked} onClick={() => editor.updateShape({ id: shape.id, type: "bookmark", props: { h: open ? 101 : 440, w: open ? shape.props.w : Math.max(360, shape.props.w) } })}>{open ? "Collapse" : "Open inline"}</button>
      <a href={src} target="_blank" rel="noopener noreferrer">Open file <Emoji name="open" /></a>
      <span>Sandboxed · no board access</span>
    </div>
    {open ? <iframe data-testid="inline-report" title="Sandboxed HTML report" src={src} sandbox="allow-scripts" referrerPolicy="no-referrer" style={{ width: "100%", flex: 1, minHeight: 0, border: 0, pointerEvents: "all" }} /> : <div style={{ padding: 8, font: "12px system-ui", overflowWrap: "anywhere" }}>{reportName(src)}</div>}
  </HTMLContainer>;
}
export class ReportBookmarkShapeUtil extends BookmarkShapeUtil {
  override getGeometry(shape: TLBookmarkShape) { return reportUrl(shape.props.url) ? new Rectangle2d({ width: shape.props.w, height: shape.props.h, isFilled: true }) : super.getGeometry(shape); }
  override getIndicatorPath(shape: TLBookmarkShape) { if (!reportUrl(shape.props.url)) return super.getIndicatorPath(shape); const p = new Path2D(); p.rect(0, 0, shape.props.w, shape.props.h); return p; }
  // Phone overview / off screen: a placeholder; an inline report's iframe is not mounted (mobile/lod.tsx).
  override component(shape: TLBookmarkShape) {
    const src = reportUrl(shape.props.url);
    return phoneLod(shape, true, () => <CardPlaceholder w={shape.props.w} h={shape.props.h} title={src ? `HTML report · ${reportName(src)}` : bookmarkTitle(this.editor, shape)} tone={src ? "#fff" : "#f3f1ec"} />, () => (src ? <Report shape={shape} src={src} /> : super.component(shape)));
  }
  override onBeforeCreate(shape: TLBookmarkShape) { return reportUrl(shape.props.url) ? shape : super.onBeforeCreate(shape); }
  override onBeforeUpdate(prev: TLBookmarkShape, shape: TLBookmarkShape) { return reportUrl(shape.props.url) ? shape : super.onBeforeUpdate(prev, shape); }
}
