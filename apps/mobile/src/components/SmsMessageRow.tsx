/**
 * One bank message, as a row you can tick.
 *
 * The shape is the one every app of this kind has converged on, and it has
 * converged for a reason: a glyph for what it was, the shop, the day, the bank
 * and the last digits of the card, and the amount hard right where a column of
 * numbers can be read down in one pass. What differs here is what the row is
 * *for* — not "here is a transaction" but "is this yours to split?" — so three
 * things are added that a personal-finance list would not carry.
 *
 *   * **A tick box, always visible.** Not revealed by a long press. Choosing
 *     several and placing them together is the main verb of this screen, and a
 *     main verb behind a hidden gesture is a main verb most people never find.
 *   * **What the app was unsure of, on the row.** "Date guessed", "check this
 *     one" — the two doubts that decide whether a row went to Review by itself
 *     (`lib/smsInbox.ts`). A row marked this way is a row somebody should open
 *     before ticking, and saying which part is doubtful is the difference
 *     between a useful warning and a vague one.
 *   * **Whether Review already has it.** The confident expenses are in both
 *     places by design; a row that did not say so would look like a duplicate.
 *
 * The message body is never on the row, though the row has one. It is on the
 * detail screen, behind a tap, labelled as being on this phone only — a list
 * that printed everybody's bank messages down the side of the screen would be
 * a list nobody could open in public.
 */

import { memo } from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import { Pressable, View } from 'react-native';

import { SmsKind, type SmsOtherReason } from '@waves/core';
import { Badge, iconSize, MoneyText, Row, Text, useTheme } from '@waves/ui';

import { CategoryBadge } from '@/components/Category';
import { dayHeading } from '@/data/activity';
import type { UiStrings } from '@/i18n';
import { doubtsAbout, reachedReview } from '@/lib/smsInbox';
import type { StoredSms } from '@/lib/smsMessageTypes';

/** The words for why a row is in the third pile. */
export function reasonWords(reason: SmsOtherReason | null, t: UiStrings): string | null {
  switch (reason) {
    case 'card-bill':
      return t.smsInbox.reasonCardBill;
    case 'wallet-top-up':
      return t.smsInbox.reasonWalletTopUp;
    case 'investment':
      return t.smsInbox.reasonInvestment;
    case 'self-transfer':
      return t.smsInbox.reasonSelfTransfer;
    case 'cash-withdrawal':
      return t.smsInbox.reasonCashWithdrawal;
    case 'refund':
      return t.smsInbox.reasonRefund;
    default:
      return null;
  }
}

export const SmsMessageRow = memo(function SmsMessageRow({
  row,
  selected,
  locale,
  now,
  t,
  onToggle,
  onOpen,
}: {
  row: StoredSms;
  selected: boolean;
  locale: string;
  /** The screen's own clock — never `Date.now()` read while rendering. */
  now: number;
  t: UiStrings;
  onToggle: () => void;
  onOpen: () => void;
}): React.JSX.Element {
  const theme = useTheme();
  const doubts = doubtsAbout(row);
  const reason = reasonWords(row.reason, t);
  const inReview = reachedReview(row);
  const name = row.merchant ?? t.smsInbox.noShopNamed;

  // Money coming in reads as a credit; everything else reads as money leaving.
  // The sign is carried by the colour *and* the words beside it, never colour
  // alone (#191).
  const incoming = row.kind === SmsKind.Income;

  return (
    <Row
      style={{
        alignItems: 'center',
        gap: theme.spacing.md,
        paddingVertical: theme.spacing.md,
      }}
    >
      {/* The tick box owns its own hit area, so ticking a row and opening it
          are two different taps a thumb can tell apart. */}
      <Pressable
        accessibilityRole="checkbox"
        accessibilityState={{ checked: selected }}
        accessibilityLabel={`${name}. ${t.smsInbox.selectAll}`}
        hitSlop={10}
        onPress={onToggle}
      >
        <Ionicons
          name={selected ? 'checkbox' : 'square-outline'}
          size={iconSize.lg}
          color={selected ? theme.color.brand : theme.color.textMuted}
        />
      </Pressable>

      <Pressable
        accessibilityRole="button"
        accessibilityLabel={name}
        onPress={onOpen}
        style={({ pressed }) => ({
          flex: 1,
          flexDirection: 'row',
          alignItems: 'center',
          gap: theme.spacing.md,
          opacity: pressed ? 0.7 : 1,
        })}
      >
        {/* The glyph is guessed from the shop's own name — a coffee cup for a
            café — exactly as it is on every other row in the app. Nothing has
            chosen a category yet: that happens when the row becomes an expense. */}
        <CategoryBadge category={null} meta={null} description={row.merchant ?? ''} size={38} />

        <View style={{ flex: 1, minWidth: 0 }}>
          <Row style={{ alignItems: 'center', gap: theme.spacing.xs }}>
            <Text variant="body" numberOfLines={1} style={{ flexShrink: 1 }}>
              {name}
            </Text>
            {row.settledAs === null && row.readAt >= new Date(now - 86_400_000).toISOString() ? (
              <Badge label={t.smsInbox.isNew} tone="brand" />
            ) : null}
          </Row>

          <Row style={{ alignItems: 'center', gap: theme.spacing.xs, flexWrap: 'wrap' }}>
            <Text variant="micro" tone="muted">
              {dayHeading(locale, row.at, now)}
            </Text>
            {row.sender ? (
              <Text variant="micro" tone="muted" numberOfLines={1}>
                {`· ${row.sender}`}
              </Text>
            ) : null}
            {row.accountTail ? (
              <Text variant="micro" tone="muted">
                {`· ${row.accountTail}`}
              </Text>
            ) : null}
          </Row>

          {/* One line of marks, and only when there is something to say. */}
          {reason || doubts.length > 0 || inReview ? (
            <Row style={{ gap: theme.spacing.xs, flexWrap: 'wrap', marginTop: 2 }}>
              {reason ? <Badge label={reason} /> : null}
              {doubts.includes('date-inferred') ? (
                <Badge label={t.smsInbox.dateGuessed} tone="negative" />
              ) : null}
              {doubts.includes('hard-to-read') ? (
                <Badge label={t.smsInbox.hardToRead} tone="negative" />
              ) : null}
              {inReview ? <Badge label={t.smsInbox.inReview} tone="positive" /> : null}
            </Row>
          ) : null}
        </View>

        <MoneyText
          amount={BigInt(safeMinor(row.amount))}
          currency={row.currency}
          locale={locale}
          variant="body"
          tone={incoming ? 'positive' : undefined}
        />
      </Pressable>
    </Row>
  );
});

/**
 * An amount the ledger can take, or zero.
 *
 * A row whose amount is not a whole number of minor units is a parser bug, and
 * it is one this screen must survive rather than crash on: `BigInt('12.5')`
 * throws, and a throw inside a recycled list row takes the whole screen down.
 * The row is still shown — placing it will report it as unusable, which is the
 * honest outcome — and zero is visibly wrong rather than quietly plausible.
 */
function safeMinor(amount: string): string {
  return /^-?\d+$/.test(amount.trim()) ? amount.trim() : '0';
}
