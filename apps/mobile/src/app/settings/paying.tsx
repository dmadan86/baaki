/**
 * Paying — how people pay you.
 *
 * Was the second face of the profile screen (a SegmentedTab); it is now a row
 * in the settings list with a page of its own. The country decides which rails
 * exist, so it sits above them and is changeable here — the device guess is
 * only a start. Changing country resets the rail to that country's default and
 * clears any handle typed for the old one: a UPI ID means nothing once the rail
 * is Aani.
 *
 * It writes only the payment fields, so saving here never touches the name.
 */

import { useState } from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import { router } from 'expo-router';
import { ScrollView, TextInput, View } from 'react-native';

import { defaultRailFor, isValidHandle, railById, railsFor } from '@waves/core';
import {
  Button,
  Card,
  ChipRow,
  directionalIcon,
  EmptyState,
  IconButton,
  iconSize,
  Row,
  Screen,
  Text,
  useTabBarClearance,
  useTheme,
} from '@waves/ui';

import { CountryRow } from '@/components/CountryPicker';
import { friendlyError } from '@/lib/errors';
import { deviceCountry, useStrings } from '@/i18n';
import { useAuth } from '@/lib/auth';

export default function PayingScreen() {
  const { profile, profileSettled, reloadProfile } = useAuth();
  const { t } = useStrings();
  // Seed once, keyed on the id, so Save never writes an empty seed over a real
  // row before the profile has loaded.
  //
  // Blank while it is on its way, but not blank for ever: when the load has
  // settled with no profile it is not coming, and an empty screen with no way
  // out is the wrong answer to that.
  if (!profile) {
    return (
      <Screen>
        {profileSettled ? (
          <EmptyState
            title={t.loadError}
            body={t.loadErrorBody}
            action={<Button label={t.retry} variant="secondary" onPress={reloadProfile} />}
          />
        ) : (
          <View />
        )}
      </Screen>
    );
  }
  return <PayingForm key={profile.id} />;
}

function PayingForm() {
  const theme = useTheme();
  const clearance = useTabBarClearance();
  const { t } = useStrings();
  const { profile, updateProfile } = useAuth();

  const [country, setCountry] = useState<string | null>(profile?.country_code ?? deviceCountry());
  /**
   * How this person is paid. Falls back through the rail pair, then the old
   * `default_vpa` — anything written before rails existed can only have been a
   * UPI ID, and nobody should have to type theirs again.
   */
  const [rail, setRail] = useState(
    profile?.payment_rail ?? (profile?.default_vpa ? 'upi' : defaultRailFor(country)),
  );
  const [handle, setHandle] = useState(profile?.payment_handle ?? profile?.default_vpa ?? '');
  const [status, setStatus] = useState<string | null>(null);

  // Changing country changes which rails exist, so the rail drops to that
  // country's default and any handle typed for the old rail is cleared.
  const onCountry = (next: string | null): void => {
    setCountry(next);
    setRail(defaultRailFor(next));
    setHandle('');
  };

  const railInfo = railById(rail);
  const handleValid = handle.trim() === '' || isValidHandle(rail, handle.trim());
  // The rail falls back to the country's default — the same seed the state took
  // — so switching rail alone still counts as a change. Comparing rail against
  // itself never did.
  const dirty =
    country !== (profile?.country_code ?? deviceCountry()) ||
    handle.trim() !== (profile?.payment_handle ?? profile?.default_vpa ?? '') ||
    rail !== (profile?.payment_rail ?? (profile?.default_vpa ? 'upi' : defaultRailFor(country)));

  const save = async (): Promise<void> => {
    setStatus(null);
    const trimmed = handle.trim();
    // Some rails carry no handle at all (railInfo.handle === 'none') — you pick
    // the rail and there is nothing to type. Those save the rail with no handle;
    // only a rail that needs a handle is dropped when the handle is left empty.
    const needsHandle = railInfo?.handle !== 'none';
    const hasHandle = needsHandle && trimmed !== '';
    try {
      await updateProfile({
        country_code: country,
        payment_rail: needsHandle && trimmed === '' ? null : rail,
        payment_handle: hasHandle ? trimmed : null,
        // Kept in step while the older screens still read it. A handle on any
        // other rail is not a UPI ID and must not masquerade as one.
        default_vpa: rail === 'upi' && hasHandle ? trimmed : null,
      });
      setStatus(t.account.saved);
    } catch (caught) {
      setStatus(friendlyError(caught, t.couldNotSave, 'paying.save'));
    }
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
          <Text variant="heading">{t.account.facePaying}</Text>
        </View>
        <View style={{ width: 44 }} />
      </Row>

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{
          paddingHorizontal: theme.spacing.xl,
          paddingBottom: clearance,
          paddingTop: theme.spacing.lg,
          gap: theme.spacing.xl,
        }}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        {/* The country decides which rails exist below, so it sits above them
            and is changeable here — the device guess is only a start. */}
        <CountryRow countryCode={country} onChange={onCountry} />
        <Card style={{ gap: theme.spacing.lg }}>
          <View style={{ gap: theme.spacing.sm }}>
            <Text variant="caption" tone="muted">
              {t.account.howPeoplePayYou}
            </Text>
            {/* Whatever this person's country uses. In India that still starts
                on UPI; in the UAE it starts on Aani. */}
            <ChipRow<string>
              value={rail}
              onChange={setRail}
              options={railsFor(country).map((entry) => ({
                value: entry.id,
                label: entry.label,
              }))}
            />
            {railInfo && railInfo.handle !== 'none' ? (
              <>
                <TextInput
                  value={handle}
                  onChangeText={setHandle}
                  autoCapitalize="none"
                  accessibilityLabel={t.account.yourRailDetails.replace('{rail}', railInfo.label)}
                  placeholder={railInfo.handleHint}
                  placeholderTextColor={theme.color.textFaint}
                  style={{
                    fontSize: 18,
                    fontWeight: '600',
                    color: handleValid ? theme.color.text : theme.color.negative,
                    paddingVertical: theme.spacing.sm,
                  }}
                />
                <Text variant="micro" tone={handleValid ? 'faint' : 'negative'}>
                  {!handleValid
                    ? t.account.handleWrong.replace('{hint}', railInfo.handleHint.toLowerCase())
                    : railInfo.link
                      ? t.account.railLinkNote
                      : t.account.railManualNote}
                </Text>
              </>
            ) : (
              <Text variant="micro" tone="muted">
                {t.account.nothingToAdd}
              </Text>
            )}
          </View>
          <Button
            label={t.common.save}
            fullWidth
            disabled={!dirty || !handleValid}
            onPress={() => void save()}
          />
          {status ? (
            <Text variant="caption" tone={status === t.account.saved ? 'positive' : 'negative'}>
              {status}
            </Text>
          ) : null}
        </Card>
      </ScrollView>
    </Screen>
  );
}
