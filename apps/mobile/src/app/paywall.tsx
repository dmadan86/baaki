/**
 * Choose your plan — the paywall, presented as a sheet.
 *
 * UI only for now: the plans, prices and dates below are placeholders, and
 * nothing here talks to a store. "Subscribe" does not buy anything yet — the
 * purchase, the products and the real prices get wired in later.
 *
 * NOTE — this screen sells a paid tier, which runs against `settings/upgrade`,
 * the screen that today says there is nothing to buy (the ledger is free
 * forever, only convenience would ever be charged for). Before this ships the
 * two have to be reconciled: either upgrade points here, or this stays behind a
 * flag. Left as a deliberate follow-up.
 *
 * Copy is hardcoded English — the i18n pass comes with the wiring, not before.
 */

import { useState } from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import { router } from 'expo-router';
import { Pressable, ScrollView, View } from 'react-native';

import { IconButton, iconSize, Screen, Text, useTheme } from '@waves/ui';

/** The reference's warm gold, for the badge and the call to action. Local, not
    a brand token: the app's brand is purple, and this is placeholder styling to
    match the concept until the paywall's real look is decided. */
const GOLD = '#F5C518';
const GOLD_INK = '#1A1A2E';

type PlanId = 'annual' | 'monthly';

interface Plan {
  id: PlanId;
  badge?: string;
  title: string;
  price: string;
  cadence: string;
  note: string;
}

const PLANS: Plan[] = [
  {
    id: 'annual',
    badge: 'Best Value',
    title: 'Annual + 7-day free trial',
    price: '$49.98',
    cadence: '/ year',
    note: 'Cancel up to 24 hours before trial ends',
  },
  {
    id: 'monthly',
    title: 'Monthly',
    price: '$14.98',
    cadence: '/ month',
    note: 'Recurring billing. Cancel anytime.',
  },
];

/** A placeholder renewal date so the timeline reads as real. Wiring replaces
    this with the store's own date. */
function renewalLabel(plan: PlanId): string {
  const d = new Date();
  if (plan === 'annual') d.setDate(d.getDate() + 7);
  else d.setMonth(d.getMonth() + 1);
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
}

