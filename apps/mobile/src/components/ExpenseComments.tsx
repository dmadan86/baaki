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
 * "···" so the row stays clean.
 *
 * Comments are **rich text stored as Markdown** — a deliberately small subset:
 * bold, italic, strikethrough and bullet lists (see `CommentMarkdown` for the
 * render and `sanitizeCommentMarkdown` for the write side). No images, ever.
 * Instead of a live field, a "+" launcher opens a bottom-sheet editor carrying a
 * formatting toolbar, so the formatting controls have somewhere to live and the
 * thread stays uncluttered.
 */

import { useState } from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Avatar, Button, iconSize, Row, Text, useTheme } from '@waves/ui';

import {
  useAddExpenseComment,
  useDeleteExpenseComment,
  useEditExpenseComment,
  useFlagExpenseComment,
  useExpenseComments,
  type ExpenseCommentRow,
} from '@/data/hooks';
import { MAX_COMMENT_LENGTH, sanitizeCommentMarkdown } from '@/lib/commentMarkdown';
import { useAvatarUrl } from '@/components/ProfileAvatar';
import { CommentMarkdown } from '@/components/CommentMarkdown';
import { RichCommentInput } from '@/components/RichCommentInput';
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

type Selection = { start: number; end: number };

/**
 * One author's avatar. `useAvatarUrl` signs the private-bucket path so the real
 * picture can load; it's a hook, so it lives in its own component instance —
 * one per row — rather than being called inside a `.map`. Falls back to initials
 * when the person has no picture.
 */
function CommentAvatar({ name, photo }: { name: string; photo: string | null }): React.JSX.Element {
  const url = useAvatarUrl(photo);
  return <Avatar name={name} size={AVATAR} photoUrl={url} />;
}

