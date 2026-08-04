import { useState } from 'react';
import { ActivityIndicator, KeyboardAvoidingView, Platform, TextInput, View } from 'react-native';

import { Button, Card, Screen, Text, useTheme } from '@baaki/ui';

import { useStrings } from '@/i18n';
import { useAuth } from '@/lib/auth';

export default function SignInScreen() {
  const theme = useTheme();
  const { t } = useStrings();
  const { sendOtp, verifyOtp, continueAsGuest } = useAuth();

  const [phone, setPhone] = useState('+91');
  const [code, setCode] = useState('');
  const [stage, setStage] = useState<'phone' | 'code'>('phone');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (action: () => Promise<void>): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen edges={['top', 'bottom']}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={{ flex: 1, justifyContent: 'center', paddingHorizontal: theme.spacing.xl }}
      >
        <View style={{ gap: theme.spacing.xxl }}>
          <View style={{ gap: theme.spacing.sm }}>
            <Text style={{ fontSize: 44, lineHeight: 50, fontWeight: '700' }}>பாக்கி</Text>
            <Text variant="title">Baaki</Text>
            <Text variant="body" tone="muted">
              Split anything with anyone. {t.freeForever}.
            </Text>
          </View>

          <Card style={{ gap: theme.spacing.lg }}>
            {stage === 'phone' ? (
              <>
                <Text variant="caption" tone="muted">
                  Phone number
                </Text>
                <TextInput
                  value={phone}
                  onChangeText={setPhone}
                  keyboardType="phone-pad"
                  autoComplete="tel"
                  accessibilityLabel="Phone number"
                  placeholderTextColor={theme.color.textFaint}
                  style={{
                    fontSize: 22,
                    fontWeight: '600',
                    color: theme.color.text,
                    paddingVertical: theme.spacing.sm,
                  }}
                />
                <Button
                  label="Send code"
                  size="lg"
                  fullWidth
                  disabled={busy || phone.trim().length < 8}
                  onPress={() =>
                    void run(async () => {
                      await sendOtp(phone.trim());
                      setStage('code');
                    })
                  }
                />
              </>
            ) : (
              <>
                <Text variant="caption" tone="muted">
                  {`Code sent to ${phone}`}
                </Text>
                <TextInput
                  value={code}
                  onChangeText={setCode}
                  keyboardType="number-pad"
                  autoComplete="sms-otp"
                  accessibilityLabel="Verification code"
                  placeholder="123456"
                  placeholderTextColor={theme.color.textFaint}
                  style={{
                    fontSize: 28,
                    fontWeight: '700',
                    letterSpacing: 8,
                    color: theme.color.text,
                    paddingVertical: theme.spacing.sm,
                  }}
                />
                <Button
                  label="Verify"
                  size="lg"
                  fullWidth
                  disabled={busy || code.trim().length < 4}
                  onPress={() => void run(() => verifyOtp(phone.trim(), code.trim()))}
                />
                <Button
                  label="Use a different number"
                  variant="ghost"
                  onPress={() => {
                    setStage('phone');
                    setCode('');
                  }}
                />
              </>
            )}

            {busy ? <ActivityIndicator color={theme.color.brand} /> : null}
            {error ? (
              <Text variant="caption" tone="negative">
                {error}
              </Text>
            ) : null}
          </Card>

          {/* ADR-006: nobody is forced to register before they can use Baaki. */}
          <Button
            label="Continue as guest"
            variant="secondary"
            size="lg"
            fullWidth
            disabled={busy}
            onPress={() => void run(continueAsGuest)}
          />

          <Text variant="micro" tone="faint" align="center">
            A guest account keeps everything on this device until you add a phone number. Your
            ledger is never held hostage.
          </Text>
        </View>
      </KeyboardAvoidingView>
    </Screen>
  );
}
