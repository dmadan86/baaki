import Ionicons from '@expo/vector-icons/Ionicons';
import { View } from 'react-native';

import { Badge, directionalIcon, iconSize, MoneyText, Row, Text, useTheme } from '@waves/ui';

import type { ExpenseVersionAudit } from '@/data/api';
import type { ExpenseImageEventRow } from '@/data/hooks';
import { type ActivityTint, dayHeading, groupByDay, relativeTime } from '@/data/activity';
import { coordLabel } from '@/lib/location';
import { fill, type UiStrings } from '@/i18n';

/**
 * The edit history of one expense, said as an audit: for every version after
 * the first, exactly which fields changed and what they went from and to
 * (ADR-004 — nothing is overwritten, and the group can see what changed). The
 * image audit (A46 — who added or removed a receipt or attachment) rides in the
 * same timeline underneath.
 *
 * The bug this fixes: the old history was a flat list of versions showing only
 * each version's amount, so editing 30,000 → 300 left no trace of *what*
 * happened. Now each edit spells out `Amount  30,000 → 300`.
 */

function splitLabel(t: UiStrings, splitType: string): string {
  const map: Record<string, string> = {
    equal: t.expense.splitEqually,
    exact: t.expense.exactAmounts,
    percent: t.expense.byPercentage,
    shares: t.expense.byShares,
    adjustment: t.expense.withAdjustments,
    itemized: t.expense.itemized,
  };
  return map[splitType] ?? splitType;
}

function categoryLabel(t: UiStrings, version: ExpenseVersionAudit): string {
  const builtins = t.categories as Record<string, string>;
  return (
    version.category_meta?.label ??
    (version.category ? (builtins[version.category] ?? version.category) : t.expense.audit.none)
  );
}

function locationLabel(t: UiStrings, version: ExpenseVersionAudit): string {
  const location = version.location;
  if (!location) return t.expense.audit.none;
  return location.name?.trim() || coordLabel(location);
}

/** A date with no time (the expense's own date), read in UTC to match the rest
 *  of the screen. */
function dateLabel(locale: string, iso: string): string {
  return new Intl.DateTimeFormat(locale, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(iso));
}

/** The set of member ids on a side, sorted, as a stable comparison key. */
function memberKey(rows: { member_id: string }[]): string {
  return rows
    .map((row) => row.member_id)
    .sort()
    .join(',');
}

type Change =
  | {
      key: string;
      label: string;
      kind: 'money';
      oldAmount: bigint;
      newAmount: bigint;
      oldCurrency: string;
      newCurrency: string;
    }
  | { key: string; label: string; kind: 'text'; oldText: string; newText: string };

function diffVersions(
  t: UiStrings,
  locale: string,
  nameOf: (id: string | null) => string,
  prev: ExpenseVersionAudit,
  cur: ExpenseVersionAudit,
): Change[] {
  const changes: Change[] = [];

  if (prev.amount !== cur.amount || prev.currency !== cur.currency) {
    changes.push({
      key: 'amount',
      label: t.expense.audit.amount,
      kind: 'money',
      oldAmount: BigInt(prev.amount),
      newAmount: BigInt(cur.amount),
      oldCurrency: prev.currency,
      newCurrency: cur.currency,
    });
  }
  if ((prev.description ?? '').trim() !== (cur.description ?? '').trim()) {
    changes.push({
      key: 'description',
      label: t.expense.audit.description,
      kind: 'text',
      oldText: (prev.description ?? '').trim() || t.expense.audit.none,
      newText: (cur.description ?? '').trim() || t.expense.audit.none,
    });
  }
  if (
    (prev.category ?? '') !== (cur.category ?? '') ||
    prev.category_meta?.label !== cur.category_meta?.label
  ) {
    changes.push({
      key: 'category',
      label: t.expense.audit.category,
      kind: 'text',
      oldText: categoryLabel(t, prev),
      newText: categoryLabel(t, cur),
    });
  }
  if (prev.split_type !== cur.split_type) {
    changes.push({
      key: 'split',
      label: t.expense.audit.split,
      kind: 'text',
      oldText: splitLabel(t, prev.split_type),
      newText: splitLabel(t, cur.split_type),
    });
  }
  if (prev.expense_date !== cur.expense_date) {
    changes.push({
      key: 'date',
      label: t.expense.audit.date,
      kind: 'text',
      oldText: dateLabel(locale, prev.expense_date),
      newText: dateLabel(locale, cur.expense_date),
    });
  }
  if (locationLabel(t, prev) !== locationLabel(t, cur)) {
    changes.push({
      key: 'location',
      label: t.expense.audit.location,
      kind: 'text',
      oldText: locationLabel(t, prev),
      newText: locationLabel(t, cur),
    });
  }
  // Who paid: compare the set of payers, not amounts (an amount move is already
  // the Amount line). A changed set is a real "someone else paid".
  if (memberKey(prev.payers) !== memberKey(cur.payers)) {
    changes.push({
      key: 'payers',
      label: t.expense.audit.payers,
      kind: 'text',
      oldText: prev.payers.map((p) => nameOf(p.member_id)).join(', ') || t.expense.audit.none,
      newText: cur.payers.map((p) => nameOf(p.member_id)).join(', ') || t.expense.audit.none,
    });
  }
  // Participants: who is splitting the bill, by name — the same treatment as
  // payers. Named rather than counted, so replacing one person with another
  // (the set changes but the count does not) reads as a real change instead of
  // an identical "3 → 3". Amount-only edits keep the same set, so they never
  // show here.
  if (memberKey(prev.shares) !== memberKey(cur.shares)) {
    changes.push({
      key: 'participants',
      label: t.expense.audit.participants,
      kind: 'text',
      oldText: prev.shares.map((s) => nameOf(s.member_id)).join(', ') || t.expense.audit.none,
      newText: cur.shares.map((s) => nameOf(s.member_id)).join(', ') || t.expense.audit.none,
    });
  }

  return changes;
}

