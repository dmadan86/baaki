/**
 * The trip's exchange rates, pinned on the group (ADR-003, extended).
 *
 * A rate should be entered once, not once per bill. An admin pins one number
 * per currency the trip will be paid in — "1 ₹ = ₫312" — and every expense
 * entered in that currency converts with it, for everybody, including the
 * budgets. A bill can still disagree: the rate on an expense wins over the
 * trip's, and what is stored on the expense is the winner, so moving the trip
 * rate next week can never quietly re-price last week's dinner.
 *
 * Two controls live here. `SettlesInRow` is the currency the group counts in —
 * the one thing every balance is expressed in, and so the one thing that cannot
 * be moved once there are entries counted in it. `TripRatesCard` is the list of
 * pinned rates and the sheet that edits one.
 *
 * The editor asks for the rate in whichever direction gives a number bigger
 * than one, because that is the direction people actually hold: 312 dong to the
 * rupee, 91 rupees to the dollar. Which of those it is depends on the pair, so
 * both are offered and either is turned into the single shape storage takes.
 */

import { useState } from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import { TextInput, View } from 'react-native';

import {
  type CurrencyCode,
  currencySymbol,
  fromFxRecord,
  type FxRate,
  isCurrencyCode,
} from '@waves/core';
import {
  Button,
  Card,
  ChipRow,
  iconSize,
  ListRow,
  Row,
  SectionHeader,
  Sheet,
  Text,
  useTheme,
} from '@waves/ui';

import { COMMON_CURRENCIES } from '@/components/CurrencyRate';
import { ChoiceRow } from '@/components/expense/SheetOverlay';
import { fetchFxRate } from '@/data/api';
import { useGroupFxRates, useSetGroupFxRate } from '@/data/hooks';
import { useStrings } from '@/i18n';
import { friendlyError } from '@/lib/errors';
import {
  homeFirstFor,
  rateFromTyped,
  rateLine,
  shownText,
  tripRateFor,
  type TripRateRow,
} from '@/lib/tripRates';

/** A currency's mark in a fixed-width slot, so a column of them lines up. */
function CurrencyMark({ code }: { code: string }) {
  const theme = useTheme();
  return (
    <View
      style={{
        width: 40,
        height: 40,
        borderRadius: theme.radius.pill,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: theme.color.brandSoft,
      }}
    >
      <Text variant="subheading" tone="brand" numberOfLines={1} adjustsFontSizeToFit>
        {currencySymbol(code)}
      </Text>
    </View>
  );
}

/**
 * The currency the group counts in.
 *
 * Openable only while the group has nothing counted in it yet. Every balance,
 * every settle-up and every pinned rate points at this currency, and changing
 * it under a ledger would not convert those — it would relabel them, which is
 * the one thing a ledger must never do. So after the first expense it is a fact
 * the row states rather than a control.
 */
export function SettlesInRow({
  currency,
  locked,
  onChange,
}: {
  currency: string;
  locked: boolean;
  onChange: (currency: string) => void;
}) {
  const theme = useTheme();
  const { t } = useStrings();
  const [open, setOpen] = useState(false);

  return (
    <>
      <Card padded={false} style={{ paddingHorizontal: theme.spacing.lg }}>
        <ListRow
          title={t.fx.settlesIn}
          subtitle={locked ? t.fx.settlesInLocked : t.fx.settlesInHint}
          leading={<CurrencyMark code={currency} />}
          trailing={
            <Row style={{ alignItems: 'center', gap: theme.spacing.xs }}>
              <Text variant="body" tone="muted">
                {currency}
              </Text>
              {locked ? null : (
                <Ionicons name="chevron-forward" size={iconSize.sm} color={theme.color.textFaint} />
              )}
            </Row>
          }
          onPress={locked ? undefined : () => setOpen(true)}
        />
      </Card>

      <Sheet
        visible={open}
        onClose={() => setOpen(false)}
        closeLabel={t.common.close}
        style={{ maxHeight: '82%' }}
      >
        <Text variant="heading">{t.fx.settlesIn}</Text>
        <View style={{ gap: theme.spacing.xs }}>
          {COMMON_CURRENCIES.map((code) => (
            <ChoiceRow
              key={code}
              leading={<CurrencyMark code={code} />}
              label={code}
              selected={code === currency}
              onPress={() => {
                setOpen(false);
                if (code !== currency) onChange(code);
              }}
            />
          ))}
        </View>
      </Sheet>
    </>
  );
}

/**
 * The pinned rates, and the way to pin another.
 *
 * A member who is not an admin still sees the rates — they are what their own
 * bills will be converted with, so hiding them would be hiding the arithmetic —
 * but the rows do not open and the add button is not drawn.
 */
