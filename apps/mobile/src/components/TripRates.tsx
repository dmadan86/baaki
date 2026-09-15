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
import { Pressable, ScrollView, TextInput, View } from 'react-native';

import { type CurrencyCode, fromFxRecord, type FxRate, isCurrencyCode } from '@waves/core';
import {
  Button,
  Card,
  directionalIcon,
  iconSize,
  ListRow,
  Row,
  SectionHeader,
  Sheet,
  Text,
  useTheme,
} from '@waves/ui';

import { fetchFxRate } from '@/data/api';
import { COMMON_CURRENCIES } from '@/lib/currencyChoices';
import { useGroupFxRates, useSetGroupFxRate } from '@/data/hooks';
import { useStrings } from '@/i18n';
import { friendlyError } from '@/lib/errors';
import {
  currencyMark,
  currencyName,
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
      <Text variant="caption" tone="brand" numberOfLines={1} adjustsFontSizeToFit>
        {currencyMark(code) || code}
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
  const { t, locale } = useStrings();
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
        <ScrollView showsVerticalScrollIndicator={false} style={{ flexShrink: 1 }}>
          {COMMON_CURRENCIES.map((code) => {
            const name = currencyName(code, locale);
            return (
              <ListRow
                key={code}
                title={name ?? code}
                subtitle={name ? code : undefined}
                leading={<CurrencyMark code={code} />}
                trailing={
                  code === currency ? (
                    <Ionicons name="checkmark" size={iconSize.md} color={theme.color.brand} />
                  ) : undefined
                }
                accessibilityRole="radio"
                accessibilityState={{ selected: code === currency }}
                onPress={() => {
                  setOpen(false);
                  if (code !== currency) onChange(code);
                }}
              />
            );
          })}
        </ScrollView>
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
  const { t, locale } = useStrings();
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
            const name = currencyName(row.from, locale);
            return (
              <ListRow
                key={row.from}
                title={name ? `${name} · ${row.from}` : row.from}
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
 * The shape every app that converts money has arrived at, and it is worth
 * saying why rather than only that: **two cards, one currency each, and a
 * circle on the seam between them that turns the pair around** (Wise, Revolut,
 * Airwallex and Trust Wallet all draw this, and a traveller has met it before).
 * One card holds a bare `1`, the other holds the number being typed — which is
 * exactly what a rate is, said as a picture instead of as the sentence
 * "1 USD = ⬚ INR" with a text link called "turn it around" beside it.
 *
 * What it replaces was a wall of sixteen chips, a label, a link, a field, a
 * full-width fetch button and a line restating the rate that had just been
 * typed: six controls to enter one number. The currency moved into its own
 * pane, reached by tapping the pill on the card it belongs to, because picking
 * from sixteen currencies is a list with names in it rather than a strip of
 * codes.
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
  const { t, locale } = useStrings();
  const rates = useGroupFxRates(groupId);
  const setRate = useSetGroupFxRate(groupId);

  const existing =
    editingFrom === '' ? null : tripRateFor(rates.data ?? [], editingFrom, groupCurrency);

  const [from, setFrom] = useState(editingFrom);
  // Which currency holds the bare 1. An existing rate opens the way its number
  // is readable — 312 to the rupee rather than 0.0032 to the dong.
  const [homeFirst, setHomeFirst] = useState(existing ? homeFirstFor(existing) : false);
  const [text, setText] = useState(() =>
    existing ? shownText(existing, homeFirstFor(existing)) : '',
  );
  // The rate as it actually is, when we have it exactly: the one already
  // pinned, the one just fetched, the one carried through a turn.
  //
  // The field cannot hold it. Turned around, 1/91.25 is 0.010958…, and what the
  // input shows is that rounded — so reading the rate back out of the text
  // would shave a tenth of a percent off it every time somebody pressed the
  // swap. Typing clears this, because then the typed number IS the rate.
  const [exact, setExact] = useState<FxRate | null>(existing);
  const [picking, setPicking] = useState(editingFrom === '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
      const fetched = fromFxRecord(await fetchFxRate(foreign, home));
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

  const turnAround = (): void => {
    const next = !homeFirst;
    // Carry the rate itself across and show it rounded: the display is the only
    // thing that rounds.
    if (rate) setText(shownText(rate, next));
    setHomeFirst(next);
  };

  // Which currency sits on which card. The one holding the bare 1 is whichever
  // the person is quoting from; the other holds the number they are typing.
  const unitCode = homeFirst ? groupCurrency : from;
  const rateCode = homeFirst ? from : groupCurrency;

  if (picking) {
    return (
      <Sheet
        visible
        onClose={onClose}
        closeLabel={t.common.close}
        style={{ paddingHorizontal: theme.spacing.xl, gap: theme.spacing.lg, maxHeight: '88%' }}
      >
        <CurrencyPane
          choices={choices}
          chosen={from}
          locale={locale}
          canGoBack={Boolean(foreign)}
          onPick={(code) => {
            if (code !== from) {
              setFrom(code);
              setText('');
              setExact(null);
              setError(null);
            }
            setPicking(false);
          }}
          onBack={() => setPicking(false)}
        />
      </Sheet>
    );
  }

  return (
    <Sheet
      visible
      onClose={onClose}
      closeLabel={t.common.close}
      style={{ paddingHorizontal: theme.spacing.xl, gap: theme.spacing.lg, maxHeight: '88%' }}
    >
      <Text variant="heading">{editingFrom === '' ? t.fx.newRate : t.fx.editRate}</Text>

      {/* The pair, and the circle that turns it around. The cards are drawn a
          hair apart so the circle can sit on the seam between them, which is
          the whole reason that control reads as "these two swap" with no label
          on it at all. */}
      <View>
        <RateCard
          value="1"
          code={unitCode}
          locale={locale}
          muted
          onPickCurrency={homeFirst ? undefined : () => setPicking(true)}
        />
        <View style={{ height: theme.spacing.xs }} />
        <RateCard
          value={text}
          code={rateCode}
          locale={locale}
          placeholder="312"
          onChangeText={(next) => {
            setText(next);
            // Typed over: the number in the field is now the rate itself.
            setExact(null);
            setError(null);
          }}
          onPickCurrency={homeFirst ? () => setPicking(true) : undefined}
        />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t.fx.swap}
          onPress={turnAround}
          style={({ pressed }) => ({
            position: 'absolute',
            alignSelf: 'center',
            top: '50%',
            marginTop: -18,
            width: 36,
            height: 36,
            borderRadius: 18,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: theme.color.surface,
            borderWidth: 2,
            // The card's own ground, so the circle punches a hole through the
            // seam rather than sitting on top of both cards.
            borderColor: theme.color.bg,
            opacity: pressed ? 0.6 : 1,
          })}
        >
          <Ionicons name="swap-vertical" size={iconSize.md} color={theme.color.brand} />
        </Pressable>
      </View>

      {/* Quiet, and under the thing it fills in. It was a full-width secondary
          button, which made "ask the internet" look like the action of the
          sheet when the action of the sheet is Save. */}
      <Row style={{ alignItems: 'center', justifyContent: 'space-between' }}>
        <Button
          label={busy ? t.misc.askingRate : t.fx.useTodaysRate}
          variant="ghost"
          size="sm"
          disabled={busy || !foreign}
          onPress={() => void fetchToday()}
        />
        {existing ? (
          <Button
            label={t.fx.removeRate}
            variant="ghostDanger"
            size="sm"
            disabled={setRate.isPending}
            onPress={remove}
          />
        ) : null}
      </Row>

      {error ? (
        <Text variant="caption" tone="negative">
          {error}
        </Text>
      ) : !rate && text.trim() ? (
        <Text variant="caption" tone="negative">
          {t.misc.notARate}
        </Text>
      ) : (
        <Text variant="micro" tone="faint">
          {t.fx.removeConfirm}
        </Text>
      )}

      <Button
        label={t.common.save}
        fullWidth
        disabled={!rate || setRate.isPending}
        onPress={save}
      />
    </Sheet>
  );
}

/**
 * One side of the rate: a number, and the currency it is in.
 *
 * The number is the size of an amount because that is what it is, and the
 * currency is a pill on the right — tappable, with a chevron, only on the side
 * that can change. The group's own currency has no chevron: it is not a choice
 * being made here, and drawing one would offer a door that opens onto nothing.
 */
function RateCard({
  value,
  code,
  locale,
  muted = false,
  placeholder,
  onChangeText,
  onPickCurrency,
}: {
  value: string;
  code: string;
  locale: string;
  /** The fixed `1` side: shown, never typed in. */
  muted?: boolean;
  placeholder?: string;
  onChangeText?: (value: string) => void;
  onPickCurrency?: () => void;
}) {
  const theme = useTheme();
  const mark = currencyMark(code);
  const name = currencyName(code, locale);

  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.spacing.md,
        paddingHorizontal: theme.spacing.lg,
        paddingVertical: theme.spacing.md,
        borderRadius: theme.radius.lg,
        backgroundColor: theme.color.surfaceMuted,
        minHeight: 72,
      }}
    >
      {onChangeText ? (
        <TextInput
          value={value}
          onChangeText={onChangeText}
          keyboardType="decimal-pad"
          accessibilityLabel={name ?? code}
          placeholder={placeholder}
          placeholderTextColor={theme.color.textFaint}
          style={{
            flex: 1,
            fontSize: 28,
            fontWeight: '700',
            color: theme.color.text,
            paddingVertical: 0,
          }}
        />
      ) : (
        <Text
          variant="title"
          tone={muted ? 'muted' : undefined}
          numberOfLines={1}
          style={{ flex: 1 }}
        >
          {value}
        </Text>
      )}

      <Pressable
        accessibilityRole={onPickCurrency ? 'button' : 'text'}
        accessibilityLabel={name ?? code}
        disabled={!onPickCurrency}
        onPress={onPickCurrency}
        style={({ pressed }) => ({
          flexDirection: 'row',
          alignItems: 'center',
          gap: theme.spacing.xs,
          paddingHorizontal: theme.spacing.md,
          paddingVertical: theme.spacing.xs,
          borderRadius: theme.radius.pill,
          backgroundColor: onPickCurrency ? theme.color.surface : 'transparent',
          opacity: pressed ? 0.6 : 1,
        })}
      >
        {mark ? (
          <Text variant="subheading" tone="muted">
            {mark}
          </Text>
        ) : null}
        <Text variant="subheading">{code}</Text>
        {onPickCurrency ? (
          <Ionicons name="chevron-down" size={iconSize.sm} color={theme.color.textMuted} />
        ) : null}
      </Pressable>
    </View>
  );
}

