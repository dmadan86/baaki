import { useState } from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useLocalSearchParams } from 'expo-router';
import { ScrollView, View } from 'react-native';

import { currencyExposure, format, isValidVpa, money, type CurrencyCode } from '@waves/core';
import {
  Avatar,
  Badge,
  Button,
  Card,
  directionalIcon,
  EmptyState,
  IconButton,
  iconSize,
  ListRow,
  MoneyText,
  Row,
  Screen,
  SectionHeader,
  Text,
  TintCard,
  useTheme,
} from '@waves/ui';

import { EditTextSheet } from '@/components/EditTextSheet';
import { ProfileAvatar } from '@/components/ProfileAvatar';
import { SettingsSection, type SettingsRow } from '@/components/SettingsSection';
import { useGroup, useGroupLedger, useSetMemberRole, useUpdateMember } from '@/data/hooks';
import { friendlyError } from '@/lib/errors';
import { expenseTitle } from '@/data/expenseTitle';
import { useBlockedUsers } from '@/data/blocked';
import { displayName, groupLabel, isBlockedMember, isGhost, isViewer } from '@/data/types';
import { fill, plural, useStrings } from '@/i18n';
import { useAuth, useViewerId } from '@/lib/auth';
import { useBottomClearance } from '@/lib/clearance';
import { router } from '@/lib/navigation';
import { useDialog } from '@/lib/dialog';