export function TripRatesCard({
  groupId,
  groupCurrency,
  canEdit,
}: {
  groupId: string;
  groupCurrency: string;
  canEdit: boolean;
}) {
  const theme = useTheme();
  const { t } = useStrings();
  const rates = useGroupFxRates(groupId);
  const rows: TripRateRow[] = rates.data ?? [];
  /** The currency being edited, or `''` for a rate that does not exist yet. */
  const [editing, setEditing] = useState<string | null>(null);

  return (
    <View style={{ gap: theme.spacing.sm }}>
      <SectionHeader title={t.fx.tripRates} />
      <Text variant="caption" tone="muted">
        {t.fx.tripRatesBody}
      </Text>

      <Card padded={false} style={{ paddingHorizontal: theme.spacing.lg }}>
        {rows.length === 0 ? (
          <View style={{ paddingVertical: theme.spacing.md }}>
            <Text variant="caption" tone="muted">
              {canEdit ? t.fx.noRates : `${t.fx.noRates} ${t.fx.adminOnly}`}
            </Text>
          </View>
        ) : (
          rows.map((row) => {
            const rate = tripRateFor([row], row.from, groupCurrency);
            return (
              <ListRow
                key={row.from}
                title={row.from}
                subtitle={rate ? rateLine(rate) : undefined}
                leading={<CurrencyMark code={row.from} />}
                trailing={
                  canEdit ? (
                    <Ionicons
                      name="chevron-forward"
                      size={iconSize.sm}
                      color={theme.color.textFaint}
                    />
                  ) : undefined
                }
                onPress={canEdit ? () => setEditing(row.from) : undefined}
              />
            );
          })
        )}

        {canEdit ? (
          <ListRow
            title={t.fx.addRate}
            leading={
              <View
                style={{
                  width: 40,
                  height: 40,
                  borderRadius: theme.radius.pill,
                  alignItems: 'center',
                  justifyContent: 'center',
                  backgroundColor: theme.color.brandSoft,
                }}
              >
                <Ionicons name="add" size={iconSize.md} color={theme.color.brand} />
              </View>
            }
            onPress={() => setEditing('')}
          />
        ) : null}
      </Card>

      <Text variant="micro" tone="faint">
        {t.fx.appliesNote}
      </Text>

      {editing !== null ? (
        <TripRateSheet
          groupId={groupId}
          groupCurrency={groupCurrency}
          editingFrom={editing}
          taken={rows.map((row) => row.from)}
          onClose={() => setEditing(null)}
        />
      ) : null}
    </View>
  );
}

/**
 * Pin one currency's rate.
 *
 * Two ways to arrive at the number, in the order somebody actually has one:
 * typing what they know, and asking for today's mid-market rate. There is no
 * "what my card charged" here — that is a fact about one payment, and this is
 * the number the whole trip is counted with; the per-bill editor keeps it.
 */
