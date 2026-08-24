/**
 * The comment thread on one expense (a group-visible discussion of one bill).
 *
 * The permission matrix is enforced by the RPCs, not here — this screen only
 * offers the controls a person is allowed to use, so the UI and the server
 * agree: any member adds and reads; the author edits and deletes their own; an
 * admin can delete anyone's and resolve a report; any member can flag/report a
 * comment for an admin to look at. A denied action still fails safe at the DB.
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

export function ExpenseComments({
  groupId,
  expenseId,
  myMemberId,
  iAmAdmin,
  nameOf,
}: {
  groupId: string;
  expenseId: string;
  myMemberId: string | null;
  iAmAdmin: boolean;
  nameOf: (memberId: string | null) => string;
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

  const rows = comments.data;

  const submit = () => {
    const body = draft.trim();
    if (body === '') return;
    add.mutate(
      { body },
      {
        onSuccess: () => setDraft(''),
        onError: () => Alert.alert(t.comments.couldNotPost),
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

  const inputStyle = {
    flex: 1,
    minHeight: 40,
    maxHeight: 120,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.sm,
    borderRadius: theme.radius.md,
    backgroundColor: theme.color.surfaceMuted,
    color: theme.color.text,
  } as const;

  return (
    <View style={{ gap: theme.spacing.md }}>
      {rows.length === 0 ? (
        <Text variant="caption" tone="muted">
          {t.comments.empty}
        </Text>
      ) : (
        rows.map((row) => {
          const mine = myMemberId !== null && row.authorMemberId === myMemberId;
          const canDelete = mine || iAmAdmin;
          const flagged = row.flaggedAt !== null;
          const editing = editingId === row.id;
          return (
            <View key={row.id} style={{ gap: theme.spacing.xs }}>
              <Row style={{ gap: theme.spacing.sm, alignItems: 'center' }}>
                <Avatar name={nameOf(row.authorMemberId)} size={28} />
                <Text variant="caption" style={{ flex: 1 }} numberOfLines={1}>
                  {mine ? t.comments.you : nameOf(row.authorMemberId)}
                </Text>
                <Text variant="micro" tone="muted">
                  {whenLabel(row.createdAt, locale)}
                  {row.editedAt ? ` · ${t.comments.edited}` : ''}
                </Text>
                {/* A report is visible to admins (who resolve it); the flagger
                    sees it reflected too. It never names who reported. */}
                {flagged && iAmAdmin ? (
                  <Ionicons name="flag" size={12} color={theme.color.negative} />
                ) : null}
              </Row>

              {editing ? (
                <View style={{ gap: theme.spacing.xs }}>
                  <TextInput
                    value={editingBody}
                    onChangeText={setEditingBody}
                    multiline
                    style={inputStyle}
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
                <>
                  <Text variant="body" style={{ marginStart: 36 }}>
                    {row.body}
                  </Text>
                  <Row style={{ gap: theme.spacing.lg, marginStart: 36 }}>
                    {mine ? (
                      <CommentAction
                        label={t.comments.edit}
                        onPress={() => {
                          setEditingId(row.id);
                          setEditingBody(row.body);
                        }}
                      />
                    ) : null}
                    {canDelete ? (
                      <CommentAction
                        label={t.comments.delete}
                        tone="negative"
                        onPress={() => confirmDelete(row)}
                      />
                    ) : null}
                    {/* Reporting is for someone else's comment; an admin can also
                        resolve a standing report. */}
                    {!mine && !flagged ? (
                      <CommentAction
                        label={t.comments.report}
                        onPress={() => flag.mutate({ commentId: row.id, flag: true })}
                      />
                    ) : null}
                    {flagged && iAmAdmin ? (
                      <CommentAction
                        label={t.comments.resolve}
                        onPress={() => flag.mutate({ commentId: row.id, flag: false })}
                      />
                    ) : null}
                  </Row>
                </>
              )}
            </View>
          );
        })
      )}

      {/* Composer — any member can add. */}
      <Row style={{ gap: theme.spacing.sm, alignItems: 'flex-end' }}>
        <TextInput
          value={draft}
          onChangeText={setDraft}
          multiline
          placeholder={t.comments.placeholder}
          placeholderTextColor={theme.color.textFaint}
          style={inputStyle}
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
            borderRadius: theme.radius.md,
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
              name="send"
              size={iconSize.md}
              color={draft.trim() === '' ? theme.color.textFaint : theme.color.onBrand}
            />
          )}
        </Pressable>
      </Row>
    </View>
  );
}

function CommentAction({
  label,
  onPress,
  tone,
}: {
  label: string;
  onPress: () => void;
  tone?: 'negative';
}): React.JSX.Element {
  const theme = useTheme();
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={label} hitSlop={8}>
      <Text
        variant="micro"
        style={{ color: tone === 'negative' ? theme.color.negative : theme.color.brand }}
      >
        {label}
      </Text>
    </Pressable>
  );
}