export default function MemberScreen() {
  const theme = useTheme();
  const clearance = useBottomClearance();
  const { t, locale } = useStrings();
  const { confirm } = useDialog();
  const { id, memberId } = useLocalSearchParams<{ id: string; memberId: string }>();
  const groupId = id ?? '';
  const { profile } = useAuth();
  // Identity for "which member am I", from the session rather than the profile:
  // the session is on the device at launch, the profile is a fetch that lands
  // later, and in the gap `profile?.id` is undefined — which `isViewer` refuses
  // to match, but only if it is given the right thing to compare. See
  // `lib/auth.useViewerId`.
  const viewerId = useViewerId();

  const { group, members, expenses } = useGroup(groupId);
  const ledger = useGroupLedger(groupId, viewerId);
  const updateMember = useUpdateMember(groupId);
  const setRole = useSetMemberRole(groupId);
  const { blockedIds, block, unblock } = useBlockedUsers();

  const member = members.data?.find((row) => row.id === memberId);
  const isMe = member ? isViewer(member, viewerId) : false;
  const iAmAdmin = members.data?.find((row) => isViewer(row, viewerId))?.role === 'admin';
  const currency = group.data?.default_currency ?? 'INR';

  const [name, setName] = useState(member?.ghost_name ?? '');
  const [vpa, setVpa] = useState(member?.vpa ?? '');
  const [status, setStatus] = useState<string | null>(null);
  /** Which editable row has its sheet open, or null. */
  const [editing, setEditing] = useState<'name' | 'vpa' | null>(null);

  // Seed the editors from the member the moment the query resolves, and again
  // if the row identity changes — synced in render (the app's idiom for
  // "follow a value until touched"), not in an effect, so it never triggers a
  // cascading-render lint or a frame of empty fields.
  const [seededId, setSeededId] = useState<string | null>(null);
  if (member && seededId !== member.id) {
    setSeededId(member.id);
    setName(member.ghost_name ?? '');
    setVpa(member.vpa ?? '');
  }

  if (!member) {
    return (
      <Screen>
        <EmptyState title={t.people.memberNotFound} body={t.people.memberNotFoundBody} />
      </Screen>
    );
  }

  const ghost = isGhost(member);
  const blocked = isBlockedMember(member, blockedIds);
  // A blocked person wears the ghost look and the ghost name here too — the one
  // exception is the block card below, which needs their real name to name the
  // action. Blocking is display-only; it never touches the balance shown here.
  const shownName = displayName(member, viewerId, blockedIds, t.misc.someone);
  const realName = member.profile?.display_name ?? member.ghost_name ?? t.misc.someone;

  const confirmBlock = async (): Promise<void> => {
    if (!member.profile_id) return;
    const profileId = member.profile_id;
    const ok = await confirm({
      title: fill(t.blocked.confirmTitle, { name: realName }),
      body: t.blocked.confirmBody,
      confirmLabel: t.blocked.action,
      tone: 'danger',
    });
    if (ok) {
      block({ id: profileId, name: realName, avatarUrl: member.profile?.avatar_url ?? null });
    }
  };
  const balance = ledger.balances.get(member.id) ?? 0n;
  // The hero wears the money colour for its meaning — mint when this person is
  // owed, pink when they owe — and a neutral lilac when they are square, so a
  // settled member is never painted a direction they are not in. Ink from the
  // pair keeps the amount readable on the tint.
  const heroTint = balance > 0n ? 'mint' : balance < 0n ? 'pink' : 'lilac';
  const heroInk = theme.tint[heroTint].ink;

  /**
   * Promote, demote, block, unblock — whichever of them apply to this person.
   *
   * Built as a list so the section can be omitted entirely when none apply,
   * rather than drawing a heading over nothing. That is the case for yourself,
   * and for a ghost seen by a non-admin.
   */
  const manageRows: SettingsRow[] = [
    ...(iAmAdmin && !isMe
      ? [
          {
            icon: (member.role === 'admin' ? 'shield-outline' : 'shield-checkmark-outline') as
              'shield-outline' | 'shield-checkmark-outline',
            label: member.role === 'admin' ? t.people.removeAdmin : t.people.makeAdmin,
            hint: ghost ? t.people.adminNeedsAccount : t.people.adminNote,
            onPress:
              ghost || setRole.isPending
                ? undefined
                : () =>
                    setRole.mutate(
                      {
                        memberId: member.id,
                        role: member.role === 'admin' ? 'member' : 'admin',
                      },
                      {
                        onSuccess: () => setStatus(t.account.saved),
                        onError: (caught) =>
                          setStatus(friendlyError(caught, t.couldNotSave, 'member.setRole')),
                      },
                    ),
          },
        ]
      : []),
    ...(!isMe && !ghost && member.profile_id
      ? [
          {
            icon: (blocked ? 'eye-outline' : 'ban-outline') as 'eye-outline' | 'ban-outline',
            label: blocked ? t.blocked.unblock : t.blocked.action,
            hint: t.blocked.note,
            destructive: !blocked,
            onPress: blocked ? () => unblock(member.profile_id!) : () => void confirmBlock(),
          },
        ]
      : []),
  ];

  // Expenses this person is actually part of.
  const involved = expenses.rows.filter((expense) =>
    expense.currentVersion?.shares.some((share) => share.member_id === member.id),
  );

  // What this person actually fronted, per currency (ADR-004: never summed into
  // one). "You paid ₹12,400, €90 and ฿2,100" — the honest answer on a trip that
  // touched more than one currency, drawn from the payments the ledger stored.
  const paidExposure = currencyExposure(
    expenses.rows.reduce<Record<string, bigint>>((acc, expense) => {
      const version = expense.currentVersion;
      if (!version || expense.deleted_at) return acc;
      for (const payer of version.payers) {
        if (payer.member_id !== member.id) continue;
        acc[version.currency] = (acc[version.currency] ?? 0n) + BigInt(payer.amount);
      }
      return acc;
    }, {}),
  );

  const save = (patch: { ghost_name?: string; vpa?: string | null }): void => {
    setStatus(null);
    updateMember.mutate(
      { memberId: member.id, patch },
      {
        onSuccess: () => setStatus(t.account.saved),
        onError: (caught) => setStatus(friendlyError(caught, t.couldNotSave, 'member.save')),
      },
    );
  };

  return (
    <Screen>
      <Row style={{ paddingHorizontal: theme.spacing.xl, paddingTop: theme.spacing.md }}>
        <IconButton label={t.common.back} onPress={() => router.back()}>
          <Ionicons
            name={directionalIcon('chevron-back')}
            size={iconSize.lg}
            color={theme.color.text}
          />
        </IconButton>
        <View style={{ flex: 1, alignItems: 'center' }}>
          <Text variant="heading">{shownName}</Text>
          <Text variant="micro" tone="muted">
            {groupLabel(group.data, members.data ?? [])}
          </Text>
        </View>
        <View style={{ width: 44 }} />
      </Row>

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{
          paddingHorizontal: theme.spacing.xl,
          paddingTop: theme.spacing.lg,
          paddingBottom: clearance,
          gap: theme.spacing.xl,
        }}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        {/* Who, how much, and which way round.
            
            The amount used to stand alone: a number in a tinted card with no
            word next to it, so "¥58,039" could as easily have been money owed
            to this person as money they owe. The colour said which — and colour
            alone is the one thing a balance must never rely on (ADR-009 and the
            #191 regression this app already had once). Splitwise puts the
            direction in words above the figure; bunq labels the hero outright.
            So does this now, in the same words the Friends tab already uses.

            The portrait is `ProfileAvatar`, so a member who has a photo shows
            it. `Avatar` drew initials and nothing else, which meant the one
            screen entirely about a person was the one screen that never showed
            their face. */}
        <TintCard
          tint={heroTint}
          style={{
            alignItems: 'center',
            gap: theme.spacing.sm,
            borderRadius: theme.radius.xl,
            padding: theme.spacing.xl,
          }}
        >
          <ProfileAvatar
            name={shownName}
            avatarUrl={ghost || blocked ? null : (member.profile?.avatar_url ?? null)}
            size={78}
          />
          {balance !== 0n ? (
            <Text variant="caption" style={{ color: heroInk, opacity: 0.85 }}>
              {balance > 0n ? t.tabs.owesYou : t.tabs.youOweThem}
            </Text>
          ) : null}
          <MoneyText
            amount={balance}
            currency={currency}
            locale={locale}
            mode="balance"
            variant="title"
            tone="default"
            style={{ color: heroInk }}
          />
          {balance === 0n ? (
            <Text variant="caption" style={{ color: heroInk, opacity: 0.85 }}>
              {t.tabs.allSquare}
            </Text>
          ) : null}
          <Row style={{ gap: theme.spacing.sm, flexWrap: 'wrap', justifyContent: 'center' }}>
            {ghost ? <Badge label={t.notJoinedYet} /> : null}
            {blocked ? <Badge label={t.blocked.badge} /> : null}
            {member.role === 'admin' ? <Badge label={t.people.admin} tone="brand" /> : null}
            {isMe ? <Badge label={t.people.you} tone="positive" /> : null}
          </Row>
          {balance !== 0n && !isMe ? (
            // Full width, and the only filled button on the screen. It was a
            // content-width pill sitting against the leading edge of a centred
            // card, which read as an afterthought rather than as the thing this
            // screen is for.
            <Button
              label={t.settleUp}
              fullWidth
              onPress={() => router.push(`/group/${groupId}/settle`)}
            />
          ) : null}
        </TintCard>

        {/* What this person has actually put in, as rows rather than a card per
            figure. Two facts read down a column in the time it takes to read
            one sentence, which is the bunq and Wanderlog shape. Paid stays
            per-currency and unsummed (ADR-004): a trip that touched yen and
            dollars has no single true total. */}
        <SettingsSection
          title={t.people.inThisGroup}
          rows={[
            ...(paidExposure.length > 0
              ? [
                  {
                    icon: 'card-outline' as const,
                    label: t.people.paidAcross,
                    value: paidExposure
                      .map((entry) =>
                        format(money(entry.amountMinor, entry.currency as CurrencyCode), {
                          locale,
                        }),
                      )
                      .join(' · '),
                  },
                ]
              : []),
            {
              icon: 'receipt-outline' as const,
              label: t.people.expensesLabel,
              value: String(involved.length),
            },
          ]}
        />

        {/* The two editable facts, as rows that open a sheet — the same pattern
            the account screen uses, so a field is one line until somebody wants
            to change it. A ghost's name is editable by anyone in the group; the
            UPI override is yours alone. */}
        {ghost || isMe ? (
          <SettingsSection
            rows={[
              ...(ghost
                ? [
                    {
                      icon: 'person-outline' as const,
                      label: t.people.memberName,
                      hint: t.people.ghostNote,
                      value: name.trim() || t.misc.someone,
                      valueMuted: !name.trim(),
                      onPress: () => setEditing('name'),
                    },
                  ]
                : []),
              ...(isMe
                ? [
                    {
                      icon: 'wallet-outline' as const,
                      label: t.people.upiForGroup,
                      hint: t.people.upiForGroupNote,
                      value: vpa.trim() || (profile?.default_vpa ?? 'you@bank'),
                      valueMuted: !vpa.trim(),
                      onPress: () => setEditing('vpa'),
                    },
                  ]
                : []),
            ]}
          />
        ) : null}

        {/* Managing this person: one section of rows rather than a card each.
            
            These were two cards, each a caption over a button over a note, at
            two different weights — a soft lavender "Make admin" and a red
            "Block" — for two things that are both just controls. GoPay files
            exactly this under one "More action" heading of icon rows, and the
            note each one carried becomes the row's second line, which is where
            a sentence explaining a control belongs.

            An admin can promote or demote anyone but themselves. A ghost shows
            the row disabled with the reason rather than hiding it, so the
            capability stays discoverable — the server enforces the rule either
            way (GHOST_CANNOT_ADMIN, and the last admin cannot be demoted).
            Blocking is display-only and never touches the balance above. */}
        {manageRows.length > 0 ? (
          <SettingsSection title={t.people.manageTitle} rows={manageRows} />
        ) : null}

        {status ? (
          <Text variant="caption" tone={status === t.account.saved ? 'positive' : 'negative'}>
            {status}
          </Text>
        ) : null}

        <View>
          <SectionHeader title={plural(locale, involved.length, t.expense.inCount)} />
          <Card padded={false} style={{ paddingHorizontal: theme.spacing.lg }}>
            {involved.map((expense, index) => {
              const share = expense.currentVersion?.shares.find(
                (row) => row.member_id === member.id,
              );
              return (
                <View key={expense.id}>
                  <ListRow
                    title={expenseTitle(
                      expense.currentVersion?.description,
                      expense.currentVersion?.category,
                      t,
                      expense.currentVersion?.category_meta,
                    )}
                    subtitle={
                      expense.currentVersion
                        ? new Intl.DateTimeFormat(locale, {
                            day: 'numeric',
                            month: 'short',
                          }).format(new Date(expense.currentVersion.expense_date))
                        : undefined
                    }
                    leading={<Avatar name={expense.currentVersion?.description ?? '?'} size={38} />}
                    onPress={() => router.push(`/group/${groupId}/expense/${expense.id}`)}
                    trailing={
                      share ? (
                        <MoneyText
                          amount={BigInt(share.amount)}
                          currency={currency}
                          locale={locale}
                          variant="caption"
                        />
                      ) : null
                    }
                  />
                  {index < involved.length - 1 ? (
                    <View style={{ height: 1, backgroundColor: theme.color.border }} />
                  ) : null}
                </View>
              );
            })}
          </Card>
        </View>
      </ScrollView>

      {/* The editors, over the list rather than inside it — see the account
          screen for why a row beats a field with a Save button beside it. */}
      <EditTextSheet
        visible={editing === 'name'}
        title={t.people.memberName}
        hint={t.people.ghostNote}
        value={name}
        saving={updateMember.isPending}
        onSave={(next) => {
          setName(next);
          save({ ghost_name: next });
          setEditing(null);
        }}
        onClose={() => setEditing(null)}
      />
      <EditTextSheet
        visible={editing === 'vpa'}
        title={t.people.upiForGroup}
        hint={t.people.upiForGroupNote}
        value={vpa}
        placeholder={profile?.default_vpa ?? 'you@bank'}
        autoCapitalize="none"
        saving={updateMember.isPending}
        onSave={(next) => {
          // An empty field clears the override rather than storing a blank —
          // and an unparseable handle is refused here, since the sheet is the
          // only door and the ledger should never hold one.
          if (next.trim() !== '' && !isValidVpa(next.trim())) {
            setStatus(t.people.upiInvalid);
            return;
          }
          setVpa(next);
          save({ vpa: next.trim() === '' ? null : next.trim() });
          setEditing(null);
        }}
        onClose={() => setEditing(null)}
      />
    </Screen>
  );
}
