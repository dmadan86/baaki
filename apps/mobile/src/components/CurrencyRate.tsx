/**
 * Paying in a currency the group does not settle in (ADR-003).
 *
 * The expense stays in the currency it was actually paid in — that is the only
 * number that was ever true — and the rate rides along so a converted total can
 * be shown without a converted number ever entering the ledger.
 *
 * Three ways to get a rate, in the order a person actually has one:
 *
 *   - "what my card was charged" — the honest answer for a card payment, since
 *     the bank's rate already includes its markup and no reference rate will
 *     match the statement;
 *   - typing it, which is the only one that works with no network;
 *   - fetching today's mid-market rate, which is convenient and approximate.
 *
 * Fetching is last on purpose. It is the one that looks most authoritative and
 * is most often the least accurate.
 */

import { useState } from 'react';
import { TextInput, View } from 'react-native';

import {
  convertWithRecord,
  format,
  fromFxRecord,
  minorUnitExponent,
  money,
  rateFromAmounts,
  rateFromDecimal,
  rateToDecimal,
  toFxRecord,
  type FxRecord,
} from '@baaki/core';
import { Button, Card, ChipRow, Text, useTheme } from '@baaki/ui';

import { fetchFxRate } from '@/data/api';

/** Enough for the currencies an India-first app actually sees. */
const COMMON = ['INR', 'USD', 'EUR', 'GBP', 'AED', 'SGD', 'AUD', 'THB', 'JPY', 'LKR', 'NPR'];

type Method = 'charged' | 'typed' | 'fetched';

export interface CurrencyRateProps {
  /** What the group settles in. */
  groupCurrency: string;
  /** What this expense was paid in. */
  currency: string;
  onCurrencyChange: (currency: string) => void;
  /** The expense amount, in minor units of `currency`. */
  amount: bigint;
  fx: FxRecord | null;
  onFxChange: (fx: FxRecord | null) => void;
}

