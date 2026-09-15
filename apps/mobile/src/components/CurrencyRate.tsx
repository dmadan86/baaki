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
  type FxRate,
  sameRate,
  minorUnitExponent,
  money,
  rateFromAmounts,
  rateFromDecimal,
  rateToDecimal,
  toFxRecord,
  type FxRecord,
} from '@waves/core';
import { Button, Callout, Card, ChipRow, Row, Text, useTheme } from '@waves/ui';

import { useStrings } from '@/i18n';
import { friendlyError } from '@/lib/errors';
import { COMMON_CURRENCIES } from '@/lib/currencyChoices';
import { rateLine } from '@/lib/tripRates';

import { fetchFxRate } from '@/data/api';

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
   * The rate the group has pinned for this pair, if it has one (A?? — see
   * `components/TripRates`).
   *
   * Given one, a foreign expense opens already converted: the trip's rate is
   * put on the bill and the card collapses to a single line saying what the
   * total comes to and which rate said so. That is the whole point of pinning
   * one — the rate was entered for the trip, so it should not be asked for
   * again at every meal. "Change" opens the methods below for this bill alone,
   * and what is then stored on the expense is that bill's own rate: the pinned
   * number is a default, never a rule.
   */
  tripRate?: FxRate | null;
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
  tripRate = null,
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

  // Whether the methods are open. They start closed while the bill is riding the
  // trip's rate, and open the moment somebody asks to change it — or the moment
  // the bill carries a rate that is not the trip's, since that is a choice
  // already made and hiding it would be hiding it from the person who made it.
  const [overriding, setOverriding] = useState(false);
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
    // Invalidate any in-flight fetch synchronously: point `latestPair` at the
    // pair we are switching to so a response for the old pair is dropped the
    // moment it returns, and clear the spinner now — the stale fetch's `finally`
    // is guarded on the pair and would otherwise never release `busy`.
    latestPair.current = `${next}|${groupCurrency}`;
    setBusy(false);
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
    // A new currency is a new question. Whatever was decided about the last
    // one — including a decision to override the trip's rate for it — does not
    // carry over to a rate for a different pair.
    setOverriding(false);
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

  // The trip's rate, but only if it converts the pair this expense is actually
  // in — a pinned VND rate is not a worse answer for a THB bill, it is a wrong
  // one, and `resolveFxRate` skips it for exactly the same reason.
  const pinned =
    tripRate && tripRate.from === currency && tripRate.to === groupCurrency ? tripRate : null;

  // Put the pinned rate on the bill the moment it becomes a foreign one, unless
  // a rate is already there — an edit reopening on its stored rate, or one the
  // person has just typed, is never overwritten by the group's.
  useEffect(() => {
    if (!foreign || !pinned || fx) return;
    onFxChange(toFxRecord(pinned));
    // `onFxChange` is a setter from the screen and stable in practice; keying on
    // it would re-run this on every parent render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [foreign, pinned, fx]);

  const onTripRate = Boolean(pinned && fx && sameRate(fromFxRecord(fx), pinned));

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

  // Riding the trip's rate: one line, not a card of controls. What the bill
  // comes to in the group's currency, the rate that said so, and the way out.
  if (foreign && pinned && onTripRate && !overriding) {
    return (
      <Card style={{ gap: theme.spacing.xs }}>
        <Row style={{ alignItems: 'center', justifyContent: 'space-between' }}>
          <View style={{ flex: 1, gap: 2 }}>
            {converted ? (
              <Text variant="body" numberOfLines={1}>
                {t.misc.convertedApprox
                  .replace('{amount}', format(converted))
                  .replace('{currency}', groupCurrency)}
              </Text>
            ) : null}
            <Text variant="micro" tone="muted" numberOfLines={1}>
              {`${t.fx.tierTrip} · ${rateLine(pinned)}`}
            </Text>
          </View>
          <Button
            label={t.fx.change}
            variant="ghost"
            size="sm"
            onPress={() => setOverriding(true)}
          />
        </Row>
      </Card>
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