function TripRateSheet({
  groupId,
  groupCurrency,
  editingFrom,
  taken,
  onClose,
}: {
  groupId: string;
  groupCurrency: string;
  /** The currency being edited, or `''` when pinning a new one. */
  editingFrom: string;
  taken: readonly string[];
  onClose: () => void;
}) {
  const theme = useTheme();
  const { t } = useStrings();
  const rates = useGroupFxRates(groupId);
  const setRate = useSetGroupFxRate(groupId);

  const existing =
    editingFrom === '' ? null : tripRateFor(rates.data ?? [], editingFrom, groupCurrency);

  const [from, setFrom] = useState(editingFrom);
  // Which way round the input reads. On an existing rate, open it the way it is
  // shown in the list — that is the way its number is readable.
  const [homeFirst, setHomeFirst] = useState(existing ? homeFirstFor(existing) : false);
  const [text, setText] = useState(() =>
    existing ? shownText(existing, homeFirstFor(existing)) : '',
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The rate as it actually is, when we have it exactly: the one already pinned,
  // the one just fetched, the one carried through a turn of the direction.
  //
  // The field cannot hold it. Turned around, 1/91.25 is 0.010958…, and what the
  // input shows is that rounded — so reading the rate back out of the text would
  // shave a tenth of a percent off it every time somebody pressed "turn it
  // around". Typing clears this, because then the typed number IS the rate.
  const [exact, setExact] = useState<FxRate | null>(existing);

  const foreign = isCurrencyCode(from) ? (from as CurrencyCode) : null;
  const home = groupCurrency as CurrencyCode;
  const rate: FxRate | null =
    exact ?? (foreign ? rateFromTyped(text, foreign, home, homeFirst) : null);

  const choices = COMMON_CURRENCIES.filter(
    (code) => code !== groupCurrency && (code === editingFrom || !taken.includes(code)),
  );

  const fetchToday = async (): Promise<void> => {
    if (!foreign) return;
    setError(null);
    setBusy(true);
    try {
      const record = await fetchFxRate(foreign, home);
      // Show the fetched number the way this input is currently pointing, so
      // the field the person is reading is the field that changed.
      const fetched = fromFxRecord(record);
      setExact(fetched);
      setText(shownText(fetched, homeFirst));
    } catch (caught) {
      setError(
        `${friendlyError(caught, t.misc.rateFetchFailed, 'tripRate.fetch')}${t.misc.rateFetchFailedSuffix}`,
      );
    } finally {
      setBusy(false);
    }
  };

  const save = (): void => {
    if (!rate) return;
    setRate.mutate(
      // Where the number came from rides with it: a fetched rate says so, a
      // typed one says it was typed, and the list can tell them apart later.
      { from: rate.from, num: rate.num, den: rate.den, source: rate.source || 'manual' },
      {
        onSuccess: onClose,
        onError: (caught) => setError(friendlyError(caught, '', 'tripRate.set')),
      },
    );
  };

  const remove = (): void => {
    if (!foreign) return;
    setRate.mutate(
      { from: foreign, num: null, den: null },
      {
        onSuccess: onClose,
        onError: (caught) => setError(friendlyError(caught, '', 'tripRate.set')),
      },
    );
  };

  const leftCode = homeFirst ? groupCurrency : from;
  const rightCode = homeFirst ? from : groupCurrency;

  return (
    <Sheet visible onClose={onClose} closeLabel={t.common.close} style={{ maxHeight: '88%' }}>
      <Text variant="heading">{editingFrom === '' ? t.fx.newRate : t.fx.editRate}</Text>

      {editingFrom === '' ? (
        <ChipRow<string>
          value={from}
          onChange={(next) => {
            setFrom(next);
            setText('');
            setExact(null);
            setError(null);
          }}
          options={choices.map((code) => ({ value: code, label: code }))}
        />
      ) : null}

      {foreign ? (
        <>
          <View style={{ gap: theme.spacing.xs }}>
            <Row style={{ alignItems: 'center', justifyContent: 'space-between' }}>
              <Text variant="caption" tone="muted">
                {t.fx.oneEquals.replace('{from}', leftCode)}
              </Text>
              <Button
                label={t.fx.swap}
                variant="ghost"
                size="sm"
                onPress={() => {
                  // Turning it around re-states the same rate the other way up,
                  // read off the stored rational — never off the text, which
                  // has already been rounded for display once.
                  const next = !homeFirst;
                  if (rate) {
                    // Carry the rate itself across, and show it rounded — the
                    // display is the only thing that rounds.
                    setExact(rate);
                    setText(shownText(rate, next));
                  }
                  setHomeFirst(next);
                }}
              />
            </Row>
            <Row style={{ alignItems: 'center', gap: theme.spacing.sm }}>
              <TextInput
                value={text}
                onChangeText={(next) => {
                  setText(next);
                  // Typed over: the number in the field is now the rate itself.
                  setExact(null);
                  setError(null);
                }}
                keyboardType="decimal-pad"
                accessibilityLabel={t.fx.oneEquals.replace('{from}', leftCode)}
                placeholder="312"
                placeholderTextColor={theme.color.textFaint}
                style={{
                  flex: 1,
                  borderWidth: 1,
                  borderColor: theme.color.border,
                  borderRadius: theme.radius.md,
                  paddingHorizontal: theme.spacing.md,
                  paddingVertical: theme.spacing.sm,
                  color: theme.color.text,
                  fontSize: 18,
                }}
              />
              <Text variant="subheading" tone="muted">
                {rightCode}
              </Text>
            </Row>
          </View>

          <Button
            label={
              busy
                ? t.misc.askingRate
                : t.misc.getTodaysRate.replace('{from}', from).replace('{to}', groupCurrency)
            }
            variant="secondary"
            disabled={busy}
            onPress={() => void fetchToday()}
          />

          {rate ? (
            <Text variant="caption" tone="positive">
              {rateLine(rate)}
            </Text>
          ) : text.trim() ? (
            <Text variant="caption" tone="negative">
              {t.misc.notARate}
            </Text>
          ) : null}
        </>
      ) : null}

      {error ? (
        <Text variant="caption" tone="negative">
          {error}
        </Text>
      ) : null}

      <Text variant="micro" tone="faint">
        {t.fx.removeConfirm}
      </Text>

      <Button
        label={t.common.save}
        fullWidth
        disabled={!rate || setRate.isPending}
        onPress={save}
      />
      {existing ? (
        <Button
          label={t.fx.removeRate}
          variant="ghostDanger"
          fullWidth
          disabled={setRate.isPending}
          onPress={remove}
        />
      ) : null}
    </Sheet>
  );
}
