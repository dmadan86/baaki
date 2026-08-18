/**
 * Typing in a promotion code.
 *
 * The grant is not written from here. `subscriptions` is not writable by a
 * client and `baaki_redeem_promo` is SECURITY DEFINER for exactly that reason —
 * a paywall a client can insert its own row into is a paywall with a door in
 * the back. This screen collects four to twenty-four characters and says what
 * came back.
 *
 * Every refusal gets its own sentence. Expired, used up and mistyped send
 * somebody to check three different things, and one "that did not work" makes
 * them check all three.
 */

import { useState } from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import { router } from 'expo-router';
import { ActivityIndicator, ScrollView, TextInput, View } from 'react-native';

import {
  Button,
  Callout,
  Card,
  directionalIcon,
  IconButton,
  iconSize,
  Row,
  Screen,
  Text,
  useTabBarClearance,
  useTheme,
} from '@waves/ui';

import { redeemPromoCode, type PromoOutcome } from '@/data/api';
import { fill, useStrings, type UiStrings } from '@/i18n';
import { friendlyError } from '@/lib/errors';

/**
 * The same shape the `promo_codes_shape` constraint enforces.
 *
 * Not validation — the database decides what a code is. This only avoids a
 * round trip for something that cannot possibly match, so a half-typed code
 * does not come back as "no code like that" before it has been finished.
 */
const CODE_SHAPE = /^[A-Z0-9]{4,24}$/;

/** Each refusal, in its own words. */
function refusal(reason: Extract<PromoOutcome, { ok: false }>['reason'], t: UiStrings): string {
  switch (reason) {
    case 'UNKNOWN_CODE':
      return t.promo.unknownCode;
    case 'EXPIRED':
      return t.promo.expired;
    case 'EXHAUSTED':
      return t.promo.exhausted;
    case 'ALREADY_REDEEMED':
      return t.promo.alreadyRedeemed;
  }
}

export default function RedeemScreen() {
  const theme = useTheme();
  const clearance = useTabBarClearance();
  const { t, locale } = useStrings();

  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [granted, setGranted] = useState<Extract<PromoOutcome, { ok: true }> | null>(null);

  const redeem = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const outcome = await redeemPromoCode(code.trim());
      if (outcome.ok) setGranted(outcome);
      else setError(refusal(outcome.reason, t));
    } catch (caught) {
      // Never the raw message: a build that reaches a project the migration has
      // not, reports "Could not find the function public.baaki_redeem_promo".
      setError(friendlyError(caught, t.promo.couldNotRedeem, 'promo.redeem'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen>
      <ScrollView
        contentContainerStyle={{
          paddingHorizontal: theme.spacing.xl,
          paddingBottom: clearance,
          gap: theme.spacing.xl,
        }}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <Row style={{ paddingTop: theme.spacing.md }}>
          <IconButton label={t.common.back} onPress={() => router.back()}>
            <Ionicons
              name={directionalIcon('chevron-back')}
              size={iconSize.lg}
              color={theme.color.text}
            />
          </IconButton>
          <View style={{ flex: 1, alignItems: 'center' }}>
            <Text variant="heading">{t.promo.title}</Text>
          </View>
          <View style={{ width: 44 }} />
        </Row>

        {granted ? (
          <Card style={{ gap: theme.spacing.md, alignItems: 'center' }}>
            <Ionicons name="checkmark-circle" size={iconSize.hero} color={theme.color.positive} />
            <Text variant="subheading" align="center">
              {t.promo.granted}
            </Text>
            <Text variant="caption" tone="muted" align="center">
              {fill(t.promo.grantedBody, {
                until: new Date(granted.until).toLocaleDateString(locale, {
                  day: 'numeric',
                  month: 'short',
                  year: 'numeric',
                }),
              })}
            </Text>
            <Button label={t.common.close} variant="secondary" onPress={() => router.back()} />
          </Card>
        ) : (
          <>
            <Text variant="body" tone="muted">
              {t.promo.intro}
            </Text>

            <Card>
              <TextInput
                value={code}
                // Upper-cased as it is typed rather than on submit, so what is
                // on screen is what gets looked up. The function upper-cases
                // too; this stops the two disagreeing in front of somebody.
                onChangeText={(next) => setCode(next.toUpperCase())}
                placeholder={t.promo.placeholder}
                placeholderTextColor={theme.color.textFaint}
                accessibilityLabel={t.promo.title}
                autoCapitalize="characters"
                autoCorrect={false}
                autoComplete="off"
                autoFocus
                maxLength={24}
                onSubmitEditing={() => {
                  if (!busy && CODE_SHAPE.test(code.trim())) void redeem();
                }}
                style={{
                  fontSize: 22,
                  letterSpacing: 2,
                  color: theme.color.text,
                  paddingVertical: theme.spacing.sm,
                }}
              />
            </Card>

            {error ? <Callout tone="negative">{error}</Callout> : null}
            {busy ? <ActivityIndicator color={theme.color.brand} /> : null}

            <Button
              label={t.promo.redeem}
              size="lg"
              fullWidth
              disabled={busy || !CODE_SHAPE.test(code.trim())}
              onPress={() => void redeem()}
            />
          </>
        )}
      </ScrollView>
    </Screen>
  );
}
