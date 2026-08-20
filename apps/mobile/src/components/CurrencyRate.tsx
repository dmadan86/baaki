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

import { useEffect, useRef, useState } from 'react';
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
} from '@waves/core';
import { Button, Callout, Card, ChipRow, Text, useTheme } from '@waves/ui';

import { useStrings } from '@/i18n';
import { friendlyError } from '@/lib/errors';

import { fetchFxRate } from '@/data/api';

/** Enough for the currencies an India-first app actually sees. Exported so the
 *  capture screen's currency picker draws from the very same shortlist rather
 *  than a second copy that could drift out of step with this one. */
export const COMMON_CURRENCIES = [
  'INR',
  'USD',
  'EUR',
  'GBP',
  'AED',
  'SGD',
  'AUD',
  'THB',
  'JPY',
  'LKR',
  'NPR',
];

enum Method {
  Charged = 'charged',
  Typed = 'typed',
  Fetched = 'fetched',
}

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
  /**
   * Whether this component owns picking the currency, too.
   *
   * True (the default) keeps the historical shape: a "Paid in another currency"
   * ghost button that opens a card carrying both the currency chips and, once a
   * foreign currency is chosen, the rate. False means the currency is chosen
   * elsewhere — the add-expense header pill — so this collapses to the rate
   * alone: nothing at all while the expense is in the group's currency, and only
   * the rate methods once it is foreign.
   */
  showCurrencyPicker?: boolean;
}

