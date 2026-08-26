import { describe, expect, it } from 'vitest';

import { groupNotificationsByDay } from '../src/data/inbox';
import type { NotificationRow } from '../src/data/types';

function row(id: string, createdAt: string): NotificationRow {
  return {
    id,
    group_id: null,
    kind: 'nudge',
    title: 'Title',
    body: 'Body',
    deep_link: null,
    payload: {},
    read_at: null,
    created_at: createdAt,
  };
}

describe('groupNotificationsByDay', () => {
  it('keeps notification order while grouping consecutive rows by local day', () => {
    const sections = groupNotificationsByDay([
      row('newer-1', '2026-08-26T10:00:00.000Z'),
      row('newer-2', '2026-08-26T09:00:00.000Z'),
      row('older-1', '2026-08-24T10:00:00.000Z'),
    ]);

    expect(sections.map((section) => section.key)).toEqual(['2026-8-26', '2026-8-24']);
    expect(sections[0]?.data.map((item) => item.id)).toEqual(['newer-1', 'newer-2']);
    expect(sections[0]?.first.id).toBe('newer-1');
    expect(sections[1]?.data.map((item) => item.id)).toEqual(['older-1']);
  });

  it('returns no sections for an empty inbox', () => {
    expect(groupNotificationsByDay([])).toEqual([]);
  });
});