/** One "old → new" line: a field name, then the two values with a direction
 *  arrow between them. Money renders through MoneyText; everything else is
 *  plain text with the previous value struck through. */
function ChangeLine({ change, locale }: { change: Change; locale: string }) {
  const theme = useTheme();
  return (
    <View style={{ gap: 2 }}>
      <Text variant="micro" tone="muted">
        {change.label}
      </Text>
      <Row style={{ alignItems: 'center', gap: theme.spacing.sm, flexWrap: 'wrap' }}>
        {change.kind === 'money' ? (
          <MoneyText
            amount={change.oldAmount}
            currency={change.oldCurrency as never}
            locale={locale}
            variant="caption"
            tone="muted"
          />
        ) : (
          <Text
            variant="caption"
            tone="muted"
            style={{ textDecorationLine: 'line-through' }}
            numberOfLines={2}
          >
            {change.oldText}
          </Text>
        )}
        <Ionicons
          name={directionalIcon('arrow-forward')}
          size={iconSize.sm}
          color={theme.color.textFaint}
        />
        {change.kind === 'money' ? (
          <MoneyText
            amount={change.newAmount}
            currency={change.newCurrency as never}
            locale={locale}
            variant="caption"
          />
        ) : (
          <Text variant="caption" numberOfLines={2} style={{ flexShrink: 1 }}>
            {change.newText}
          </Text>
        )}
      </Row>
    </View>
  );
}

/** One line of the image audit — "{name} added the receipt", etc. */
function imageAuditLine(t: UiStrings, event: ExpenseImageEventRow, name: string): string {
  const template =
    event.kind === 'receipt'
      ? event.action === 'added'
        ? t.imageAudit.receiptAdded
        : t.imageAudit.receiptRemoved
      : event.action === 'added'
        ? t.imageAudit.attachmentAdded
        : t.imageAudit.attachmentRemoved;
  return fill(template, { name });
}

/** One node on the expense's timeline — a version edit or an image event, in the
 *  same shape so both render as one activity-style feed. */
interface HistoryEvent {
  id: string;
  created_at: string;
  icon: React.ComponentProps<typeof Ionicons>['name'];
  tint: ActivityTint;
  title: string;
  /** Version amount, when the node is a version. */
  money?: { amount: bigint; currency: string };
  /** The field-level diff of an edit; empty for the "created" node. */
  changes?: Change[];
  /** True for the very first version (a creation, no diff to show). */
  created?: boolean;
  /** A party-only image event wears a badge. */
  partyOnly?: boolean;
}

