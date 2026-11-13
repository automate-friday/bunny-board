// Shared document contract. No agent/runtime identity is stored in a checklist.
import { createShapePropsMigrationSequence } from '@tldraw/tlschema';
import { T } from '@tldraw/validate';

export const CHECKLIST_TYPE = 'checklist' as const;
export interface ChecklistItem { id: string; text: string; checked: boolean }
export interface ChecklistProps { title: string; items: ChecklistItem[]; w: number; h: number }
const boundedString = (max: number) => T.string.check(value => {
  if (value.length > max) throw new Error(`Must be at most ${max} characters`);
});
const itemId = boundedString(200).check(value => {
  if (!value.trim()) throw new Error('Checklist item ID must not be empty');
});
const dimension = T.number.check(value => {
  if (!Number.isFinite(value) || value <= 0) throw new Error('Checklist dimensions must be positive and finite');
});
export const checklistShapeProps = {
  title: boundedString(200),
  items: T.arrayOf(T.object({ id: itemId, text: boundedString(1000), checked: T.boolean })).check(items => {
    if (items.length > 100) throw new Error('Checklist allows at most 100 items');
    if (new Set(items.map(item => item.id)).size !== items.length) throw new Error('Checklist item IDs must be unique');
  }),
  w: dimension,
  h: dimension,
};
export const checklistMigrations = createShapePropsMigrationSequence({ sequence: [] });
export function checklistDefaults(): ChecklistProps {
  return { title: 'Checklist', items: [
    { id: 'item-1', text: 'First item', checked: false },
    { id: 'item-2', text: 'Second item', checked: false },
  ], w: 320, h: 240 };
}
export function checklistOutline(props: Pick<ChecklistProps, 'title' | 'items'>): string {
  const checked = props.items.filter(item => item.checked).length;
  return `checklist ${JSON.stringify(props.title)} ${checked}/${props.items.length}: ` +
    props.items.map(item => `[${item.checked ? 'x' : ' '}] ${item.text.replace(/\s+/g, ' ')} (${item.id})`).join('; ');
}

export function checklistProps(input: Partial<ChecklistProps>): ChecklistProps {
  const props = { ...checklistDefaults(),
    ...(input.title !== undefined ? {title: input.title} : {}),
    ...(input.items !== undefined ? {items: input.items} : {}),
    ...(input.w !== undefined ? {w: input.w} : {}),
    ...(input.h !== undefined ? {h: input.h} : {}),
  };
  for (const [key, validator] of Object.entries(checklistShapeProps)) validator.validate(props[key as keyof ChecklistProps]);
  return props;
}

// An agent's change to a checklist (board_update patch.items), merged by item id so ticks the
// person made in the meantime survive: an existing id takes the given text and/or checked,
// remove:true drops it, and an unknown id with text is appended. Throws with the reason and
// the checklist's ids when a change cannot apply.
export interface ChecklistItemChange { id: string; text?: string; checked?: boolean; remove?: boolean }
export function patchChecklistItems(items: readonly ChecklistItem[], changes: unknown): ChecklistItem[] {
  if (!Array.isArray(changes) || !changes.length) throw new Error('items must be a list like [{id, checked}] (ids are in board_read)');
  const next = items.map(item => ({ ...item }));
  for (const raw of changes as ChecklistItemChange[]) {
    if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || !raw.id.trim()) throw new Error('every item change needs an id');
    if (raw.text !== undefined && typeof raw.text !== 'string') throw new Error(`item ${raw.id}: text must be a string`);
    if (raw.checked !== undefined && typeof raw.checked !== 'boolean') throw new Error(`item ${raw.id}: checked must be true or false`);
    const at = next.findIndex(item => item.id === raw.id);
    if (at < 0) {
      const known = next.map(item => item.id).join(', ') || 'none';
      if (raw.remove) throw new Error(`no item ${JSON.stringify(raw.id)} to remove; this checklist's item ids are: ${known}`);
      if (raw.text === undefined) throw new Error(`no item ${JSON.stringify(raw.id)}; this checklist's item ids are: ${known}. Give text as well to add a new item`);
      next.push({ id: raw.id, text: raw.text, checked: raw.checked ?? false });
    } else if (raw.remove) next.splice(at, 1);
    else next[at] = { ...next[at], ...(raw.text !== undefined ? { text: raw.text } : {}), ...(raw.checked !== undefined ? { checked: raw.checked } : {}) };
  }
  return next;
}
