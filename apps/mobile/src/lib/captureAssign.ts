/**
 * Where a capture goes when it is assigned to a group: the add-expense form,
 * prefilled from the capture and carrying its id so saving there closes the
 * capture (useAssignCapture) rather than leaving a duplicate behind.
 *
 * One place builds this href so the two callers that assign — the inbox's group
 * picker and the "New group" flow that creates a group then drops the capture
 * into it — hand the form exactly the same params. The caller chooses how to
 * navigate: the picker pushes (back returns to the inbox), the new-group flow
 * replaces (back must not return to the half-made group screen).
 */

import { type CaptureRow } from '@/data/types';

export function assignCaptureHref(capture: CaptureRow, groupId: string) {
  return {
    pathname: '/group/[id]/add-expense' as const,
    params: {
      id: groupId,
      captureId: capture.id,
      description: capture.description,
      // The amount travels as the same minor-unit string the row stores.
      amount: capture.amount,
      category: capture.category ?? '',
      // A custom tag rides along as JSON so the assigned expense keeps it,
      // rather than dropping to a built-in (extends TDR §8).
      ...(capture.category_meta ? { categoryMeta: JSON.stringify(capture.category_meta) } : {}),
      // The place the capture recorded, so the assigned expense keeps it (A43).
      ...(capture.location ? { location: JSON.stringify(capture.location) } : {}),
      expenseDate: capture.expense_date,
    },
  };
}
