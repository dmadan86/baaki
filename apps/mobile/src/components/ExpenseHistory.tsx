import Ionicons from '@expo/vector-icons/Ionicons';
import { View } from 'react-native';

import {
  Avatar,
  Badge,
  Card,
  directionalIcon,
  iconSize,
  MoneyText,
  Row,
  SectionHeader,
  Text,
  useTheme,
} from '@waves/ui';

import type { ExpenseVersionAudit } from '@/data/api';
import type { ExpenseImageEventRow } from '@/data/hooks';
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

/** A wall-clock timestamp (when the edit was saved). */
function stampLabel(locale: string, iso: string): string {
  return new Intl.DateTimeFormat(locale, {
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
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
      currency: string;
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
      currency: cur.currency,
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
  // Participants: the count of people splitting the bill, which is what "3 → 2"
  // means. Amount-only edits keep the same set, so they never show here.
  if (memberKey(prev.shares) !== memberKey(cur.shares)) {
    changes.push({
      key: 'participants',
      label: t.expense.audit.participants,
      kind: 'text',
      oldText: String(prev.shares.length),
      newText: String(cur.shares.length),
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
            currency={change.currency as never}
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
            currency={change.currency as never}
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
  const entries = ascending.map((version, index) => ({
    version,
    changes: index === 0 ? [] : diffVersions(t, locale, nameOf, ascending[index - 1]!, version),
    created: index === 0,
  }));
  // Newest first for display.
  entries.reverse();

  return (
    <View style={{ gap: theme.spacing.xl }}>
      <View>
        <SectionHeader title={t.expense.history} />
        <View style={{ gap: theme.spacing.md }}>
          {entries.map(({ version, changes, created }) => (
            <Card key={version.id} style={{ gap: theme.spacing.md }}>
              <Row style={{ alignItems: 'center', gap: theme.spacing.md }}>
                <Avatar name={`v${version.version_no}`} emoji={created ? '🧾' : '✏️'} size={38} />
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text variant="subheading" numberOfLines={1}>
                    {fill(created ? t.expense.createdByName : t.expense.editedByName, {
                      name: nameOf(version.author_member_id),
                    })}
                  </Text>
                  <Text variant="micro" tone="muted" numberOfLines={1}>
                    {stampLabel(locale, version.created_at)}
                  </Text>
                </View>
                <MoneyText
                  amount={BigInt(version.amount)}
                  currency={version.currency as never}
                  locale={locale}
                  variant="caption"
                />
              </Row>
              {created ? null : changes.length === 0 ? (
                <Text variant="caption" tone="muted">
                  {t.expense.noChanges}
                </Text>
              ) : (
                <View style={{ gap: theme.spacing.sm, paddingLeft: 38 + theme.spacing.md }}>
                  {changes.map((change) => (
                    <ChangeLine key={change.key} change={change} locale={locale} />
                  ))}
                </View>
              )}
            </Card>
          ))}
        </View>
      </View>

      {/* The image audit (A46): who added or removed a receipt or attachment,
          oldest first. A `parties` line only reaches a party's device (RLS on
          the pull). Absent until something happens to an image. */}
      {imageEvents.length > 0 ? (
        <View>
          <SectionHeader title={t.imageAudit.title} />
          <Card padded={false} style={{ paddingHorizontal: theme.spacing.lg }}>
            {imageEvents.map((event, index) => (
              <View key={event.id}>
                <Row
                  style={{
                    alignItems: 'center',
                    gap: theme.spacing.md,
                    paddingVertical: theme.spacing.md,
                  }}
                >
                  <Avatar
                    name={nameOf(event.actorMemberId)}
                    emoji={event.action === 'added' ? '📎' : '🗑️'}
                    size={38}
                  />
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text variant="body" numberOfLines={2}>
                      {imageAuditLine(t, event, nameOf(event.actorMemberId))}
                    </Text>
                    {event.createdAt ? (
                      <Text variant="micro" tone="muted" numberOfLines={1}>
                        {stampLabel(locale, event.createdAt)}
                      </Text>
                    ) : null}
                  </View>
                  {event.visibility === 'parties' ? (
                    <Badge label={t.imageAudit.partyOnly} tone="neutral" />
                  ) : null}
                </Row>
                {index < imageEvents.length - 1 ? (
                  <View style={{ height: 1, backgroundColor: theme.color.border }} />
                ) : null}
              </View>
            ))}
          </Card>
        </View>
      ) : null}
    </View>
  );
}