export function ExpenseComments({
  groupId,
  expenseId,
  myMemberId,
  iAmAdmin,
  nameOf,
  avatarNameOf,
  photoOf,
}: {
  groupId: string;
  expenseId: string;
  myMemberId: string | null;
  iAmAdmin: boolean;
  nameOf: (memberId: string | null) => string;
  /** The real name to seed an avatar's initial/colour (not the "You" label). */
  avatarNameOf?: (memberId: string | null) => string;
  /** The author's raw (unsigned) avatar path, if any, for their picture. */
  photoOf?: (memberId: string | null) => string | null;
}): React.JSX.Element {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const { t, locale } = useStrings();
  const comments = useExpenseComments(expenseId);
  const add = useAddExpenseComment(groupId, expenseId);
  const edit = useEditExpenseComment();
  const remove = useDeleteExpenseComment();
  const flag = useFlagExpenseComment();

  const avatarName = (memberId: string | null): string => (avatarNameOf ?? nameOf)(memberId);
  const photo = (memberId: string | null): string | null => photoOf?.(memberId) ?? null;

  // The editor bottom sheet. `commentId === null` means a new comment; otherwise
  // it edits that comment. `forcedSel`, when set, is handed to the TextInput's
  // `selection` for exactly one render after a toolbar action moves the caret,
  // then cleared by the next selection change so the person can move freely.
  const [editorOpen, setEditorOpen] = useState(false);
  const [editorCommentId, setEditorCommentId] = useState<string | null>(null);
  const [editorBody, setEditorBody] = useState('');
  const [sel, setSel] = useState<Selection>({ start: 0, end: 0 });
  const [forcedSel, setForcedSel] = useState<Selection | null>(null);

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

  const busy = add.isPending || edit.isPending;

  const openNew = () => {
    setEditorCommentId(null);
    setEditorBody('');
    setSel({ start: 0, end: 0 });
    setForcedSel({ start: 0, end: 0 });
    setEditorOpen(true);
  };

  const openEdit = (row: ExpenseCommentRow) => {
    setEditorCommentId(row.id);
    setEditorBody(row.body);
    const end = row.body.length;
    setSel({ start: end, end });
    setForcedSel({ start: end, end });
    setEditorOpen(true);
  };

  const closeEditor = () => setEditorOpen(false);

  const send = () => {
    // Sanitize here, not just trim: the mutations sanitize too and resolve
    // without calling the RPC when the result is empty, so a body that is only
    // image markdown or HTML-shaped tags (`![x](y)`, `<b></b>`) would pass a
    // bare trim, sanitize to '', and silently close the sheet with the text
    // lost. Validate against the same sanitizer and keep the sheet open on empty.
    const body = sanitizeCommentMarkdown(editorBody);
    if (body === '') return;
    if (editorCommentId === null) {
      add.mutate(
        { body },
        {
          onSuccess: (result) => {
            setEditorOpen(false);
            setEditorBody('');
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
          onError: () => Alert.alert(t.comments.couldNotPost),
        },
      );
    } else {
      edit.mutate(
        { commentId: editorCommentId, body },
        {
          onSuccess: () => setEditorOpen(false),
          onError: () => Alert.alert(t.comments.couldNotPost),
        },
      );
    }
  };

  // Wrap the current selection (or drop an empty pair at the caret) with an
  // inline marker. Bold/italic/strike all share this; only the delimiter differs.
  const wrapInline = (marker: string) => {
    const { start, end } = sel;
    const selected = editorBody.slice(start, end);
    const next = editorBody.slice(0, start) + marker + selected + marker + editorBody.slice(end);
    const caret =
      selected === ''
        ? { start: start + marker.length, end: start + marker.length }
        : {
            start: start + marker.length + selected.length + marker.length,
            end: start + marker.length + selected.length + marker.length,
          };
    setEditorBody(next);
    setSel(caret);
    setForcedSel(caret);
  };

  // Prefix the caret's line with a bullet marker, unless it already has one.
  const toggleBullet = () => {
    const { start } = sel;
    const lineStart = editorBody.lastIndexOf('\n', Math.max(0, start - 1)) + 1;
    if (editorBody.slice(lineStart, lineStart + 2) === '- ') return;
    const next = editorBody.slice(0, lineStart) + '- ' + editorBody.slice(lineStart);
    const caret = { start: start + 2, end: start + 2 };
    setEditorBody(next);
    setSel(caret);
    setForcedSel(caret);
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
      options.push({ text: t.comments.edit, onPress: () => openEdit(row) });
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

  // Ionicons has no bold/italic/strike glyph, so those three read as a styled
  // letter (the toolbar convention every editor uses); the bullet is an icon.
  const glyph = (letter: string, style: object) => (
    <Text variant="subheading" style={{ color: theme.color.text, ...style }}>
      {letter}
    </Text>
  );
  const toolbar: { label: string; node: React.ReactNode; onPress: () => void }[] = [
    {
      label: t.comments.bold,
      node: glyph('B', { fontWeight: '800' }),
      onPress: () => wrapInline('**'),
    },
    {
      label: t.comments.italic,
      node: glyph('I', { fontStyle: 'italic' }),
      onPress: () => wrapInline('_'),
    },
    {
      label: t.comments.strike,
      node: glyph('S', { textDecorationLine: 'line-through' }),
      onPress: () => wrapInline('~~'),
    },
    {
      label: t.comments.bulletList,
      node: <Ionicons name="list-outline" size={iconSize.md} color={theme.color.text} />,
      onPress: toggleBullet,
    },
  ];

  return (
    <View style={{ gap: theme.spacing.lg }}>
      {/* The launcher: a "+" pill in place of a live field. Tapping it raises the
          editor sheet, where the formatting controls live. */}
      <Row style={{ gap: 10, alignItems: 'center' }}>
        <CommentAvatar name={avatarName(myMemberId)} photo={photo(myMemberId)} />
        <Pressable
          onPress={openNew}
          accessibilityRole="button"
          accessibilityLabel={t.comments.addComment}
          style={({ pressed }) => ({
            flex: 1,
            flexDirection: 'row',
            alignItems: 'center',
            gap: theme.spacing.xs,
            minHeight: 40,
            paddingHorizontal: theme.spacing.md,
            borderRadius: theme.radius.pill,
            backgroundColor: theme.color.surfaceMuted,
            opacity: pressed ? 0.7 : 1,
          })}
        >
          <Ionicons name="add" size={iconSize.md} color={theme.color.textMuted} />
          <Text variant="body" style={{ color: theme.color.textFaint }}>
            {t.comments.addComment}
          </Text>
        </Pressable>
      </Row>

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
        // A centred icon-over-title-over-subtitle empty state (the pattern most
        // comment threads use), so a bill with no discussion reads as an
        // invitation, not a bare line of grey text.
        <View
          style={{ alignItems: 'center', gap: theme.spacing.sm, paddingVertical: theme.spacing.xl }}
        >
          <View
            style={{
              width: 56,
              height: 56,
              borderRadius: 28,
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: theme.color.surfaceMuted,
            }}
          >
            <Ionicons name="chatbubbles-outline" size={26} color={theme.color.textMuted} />
          </View>
          <Text variant="heading">{t.comments.emptyTitle}</Text>
          <Text variant="caption" tone="muted">
            {t.comments.empty}
          </Text>
        </View>
      ) : (
        shown.map((row) => {
          const mine = myMemberId !== null && row.authorMemberId === myMemberId;
          const flagged = row.flaggedAt !== null;
          return (
            <Row key={row.id} style={{ gap: 10, alignItems: 'flex-start' }}>
              <CommentAvatar
                name={avatarName(row.authorMemberId)}
                photo={photo(row.authorMemberId)}
              />
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
                  {hasActions(row) ? (
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

                <CommentMarkdown source={row.body} />
              </View>
            </Row>
          );
        })
      )}

      {/* The editor — always mounted, driven by `visible` (a Modal toggled after
          mount presents reliably on Android only when it stays mounted). A
          centred card rather than a bottom sheet, so the field sits in the eye's
          middle; the KeyboardAvoidingView lifts the whole card as the keyboard
          rises so nothing it covers is lost. Text only: no image control here. */}
      <Modal transparent animationType="fade" visible={editorOpen} onRequestClose={closeEditor}>
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          style={{ flex: 1 }}
        >
          <Pressable
            onPress={closeEditor}
            accessibilityLabel={t.common.close}
            style={{
              flex: 1,
              backgroundColor: 'rgba(10, 10, 26, 0.55)',
              justifyContent: 'center',
              alignItems: 'center',
              paddingHorizontal: theme.spacing.xl,
              paddingVertical: theme.spacing.xxl + insets.top,
            }}
          >
            {/* Swallow taps so pressing the card does not dismiss it. */}
            <Pressable
              onPress={() => {}}
              style={{
                width: '100%',
                maxWidth: 480,
                backgroundColor: theme.color.surface,
                borderRadius: theme.radius.xxl,
                paddingHorizontal: theme.spacing.xl,
                paddingTop: theme.spacing.lg,
                paddingBottom: theme.spacing.lg,
                gap: theme.spacing.md,
              }}
            >
              <Text variant="heading">
                {editorCommentId === null ? t.comments.editorTitle : t.comments.editLabel}
              </Text>

              <RichCommentInput
                value={editorBody}
                onChangeText={setEditorBody}
                onSelectionChange={(e) => {
                  setSel(e.nativeEvent.selection);
                  setForcedSel(null);
                }}
                selection={forcedSel ?? undefined}
                autoFocus
                maxLength={MAX_COMMENT_LENGTH}
                placeholder={t.comments.placeholder}
                accessibilityLabel={t.comments.placeholder}
                style={{
                  minHeight: 96,
                  maxHeight: 200,
                  paddingHorizontal: theme.spacing.md,
                  paddingVertical: theme.spacing.sm,
                  borderRadius: theme.radius.lg,
                  backgroundColor: theme.color.surfaceMuted,
                  color: theme.color.text,
                  textAlignVertical: 'top',
                }}
              />

              <Row style={{ alignItems: 'center', gap: theme.spacing.xs }}>
                {toolbar.map((tool) => (
                  <Pressable
                    key={tool.label}
                    onPress={tool.onPress}
                    accessibilityRole="button"
                    accessibilityLabel={tool.label}
                    hitSlop={6}
                    style={({ pressed }) => ({
                      width: 38,
                      height: 38,
                      borderRadius: theme.radius.md,
                      alignItems: 'center',
                      justifyContent: 'center',
                      backgroundColor: theme.color.surfaceMuted,
                      opacity: pressed ? 0.6 : 1,
                    })}
                  >
                    {tool.node}
                  </Pressable>
                ))}
                <View style={{ flex: 1 }} />
                <Button
                  label={t.comments.post}
                  size="sm"
                  disabled={busy || editorBody.trim() === ''}
                  onPress={send}
                />
                {busy ? <ActivityIndicator color={theme.color.buttonPrimary} /> : null}
              </Row>
            </Pressable>
          </Pressable>
        </KeyboardAvoidingView>
      </Modal>
    </View>
  );
}
