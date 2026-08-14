/**
 * "This isn't right."
 *
 * The obvious version of this feature takes you out of the split. That is the
 * one thing it must not do: a share you can remove unilaterally is a debt you
 * can delete, and the ledger is worth exactly as much as that is impossible.
 *
 * So declining records a position and tells the person who entered it. The
 * numbers move when somebody edits the expense — which anybody in the group
 * has always been able to do, because the person who spots that dinner was
 * ₹1,800 is usually not the person who typed ₹1,300.
 *
 * The wording follows ADR-010's tone rule. Almost every one of these is a
 * genuine mistake, and copy that calls it a dispute makes a fight out of a
 * typo: the button says "Something's wrong", not "Reject".
 */

import { useState } from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import { TextInput, View } from 'react-native';

import { Badge, Button, Card, iconSize, Row, Text, useTheme } from '@baaki/ui';

import { useStrings } from '@/i18n';

import type { MemberId } from '@baaki/core';

import type { DisputeRow } from '@/data/types';

export interface DisputePanelProps {
  disputes: DisputeRow[];
  /** My member id in this group, or null while it loads. */
  myMemberId: MemberId | null;
  /** Who entered the version being looked at. */
  authorMemberId: MemberId | null;
  isAdmin: boolean;
  nameOf: (memberId: string | null) => string;
  busy?: boolean;
  onRaise: (reason: string) => void;
  onWithdraw: () => void;
  onResolve: (disputeId: string, accept: boolean, note: string) => void;
  /** Accepting means fixing it, so the caller opens the editor. */
  onEdit: () => void;
}

export function DisputePanel({
  disputes,
  myMemberId,
  authorMemberId,
  isAdmin,
  nameOf,
  busy = false,
  onRaise,
  onWithdraw,
  onResolve,
  onEdit,
}: DisputePanelProps) {
  const theme = useTheme();
  const { t } = useStrings();
  const [writing, setWriting] = useState(false);
  const [reason, setReason] = useState('');
  const [answering, setAnswering] = useState<string | null>(null);
  const [note, setNote] = useState('');

  const open = disputes.filter((row) => row.status === 'open');
  const mine = open.find((row) => row.member_id === myMemberId);
  const others = open.filter((row) => row.member_id !== myMemberId);
  const canAnswer = myMemberId !== null && (myMemberId === authorMemberId || isAdmin);

  const input = {
    fontSize: 15,
    color: theme.color.text,
    paddingVertical: theme.spacing.sm,
    minHeight: 44,
  } as const;

  return (
    <Card style={{ gap: theme.spacing.lg }}>
      {open.length > 0 ? (
        <Row style={{ gap: theme.spacing.sm, alignItems: 'center' }}>
          <Ionicons name="alert-circle" size={iconSize.md} color={theme.color.negative} />
          <Text variant="subheading" tone="negative">
            {open.length === 1
              ? 'Someone thinks this is off'
              : `${open.length} people think this is off`}
          </Text>
        </Row>
      ) : null}

      {others.map((row) => (
        <View key={row.id} style={{ gap: theme.spacing.sm }}>
          <Text variant="caption" tone="muted">
            {`${nameOf(row.member_id)} says:`}
          </Text>
          <Text variant="body">{row.reason ?? t.misc.noReasonGiven}</Text>

          {canAnswer ? (
            answering === row.id ? (
              <View style={{ gap: theme.spacing.sm }}>
                <TextInput
                  value={note}
                  onChangeText={setNote}
                  multiline
                  accessibilityLabel={t.dispute.yourReply}
                  placeholder={t.dispute.replyPlaceholder}
                  placeholderTextColor={theme.color.textFaint}
                  style={input}
                />
                <Row style={{ gap: theme.spacing.sm }}>
                  <Button
                    label={busy ? t.dispute.saving : t.dispute.theyAreRight}
                    size="sm"
                    disabled={busy}
                    onPress={() => {
                      onResolve(row.id, true, note);
                      setAnswering(null);
                      setNote('');
                      onEdit();
                    }}
                  />
                  <Button
                    label={t.dispute.itIsCorrect}
                    size="sm"
                    variant="secondary"
                    disabled={busy}
                    onPress={() => {
                      onResolve(row.id, false, note);
                      setAnswering(null);
                      setNote('');
                    }}
                  />
                </Row>
              </View>
            ) : (
              <Button
                label={t.dispute.answerThis}
                size="sm"
                variant="secondary"
                onPress={() => setAnswering(row.id)}
              />
            )
          ) : null}
        </View>
      ))}

      {mine ? (
        <View style={{ gap: theme.spacing.sm }}>
          <Badge label={t.dispute.youSaidWrong} tone="negative" />
          {mine.reason ? (
            <Text variant="caption" tone="muted">
              {mine.reason}
            </Text>
          ) : null}
          <Text variant="micro" tone="faint">
            {t.misc.disputeStands}
          </Text>
          <Button
            label={t.misc.neverMind}
            size="sm"
            variant="ghost"
            disabled={busy}
            onPress={onWithdraw}
          />
        </View>
      ) : writing ? (
        <View style={{ gap: theme.spacing.sm }}>
          <Text variant="caption" tone="muted">
            {t.misc.whatsWrongWithIt}
          </Text>
          <TextInput
            value={reason}
            onChangeText={setReason}
            multiline
            autoFocus
            accessibilityLabel={t.dispute.whatIsWrong}
            placeholder={t.dispute.reasonPlaceholder}
            placeholderTextColor={theme.color.textFaint}
            style={input}
          />
          <Row style={{ gap: theme.spacing.sm }}>
            <Button
              label={busy ? 'Sending…' : 'Tell them'}
              size="sm"
              disabled={busy}
              onPress={() => {
                onRaise(reason);
                setWriting(false);
                setReason('');
              }}
            />
            <Button
              label={t.common.cancel}
              size="sm"
              variant="ghost"
              onPress={() => {
                setWriting(false);
                setReason('');
              }}
            />
          </Row>
          <Text variant="micro" tone="faint">
            {t.dispute.reasonOptional}
          </Text>
        </View>
      ) : (
        <Row style={{ gap: theme.spacing.sm }}>
          {/* Correcting it is the better answer whenever you know what it should
              say, so it is offered first and equally. */}
          <Button label={t.dispute.fixItMyself} size="sm" variant="secondary" onPress={onEdit} />
          <Button
            label={t.misc.somethingsWrong}
            size="sm"
            variant="ghost"
            onPress={() => setWriting(true)}
          />
        </Row>
      )}
    </Card>
  );
}
