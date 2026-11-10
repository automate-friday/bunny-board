// Phone shell: what the next Undo takes back, for the Undo chips ("Undo push", then "Undo
// resize"). One tap is one visible step: tldraw undoes back to the last stopping point, and every
// phone edit marks one (editGestures.ts, resize.ts, AddSheet.tsx) with a name read here.
import type { Editor } from "tldraw";

type Entry = { type: "stop"; id: string } | { type: "diff" };

// The phone's marks ("[phone push neighbours]_<id>") and the word the chip shows for each.
const WORDS: [RegExp, string][] = [
  [/^\[phone push neighbours\]/, "push"],
  [/^\[phone resize\]/, "resize"],
  [/^\[phone move\]/, "move"],
  [/^\[phone delete\]/, "delete"],
  [/^\[phone add /, "add"],
];

// The mark the next undo stops at, given the undo stack from the top and whether anything has
// changed since the last mark (tldraw's HistoryManager._undo): with pending changes, the newest
// mark; with none, the empty marks on top are skipped and the undo runs to the next mark below
// a change.
export function nextUndoMark(undos: readonly Entry[], pendingEmpty: boolean): string | null {
  let i = 0;
  if (pendingEmpty) {
    while (i < undos.length && undos[i].type === "stop") i++;
    if (i >= undos.length) return null;
  }
  for (; i < undos.length; i++) {
    const e = undos[i];
    if (e.type === "stop") return e.id;
  }
  return null;
}

export function undoWord(markId: string | null): string | null {
  if (!markId) return null;
  return WORDS.find(([re]) => re.test(markId))?.[1] ?? null;
}

// Reactive (the history's stacks and pending diff are atoms): call inside useValue.
export function nextUndoWord(editor: Editor): string | null {
  try {
    const h = (editor as unknown as { history: { stacks: { get(): { undos: { head?: Entry; tail?: unknown } } }; pendingDiff: { isEmpty(): boolean } } }).history;
    const pendingEmpty = h.pendingDiff.isEmpty();
    const list: Entry[] = [];
    let s = h.stacks.get().undos as { head?: Entry; tail?: unknown } | undefined;
    // Far enough for any phone step; the stack can hold a whole session.
    while (s?.head && list.length < 400) {
      list.push(s.head);
      if (s.head.type === "stop" && list.some((e) => e.type === "diff")) break;
      s = s.tail as typeof s;
    }
    return undoWord(nextUndoMark(list, pendingEmpty));
  } catch {
    return null;
  }
}
