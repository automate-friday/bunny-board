// Use the same validators and defaults as the server document schema.
import { checklistProps as sharedChecklistProps, type ChecklistProps } from "../../../../shared/components/checklist";
export { CHECKLIST_TYPE, checklistDefaults, type ChecklistProps } from "../../../../shared/components/checklist";

export function checklistProps(value: Record<string, unknown>): ChecklistProps | null {
  try { return sharedChecklistProps(value as Partial<ChecklistProps>); }
  catch { return null; }
}
