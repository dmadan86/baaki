/**
 * Merge same-person guests into one, on the Friends screen.
 *
 * A guest (ghost) appears once per group, because a name is no proof that the
 * "person1" in one group is the "person1" in another (see the
 * `baaki_people_i_owe` migration). This screen is where the one thing that *is*
 * proof — a person saying "these are the same" — gets recorded. The merge is
 * per-viewer and never rewrites the ledger; each group keeps its own guest and
 * its own balance, and only the Friends aggregation folds them into one name.
 *
 * It is presented as permanent: there is no un-merge, and the screen says so in
 * as many words before the button. Only guests can be picked — a real person is
 * already one identity by their account and must never be folded under a made-up
 * name, which the RPC also enforces.
 */
import { useMemo, useState } from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  TextInput,
  View,
} from 'react-native';

import {
  Avatar,
  Button,
  Callout,
  Card,
  directionalIcon,
  EmptyState,
  IconButton,
  iconSize,
  Row,
  Screen,
  Text,
  useScreenClearance,
  useTheme,
} from '@baaki/ui';

import { fetchPeopleBalances, mergeGhosts, type PersonBalanceRow } from '@/data/api';
import {
  canMerge,
  defaultMergeName,
  isMergeable,
  memberIdsForMerge,
  mergeErrorMessage,
} from '@/data/mergePeople';
import { PeopleSkeleton } from '@/components/Skeletons';
import { plural, useStrings } from '@/i18n';

export default function MergePeopleScreen() {
  const theme = useTheme();
  const clearance = useScreenClearance();
  const { t, locale } = useStrings();
  const queryClient = useQueryClient();

  const people = useQuery({ queryKey: ['people', 'balances'], queryFn: fetchPeopleBalances });

  // One selectable row per guest. A guest unsettled in two currencies is two
  // balance rows but one person, so collapse by `person_key`; the first row
  // carries the member id and name the rest of the screen needs.
  const guests = useMemo(() => {
    const byKey = new Map<string, PersonBalanceRow>();
    for (const row of people.data ?? []) {
      if (!isMergeable(row)) continue;
      if (!byKey.has(row.person_key)) byKey.set(row.person_key, row);
    }
    return [...byKey.values()];
  }, [people.data]);

  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [name, setName] = useState('');
  const [nameTouched, setNameTouched] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedRows = guests.filter((row) => selected.has(row.person_key));

  const toggle = (personKey: string): void => {
    setError(null);
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(personKey)) next.delete(personKey);
      else next.add(personKey);
      // Keep the name in step with the pick until the person types their own.
      if (!nameTouched) {
        const rows = guests.filter((row) => next.has(row.person_key));
        setName(defaultMergeName(rows));
      }
      return next;
    });
  };

  const ready = canMerge(selectedRows) && name.trim().length > 0;

  const merge = useMutation({
    mutationFn: () => mergeGhosts(memberIdsForMerge(selectedRows), name.trim()),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['people', 'balances'] });
      router.back();
    },
    onError: (caught) => setError(mergeErrorMessage(caught, t.mergePeople)),
  });

  return (
    <Screen>
      {/* On edge-to-edge Android the resize inset does not always lift the
          content above the keyboard, so the name field's own button can end up
          behind it and the screen reads as "won't scroll to the end". The
          avoider (padding on iOS, resize on Android) keeps the button reachable
          while the keyboard is open. */}
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={{ flex: 1 }}
      >
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
              <Text variant="heading">{t.mergePeople.title}</Text>
            </View>
            <View style={{ width: 44 }} />
          </Row>

          {people.isLoading ? (
            <PeopleSkeleton />
          ) : people.isError ? (
            <EmptyState
              title={t.loadError}
              body={t.loadErrorBody}
              action={
                <Button label={t.retry} variant="secondary" onPress={() => people.refetch()} />
              }
            />
          ) : guests.length < 2 ? (
            // Fewer than two guests: nothing to merge. Say why rather than showing
            // an empty list with a dead button.
            <EmptyState title={t.mergePeople.title} body={t.mergePeople.empty} />
          ) : (
            <>
              <Text variant="caption" tone="muted" align="center">
                {t.mergePeople.subtitle}
              </Text>

              <Card padded={false} style={{ paddingHorizontal: theme.spacing.lg }}>
                {guests.map((row, index) => {
                  const isSelected = selected.has(row.person_key);
                  return (
                    <View key={row.person_key}>
                      <Pressable
                        accessibilityRole="checkbox"
                        accessibilityState={{ checked: isSelected }}
                        accessibilityLabel={row.display_name}
                        onPress={() => toggle(row.person_key)}
                        style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}
                      >
                        <Row style={{ paddingVertical: theme.spacing.md, alignItems: 'center' }}>
                          <Row style={{ flex: 1, gap: theme.spacing.md, alignItems: 'center' }}>
                            <Avatar name={row.display_name} size={44} ghost />
                            <View style={{ flex: 1 }}>
                              <Text variant="subheading" numberOfLines={1}>
                                {row.display_name}
                              </Text>
                              <Text variant="caption" tone="muted" numberOfLines={1}>
                                {row.group_count === 1
                                  ? t.tabs.inOneGroup
                                  : plural(locale, row.group_count, t.tabs.acrossGroups)}
                              </Text>
                            </View>
                          </Row>
                          <Ionicons
                            name={isSelected ? 'checkmark-circle' : 'ellipse-outline'}
                            size={iconSize.xl}
                            color={isSelected ? theme.color.brand : theme.color.textFaint}
                          />
                        </Row>
                      </Pressable>
                      {index < guests.length - 1 ? (
                        <View style={{ height: 1, backgroundColor: theme.color.border }} />
                      ) : null}
                    </View>
                  );
                })}
              </Card>

              <Card style={{ gap: theme.spacing.xs }}>
                <Text variant="caption" tone="muted">
                  {t.mergePeople.nameLabel}
                </Text>
                <TextInput
                  value={name}
                  onChangeText={(value) => {
                    setNameTouched(true);
                    setName(value);
                  }}
                  accessibilityLabel={t.mergePeople.nameLabel}
                  placeholder={t.mergePeople.namePlaceholder}
                  placeholderTextColor={theme.color.textFaint}
                  style={{
                    fontSize: 20,
                    fontWeight: '700',
                    color: theme.color.text,
                    paddingVertical: theme.spacing.sm,
                  }}
                />
              </Card>

              {/* The irreversibility, spelled out before the button rather than
                buried in a toast after the fact. */}
              <Callout tone="negative">
                <Text variant="subheading" tone="negative">
                  {t.mergePeople.warningTitle}
                </Text>
                <Text variant="caption" tone="muted">
                  {t.mergePeople.warningBody}
                </Text>
              </Callout>

              {error ? <Callout tone="negative">{error}</Callout> : null}

              {selectedRows.length > 0 ? (
                <Text variant="caption" tone="muted" align="center">
                  {plural(locale, memberIdsForMerge(selectedRows).length, t.mergePeople.selected)}
                </Text>
              ) : null}

              <Button
                label={t.mergePeople.cta}
                size="lg"
                fullWidth
                disabled={!ready || merge.isPending}
                onPress={() => merge.mutate()}
              />
              {merge.isPending ? <ActivityIndicator color={theme.color.brand} /> : null}
            </>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </Screen>
  );
}
