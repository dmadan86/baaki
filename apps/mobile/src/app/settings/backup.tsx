/**
 * Backing the private "Me" ledger up to the person's own Google Drive.
 *
 * The shape is WhatsApp's chat-backup screen, because that screen is the mental
 * model people already have for this and inventing a different one would only
 * cost them: back up now with a live line saying what is happening, how often
 * to do it automatically, which account it goes to, over which networks, and
 * when the last one landed. What WhatsApp puts behind "End-to-end encrypted
 * backup" is here up front instead — the key is the thing that decides whether
 * a backup is worth anything on a new phone, so it is a section, not a
 * disclosure.
 *
 * Two ordering decisions worth naming. The key section sits *above* the
 * schedule, because a schedule with no key backs nothing up and the screen
 * should not let somebody set one and walk away believing otherwise. And
 * Restore is last: it is the half people need once, at the worst moment, and
 * burying it would be cruel — but putting it near "Back up now" invites the
 * wrong tap.
 *
 * The one promise this screen makes, and must keep: nothing legible leaves the
 * phone. What goes to Drive is a sealed blob; the key that opens it is shown to
 * the person and never sent anywhere.
 */

import { useCallback, useState } from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import * as Clipboard from 'expo-clipboard';
import { router } from 'expo-router';
import { ActivityIndicator, ScrollView, TextInput, View } from 'react-native';

import {
  Button,
  Callout,
  Card,
  directionalIcon,
  Divider,
  IconButton,
  iconSize,
  ListRow,
  Popup,
  Row,
  Screen,
  SectionHeader,
  Sheet,
  Text,
  useTabBarClearance,
  useTheme,
} from '@waves/ui';

import { plural, useStrings } from '@/i18n';
import { formatBytes } from '@/lib/bytes';
import { useBackup, type BackupOutcome } from '@/lib/backup/useBackup';
import { BackupFrequency } from '@/lib/backup/schedule';
import { formatRecoveryKey } from '@/lib/backup/recoveryKey';
import type { RestoreScan } from '@/lib/backup/engine';
import { friendlyError } from '@/lib/errors';
import { SyncNetworkPreference } from '@/lib/syncNetwork';

/** A found backup, held while the person decides whether to take it. */
type FoundBackup = Extract<RestoreScan, { ok: true }>;

/** A brand name, not copy — the same word in every locale, so not translated. */
const PROVIDER_LABEL = 'Google Drive';

