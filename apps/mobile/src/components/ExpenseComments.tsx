/**
 * The comment thread on one expense (a group-visible discussion of one bill).
 *
 * The permission matrix is enforced by the RPCs, not here — this screen only
 * offers the controls a person is allowed to use, so the UI and the server
 * agree: any member adds and reads; the author edits and deletes their own; an
 * admin can delete anyone's and resolve a report; any member can flag/report a
 * comment. A denied action still fails safe at the DB.
 *
 * The layout follows the comment-thread pattern every social app converges on
 * (Substack, Beli, Digg, Meta): avatar on the left, name and time on one line,
 * the body aligned under the name, and the per-comment actions folded behind a
 * "···" so the row stays clean. The composer is a pinned pill — your avatar, a
 * rounded field, a round send button.
 */

import { useState } from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import { ActivityIndicator, Alert, Pressable, TextInput, View } from 'react-native';

import { Avatar, Button, iconSize, Row, Text, useTheme } from '@waves/ui';

import {
  useAddExpenseComment,
  useDeleteExpenseComment,
  useEditExpenseComment,
  useFlagExpenseComment,
  useExpenseComments,
  type ExpenseCommentRow,
} from '@/data/hooks';
import { useStrings } from '@/i18n';

function whenLabel(iso: string | null, locale: string): string {
  if (!iso) return '';
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return '';
  return new Date(parsed).toLocaleString(locale, {
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
  });
}

const AVATAR = 32;

/**
 * How many comments to render at once. A long thread is all on the device
 * already (it rides the mirror), so this bounds the render cost, not a fetch —
 * the newest page shows, older pages reveal on demand as the person scrolls up,
 * the pattern every embedded comment thread uses (Instagram, YouTube). Rendering
 * a nested FlatList inside the page's ScrollView would trip React Native's
 * "VirtualizedLists should never be nested" warning, so the window is manual.
 */
const PAGE = 20;