/**
 * Choosing the currency, as a list with names in it.
 *
 * A second pane inside the same sheet rather than a second sheet: a modal
 * opened from inside a modal is a fight with Android, and the cover picker
 * settled this same question the same way.
 *
 * Names, not only codes. "VND" is what somebody types afterwards; "Vietnamese
 * dong" is how they find it in the first place, and sixteen bare codes is a
 * memory test. It is also where a new rate starts — the first question is
 * which currency, so the sheet opens on the answer to it rather than on an
 * empty pair of cards.
 */
function CurrencyPane({
  choices,
  chosen,
  locale,
  canGoBack,
  onPick,
  onBack,
}: {
  choices: readonly string[];
  chosen: string;
  locale: string;
  /** False on a brand-new rate: there is no rate behind this pane to go back to. */
  canGoBack: boolean;
  onPick: (code: string) => void;
  onBack: () => void;
}) {
  const theme = useTheme();
  const { t } = useStrings();

  return (
    <>
      <Row style={{ alignItems: 'center', gap: theme.spacing.sm }}>
        {canGoBack ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t.common.back}
            hitSlop={10}
            onPress={onBack}
            style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
          >
            <Ionicons
              name={directionalIcon('chevron-back')}
              size={iconSize.lg}
              color={theme.color.text}
            />
          </Pressable>
        ) : null}
        <Text variant="heading">{t.captures.currencyPickerTitle}</Text>
      </Row>

      <ScrollView showsVerticalScrollIndicator={false} style={{ flexShrink: 1 }}>
        {choices.map((code) => {
          const name = currencyName(code, locale);
          return (
            <ListRow
              key={code}
              title={name ?? code}
              subtitle={name ? code : undefined}
              leading={<CurrencyMark code={code} />}
              trailing={
                code === chosen ? (
                  <Ionicons name="checkmark" size={iconSize.md} color={theme.color.brand} />
                ) : undefined
              }
              accessibilityRole="radio"
              accessibilityState={{ selected: code === chosen }}
              onPress={() => onPick(code)}
            />
          );
        })}
      </ScrollView>
    </>
  );
}