export default function BackupSettingsScreen() {
  const theme = useTheme();
  const clearance = useTabBarClearance();
  const { t, locale } = useStrings();
  const backup = useBackup();

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [shownKey, setShownKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [entering, setEntering] = useState(false);
  const [typedKey, setTypedKey] = useState('');
  const [typedInvalid, setTypedInvalid] = useState(false);
  const [unlinking, setUnlinking] = useState(false);
  const [found, setFound] = useState<FoundBackup | null>(null);
  const [restored, setRestored] = useState<number | null>(null);

  const dateTime = useCallback(
    (at: number): string =>
      new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(
        new Date(at),
      ),
    [locale],
  );

  /** The one sentence for a refusal — each has a different way out. */
  const refusalLine = (outcome: BackupOutcome): string => {
    if (outcome.kind === 'ok') return plural(locale, outcome.records, t.backup.backedUp);
    switch (outcome.refusal) {
      case 'not-configured':
        return t.backup.unavailable;
      case 'not-connected':
        return t.backup.refusedNotConnected;
      case 'no-key':
        return t.backup.refusedNoKey;
      case 'offline':
        return t.backup.refusedOffline;
      case 'network-policy':
        return t.backup.refusedNetwork;
      case 'auth':
        return t.backup.refusedAuth;
      case 'no-backup':
        return t.backup.refusedNoBackup;
      default:
        return t.backup.refusedBusy;
    }
  };

  const phaseLine =
    backup.phase === 'collecting'
      ? t.backup.phaseCollecting
      : backup.phase === 'sealing'
        ? t.backup.phaseSealing
        : backup.phase === 'uploading'
          ? t.backup.phaseUploading
          : null;

  const onConnect = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await backup.connect();
    } catch (caught) {
      setError(friendlyError(caught, t.backup.connectFailed, 'backup.connect'));
    } finally {
      setBusy(false);
    }
  };

  const onBackUpNow = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await backup.backupNow();
    } catch (caught) {
      setError(friendlyError(caught, t.backup.backupFailed, 'backup.run'));
    } finally {
      setBusy(false);
    }
  };

  const onCreateKey = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      setCopied(false);
      setShownKey(await backup.createKey());
    } catch (caught) {
      setError(friendlyError(caught, t.backup.backupFailed, 'backup.createKey'));
    } finally {
      setBusy(false);
    }
  };

  const onShowKey = async (): Promise<void> => {
    setCopied(false);
    setShownKey(await backup.revealKey());
  };

  const onAcceptKey = async (): Promise<void> => {
    if (!(await backup.acceptKey(typedKey))) {
      setTypedInvalid(true);
      return;
    }
    setEntering(false);
    setTypedKey('');
    setTypedInvalid(false);
  };

  const onCheckForBackup = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    setRestored(null);
    try {
      const result = await backup.scan();
      if (result.ok) setFound(result);
      else setError(refusalLine({ kind: 'refused', refusal: result.refusal }));
    } catch (caught) {
      // A key that does not open the file throws out of the AEAD. That is the
      // whole diagnosis and it is worth saying precisely; anything else is a
      // transport failure whose text must not reach the screen.
      const wrongKey =
        caught instanceof Error && /Poly1305|invalid tag|decrypt/i.test(caught.message);
      setError(
        wrongKey
          ? t.backup.restoreWrongKey
          : friendlyError(caught, t.backup.restoreFailed, 'backup.scan'),
      );
    } finally {
      setBusy(false);
    }
  };

  const onRestore = async (): Promise<void> => {
    if (!found) return;
    setBusy(true);
    try {
      setRestored(await backup.applyRestore(found));
      setFound(null);
    } catch (caught) {
      setFound(null);
      setError(friendlyError(caught, t.backup.restoreFailed, 'backup.restore'));
    } finally {
      setBusy(false);
    }
  };

  const onUnlink = async (): Promise<void> => {
    setUnlinking(false);
    setBusy(true);
    try {
      await backup.disconnect();
    } catch (caught) {
      setError(friendlyError(caught, t.backup.connectFailed, 'backup.disconnect'));
    } finally {
      setBusy(false);
    }
  };

  const frequencies: { value: BackupFrequency; label: string }[] = [
    { value: BackupFrequency.Off, label: t.backup.freqOff },
    { value: BackupFrequency.Daily, label: t.backup.freqDaily },
    { value: BackupFrequency.Weekly, label: t.backup.freqWeekly },
    { value: BackupFrequency.Monthly, label: t.backup.freqMonthly },
  ];

  const networks: { value: SyncNetworkPreference; label: string }[] = [
    { value: SyncNetworkPreference.Wifi, label: t.backup.networkWifi },
    { value: SyncNetworkPreference.Both, label: t.backup.networkAny },
  ];

  const running = backup.phase !== null;
  // A backup needs a linked account and a key the person has confirmed they
  // kept. Anything less and the button would produce a file nobody can open.
  const canBackUp =
    backup.configured && backup.connected && backup.hasKey && backup.settings.keySeen;

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
          <Text variant="heading">{t.backup.title}</Text>
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
      >
        <Text variant="body" tone="muted">
          {t.backup.intro}
        </Text>

        {!backup.configured ? <Callout tone="warning">{t.backup.unavailable}</Callout> : null}
        {error ? <Callout tone="negative">{error}</Callout> : null}

        {/* Back up now, and the last one. The button and the record it produces
            belong together — a result line under a button somewhere else is a
            result nobody connects to what they just pressed. */}
        <Card style={{ gap: theme.spacing.md }}>
          <Button
            label={t.backup.backUpNow}
            onPress={() => void onBackUpNow()}
            disabled={!canBackUp || busy || running}
            fullWidth
            icon={
              running ? (
                <ActivityIndicator size="small" color={theme.color.onBrand} />
              ) : (
                <Ionicons
                  name="cloud-upload-outline"
                  size={iconSize.md}
                  color={theme.color.onBrand}
                />
              )
            }
          />
          {phaseLine ? (
            <Text variant="micro" tone="muted" align="center">
              {phaseLine}
            </Text>
          ) : backup.outcome ? (
            <Text
              variant="micro"
              tone={backup.outcome.kind === 'ok' ? 'muted' : 'faint'}
              align="center"
            >
              {refusalLine(backup.outcome)}
            </Text>
          ) : null}

          <Divider />
          <Row style={{ justifyContent: 'space-between' }}>
            <Text variant="micro" tone="faint">
              {t.backup.lastSection}
            </Text>
            <Text variant="micro" tone="muted">
              {backup.settings.last
                ? `${dateTime(backup.settings.last.at)} · ${formatBytes(
                    backup.settings.last.size,
                    locale,
                  )}`
                : t.backup.never}
            </Text>
          </Row>
        </Card>

        {/* Which Google account. */}
        <View style={{ gap: theme.spacing.sm }}>
          <SectionHeader title={t.backup.accountSection} />
          <Card style={{ gap: theme.spacing.md }}>
            <Row style={{ gap: theme.spacing.md }}>
              <Ionicons
                name={backup.connected ? 'logo-google' : 'cloud-offline-outline'}
                size={iconSize.xl}
                color={backup.connected ? theme.color.brand : theme.color.textFaint}
              />
              {/* The linked address when Drive will say who it is, and the
                  destination's own name when it will not — never a guess, and
                  never a blank row that reads as "not connected". */}
              <Text variant="body" style={{ flex: 1 }}>
                {backup.connected ? (backup.account ?? PROVIDER_LABEL) : t.backup.notConnected}
              </Text>
            </Row>
            <Button
              label={backup.connected ? t.backup.disconnect : t.backup.connect}
              variant={backup.connected ? 'ghostDanger' : 'secondary'}
              onPress={() => (backup.connected ? setUnlinking(true) : void onConnect())}
              disabled={!backup.configured || busy}
              fullWidth
            />
          </Card>
        </View>

        {/* The key. Above the schedule on purpose — see the file header. */}
        <View style={{ gap: theme.spacing.sm }}>
          <SectionHeader title={t.backup.keySection} />
          <Card style={{ gap: theme.spacing.md }}>
            <Text variant="micro" tone="muted">
              {t.backup.keyIntro}
            </Text>
            <Row style={{ gap: theme.spacing.sm }}>
              <Ionicons
                name={backup.hasKey ? 'key' : 'key-outline'}
                size={iconSize.md}
                color={backup.hasKey ? theme.color.brand : theme.color.textFaint}
              />
              <Text variant="body">{backup.hasKey ? t.backup.keyPresent : t.backup.keyAbsent}</Text>
            </Row>
            {/* A key made and then dismissed without confirming leaves "Back up
                now" disabled with nothing on screen explaining why. Say it, and
                point at the button that fixes it. */}
            {backup.hasKey && !backup.settings.keySeen ? (
              <Callout tone="warning">{t.backup.keyWarning}</Callout>
            ) : null}
            <Row style={{ gap: theme.spacing.sm }}>
              <View style={{ flex: 1 }}>
                <Button
                  label={backup.hasKey ? t.backup.keyShow : t.backup.keyCreate}
                  variant="secondary"
                  size="sm"
                  onPress={() => void (backup.hasKey ? onShowKey() : onCreateKey())}
                  disabled={busy}
                  fullWidth
                />
              </View>
              <View style={{ flex: 1 }}>
                <Button
                  label={t.backup.keyEnter}
                  variant="ghost"
                  size="sm"
                  onPress={() => {
                    setTypedKey('');
                    setTypedInvalid(false);
                    setEntering(true);
                  }}
                  disabled={busy}
                  fullWidth
                />
              </View>
            </Row>
          </Card>
        </View>

        {/* How often. */}
        <View style={{ gap: theme.spacing.sm }}>
          <SectionHeader title={t.backup.frequencySection} />
          <Card padded={false} style={{ paddingHorizontal: theme.spacing.lg }}>
            {frequencies.map((option, index) => {
              const chosen = backup.settings.frequency === option.value;
              return (
                <View key={option.value}>
                  <ListRow
                    title={option.label}
                    onPress={() => void backup.setFrequency(option.value)}
                    accessibilityRole="radio"
                    accessibilityState={{ selected: chosen }}
                    accessibilityLabel={`${option.label}${chosen ? `, ${t.backup.selected}` : ''}`}
                    trailing={
                      chosen ? (
                        <Ionicons name="checkmark" size={iconSize.lg} color={theme.color.brand} />
                      ) : null
                    }
                  />
                  {index < frequencies.length - 1 ? (
                    <View style={{ height: 1, backgroundColor: theme.color.border }} />
                  ) : null}
                </View>
              );
            })}
          </Card>
          <Text variant="micro" tone="faint">
            {t.backup.frequencyNote}
          </Text>
        </View>

        {/* Over which networks. The same vocabulary the sync setting uses. */}
        <View style={{ gap: theme.spacing.sm }}>
          <SectionHeader title={t.backup.networkSection} />
          <Card padded={false} style={{ paddingHorizontal: theme.spacing.lg }}>
            {networks.map((option, index) => {
              const chosen = backup.settings.network === option.value;
              return (
                <View key={option.value}>
                  <ListRow
                    title={option.label}
                    onPress={() => void backup.setNetwork(option.value)}
                    accessibilityRole="radio"
                    accessibilityState={{ selected: chosen }}
                    accessibilityLabel={`${option.label}${chosen ? `, ${t.backup.selected}` : ''}`}
                    leading={
                      <Ionicons
                        name={
                          option.value === SyncNetworkPreference.Wifi
                            ? 'wifi-outline'
                            : 'globe-outline'
                        }
                        size={iconSize.xl}
                        color={theme.color.text}
                      />
                    }
                    trailing={
                      chosen ? (
                        <Ionicons name="checkmark" size={iconSize.lg} color={theme.color.brand} />
                      ) : null
                    }
                  />
                  {index < networks.length - 1 ? (
                    <View style={{ height: 1, backgroundColor: theme.color.border }} />
                  ) : null}
                </View>
              );
            })}
          </Card>
        </View>

        {/* Getting it back. Last, and deliberately not beside "Back up now". */}
        <View style={{ gap: theme.spacing.sm }}>
          <SectionHeader title={t.backup.restoreSection} />
          <Card style={{ gap: theme.spacing.md }}>
            <Text variant="micro" tone="muted">
              {t.backup.restoreIntro}
            </Text>
            {restored !== null ? (
              <Text variant="body" tone="muted">
                {plural(locale, restored, t.backup.restoreDone)}
              </Text>
            ) : null}
            <Button
              label={t.backup.restoreCheck}
              variant="secondary"
              onPress={() => void onCheckForBackup()}
              disabled={!backup.configured || !backup.connected || !backup.hasKey || busy}
              fullWidth
            />
          </Card>
        </View>
      </ScrollView>

      {/* The key, shown once — or again, on request. */}
      <Sheet
        visible={shownKey !== null}
        onClose={() => setShownKey(null)}
        closeLabel={t.common.close}
      >
        <View style={{ gap: theme.spacing.md }}>
          <Text variant="heading">{t.backup.keyTitle}</Text>
          <Card flat style={{ backgroundColor: theme.color.surfaceMuted }}>
            <Text
              variant="body"
              // Monospace so the groups line up and a mistyped character is
              // visible; selectable so it can be dragged out as well as copied.
              selectable
              style={{ fontFamily: 'monospace', letterSpacing: 1, lineHeight: 24 }}
            >
              {shownKey ? formatRecoveryKey(shownKey) : ''}
            </Text>
          </Card>
          <Callout tone="warning">{t.backup.keyWarning}</Callout>
          <Row style={{ gap: theme.spacing.sm }}>
            <View style={{ flex: 1 }}>
              <Button
                label={copied ? t.backup.keyCopied : t.backup.keyCopy}
                variant="secondary"
                onPress={() => {
                  if (!shownKey) return;
                  void Clipboard.setStringAsync(formatRecoveryKey(shownKey));
                  setCopied(true);
                }}
                fullWidth
              />
            </View>
            <View style={{ flex: 1 }}>
              <Button
                label={t.backup.keyConfirm}
                onPress={() => {
                  void backup.confirmKeySeen();
                  setShownKey(null);
                }}
                fullWidth
              />
            </View>
          </Row>
        </View>
      </Sheet>

      {/* A key brought over from the phone that made the backup. */}
      <Sheet visible={entering} onClose={() => setEntering(false)} closeLabel={t.common.close}>
        <View style={{ gap: theme.spacing.md }}>
          <Text variant="heading">{t.backup.keyEnterTitle}</Text>
          <Text variant="micro" tone="muted">
            {t.backup.keyEnterBody}
          </Text>
          <Card flat style={{ backgroundColor: theme.color.surfaceMuted }}>
            <TextInput
              value={typedKey}
              onChangeText={(value) => {
                setTypedKey(value);
                setTypedInvalid(false);
              }}
              placeholder={t.backup.keyEnterPlaceholder}
              placeholderTextColor={theme.color.textFaint}
              accessibilityLabel={t.backup.keyEnterTitle}
              autoCapitalize="none"
              autoCorrect={false}
              multiline
              style={{
                minHeight: 72,
                fontSize: 16,
                fontFamily: 'monospace',
                color: theme.color.text,
                textAlignVertical: 'top',
                // A key is hexadecimal in either direction; forcing LTR keeps it
                // readable, and typed correctly, in an Arabic layout.
                writingDirection: 'ltr',
              }}
            />
          </Card>
          {typedInvalid ? <Callout tone="negative">{t.backup.keyEnterInvalid}</Callout> : null}
          <Button label={t.backup.keyEnterSave} onPress={() => void onAcceptKey()} fullWidth />
        </View>
      </Sheet>

      {/* What a restore would bring back, before it brings anything back. */}
      <Sheet visible={found !== null} onClose={() => setFound(null)} closeLabel={t.common.close}>
        <View style={{ gap: theme.spacing.md }}>
          <Text variant="heading">{t.backup.restoreSection}</Text>
          {found ? (
            <>
              <Text variant="micro" tone="muted">
                {t.backup.restoreFrom.replace(
                  '{date}',
                  found.body.createdAt ? dateTime(Date.parse(found.body.createdAt)) : '—',
                )}
              </Text>
              <Text variant="body">
                {found.plan.restore.length === 0
                  ? t.backup.restoreNothingNew
                  : plural(locale, found.plan.restore.length, t.backup.restoreFound)}
              </Text>
              {found.plan.restore.length > 0 ? (
                <Button
                  label={t.backup.restoreConfirm}
                  onPress={() => void onRestore()}
                  disabled={busy}
                  fullWidth
                />
              ) : null}
            </>
          ) : null}
        </View>
      </Sheet>

      <Popup visible={unlinking} onClose={() => setUnlinking(false)} closeLabel={t.common.close}>
        <View style={{ gap: theme.spacing.md }}>
          <Text variant="heading">{t.backup.disconnectTitle}</Text>
          <Text variant="body" tone="muted">
            {t.backup.disconnectBody}
          </Text>
          <Row style={{ gap: theme.spacing.sm }}>
            <View style={{ flex: 1 }}>
              <Button
                label={t.common.cancel}
                variant="ghost"
                onPress={() => setUnlinking(false)}
                fullWidth
              />
            </View>
            <View style={{ flex: 1 }}>
              <Button
                label={t.backup.disconnect}
                variant="danger"
                onPress={() => void onUnlink()}
                fullWidth
              />
            </View>
          </Row>
        </View>
      </Popup>
    </Screen>
  );
}
