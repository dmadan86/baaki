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
 *
 * A merge target does not have to already be on this screen's list. Picking a
 * phone contact resolves it the same way a person reading names would: if it
 * matches an existing guest by name, that guest is ticked; if it does not, the
 * contact is not yet anyone in Waves, so it is added as a guest of one of your
 * groups first — through the very same `addGhostMember` path `contacts.tsx` and
 * `add-person.tsx` use — and then folded into the selection. Either way the
 * merge itself still goes through `mergeGhosts` and its ledger-safety rules;
 * nothing here writes to a balance.
 */
import { useMemo, useState } from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { router, useLocalSearchParams } from 'expo-router';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Platform,
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
  Divider,
  EmptyState,
  IconButton,
  iconSize,
  ListRow,
  Row,
  Screen,
  Text,
  useTabBarClearance,
  useTheme,
} from '@waves/ui';

import {
  addGhostMember,
  fetchGroups,
  fetchPeopleBalances,
  mergeGhosts,
  type PersonBalanceRow,
} from '@/data/api';
import {
  canMerge,
  defaultMergeName,
  isMergeable,
  memberIdsForMerge,
  mergeErrorMessage,
} from '@/data/mergePeople';
import { groupLabel, type GroupRow } from '@/data/types';
import { ContactPicker, type PickedContact } from '@/components/ContactPicker';
import { PeopleSkeleton } from '@/components/Skeletons';
import { friendlyError } from '@/lib/errors';
import { useSync } from '@/sync';
import { fill, plural, useStrings } from '@/i18n';

/**
 * A merge candidate that did not come from the balances list — a ghost just
 * created (or about to be) from a device contact. Shaped like the subset of
 * {@link PersonBalanceRow} the merge logic actually reads, so it can sit
 * alongside guest rows in the same selection without either side knowing about
 * the other's origin.
 */
interface ContactMergeTarget {
  readonly member_id: string;
  readonly display_name: string;
}

/** Where the "add a contact" flow is: closed, picking a contact, or — once a
 * contact turns out to be new to the app — picking which group to add them to. */
type ContactStep = 'closed' | 'pick' | 'chooseGroup';