export function ExpenseHistory({
  versions,
  imageEvents,
  nameOf,
  t,
  locale,
}: {
  /** Newest version first, as `fetchExpenseVersions` returns them. */
  versions: ExpenseVersionAudit[];
  imageEvents: ExpenseImageEventRow[];
  nameOf: (id: string | null) => string;
  t: UiStrings;
  locale: string;
}) {
  const theme = useTheme();

  // Ascending, so each version can look one step back for its diff.
  const ascending = [...versions].sort((a, b) => a.version_no - b.version_no);
  // A fallback timestamp for the rare image event with no recorded time, so it
  // still buckets into a day rather than an invalid heading. Fall back to the
  // oldest version stamp (so an undated event sorts to the tail, not the top),
  // and to an image event's own stamp when there is no version at all — without
  // that second step an all-image, version-less history would drop every undated
  // event outright.
  const fallbackIso =
    ascending[0]?.created_at ?? imageEvents.find((event) => event.createdAt)?.createdAt ?? '';

  const versionEvents: HistoryEvent[] = ascending.map((version, index) => {
    const created = index === 0;
    return {
      id: `v-${version.id}`,
      created_at: version.created_at,
      icon: created ? 'receipt-outline' : 'create-outline',
      tint: created ? 'mint' : 'sky',
      title: fill(created ? t.expense.createdByName : t.expense.editedByName, {
        name: nameOf(version.author_member_id),
      }),
      money: { amount: BigInt(version.amount), currency: version.currency },
      changes: created ? [] : diffVersions(t, locale, nameOf, ascending[index - 1]!, version),
      created,
    };
  });

  // The image audit (A46): who added or removed a receipt or attachment. A
  // `parties` line only reaches a party's device (RLS on the pull). Folded into
  // the same timeline so history reads as one feed.
  const imageAuditEvents: HistoryEvent[] = imageEvents.map((event) => ({
    id: `i-${event.id}`,
    created_at: event.createdAt ?? fallbackIso,
    icon: event.action === 'added' ? 'attach-outline' : 'trash-outline',
    tint: event.action === 'added' ? 'lilac' : 'coral',
    title: imageAuditLine(t, event, nameOf(event.actorMemberId)),
    partyOnly: event.visibility === 'parties',
  }));

  // Merge, drop anything with an unreadable timestamp, and sort newest-first so
  // the day buckets come out latest-day-first (like the Activity feed).
  const events = [...versionEvents, ...imageAuditEvents]
    .filter((event) => Number.isFinite(Date.parse(event.created_at)))
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
  const sections = groupByDay(events);

  return (
    <View>
      {sections.map((section) => (
        <View key={section.key}>
          {/* Day heading — the split that makes a long history skimmable, the
              same uppercase micro label the Activity feed uses. */}
          <Text
            variant="micro"
            tone="muted"
            style={{
              textTransform: 'uppercase',
              marginTop: theme.spacing.lg,
              marginBottom: theme.spacing.sm,
            }}
          >
            {dayHeading(locale, section.entries[0]!.created_at)}
          </Text>

          {section.entries.map((event, index) => {
            const tint = theme.tint[event.tint];
            return (
              <View key={event.id}>
                <Row
                  style={{
                    gap: theme.spacing.md,
                    alignItems: 'flex-start',
                    paddingVertical: theme.spacing.md,
                  }}
                >
                  {/* The soft rounded-square icon tile — the same row shape the
                      Activity and group feeds use, so history reads one way. */}
                  <View
                    style={{
                      width: 40,
                      height: 40,
                      borderRadius: theme.radius.md,
                      alignItems: 'center',
                      justifyContent: 'center',
                      backgroundColor: tint.bg,
                    }}
                  >
                    <Ionicons name={event.icon} size={iconSize.lg} color={tint.ink} />
                  </View>

                  <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                    <Row style={{ gap: theme.spacing.sm, alignItems: 'flex-start' }}>
                      <Text variant="body" numberOfLines={2} style={{ flex: 1 }}>
                        {event.title}
                      </Text>
                      {event.money ? (
                        <MoneyText
                          amount={event.money.amount}
                          currency={event.money.currency as never}
                          locale={locale}
                          variant="caption"
                        />
                      ) : event.partyOnly ? (
                        <Badge label={t.imageAudit.partyOnly} tone="neutral" />
                      ) : null}
                    </Row>
                    <Text variant="micro" tone="muted" numberOfLines={1}>
                      {relativeTime(locale, event.created_at)}
                    </Text>

                    {/* An edit spells out what changed, aligned under its
                        sentence. A "created" node has no diff; an edit with no
                        detected field change says so plainly. */}
                    {event.created ? null : event.changes && event.changes.length > 0 ? (
                      <View style={{ gap: theme.spacing.sm, marginTop: theme.spacing.xs }}>
                        {event.changes.map((change) => (
                          <ChangeLine key={change.key} change={change} locale={locale} />
                        ))}
                      </View>
                    ) : event.money ? (
                      <Text variant="caption" tone="muted" style={{ marginTop: 2 }}>
                        {t.expense.noChanges}
                      </Text>
                    ) : null}
                  </View>
                </Row>

                {index < section.entries.length - 1 ? (
                  <View style={{ height: 1, backgroundColor: theme.color.border }} />
                ) : null}
              </View>
            );
          })}
        </View>
      ))}
    </View>
  );
}
