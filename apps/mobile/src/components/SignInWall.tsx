/**
 * The wall in front of the two rooms a guest account cannot hold.
 *
 * A guest here is a real anonymous session — it can start a group, add
 * expenses, settle — and the ceilings on it are about *how much* (ADR-006
 * addendum, `lib/guestGuard`). This is a different kind of limit and it is
 * about *what*: two features whose whole value is that they survive this phone,
 * under an identity that by definition cannot be signed back into.
 *
 *   **The private ledger.** Personal records are the one part of the app nobody
 *   else can ever see, so nobody else can ever hand them back. A guest keeping
 *   a year of their own spending under a session they cannot recover is a
 *   promise the app cannot keep.
 *
 *   **Bank messages.** The messages stay on the device either way — that never
 *   changes and the copy says so, because a person reading a wall about their
 *   own bank texts deserves to be told the boundary has not moved. What needs
 *   an account is the ledger they turn into.
 *
 * So the wall is shown *instead of* the screen rather than over it: nothing is
 * mounted behind it, no read is started, and the back stack is untouched. The
 * one way through is the way that keeps what the guest already has — linking an
 * email or a phone to this same session on `/settings/account`, which is the
 * screen that does it. Signing in as somebody else is not offered here on
 * purpose: from a guest session that is not an upgrade, it is a swap, and the
 * groups made this afternoon would be left behind an account with no address.
 */

import Ionicons from '@expo/vector-icons/Ionicons';
import { View } from 'react-native';

import { Button, iconSize, Screen, Text, useTheme } from '@waves/ui';

import { useStrings } from '@/i18n';
import { router, useGoBack } from '@/lib/navigation';

/** Which room is shut. Only the sentence under the heading changes. */
export type WalledArea = 'personal' | 'sms';

const GLYPH: Record<WalledArea, 'wallet-outline' | 'chatbubbles-outline'> = {
  personal: 'wallet-outline',
  sms: 'chatbubbles-outline',
};

export function SignInWall({ area }: { area: WalledArea }) {
  const theme = useTheme();
  const { t } = useStrings();
  // Home is the fallback, because this can be the first screen of a cold open
  // from a deep link, and because the Me tab has nothing to pop at all.
  const goBack = useGoBack('/');

  return (
    <Screen edges={[]}>
      <View
        style={{
          flex: 1,
          alignItems: 'center',
          justifyContent: 'center',
          gap: theme.spacing.lg,
          paddingHorizontal: theme.spacing.xxxl,
        }}
      >
        {/* The room's own glyph rather than a padlock: this is not locked, it
            is waiting on something, and the icon says which room asked. */}
        <Ionicons name={GLYPH[area]} size={iconSize.huge} color={theme.color.textFaint} />
        <Text variant="title" align="center">
          {t.signInWall.title}
        </Text>
        <Text variant="body" tone="muted" align="center">
          {area === 'personal' ? t.signInWall.personalBody : t.signInWall.smsBody}
        </Text>
        <View style={{ alignSelf: 'stretch', gap: theme.spacing.md }}>
          <Button
            label={t.signInWall.cta}
            size="lg"
            fullWidth
            onPress={() => router.push('/settings/account')}
          />
          <Button label={t.common.back} variant="secondary" size="lg" fullWidth onPress={goBack} />
        </View>
      </View>
    </Screen>
  );
}
