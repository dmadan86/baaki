import { dayKey } from './activity';
import type { NotificationRow } from './types';

export interface NotificationDaySection {
  key: string;
  first: NotificationRow;
  data: NotificationRow[];
}

/**
 * The inbox cut into calendar days, newest first — the same day-heading grouping
 * the Activity feed uses, so the two screens that sit together read the same way.
 * The query already returns rows sorted; this only draws the lines between days.
 */
export function groupNotificationsByDay(
  rows: readonly NotificationRow[],
): NotificationDaySection[] {
  const sections: NotificationDaySection[] = [];
  for (const row of rows) {
    const key = dayKey(row.created_at);
    const last = sections[sections.length - 1];
    if (last && last.key === key) last.data.push(row);
    else sections.push({ key, first: row, data: [row] });
  }
  return sections;
}