export default function MergePeopleScreen() {
  const theme = useTheme();
  // This screen renders under the persistent bottom nav (like friends/contacts),
  // so it needs the tab-bar clearance — the plain screen inset left the Merge
  // button hidden behind the bar, unreachable by scrolling.
  const clearance = useTabBarClearance();
  const { t, locale } = useStrings();
  const queryClient = useQueryClient();
  const { flush } = useSync();

  // People pre-picked on the Friends tab (its multiselect merge) arrive as a
  // comma-joined, encoded list of person_keys, plus the name to pre-fill. They
  // seed the selection and name here so this screen opens on the confirm step
  // rather than an empty pick.
  const params = useLocalSearchParams<{ keys?: string; name?: string }>();
  const initialKeys = useMemo(
    () =>
      new Set(
        (typeof params.keys === 'string' ? params.keys : '')
          .split(',')
          // useLocalSearchParams already URL-decodes params, so the keys arrive
          // decoded — decoding again would corrupt any key containing a %.
          .filter((key) => key.length > 0),
      ),
    [params.keys],
  );

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

  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set(initialKeys));
  // Guests materialised from a device contact that was new to the app. They
  // never had a balance to appear in `guests`, so they live beside it rather
  // than in it — always part of the selection once added (removable, not
  // untickable, since there is no unmerged state to go back to).
  const [contactTargets, setContactTargets] = useState<readonly ContactMergeTarget[]>([]);
  const [name, setName] = useState(() =>
    decodeURIComponent(typeof params.name === 'string' ? params.name : ''),
  );
  const [nameTouched, setNameTouched] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The "add another person" sheet — the only way more guests join the merge
  // now that the main list shows the chosen people rather than the whole roster.
  const [addOpen, setAddOpen] = useState(false);

  const [contactStep, setContactStep] = useState<ContactStep>('closed');
  const [pendingContact, setPendingContact] = useState<PickedContact | null>(null);
  const [contactBusy, setContactBusy] = useState(false);
  const [contactError, setContactError] = useState<string | null>(null);

  // Only fetched once the contact flow actually needs somewhere to put a new
  // ghost — most visits to this screen never open it.
  const groups = useQuery({
    queryKey: ['groups'],
    queryFn: fetchGroups,
    enabled: contactStep !== 'closed',
  });

  const selectedGuestRows = guests.filter((row) => selected.has(row.person_key));
  const selectedRows = [...selectedGuestRows, ...contactTargets];
  // Guests not yet in the merge — what the "add another person" sheet offers.
  const remainingGuests = guests.filter((row) => !selected.has(row.person_key));

  const openContacts = (): void => {
    setAddOpen(false);
    setContactStep('pick');
  };

  const toggle = (personKey: string): void => {
    setError(null);
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(personKey)) next.delete(personKey);
      else next.add(personKey);
      // Keep the name in step with the pick until the person types their own.
      if (!nameTouched) {
        const rows = guests.filter((row) => next.has(row.person_key));
        setName(defaultMergeName([...rows, ...contactTargets]));
      }
      return next;
    });
  };

  const removeContactTarget = (memberId: string): void => {
    setError(null);
    setContactTargets((prev) => {
      const next = prev.filter((row) => row.member_id !== memberId);
      // Keep the auto-name in step with the selection the same way toggle and
      // onPickContact do — the removed contact is no longer in it — until the
      // person types their own. The ghost addGhostMember created is left alone;
      // this only drops it from this merge's selection.
      if (!nameTouched) {
        const rows = guests.filter((row) => selected.has(row.person_key));
        setName(defaultMergeName([...rows, ...next]));
      }
      return next;
    });
  };

  const closeContactFlow = (): void => {
    setContactStep('closed');
    setPendingContact(null);
    setContactError(null);
  };

  /**
   * A contact was picked. If its name matches somebody already on this list,
   * that is exactly the recognition this screen is built on — tick them, the
   * same as tapping their row would. Only when nothing matches is the contact
   * genuinely new, and the flow moves on to asking which group to add them to.
   */
  const onPickContact = (chosen: readonly PickedContact[]): void => {
    const contact = chosen[0];
    if (!contact) return;
    setContactError(null);
    const needle = contact.name.trim().toLowerCase();
    const matches = guests.filter((row) => row.display_name.trim().toLowerCase() === needle);
    if (matches.length > 0) {
      setError(null);
      setSelected((prev) => {
        const next = new Set(prev);
        for (const row of matches) next.add(row.person_key);
        if (!nameTouched) {
          const rows = guests.filter((row) => next.has(row.person_key));
          setName(defaultMergeName([...rows, ...contactTargets]));
        }
        return next;
      });
      closeContactFlow();
      return;
    }
    // Already added as a contact target on this list — it is in the selection
    // and the name already reflects it, so re-picking it must not run through
    // chooseGroup again and create a second ghost. Just close.
    const alreadyAdded = contactTargets.some(
      (row) => row.display_name.trim().toLowerCase() === needle,
    );
    if (alreadyAdded) {
      closeContactFlow();
      return;
    }
    setPendingContact(contact);
    setContactStep('chooseGroup');
  };

  /**
   * The contact is new to the app: add them as a guest of the chosen group —
   * through the same `addGhostMember` RPC `contacts.tsx` and `add-person.tsx`
   * use, so there is exactly one path that creates a ghost — then fold the new
   * member straight into this merge's selection.
   */
  const attachContact = async (groupId: string): Promise<void> => {
    if (!pendingContact) return;
    setContactBusy(true);
    setContactError(null);
    try {
      const memberId = await addGhostMember(groupId, pendingContact.name, {
        email: pendingContact.email,
        phone: pendingContact.phone,
      });
      const newTarget: ContactMergeTarget = {
        member_id: memberId,
        display_name: pendingContact.name,
      };
      setContactTargets((prev) => [...prev, newTarget]);
      if (!nameTouched) setName(defaultMergeName([...selectedRows, newTarget]));
      setError(null);
      closeContactFlow();
    } catch (caught) {
      setContactError(
        friendlyError(
          caught,
          fill(t.mergePeople.errorContactAdd, { name: pendingContact.name }),
          'merge.attachContact',
        ),
      );
    } finally {
      setContactBusy(false);
    }
  };

  const ready = canMerge(selectedRows) && name.trim().length > 0;
  const nothingToMergeYet = guests.length === 0 && contactTargets.length === 0;

  const merge = useMutation({
    mutationFn: () => mergeGhosts(memberIdsForMerge(selectedRows), name.trim()),
    onSuccess: async () => {
      // The merge is written server-side by the RPC; pull it into the mirror so
      // the now-local Friends list (ADR-005) folds it without waiting for the
      // next background sync. The invalidate keeps this screen's own list fresh.
      await queryClient.invalidateQueries({ queryKey: ['people', 'balances'] });
      void flush();
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
          ) : nothingToMergeYet ? (
            // Nothing on the balances list yet — but a device contact can still
            // start a merge (see the module doc), so the empty state offers that
            // rather than being a dead end.
            <EmptyState
              title={t.mergePeople.title}
              body={t.mergePeople.empty}
              action={
                <Button
                  label={t.tabs.fromContacts}
                  variant="secondary"
                  onPress={() => setContactStep('pick')}
                />
              }
            />
          ) : (
            <>
              {/* The identity these people become: their faces folded into one,
                  and the name that one person will carry on the Friends list.
                  This is the whole point of the screen, so it leads. */}
              <View style={{ alignItems: 'center', gap: theme.spacing.md }}>
                <MergedAvatars names={selectedRows.map((row) => row.display_name)} />
                <View style={{ alignSelf: 'stretch', alignItems: 'center', gap: theme.spacing.xs }}>
                  <TextInput
                    value={name}
                    onChangeText={(value) => {
                      setNameTouched(true);
                      setName(value);
                    }}
                    editable={selectedRows.length > 0}
                    accessibilityLabel={t.mergePeople.nameLabel}
                    placeholder={t.mergePeople.namePlaceholder}
                    placeholderTextColor={theme.color.textFaint}
                    textAlign="center"
                    style={{
                      fontSize: 24,
                      fontWeight: '800',
                      color: theme.color.text,
                      minWidth: 180,
                      maxWidth: '100%',
                      paddingVertical: theme.spacing.xs,
                      paddingHorizontal: theme.spacing.md,
                      borderBottomWidth: 1,
                      borderBottomColor: theme.color.border,
                    }}
                  />
                  <Text variant="caption" tone="muted" align="center">
                    {t.mergePeople.heroCaption}
                  </Text>
                </View>
              </View>

              {/* Only the people actually being merged — not the whole roster.
                  Each one is removable; more are added through the sheet below. */}
              <View style={{ gap: theme.spacing.sm }}>
                <Text variant="caption" tone="muted">
                  {selectedRows.length > 0
                    ? plural(locale, selectedRows.length, t.mergePeople.peopleHeader)
                    : t.mergePeople.needTwo}
                </Text>
                {selectedRows.length > 0 ? (
                  <Card padded={false} style={{ paddingHorizontal: theme.spacing.lg }}>
                    {selectedGuestRows.map((row, index) => (
                      <View key={row.person_key}>
                        <MergeMemberRow
                          name={row.display_name}
                          subtitle={
                            row.group_count === 1
                              ? t.tabs.inOneGroup
                              : plural(locale, row.group_count, t.tabs.acrossGroups)
                          }
                          removeLabel={fill(t.pickers.removeName, { name: row.display_name })}
                          onRemove={() => toggle(row.person_key)}
                        />
                        {index < selectedGuestRows.length - 1 || contactTargets.length > 0 ? (
                          <Divider />
                        ) : null}
                      </View>
                    ))}
                    {contactTargets.map((row, index) => (
                      <View key={row.member_id}>
                        <MergeMemberRow
                          name={row.display_name}
                          subtitle={t.mergePeople.fromContactsTag}
                          removeLabel={fill(t.pickers.removeName, { name: row.display_name })}
                          onRemove={() => removeContactTarget(row.member_id)}
                        />
                        {index < contactTargets.length - 1 ? <Divider /> : null}
                      </View>
                    ))}
                  </Card>
                ) : null}
              </View>

              <Button
                label={t.mergePeople.addPerson}
                variant="secondary"
                fullWidth
                disabled={merge.isPending}
                onPress={() => setAddOpen(true)}
                icon={
                  <Ionicons
                    name="person-add-outline"
                    size={iconSize.md}
                    color={theme.color.brand}
                  />
                }
              />

              {/* The irreversibility, spelled out before the button rather than
                buried in a toast after the fact. Title + body go through Callout's
                own props: it wraps children in a single Text, so passing two Text
                nodes made the heading and body run together as inline spans. */}
              <Callout tone="negative" title={t.mergePeople.warningTitle}>
                {t.mergePeople.warningBody}
              </Callout>

              {error ? <Callout tone="negative">{error}</Callout> : null}

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

      {/* Add another person to the merge: pick from the guests not already in
          it, or reach for a device contact. Kept a plain sheet — the roster is
          usually short — with the contact door at the top for the case the
          person you mean is not a guest yet. */}
      <Modal visible={addOpen} animationType="slide" onRequestClose={() => setAddOpen(false)}>
        <Screen edges={['top', 'bottom']} inModal>
          <View
            style={{
              flex: 1,
              paddingHorizontal: theme.spacing.xl,
              paddingBottom: theme.spacing.md,
              gap: theme.spacing.lg,
            }}
          >
            <Row style={{ paddingTop: theme.spacing.md }}>
              <IconButton label={t.common.close} onPress={() => setAddOpen(false)}>
                <Ionicons name="close" size={iconSize.lg} color={theme.color.text} />
              </IconButton>
              <View style={{ flex: 1, alignItems: 'center' }}>
                <Text variant="heading">{t.mergePeople.addGuestTitle}</Text>
              </View>
              <View style={{ width: 44 }} />
            </Row>

            <Button
              label={t.tabs.fromContacts}
              variant="secondary"
              fullWidth
              onPress={openContacts}
              icon={
                <Ionicons name="person-add-outline" size={iconSize.md} color={theme.color.brand} />
              }
            />

            <ScrollView
              contentContainerStyle={{ paddingBottom: theme.spacing.xl, gap: theme.spacing.sm }}
              showsVerticalScrollIndicator={false}
              keyboardShouldPersistTaps="handled"
            >
              {remainingGuests.length === 0 ? (
                <Text variant="caption" tone="muted" align="center">
                  {t.mergePeople.noMoreGuests}
                </Text>
              ) : (
                <Card padded={false} style={{ paddingHorizontal: theme.spacing.lg }}>
                  {remainingGuests.map((row, index) => (
                    <View key={row.person_key}>
                      <ListRow
                        title={row.display_name}
                        subtitle={
                          row.group_count === 1
                            ? t.tabs.inOneGroup
                            : plural(locale, row.group_count, t.tabs.acrossGroups)
                        }
                        leading={<Avatar name={row.display_name} size={40} ghost />}
                        trailing={
                          <Ionicons
                            name="add-circle"
                            size={iconSize.xl}
                            color={theme.color.brand}
                          />
                        }
                        onPress={() => toggle(row.person_key)}
                      />
                      {index < remainingGuests.length - 1 ? <Divider /> : null}
                    </View>
                  ))}
                </Card>
              )}
            </ScrollView>
          </View>
        </Screen>
      </Modal>

      {/* Picking a device contact as a merge target: step one is the contact
          itself, step two (only when the contact is new to the app) is which
          group to add them to. Mounted only while open, for the same reason
          add-person's own contact modal is — a React Native Modal keeps its
          children mounted across a close, so without this gate the picker would
          reopen showing the last pick still ticked. */}
      <Modal
        visible={contactStep !== 'closed'}
        animationType="slide"
        onRequestClose={closeContactFlow}
      >
        <Screen edges={['top', 'bottom']} inModal>
          <View
            style={{
              flex: 1,
              paddingHorizontal: theme.spacing.xl,
              paddingBottom: theme.spacing.md,
              gap: theme.spacing.lg,
            }}
          >
            <Row style={{ paddingTop: theme.spacing.md }}>
              <IconButton label={t.common.close} onPress={closeContactFlow}>
                <Ionicons name="close" size={iconSize.lg} color={theme.color.text} />
              </IconButton>
              <View style={{ flex: 1, alignItems: 'center' }}>
                <Text variant="heading">
                  {contactStep === 'pick' ? t.tabs.fromContacts : t.misc.addToWhichGroup}
                </Text>
              </View>
              <View style={{ width: 44 }} />
            </Row>
            {contactStep === 'pick' ? (
              <ContactPicker single onConfirm={onPickContact} confirmVerb={t.misc.continueWith} />
            ) : pendingContact ? (
              <ChooseGroupForContact
                contact={pendingContact}
                groups={groups.data ?? []}
                loading={groups.isLoading}
                busy={contactBusy}
                error={contactError}
                onChoose={(groupId) => void attachContact(groupId)}
                onCancel={closeContactFlow}
              />
            ) : null}
          </View>
        </Screen>
      </Modal>
    </Screen>
  );
}

/**
 * Which of my groups a brand-new contact-ghost joins, once merge.tsx has
 * established they are not already anyone in `guests`.
 *
 * Deliberately the smaller sibling of `contacts.tsx`'s own `ChooseGroup`: one
 * contact rather than a batch, and the destination is a merge selection rather
 * than a fresh membership, but the list itself — and the "no groups yet, start
 * one" fallback — is the same shape on purpose.
 */
function ChooseGroupForContact({
  contact,
  groups,
  loading,
  busy,
  error,
  onChoose,
  onCancel,
}: {
  contact: PickedContact;
  groups: readonly GroupRow[];
  loading: boolean;
  busy: boolean;
  error: string | null;
  onChoose: (groupId: string) => void;
  onCancel: () => void;
}): React.JSX.Element {
  const theme = useTheme();
  const clearance = useTabBarClearance();
  const { t } = useStrings();

  return (
    <ScrollView
      contentContainerStyle={{ paddingBottom: clearance, gap: theme.spacing.lg }}
      showsVerticalScrollIndicator={false}
    >
      <Card style={{ gap: theme.spacing.xs }}>
        <Row style={{ gap: theme.spacing.md, alignItems: 'center' }}>
          <Avatar name={contact.name} size={44} ghost />
          <View style={{ flex: 1 }}>
            <Text variant="subheading" numberOfLines={1}>
              {contact.name}
            </Text>
            <Text variant="micro" tone="muted" numberOfLines={1}>
              {contact.email ?? contact.phone ?? t.misc.noAddress}
            </Text>
          </View>
        </Row>
      </Card>

      <Text variant="caption" tone="muted">
        {fill(t.mergePeople.newContactBody, { name: contact.name })}
      </Text>

      {loading ? (
        <ActivityIndicator color={theme.color.brand} />
      ) : groups.length === 0 ? (
        <Card style={{ gap: theme.spacing.md }}>
          <Text variant="caption" tone="muted">
            {t.extras.noGroupsYet}
          </Text>
          <Button
            label={t.misc.startAGroup}
            variant="secondary"
            onPress={() => {
              // Dismiss the contact modal before leaving, so it is not left
              // stacked under the new-group screen.
              onCancel();
              router.push('/new-group');
            }}
          />
        </Card>
      ) : (
        <Card padded={false} style={{ paddingHorizontal: theme.spacing.lg }}>
          {groups.map((group, index) => (
            <View key={group.id}>
              <ListRow
                title={groupLabel(group)}
                leading={
                  <Avatar
                    name={groupLabel(group)}
                    emoji={group.cover_emoji ?? undefined}
                    size={40}
                  />
                }
                onPress={busy ? undefined : () => onChoose(group.id)}
                trailing={
                  <Ionicons
                    name={directionalIcon('chevron-forward')}
                    size={iconSize.md}
                    color={theme.color.textFaint}
                  />
                }
              />
              {index < groups.length - 1 ? <Divider /> : null}
            </View>
          ))}
        </Card>
      )}

      {busy ? <ActivityIndicator color={theme.color.brand} /> : null}
      {error ? <Callout tone="negative">{error}</Callout> : null}

      <Button label={t.common.cancel} variant="ghost" onPress={onCancel} />
    </ScrollView>
  );
}

/**
 * The people being merged, shown as one overlapping cluster of faces — the
 * visual promise of "these become one." Up to four; a ring in the page colour
 * keeps them legible where they overlap. Empty (nothing picked yet) shows a
 * single placeholder so the hero never collapses.
 */
function MergedAvatars({ names }: { names: readonly string[] }): React.JSX.Element {
  const theme = useTheme();
  const shown = names.slice(0, 4);
  if (shown.length === 0) {
    return <Avatar name="?" size={72} ghost />;
  }
  return (
    <Row style={{ alignItems: 'center' }}>
      {shown.map((name, index) => (
        <View
          key={`${name}-${index}`}
          style={{
            marginLeft: index === 0 ? 0 : -20,
            borderRadius: 999,
            borderWidth: 3,
            borderColor: theme.color.bg,
          }}
        >
          <Avatar name={name} size={64} ghost />
        </View>
      ))}
    </Row>
  );
}

/**
 * One person in the merge selection: face, name, where their balance sits, and
 * a remove control. Removing is the only edit here — there is no "unpick to
 * unmerged," only "not part of this merge," so it reads as a delete, not a
 * toggle.
 */
function MergeMemberRow({
  name,
  subtitle,
  removeLabel,
  onRemove,
}: {
  name: string;
  subtitle: string;
  removeLabel: string;
  onRemove: () => void;
}): React.JSX.Element {
  const theme = useTheme();
  return (
    <Row style={{ paddingVertical: theme.spacing.sm, alignItems: 'center', minHeight: 44 }}>
      <Row style={{ flex: 1, gap: theme.spacing.md, alignItems: 'center' }}>
        <Avatar name={name} size={44} ghost />
        <View style={{ flex: 1 }}>
          <Text variant="subheading" numberOfLines={1}>
            {name}
          </Text>
          <Text variant="caption" tone="muted" numberOfLines={1}>
            {subtitle}
          </Text>
        </View>
      </Row>
      <IconButton label={removeLabel} onPress={onRemove}>
        <Ionicons name="close-circle" size={iconSize.xl} color={theme.color.textFaint} />
      </IconButton>
    </Row>
  );
}
