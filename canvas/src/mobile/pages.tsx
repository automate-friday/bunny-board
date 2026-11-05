// Phone shell pages: the board's tldraw pages (same names and order as desktop), listed under
// the open board in the "Bunny board ▾" menu. Picking one shows that page's frames as tiles
// and switches the editor to it, so the phone keeps the desktop's map of the board.

import { useMemo } from "react";
import { type Editor, useValue } from "tldraw";
import "./pages.css";

export type PageItem = { id: string; name: string };

export function usePages(editor: Editor): PageItem[] {
  // A string, so the list is a new array only when a page is added, renamed or moved.
  const key = useValue("mobile-pages", () => JSON.stringify(editor.getPages().map((p) => [p.id, p.name])), [editor]);
  return useMemo(() => (JSON.parse(key) as [string, string][]).map(([id, name]) => ({ id, name })), [key]);
}

// The tiles for a page (null: every page).
export function pageTiles<T extends { pageId: string }>(frames: readonly T[], page: string | null): T[] {
  return page ? frames.filter((f) => f.pageId === page) : [...frames];
}

export function PageMenu({ pages, frames, current, pick }: { pages: PageItem[]; frames: readonly { pageId: string }[]; current: string | null; pick: (page: string | null) => void }) {
  const count = (id: string | null) => pageTiles(frames, id).length;
  return (
    <div className="bm-pages" data-testid="mobile-pages" role="group" aria-label="Pages">
      {pages.map((p) => (
        <button key={p.id} type="button" role="menuitemradio" aria-checked={current === p.id} data-testid="mobile-page" data-page-id={p.id} onClick={() => pick(p.id)}>
          <span>{p.name}</span>
          <small>
            {count(p.id)} frame{count(p.id) === 1 ? "" : "s"}
          </small>
        </button>
      ))}
      <button type="button" role="menuitemradio" aria-checked={current === null} data-testid="mobile-page-all" onClick={() => pick(null)}>
        <span>All pages</span>
        <small>
          {count(null)} frame{count(null) === 1 ? "" : "s"}
        </small>
      </button>
    </div>
  );
}
