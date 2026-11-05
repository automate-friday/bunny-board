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