export function CurrencyRate({
  groupCurrency,
  currency,
  onCurrencyChange,
  amount,
  fx,
  onFxChange,
}: CurrencyRateProps): React.JSX.Element {
  const theme = useTheme();
  const [open, setOpen] = useState(false);
  const [method, setMethod] = useState<Method>('charged');
  const [chargedText, setChargedText] = useState('');
  const [rateText, setRateText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const foreign = currency !== groupCurrency;

  const choose = (next: string): void => {
    onCurrencyChange(next);
    // A rate for the old currency would convert the wrong thing, and the server
    // rejects it anyway — clearing it here just makes that visible sooner.
    onFxChange(null);
    setChargedText('');
    setRateText('');
    setError(null);
  };

  const applyCharged = (text: string): void => {
    setChargedText(text);
    setError(null);
    if (!text.trim() || amount === 0n) {
      onFxChange(null);
      return;
    }
    try {
      const charged = money(parseMinor(text, groupCurrency), groupCurrency);
      onFxChange(toFxRecord(rateFromAmounts(money(amount, currency), charged)));
    } catch {
      onFxChange(null);
      setError('That does not look like an amount');
    }
  };

  const applyTyped = (text: string): void => {
    setRateText(text);
    setError(null);
    if (!text.trim()) {
      onFxChange(null);
      return;
    }
    try {
      onFxChange(toFxRecord(rateFromDecimal(text.trim(), currency, groupCurrency)));
    } catch {
      onFxChange(null);
      setError('That does not look like a rate');
    }
  };

  const fetchToday = async (): Promise<void> => {
    setError(null);
    setBusy(true);
    try {
      const record = await fetchFxRate(currency, groupCurrency);
      onFxChange(record);
      setRateText(rateToDecimal(fromFxRecord(record), 4));
    } catch (caught) {
      // Not a blocker: typing a rate works offline and is often more accurate.
      setError(
        `${caught instanceof Error ? caught.message : String(caught)} — you can type the rate instead`,
      );
    } finally {
      setBusy(false);
    }
  };

  const converted = fx && amount > 0n ? convertWithRecord(money(amount, currency), fx) : null;

  if (!open && !foreign) {
    return (
      <Button
        label="Paid in another currency"
        variant="ghost"
        onPress={() => setOpen(true)}
        accessibilityHint={`This group settles in ${groupCurrency}`}
      />
    );
  }

  return (
    <Card style={{ gap: theme.spacing.md }}>
      <Text variant="caption" tone="muted">
        Paid in
      </Text>
      <ChipRow<string>
        value={currency}
        onChange={choose}
        options={COMMON.map((code) => ({ value: code, label: code }))}
      />

      {foreign ? (
        <>
          <Text variant="caption" tone="muted">
            {`This group settles in ${groupCurrency}. How do you know the rate?`}
          </Text>
          <ChipRow<Method>
            value={method}
            onChange={(next) => {
              setMethod(next);
              setError(null);
            }}
            options={[
              { value: 'charged', label: 'What I was charged' },
              { value: 'typed', label: 'I know the rate' },
              { value: 'fetched', label: "Today's rate" },
            ]}
          />

          {method === 'charged' ? (
            <View style={{ gap: theme.spacing.xs }}>
              <Text variant="caption" tone="muted">
                {`Amount on your statement, in ${groupCurrency}`}
              </Text>
              <TextInput
                value={chargedText}
                onChangeText={applyCharged}
                keyboardType="decimal-pad"
                accessibilityLabel={`Amount charged in ${groupCurrency}`}
                placeholder="4562.50"
                placeholderTextColor={theme.color.textFaint}
                style={inputStyle(theme)}
              />
              <Text variant="micro" tone="faint">
                Your bank&apos;s rate, markup included — this is what your statement says.
              </Text>
            </View>
          ) : null}

          {method === 'typed' ? (
            <View style={{ gap: theme.spacing.xs }}>
              <Text variant="caption" tone="muted">
                {`1 ${currency} = ? ${groupCurrency}`}
              </Text>
              <TextInput
                value={rateText}
                onChangeText={applyTyped}
                keyboardType="decimal-pad"
                accessibilityLabel={`Rate from ${currency} to ${groupCurrency}`}
                placeholder="91.25"
                placeholderTextColor={theme.color.textFaint}
                style={inputStyle(theme)}
              />
            </View>
          ) : null}

          {method === 'fetched' ? (
            <Button
              label={busy ? 'Asking…' : `Get today's ${currency}→${groupCurrency} rate`}
              variant="secondary"
              disabled={busy}
              onPress={() => void fetchToday()}
            />
          ) : null}

          {converted ? (
            <Text variant="caption" tone="positive">
              {`≈ ${format(converted)} in ${groupCurrency}`}
            </Text>
          ) : null}

          {fx ? (
            <Text variant="micro" tone="faint">
              {`Rate ${rateToDecimal(fromFxRecord(fx), 4)} from ${
                fx.source === 'ecb' ? 'the ECB' : fx.source === 'implied' ? 'your statement' : 'you'
              }. Stored with the expense, so this converts the same way later.`}
            </Text>
          ) : (
            <Text variant="micro" tone="faint">
              Without a rate the expense still saves — it just stays in {currency}, and the group
              keeps a separate {currency} balance.
            </Text>
          )}

          {error ? (
            <Text variant="caption" tone="negative">
              {error}
            </Text>
          ) : null}
        </>
      ) : null}
    </Card>
  );
}

/** "4562.50" → 456250 minor units. Parsed as digits, never as a float. */
function parseMinor(text: string, currency: string): bigint {
  const trimmed = text.trim().replace(/,/g, '');
  if (!/^\d+(\.\d+)?$/.test(trimmed)) throw new Error('not an amount');
  const exponent = minorUnitExponent(currency);
  const [whole = '0', fraction = ''] = trimmed.split('.');
  const padded = (fraction + '0'.repeat(exponent)).slice(0, exponent);
  return BigInt(whole + padded);
}

function inputStyle(theme: ReturnType<typeof useTheme>) {
  return {
    fontSize: 20,
    fontWeight: '600' as const,
    color: theme.color.text,
    paddingVertical: theme.spacing.sm,
  };
}
