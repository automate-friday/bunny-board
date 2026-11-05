// The phone composer's photo row: photos go out in the row's order, so moving one is a pure
// list move (unit-tested).

export function moveItem<T>(list: readonly T[], from: number, to: number): T[] {
  if (from < 0 || from >= list.length) return [...list];
  const target = Math.max(0, Math.min(list.length - 1, to));
  if (target === from) return [...list];
  const out = [...list];
  const [item] = out.splice(from, 1);
  out.splice(target, 0, item);
  return out;
}

// Where the dragged photo (at `from`) lands with the finger at `x`: after every other photo
// whose centre the finger has passed. `centres` are the thumbnails' horizontal centres in
// their current order.
export function dropIndex(centres: readonly number[], from: number, x: number): number {
  return centres.filter((c, j) => j !== from && c < x).length;
}