export function CurrencyRate({
  groupCurrency,
  currency,
  onCurrencyChange,
  amount,
  fx,
  onFxChange,
  showCurrencyPicker = true,
}: CurrencyRateProps): React.JSX.Element | null {
  const theme = useTheme();
  const { t } = useStrings();
  const [open, setOpen] = useState(false);
  const [method, setMethod] = useState<Method>(Method.Charged);
  const [chargedText, setChargedText] = useState('');
  const [rateText, setRateText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The pair the component is showing right now. `fetchToday` captures the pair
  // it launched for and, on return, applies its result only if this still
  // matches — otherwise a rate fetched for a currency the user has since changed
  // away from would land on the new pair. Kept in a ref so the async closure
  // reads the latest value, not the one it closed over.
  const latestPair = useRef(`${currency}|${groupCurrency}`);
  useEffect(() => {
    latestPair.current = `${currency}|${groupCurrency}`;
  }, [currency, groupCurrency]);

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
      setError(t.misc.notAnAmount);
    }
  };

  // The charged-amount method implies the rate from `amount`. If the expense
  // amount is edited after the charged amount was typed, the stored rate would
  // otherwise keep the value implied by the old amount. Recompute it here.
  useEffect(() => {
    if (method !== Method.Charged) return;
    if (!chargedText.trim() || amount === 0n) return;
    try {
      const charged = money(parseMinor(chargedText, groupCurrency), groupCurrency);
      onFxChange(toFxRecord(rateFromAmounts(money(amount, currency), charged)));
    } catch {
      onFxChange(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [amount, method, chargedText, currency, groupCurrency]);

  // When the currency is chosen elsewhere (the header pill), a change to it must
  // clear a rate typed for the previous currency — the same reset `choose` does
  // on the legacy in-card chips. Done during render (React's "adjust state when
  // the input changes" pattern) rather than in an effect, so it never lags a
  // frame behind the new currency. Guarded to the pill-driven path; the legacy
  // chips already clear through `choose`.
  const [ratedFor, setRatedFor] = useState(currency);
  if (!showCurrencyPicker && ratedFor !== currency) {
    setRatedFor(currency);
    setChargedText('');
    setRateText('');
    setError(null);
  }

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
      setError(t.misc.notARate);
    }
  };

  const fetchToday = async (): Promise<void> => {
    // The pair this request is for; a change away from it before the response
    // lands makes the response stale, and stale rates must not be applied.
    const pair = `${currency}|${groupCurrency}`;
    setError(null);
    setBusy(true);
    try {
      const record = await fetchFxRate(currency, groupCurrency);
      if (latestPair.current !== pair) return;
      onFxChange(record);
      setRateText(rateToDecimal(fromFxRecord(record), 4));
    } catch (caught) {
      if (latestPair.current !== pair) return;
      // Not a blocker: typing a rate works offline and is often more accurate.
      setError(
        `${friendlyError(caught, t.misc.rateFetchFailed, 'currencyRate.fetch')}${t.misc.rateFetchFailedSuffix}`,
      );
    } finally {
      if (latestPair.current === pair) setBusy(false);
    }
  };

  const converted = fx && amount > 0n ? convertWithRecord(money(amount, currency), fx) : null;

  // The currency lives in the header pill: nothing to show until the expense is
  // foreign, and then only the rate — never the in-card currency chips.
  if (!showCurrencyPicker) {
    if (!foreign) return null;
  } else if (!open && !foreign) {
    return (
      <Button
        label={t.misc.paidAnotherCurrency}
        variant="ghost"
        onPress={() => setOpen(true)}
        accessibilityHint={t.misc.settlesInHint.replace('{currency}', groupCurrency)}
      />
    );
  }

  return (
    <Card style={{ gap: theme.spacing.md }}>
      <Text variant="caption" tone="muted">
        {t.extras.paidIn}
      </Text>
      {showCurrencyPicker ? (
        <ChipRow<string>
          value={currency}
          onChange={choose}
          options={COMMON_CURRENCIES.map((code) => ({ value: code, label: code }))}
        />
      ) : null}

      {foreign ? (
        <>
          <Text variant="caption" tone="muted">
            {t.misc.howDoYouKnowRate.replace('{currency}', groupCurrency)}
          </Text>
          <ChipRow<Method>
            value={method}
            onChange={(next) => {
              setMethod(next);
              setError(null);
            }}
            options={[
              { value: Method.Charged, label: t.misc.whatIWasCharged },
              { value: Method.Typed, label: t.extras.iKnowTheRate },
              { value: Method.Fetched, label: t.misc.todaysRate },
            ]}
          />

          {method === Method.Charged ? (
            <View style={{ gap: theme.spacing.xs }}>
              <Text variant="caption" tone="muted">
                {t.misc.statementAmountLabel.replace('{currency}', groupCurrency)}
              </Text>
              <TextInput
                value={chargedText}
                onChangeText={applyCharged}
                keyboardType="decimal-pad"
                accessibilityLabel={t.misc.amountChargedIn.replace('{currency}', groupCurrency)}
                placeholder="4562.50"
                placeholderTextColor={theme.color.textFaint}
                style={inputStyle(theme)}
              />
              <Text variant="micro" tone="muted">
                {t.misc.bankRateNote}
              </Text>
            </View>
          ) : null}

          {method === Method.Typed ? (
            <View style={{ gap: theme.spacing.xs }}>
              <Text variant="caption" tone="muted">
                {t.misc.fxOneEquals.replace('{from}', currency).replace('{to}', groupCurrency)}
              </Text>
              <TextInput
                value={rateText}
                onChangeText={applyTyped}
                keyboardType="decimal-pad"
                accessibilityLabel={t.misc.fxRateFromTo
                  .replace('{from}', currency)
                  .replace('{to}', groupCurrency)}
                placeholder="91.25"
                placeholderTextColor={theme.color.textFaint}
                style={inputStyle(theme)}
              />
            </View>
          ) : null}

          {method === Method.Fetched ? (
            <Button
              label={
                busy
                  ? t.misc.askingRate
                  : t.misc.getTodaysRate.replace('{from}', currency).replace('{to}', groupCurrency)
              }
              variant="secondary"
              disabled={busy}
              onPress={() => void fetchToday()}
            />
          ) : null}

          {converted ? (
            <Text variant="caption" tone="positive">
              {t.misc.convertedApprox
                .replace('{amount}', format(converted))
                .replace('{currency}', groupCurrency)}
            </Text>
          ) : null}

          {fx ? (
            <Text variant="micro" tone="muted">
              {t.misc.rateStoredNote
                .replace('{rate}', rateToDecimal(fromFxRecord(fx), 4))
                .replace(
                  '{source}',
                  fx.source === 'ecb'
                    ? t.misc.rateSourceEcb
                    : fx.source === 'implied'
                      ? t.misc.rateSourceImplied
                      : t.misc.rateSourceYou,
                )}
            </Text>
          ) : (
            <Text variant="micro" tone="muted">
              {t.misc.noRateNote.replaceAll('{currency}', currency)}
            </Text>
          )}

          {error ? <Callout tone="negative">{error}</Callout> : null}
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
