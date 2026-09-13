/**
 * One bank message, opened.
 *
 * This screen exists for a reason that is easy to state and was not obvious:
 * **a person cannot trust a parser they cannot check.** The list says "SWIGGY
 * ₹1,250, Tuesday". That is the app's reading of a message, and when it is
 * wrong — a merchant read out of a reference number, a date taken from the
 * wrong half of a UPI string — there is no way to tell from the row. Showing
 * the message the app was reading turns "I think this is wrong" into "I can see
 * why it is wrong", and that is the difference between a feature people audit
 * once and abandon, and one they come to rely on.
 *
 * ## Which is exactly why the body has to stay here
 *
 * It is on this phone (`lib/smsMessageStore.ts`), sealed at rest with the same
 * key as the ledger mirror, in a database the sync engine cannot see. It is
 * destroyed when the account signs out. The line under it on this screen says
 * so in as many words, because a person looking at their own bank messages
 * inside a splitting app deserves to be told, at that moment, where they are.
 *
 * What leaves the phone, if this row is placed in a group, is the shop, the
 * amount and the day. Not this text. `lib/smsDrafts.ts` and
 * `lib/smsPlacement.ts` are where that is enforced.
 *
 * ## The three things you can do
 *
 * **Add it to a group** — the ordinary path, one row instead of a batch.
 * **Set it aside** — it is not an expense, or not one worth splitting. It is
 * reversible, and this screen is where it is reversed.
 * **Delete it from Waves** — for when the row itself is the problem. The
 * message stays in the phone's own Messages app; only Waves' copy goes, which
 * the confirmation says, because "delete" next to a bank message reads far more
 * alarming than what it actually does.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import { ScrollView, View } from 'react-native';

import { SmsKind } from '@waves/core';
import {
  Badge,
  Button,
  Card,
  Divider,
  iconSize,
  IconButton,
  MoneyText,
  Row,
  Screen,
  Text,
  useTheme,
} from '@waves/ui';

import { CategoryBadge } from '@/components/Category';
import { reasonWords } from '@/components/SmsMessageRow';
import { dayHeading, relativeTime } from '@/data/activity';
import { plural, useStrings } from '@/i18n';
import { useAuth } from '@/lib/auth';
import { useBottomClearance } from '@/lib/clearance';
import { useDialog } from '@/lib/dialog';
import { useLocalSearchParams } from 'expo-router';

import { router } from '@/lib/navigation';
import { doubtsAbout, reachedReview } from '@/lib/smsInbox';
import { reloadMessages, useSmsMessages } from '@/lib/smsMessages';
import { forgetMessage, settleMessages, unsettleMessage } from '@/lib/smsMessageStore';
import { SmsSettlement } from '@/lib/smsMessageTypes';
import { useSmsInboxReader } from '@/lib/smsFeature';
import { useToast } from '@/lib/toast';

export default function SmsMessageScreen(): React.JSX.Element | null {
  const theme = useTheme();
  const { t, locale } = useStrings();
  const clearance = useBottomClearance();
  const { session } = useAuth();
  const ownerId = session?.user?.id ?? '';
  const reader = useSmsInboxReader();
  const toast = useToast();
  const { confirm } = useDialog();

  const params = useLocalSearchParams<{ key?: string }>();
  const dedupeKey = typeof params.key === 'string' ? params.key : '';

  const { rows } = useSmsMessages();
  const row = useMemo(
    () => rows.find((each) => each.dedupeKey === dedupeKey) ?? null,
    [rows, dedupeKey],
  );

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);

  const setAside = useCallback(async (): Promise<void> => {
    if (!row) return;
    await settleMessages(ownerId, [row.dedupeKey], SmsSettlement.Dismissed);
    await reloadMessages(ownerId);
    router.back();
  }, [ownerId, row]);

  const bringBack = useCallback(async (): Promise<void> => {
    if (!row) return;
    await unsettleMessage(ownerId, row.dedupeKey);
    await reloadMessages(ownerId);
  }, [ownerId, row]);

  const forget = useCallback(async (): Promise<void> => {
    if (!row) return;
    const ok = await confirm({
      title: t.smsInbox.forget,
      body: t.smsInbox.forgetConfirm,
      confirmLabel: t.common.delete,
      tone: 'danger',
    });
    if (!ok) return;
    await forgetMessage(ownerId, row.dedupeKey);
    await reloadMessages(ownerId);
    toast.show(t.smsInbox.forget);
    router.back();
  }, [confirm, ownerId, row, t.common.delete, t.smsInbox.forget, t.smsInbox.forgetConfirm, toast]);

  // Asked again here rather than trusted from the screen that pushed: a deep
  // link or a stale back stack must end the same way as everything else.
  if (!reader) return null;
  if (!row) {
    // The row was deleted on this device while this screen was open, or the
    // link points at a message this account does not have. Neither is an error
    // worth a dialog — there is simply nothing here.
    return (
      <Screen edges={['top']}>
        <Row style={{ padding: theme.spacing.xl, alignItems: 'center', gap: theme.spacing.sm }}>
          <IconButton label={t.common.back} onPress={() => router.back()}>
            <Ionicons name="chevron-back" size={iconSize.md} color={theme.color.text} />
          </IconButton>
          <Text variant="title">{t.smsInbox.detailTitle}</Text>
        </Row>
      </Screen>
    );
  }

  const doubts = doubtsAbout(row);
  const reason = reasonWords(row.reason, t);
  const name = row.merchant ?? t.smsInbox.noShopNamed;
  const amount = /^\d+$/.test(row.amount.trim()) ? BigInt(row.amount.trim()) : 0n;

  return (
    <Screen edges={['top']}>
      <Row
        style={{
          paddingHorizontal: theme.spacing.xl,
          paddingTop: theme.spacing.md,
          alignItems: 'center',
          gap: theme.spacing.sm,
        }}
      >
        <IconButton label={t.common.back} onPress={() => router.back()}>
          <Ionicons name="chevron-back" size={iconSize.md} color={theme.color.text} />
        </IconButton>
        <Text variant="title" style={{ flex: 1 }} numberOfLines={1}>
          {t.smsInbox.detailTitle}
        </Text>
        <IconButton label={t.smsInbox.forget} onPress={() => void forget()}>
          <Ionicons name="trash-outline" size={iconSize.md} color={theme.color.negative} />
        </IconButton>
      </Row>

      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{
          paddingHorizontal: theme.spacing.xl,
          paddingTop: theme.spacing.lg,
          paddingBottom: clearance,
          gap: theme.spacing.lg,
        }}
      >
        {/* What the app made of it: the shop, the amount, the day. This is the
            claim; the message below is the evidence. */}
        <Row style={{ alignItems: 'center', gap: theme.spacing.md }}>
          <CategoryBadge category={null} meta={null} description={row.merchant ?? ''} size={48} />
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text variant="subheading" numberOfLines={2}>
              {name}
            </Text>
            <Text variant="caption" tone="muted">
              {dayHeading(locale, row.at, now)}
            </Text>
          </View>
          <MoneyText
            amount={amount}
            currency={row.currency}
            locale={locale}
            variant="heading"
            tone={row.kind === SmsKind.Income ? 'positive' : undefined}
          />
        </Row>

        {reason || doubts.length > 0 || reachedReview(row) || row.settledAs !== null ? (
          <Row style={{ gap: theme.spacing.xs, flexWrap: 'wrap' }}>
            {reason ? <Badge label={reason} /> : null}
            {doubts.includes('date-inferred') ? (
              <Badge label={t.smsInbox.dateGuessed} tone="negative" />
            ) : null}
            {doubts.includes('hard-to-read') ? (
              <Badge label={t.smsInbox.hardToRead} tone="negative" />
            ) : null}
            {reachedReview(row) ? <Badge label={t.smsInbox.inReview} tone="positive" /> : null}
          </Row>
        ) : null}

        <Divider />

        {/* Where it came from. Small facts, but they are how a person tells two
            cards apart and recognises a bank they trust. */}
        <View style={{ gap: theme.spacing.xs }}>
          {row.sender ? (
            <Text variant="caption" tone="muted">
              {t.smsInbox.sentBy.replace('{sender}', row.sender)}
            </Text>
          ) : null}
          {row.accountTail ? (
            <Text variant="caption" tone="muted">
              {t.smsInbox.cardEnding.replace('{tail}', row.accountTail)}
            </Text>
          ) : null}
          <Text variant="caption" tone="muted">
            {t.smsInbox.readOn.replace('{when}', relativeTime(locale, row.readAt, now))}
          </Text>
        </View>

        {/* The message itself — the whole reason this screen exists, and the
            one place in the app where a bank's own words are shown back. */}
        <Card>
          <Row style={{ alignItems: 'center', gap: theme.spacing.xs }}>
            <Ionicons name="chatbubble-outline" size={iconSize.sm} color={theme.color.textMuted} />
            <Text variant="micro" tone="muted">
              {t.smsInbox.fromTheMessage}
            </Text>
          </Row>
          <Text variant="body" style={{ marginTop: theme.spacing.sm }} selectable>
            {row.body === '' ? t.smsInbox.messageUnavailable : row.body}
          </Text>
          <Row style={{ alignItems: 'center', gap: theme.spacing.xs, marginTop: theme.spacing.md }}>
            <Ionicons name="phone-portrait-outline" size={iconSize.sm} color={theme.color.brand} />
            <Text variant="micro" tone="muted">
              {t.smsInbox.onThisPhoneOnly}
            </Text>
          </Row>
        </Card>

        {row.settledAs === null ? (
          <Button
            label={plural(locale, 1, t.smsInbox.setAside)}
            variant="secondary"
            onPress={() => void setAside()}
          />
        ) : (
          <Button label={t.smsInbox.undo} variant="secondary" onPress={() => void bringBack()} />
        )}
      </ScrollView>
    </Screen>
  );
}
