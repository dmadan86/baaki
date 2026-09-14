/**
 * Review selection is a screen interaction, but the failure mode is structural:
 * hidden batch members must not count as visible checkboxes, and every batch
 * placement path must end the selection. The source is small enough to pin those
 * contracts without mounting the native screen.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const SCREEN = readFileSync(join(process.cwd(), 'src/app/(tabs)/captures.tsx'), 'utf8');

describe('Review selection source contracts', () => {
  it('selects only visible single rows, not hidden members folded into a batch', () => {
    expect(SCREEN).toContain("feedItems.filter((item) => item.kind === 'single')");
    expect(SCREEN).toContain('selected.has(row.id) && selectableSet.has(row.id)');
  });

  it('preserves a user/rider/traveller/financer selection when one visible row is assigned alone', () => {
    const chooseExistingGroup = SCREEN.slice(
      SCREEN.indexOf('const chooseExistingGroup = useCallback('),
      SCREEN.indexOf('const assignToPeople = useCallback('),
    );

    expect(chooseExistingGroup).toContain("if (target.kind === 'batch')");
    expect(chooseExistingGroup).toContain('setSelecting(false);');
    expect(chooseExistingGroup).toContain('setSelected(new Set());');
    expect(chooseExistingGroup).toContain("if (target.kind === 'capture')");
  });

  it('ends selection when a whole batch is placed into a new group or Just me', () => {
    const assignToPeople = SCREEN.slice(
      SCREEN.indexOf('const assignToPeople = useCallback('),
      SCREEN.indexOf('const closeMenu = useCallback('),
    );
    const pickerMe = SCREEN.slice(
      SCREEN.indexOf("} else if (choice.kind === 'me')"),
      SCREEN.indexOf("} else if (choice.kind === 'create'"),
    );

    expect(assignToPeople).toContain('setSelecting(false);');
    expect(assignToPeople).toContain('setSelected(new Set());');
    expect(pickerMe).toContain("if (target.kind === 'batch')");
    expect(pickerMe).toContain('setSelecting(false);');
    expect(pickerMe).toContain('setSelected(new Set());');
  });
});
