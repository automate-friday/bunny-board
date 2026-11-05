import { perfCount } from "./perf";
import type { Editor, TLShapePartial } from "tldraw";
import { textBoundsSignature } from "../../shared/text-bounds";

// Browser geometry is a layout hint. Local bounds already include shape scale;
// page bounds would rotate them and must not be used here.
export function installTextBoundsMeasurements(editor: Editor) {
  let stopped = false, scheduled = 0;
  // Immutable records already checked in this browser need no geometry work on pan.
  // Never trust incoming measurements before this local validation; font loads reset it.
  let validated = new WeakSet<object>();
  const stats = { passes: 0, examined: 0, measured: 0, writes: 0, milliseconds: 0 };
  (window as unknown as { __textMeasurementStats: typeof stats }).__textMeasurementStats = stats;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const measure = () => {
    scheduled = 0;
    if (stopped || document.fonts.status !== "loaded") return;
    const started = performance.now(); stats.passes++; perfCount("text-bounds-pass");
    const changes: TLShapePartial[] = [];
    const culled = editor.getCulledShapes();
    for (const shape of editor.getCurrentPageShapes()) {
      if (!["note", "text", "geo"].includes(shape.type)) continue;
      if (culled.has(shape.id)) continue;
      stats.examined++;
      if (validated.has(shape)) continue;
      stats.measured++;
      const bounds = editor.getShapeGeometry(shape).bounds;
      const { w, h } = bounds;
      if (![w, h].every(n => Number.isFinite(n) && n > 0 && n <= 100000)) continue;
      validated.add(shape);
      const signature = textBoundsSignature({type:shape.type,props:{...shape.props}});
      const old = shape.meta.measuredTextBounds as { version?: number; signature?: string; w?: number; h?: number } | undefined;
      if (old?.version === 1 && old.signature === signature && Math.abs((old.w ?? 0) - w) < 0.1 && Math.abs((old.h ?? 0) - h) < 0.1) continue;
      changes.push({ id: shape.id, type: shape.type, meta: { ...shape.meta, measuredTextBounds: { version: 1, signature, w, h } } });
    }
    if (changes.length) {
      stats.writes += changes.length;
      const propsBefore = new Map(changes.map(change => [change.id, editor.getShape(change.id)?.props]));
      editor.run(() => editor.updateShapes(changes), { history: "ignore" });
      for (const change of changes) { const stored = editor.getShape(change.id); if (stored && stored.props === propsBefore.get(change.id)) validated.add(stored); }
    }
    stats.milliseconds += performance.now() - started;
  };
  const schedule = () => {
    if (stopped || timer || scheduled) return;
    timer = setTimeout(() => { timer = undefined; scheduled = requestAnimationFrame(measure); }, 120);
  };
  const unlisten = editor.store.listen(entry => {
    perfCount("text-bounds-listener");
    const records = [...Object.values(entry.changes.added), ...Object.values(entry.changes.updated).map(pair => pair[1]), ...Object.values(entry.changes.removed)];
    if (records.some(record => ["shape", "camera", "instance_page_state"].includes(record.typeName))) schedule();
  }, { scope: "all" });
  const fontsChanged = () => { validated = new WeakSet<object>(); schedule(); };
  document.fonts.addEventListener("loadingdone", fontsChanged);
  void document.fonts.ready.then(schedule);
  schedule();
  return () => { stopped = true; clearTimeout(timer); cancelAnimationFrame(scheduled); unlisten(); document.fonts.removeEventListener("loadingdone", fontsChanged); };
}