export function ExpenseComments({
  groupId,
  expenseId,
  myMemberId,
  iAmAdmin,
  nameOf,
  onComposerFocus,
}: {
  groupId: string;
  expenseId: string;
  myMemberId: string | null;
  iAmAdmin: boolean;
  nameOf: (memberId: string | null) => string;
  /** Called when the composer focuses — the parent scrolls it above the keyboard. */
  onComposerFocus?: () => void;
}): React.JSX.Element {
  const theme = useTheme();
  const { t, locale } = useStrings();
  const comments = useExpenseComments(expenseId);
  const add = useAddExpenseComment(groupId, expenseId);
  const edit = useEditExpenseComment();
  const remove = useDeleteExpenseComment();
  const flag = useFlagExpenseComment();

  const [draft, setDraft] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingBody, setEditingBody] = useState('');
  // Just-posted comments, shown at once so a text comment feels instant instead
  // of waiting on the sync pull that carries it back from the mirror. Each drops
  // out of the merge below the moment the mirror row with the same id arrives.
  const [optimistic, setOptimistic] = useState<ExpenseCommentRow[]>([]);
  // How many of the newest comments are rendered. Grows a page at a time when
  // the person taps "show earlier" — the just-posted comment always sits in this
  // tail window, so an echo never lands out of view.
  const [visibleCount, setVisibleCount] = useState(PAGE);

  const mirrorRows = comments.data;
  const mirrorIds = new Set(mirrorRows.map((r) => r.id));
  const rows = [...mirrorRows, ...optimistic.filter((o) => !mirrorIds.has(o.id))];
  const shown = rows.length > visibleCount ? rows.slice(rows.length - visibleCount) : rows;
  const hidden = rows.length - shown.length;

  const submit = () => {
    const body = draft.trim();
    if (body === '') return;
    setDraft('');
    add.mutate(
      { body },
      {
        onSuccess: (result) => {
          if (result) {
            setOptimistic((current) => [
              ...current,
              {
                id: result.id,
                expenseId,
                groupId,
                authorMemberId: myMemberId,
                body: result.body,
                editedAt: null,
                flaggedAt: null,
                flaggedBy: null,
                createdAt: new Date().toISOString(),
              },
            ]);
          }
        },
        onError: () => {
          setDraft(body);
          Alert.alert(t.comments.couldNotPost);
        },
      },
    );
  };

  const saveEdit = (commentId: string) => {
    const body = editingBody.trim();
    if (body === '') return;
    edit.mutate(
      { commentId, body },
      {
        onSuccess: () => setEditingId(null),
        onError: () => Alert.alert(t.comments.couldNotPost),
      },
    );
  };

  const confirmDelete = (row: ExpenseCommentRow) => {
    Alert.alert(t.comments.deleteConfirm, undefined, [
      { text: t.common.cancel, style: 'cancel' },
      {
        text: t.comments.delete,
        style: 'destructive',
        onPress: () =>
          remove.mutate(
            { commentId: row.id },
            { onError: () => Alert.alert(t.comments.couldNotDelete) },
          ),
      },
    ]);
  };

  // The "···" sheet: only the actions this person may take on this comment, so
  // it mirrors the RPC matrix. Nothing to offer → the dots are not shown.
  const openActions = (row: ExpenseCommentRow) => {
    const mine = myMemberId !== null && row.authorMemberId === myMemberId;
    const flagged = row.flaggedAt !== null;
    const options: { text: string; style?: 'destructive' | 'cancel'; onPress?: () => void }[] = [];
    if (mine) {
      options.push({
        text: t.comments.edit,
        onPress: () => {
          setEditingId(row.id);
          setEditingBody(row.body);
        },
      });
    }
    if (mine || iAmAdmin) {
      options.push({
        text: t.comments.delete,
        style: 'destructive',
        onPress: () => confirmDelete(row),
      });
    }
    if (!mine && !flagged) {
      options.push({
        text: t.comments.report,
        onPress: () => flag.mutate({ commentId: row.id, flag: true }),
      });
    }
    if (flagged && iAmAdmin) {
      options.push({
        text: t.comments.resolve,
        onPress: () => flag.mutate({ commentId: row.id, flag: false }),
      });
    }
    if (options.length === 0) return;
    options.push({ text: t.common.cancel, style: 'cancel' });
    Alert.alert(t.comments.title, undefined, options);
  };

  const hasActions = (row: ExpenseCommentRow): boolean => {
    const mine = myMemberId !== null && row.authorMemberId === myMemberId;
    return mine || iAmAdmin || row.flaggedAt === null;
  };

  const fieldStyle = {
    flex: 1,
    minHeight: 40,
    maxHeight: 120,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.sm,
    borderRadius: theme.radius.pill,
    backgroundColor: theme.color.surfaceMuted,
    color: theme.color.text,
  } as const;

  return (
    <View style={{ gap: theme.spacing.lg }}>
      {hidden > 0 ? (
        <Pressable
          onPress={() => setVisibleCount((c) => c + PAGE)}
          accessibilityRole="button"
          accessibilityLabel={`${t.comments.showEarlier} (${hidden})`}
          hitSlop={8}
          style={({ pressed }) => ({ opacity: pressed ? 0.5 : 1, alignSelf: 'flex-start' })}
        >
          <Row style={{ alignItems: 'center', gap: theme.spacing.xs }}>
            <Ionicons name="chevron-up" size={14} color={theme.color.buttonPrimary} />
            <Text variant="caption" style={{ color: theme.color.buttonPrimary, fontWeight: '600' }}>
              {`${t.comments.showEarlier} (${hidden})`}
            </Text>
          </Row>
        </Pressable>
      ) : null}

      {rows.length === 0 ? (
        <Text variant="caption" tone="muted">
          {t.comments.empty}
        </Text>
      ) : (
        shown.map((row) => {
          const mine = myMemberId !== null && row.authorMemberId === myMemberId;
          const flagged = row.flaggedAt !== null;
          const editing = editingId === row.id;
          return (
            <Row key={row.id} style={{ gap: 10, alignItems: 'flex-start' }}>
              <Avatar name={nameOf(row.authorMemberId)} size={AVATAR} />
              <View style={{ flex: 1, gap: 2 }}>
                <Row style={{ alignItems: 'center', gap: theme.spacing.xs }}>
                  <Text variant="caption" style={{ fontWeight: '600' }} numberOfLines={1}>
                    {mine ? t.comments.you : nameOf(row.authorMemberId)}
                  </Text>
                  <Text variant="micro" tone="muted">
                    {whenLabel(row.createdAt, locale)}
                    {row.editedAt ? ` · ${t.comments.edited}` : ''}
                  </Text>
                  {/* A report shows to admins (who resolve it); it never names who
                      reported. */}
                  {flagged && iAmAdmin ? (
                    <Ionicons name="flag" size={11} color={theme.color.negative} />
                  ) : null}
                  <View style={{ flex: 1 }} />
                  {!editing && hasActions(row) ? (
                    <Pressable
                      onPress={() => openActions(row)}
                      accessibilityRole="button"
                      accessibilityLabel={t.comments.title}
                      hitSlop={10}
                      style={({ pressed }) => ({ opacity: pressed ? 0.5 : 1, padding: 2 })}
                    >
                      <Ionicons
                        name="ellipsis-horizontal"
                        size={16}
                        color={theme.color.textMuted}
                      />
                    </Pressable>
                  ) : null}
                </Row>

                {editing ? (
                  <View style={{ gap: theme.spacing.xs, paddingTop: theme.spacing.xs }}>
                    <TextInput
                      value={editingBody}
                      onChangeText={setEditingBody}
                      multiline
                      autoFocus
                      style={fieldStyle}
                      accessibilityLabel={t.comments.editLabel}
                    />
                    <Row style={{ gap: theme.spacing.sm, justifyContent: 'flex-end' }}>
                      <Button
                        label={t.common.cancel}
                        variant="ghost"
                        size="sm"
                        onPress={() => setEditingId(null)}
                      />
                      <Button
                        label={t.common.save}
                        size="sm"
                        disabled={edit.isPending || editingBody.trim() === ''}
                        onPress={() => saveEdit(row.id)}
                      />
                    </Row>
                  </View>
                ) : (
                  <Text variant="body">{row.body}</Text>
                )}
              </View>
            </Row>
          );
        })
      )}

      {/* Composer — a pinned pill: your avatar, a rounded field, a round send. */}
      <Row style={{ gap: 10, alignItems: 'flex-end', paddingTop: theme.spacing.xs }}>
        <Avatar name={nameOf(myMemberId)} size={AVATAR} />
        <TextInput
          value={draft}
          onChangeText={setDraft}
          onFocus={onComposerFocus}
          multiline
          placeholder={t.comments.placeholder}
          placeholderTextColor={theme.color.textFaint}
          style={fieldStyle}
          accessibilityLabel={t.comments.placeholder}
        />
        <Pressable
          onPress={submit}
          disabled={add.isPending || draft.trim() === ''}
          accessibilityRole="button"
          accessibilityLabel={t.comments.post}
          style={{
            width: 40,
            height: 40,
            borderRadius: 20,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor:
              draft.trim() === '' ? theme.color.surfaceMuted : theme.color.buttonPrimary,
          }}
        >
          {add.isPending ? (
            <ActivityIndicator color={theme.color.onBrand} />
          ) : (
            <Ionicons
              name="arrow-up"
              size={iconSize.md}
              color={draft.trim() === '' ? theme.color.textFaint : theme.color.onBrand}
            />
          )}
        </Pressable>
      </Row>
    </View>
  );
}