export default function PaywallScreen() {
  const theme = useTheme();
  const [selected, setSelected] = useState<PlanId>('monthly');

  const isAnnual = selected === 'annual';
  const howTitle = isAnnual ? 'How your free trial works' : 'How monthly subscriptions work';
  const firstBody = isAnnual ? 'Your 7-day free trial starts now' : 'You are billed for one month';
  const renewBody = isAnnual
    ? 'Your subscription begins and you are billed for one year unless you cancel before this date.'
    : 'Your subscription is renewed for another month unless you cancel before this date.';

  return (
    <Screen edges={['top', 'bottom']}>
      <ScrollView
        contentContainerStyle={{
          paddingHorizontal: theme.spacing.xl,
          paddingBottom: theme.spacing.xxxl,
          gap: theme.spacing.xxl,
        }}
        showsVerticalScrollIndicator={false}
      >
        {/* Header: close on the left, title centred, a spacer to balance it. */}
        <View style={{ flexDirection: 'row', alignItems: 'center', paddingTop: theme.spacing.sm }}>
          <IconButton label="Close" onPress={() => router.back()}>
            <Ionicons name="close" size={iconSize.lg} color={theme.color.text} />
          </IconButton>
          <View style={{ flex: 1, alignItems: 'center' }}>
            <Text variant="heading">Choose your plan</Text>
          </View>
          <View style={{ width: 44 }} />
        </View>

        {/* The plans. Tapping one selects it; the selected card wears the brand
            border and a green check. */}
        <View style={{ gap: theme.spacing.lg }}>
          {PLANS.map((plan) => {
            const active = plan.id === selected;
            return (
              <Pressable
                key={plan.id}
                accessibilityRole="radio"
                accessibilityState={{ selected: active }}
                accessibilityLabel={`${plan.title}, ${plan.price} ${plan.cadence}`}
                onPress={() => setSelected(plan.id)}
                style={({ pressed }) => [
                  {
                    backgroundColor: theme.color.surface,
                    borderRadius: theme.radius.lg,
                    padding: theme.spacing.xl,
                    borderWidth: 2,
                    borderColor: active ? theme.color.brand : theme.color.border,
                    opacity: pressed ? 0.95 : 1,
                    gap: theme.spacing.sm,
                  },
                  theme.shadow.soft,
                ]}
              >
                <View style={{ flexDirection: 'row', alignItems: 'flex-start' }}>
                  <View style={{ flex: 1, gap: theme.spacing.sm }}>
                    {plan.badge ? (
                      <View
                        style={{
                          alignSelf: 'flex-start',
                          backgroundColor: GOLD,
                          borderRadius: theme.radius.pill,
                          paddingHorizontal: theme.spacing.md,
                          paddingVertical: theme.spacing.xs,
                        }}
                      >
                        <Text variant="micro" style={{ color: GOLD_INK, fontWeight: '800' }}>
                          {plan.badge}
                        </Text>
                      </View>
                    ) : null}
                    <Text variant="subheading" style={{ fontWeight: '800' }}>
                      {plan.title}
                    </Text>
                  </View>
                  {/* The check sits top-right; an empty ring holds the space on
                      the card that is not chosen, so nothing shifts on tap. */}
                  {active ? (
                    <View
                      style={{
                        width: 30,
                        height: 30,
                        borderRadius: 15,
                        backgroundColor: theme.color.positive,
                        alignItems: 'center',
                        justifyContent: 'center',
                      }}
                    >
                      <Ionicons name="checkmark" size={18} color="#FFFFFF" />
                    </View>
                  ) : (
                    <View
                      style={{
                        width: 30,
                        height: 30,
                        borderRadius: 15,
                        borderWidth: 2,
                        borderColor: theme.color.border,
                      }}
                    />
                  )}
                </View>

                <View
                  style={{ flexDirection: 'row', alignItems: 'baseline', gap: theme.spacing.xs }}
                >
                  <Text style={{ fontSize: 34, fontWeight: '800', color: theme.color.text }}>
                    {plan.price}
                  </Text>
                  <Text variant="body" tone="muted">
                    {plan.cadence}
                  </Text>
                </View>

                <Text variant="caption" tone="muted">
                  {plan.note}
                </Text>
              </Pressable>
            );
          })}
        </View>

        {/* How it works — a two-step timeline, the icons joined by a line. */}
        <View style={{ gap: theme.spacing.lg }}>
          <Text variant="subheading" align="center" style={{ fontWeight: '800' }}>
            {howTitle}
          </Text>

          <View>
            <TimelineStep
              icon="lock-closed"
              iconBg={GOLD}
              iconInk={GOLD_INK}
              connector
              title="Today: Get instant access"
              body={firstBody}
            />
            <TimelineStep
              icon="refresh"
              iconBg={theme.color.surface}
              iconInk={theme.color.text}
              iconBordered
              title={`${renewalLabel(selected)}: Renewal`}
              body={renewBody}
            />
          </View>
        </View>
      </ScrollView>

      {/* Terms and the call to action, pinned under the scroll. */}
      <View
        style={{
          paddingHorizontal: theme.spacing.xl,
          paddingTop: theme.spacing.md,
          paddingBottom: theme.spacing.md,
          gap: theme.spacing.lg,
        }}
      >
        <Pressable onPress={() => {}} hitSlop={8} style={{ alignSelf: 'center' }}>
          <Text tone="brand" style={{ fontWeight: '700' }}>
            Terms and conditions
          </Text>
        </Pressable>

        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Subscribe"
          onPress={() => {}}
          style={({ pressed }) => ({
            height: 56,
            borderRadius: theme.radius.pill,
            backgroundColor: GOLD,
            alignItems: 'center',
            justifyContent: 'center',
            opacity: pressed ? 0.9 : 1,
          })}
        >
          <Text variant="subheading" style={{ color: GOLD_INK, fontWeight: '800' }}>
            Subscribe
          </Text>
        </Pressable>
      </View>
    </Screen>
  );
}

/** One step in the "how it works" timeline: a round icon, an optional line to
    the next step, and the text beside it. */
function TimelineStep({
  icon,
  iconBg,
  iconInk,
  iconBordered = false,
  connector = false,
  title,
  body,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  iconBg: string;
  iconInk: string;
  iconBordered?: boolean;
  connector?: boolean;
  title: string;
  body: string;
}) {
  const theme = useTheme();
  return (
    <View style={{ flexDirection: 'row', gap: theme.spacing.lg }}>
      <View style={{ alignItems: 'center', width: 44 }}>
        <View
          style={{
            width: 44,
            height: 44,
            borderRadius: 22,
            backgroundColor: iconBg,
            borderWidth: iconBordered ? 1 : 0,
            borderColor: theme.color.border,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Ionicons name={icon} size={iconSize.md} color={iconInk} />
        </View>
        {connector ? (
          <View style={{ flex: 1, width: 2, backgroundColor: theme.color.border, marginTop: 2 }} />
        ) : null}
      </View>
      <View
        style={{ flex: 1, paddingBottom: connector ? theme.spacing.xxl : 0, gap: theme.spacing.xs }}
      >
        <Text variant="subheading" style={{ fontWeight: '700' }}>
          {title}
        </Text>
        <Text variant="body" tone="muted">
          {body}
        </Text>
      </View>
    </View>
  );
}
