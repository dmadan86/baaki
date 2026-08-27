import { useState } from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import { decode } from 'base64-arraybuffer';
import * as FileSystem from 'expo-file-system';
import { router, useLocalSearchParams } from 'expo-router';
import * as Sharing from 'expo-sharing';
import { ActivityIndicator, Platform, ScrollView, View } from 'react-native';

import {
  Button,
  Callout,
  Card,
  ChipRow,
  directionalIcon,
  IconButton,
  iconSize,
  Row,
  Screen,
  Text,
  useScreenClearance,
  useTheme,
} from '@waves/ui';

import { useGroup, useGroupLedger } from '@/data/hooks';
import { displayName, groupLabel, isGhost, GroupType, SettlementMethod } from '@/data/types';
import { useBlockedUsers } from '@/data/blocked';
import { buildGroupExportModel } from '@/data/groupExport';
import { renderGroupExportHtml, type GroupExportLabels } from '@/data/groupExportHtml';
import {
  buildGroupExportWorkbook,
  workbookToBase64,
  type GroupExportSheetLabels,
} from '@/data/groupExportXlsx';
import { friendlyError } from '@/lib/errors';
import { printAvailable, printHtmlToFile } from '@/lib/print';
import { useAuth } from '@/lib/auth';
import { useStrings } from '@/i18n';

/** The correct OOXML spreadsheet MIME type + Apple UTI for an .xlsx. */
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const XLSX_UTI = 'org.openxmlformats.spreadsheetml.sheet';

enum Format {
  Pdf = 'pdf',
  Excel = 'excel',
}

/** A filesystem-safe slug for the group name, so the shared file is recognisable. */
function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return slug || 'group';
}

/**
 * A per-group export to PDF or Excel (a client-side statement built from the
 * local mirror — distinct from the account-wide data export under Settings).
 *
 * Reached from the group's ••• overflow menu. Everything is assembled on device
 * from data already read for the group screen, so it works offline. The PDF path
 * leans on expo-print, a native module that may be missing from an older binary
 * (an OTA update landed the dependency before a native rebuild shipped); that
 * case shows an "update the app" message rather than crashing. The Excel path is
 * pure JS (SheetJS) and always works.
 */
export default function GroupExportScreen() {
  const theme = useTheme();
  const clearance = useScreenClearance();
  const { t, locale } = useStrings();
  const { id } = useLocalSearchParams<{ id: string }>();
  const groupId = id ?? '';
  const { profile } = useAuth();
  const { blockedIds } = useBlockedUsers();

  const { group, members, expenses, settlements } = useGroup(groupId);
  const ledger = useGroupLedger(groupId, profile?.id ?? null);

  const [format, setFormat] = useState<Format>(Format.Pdf);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const groupData = group.data;
  const title = groupLabel(groupData, members.data ?? [], profile?.id);

  /** The visible document labels the PDF renderer needs. */
  const pdfLabels = (): GroupExportLabels => ({
    documentTitle: t.groupExport.documentTitle,
    generatedOn: t.groupExport.generatedOn,
    totalSpent: t.groupExport.totalSpent,
    membersLabel: t.groupExport.membersLabel,
    expensesLabel: t.groupExport.expensesLabel,
    settlementsLabel: t.groupExport.settlementsLabel,
    balancesTitle: t.groupExport.balancesTitle,
    membersTitle: t.groupExport.membersTitle,
    colDate: t.groupExport.colDate,
    colDescription: t.groupExport.colDescription,
    colCategory: t.groupExport.colCategory,
    colPaidBy: t.groupExport.colPaidBy,
    colAmount: t.groupExport.colAmount,
    colParticipants: t.groupExport.colParticipants,
    colFrom: t.groupExport.colFrom,
    colTo: t.groupExport.colTo,
    colMethod: t.groupExport.colMethod,
    colStatus: t.groupExport.colStatus,
    colMember: t.groupExport.colMember,
    colRole: t.groupExport.colRole,
    colBalance: t.groupExport.colBalance,
    colDirection: t.groupExport.colDirection,
    noneYet: t.groupExport.noneYet,
    deletedTag: t.groupExport.deletedTag,
    footer: t.groupExport.footer,
  });

  /** The visible sheet + column labels the Excel builder needs. */
  const sheetLabels = (): GroupExportSheetLabels => ({
    sheetSummary: t.groupExport.sheetSummary,
    sheetExpenses: t.groupExport.sheetExpenses,
    sheetSettlements: t.groupExport.sheetSettlements,
    sheetBalances: t.groupExport.sheetBalances,
    sheetMembers: t.groupExport.sheetMembers,
    fieldGroup: t.groupExport.fieldGroup,
    fieldType: t.groupExport.fieldType,
    fieldCurrency: t.groupExport.fieldCurrency,
    fieldGeneratedOn: t.groupExport.fieldGeneratedOn,
    fieldMembers: t.groupExport.fieldMembers,
    fieldExpenses: t.groupExport.fieldExpenses,
    fieldSettlements: t.groupExport.fieldSettlements,
    fieldTotalSpent: t.groupExport.fieldTotalSpent,
    colDate: t.groupExport.colDate,
    colDescription: t.groupExport.colDescription,
    colCategory: t.groupExport.colCategory,
    colPaidBy: t.groupExport.colPaidBy,
    colParticipants: t.groupExport.colParticipants,
    colAmount: t.groupExport.colAmount,
    colDisplay: t.groupExport.colDisplay,
    colCurrency: t.groupExport.colCurrency,
    colDeleted: t.groupExport.colDeleted,
    colFrom: t.groupExport.colFrom,
    colTo: t.groupExport.colTo,
    colMethod: t.groupExport.colMethod,
    colStatus: t.groupExport.colStatus,
    colCount: t.groupExport.colCount,
    colMember: t.groupExport.colMember,
    colRole: t.groupExport.colRole,
    colDirection: t.groupExport.colDirection,
    colBalance: t.groupExport.colBalance,
    colJoined: t.groupExport.colJoined,
    yes: t.groupExport.yes,
    no: t.groupExport.no,
  });

  const run = async (): Promise<void> => {
    if (!groupData) return;
    setBusy(true);
    setError(null);
    setDone(null);

    // Guard the native path up front so a stale binary never renders a PDF that
    // cannot be produced — the Excel path is pure JS and never blocked.
    if (format === Format.Pdf && !printAvailable()) {
      setError(t.groupExport.updateNeeded);
      setBusy(false);
      return;
    }

    try {
      // Captured in the handler, never in render (React Compiler: no clock reads
      // during render).
      const generatedOnIso = new Date().toISOString();

      const typeLabel =
        t.groupExport.types[(groupData.type as GroupType) ?? GroupType.Other] ??
        t.groupExport.types.other;

      const model = buildGroupExportModel({
        group: {
          name: title,
          coverEmoji: groupData.cover_emoji,
          type: groupData.type,
          currency: groupData.default_currency,
        },
        members: (members.data ?? []).map((member) => ({
          id: member.id,
          name: displayName(member, profile?.id, blockedIds, t.misc.someone),
          role: member.role,
          isGhost: isGhost(member),
        })),
        // `expenses.rows` is the queue-replayed render list; `settlements.data`
        // is the mirror's settlement rows. Both already read for this group.
        expenses: expenses.rows,
        settlements: settlements.data ?? [],
        balances: ledger.balances,
        labels: {
          appName: t.common.appName,
          groupType: typeLabel,
          categories: t.categories,
          methods: {
            [SettlementMethod.Upi]: t.groupExport.methods.upi,
            [SettlementMethod.Cash]: t.groupExport.methods.cash,
            [SettlementMethod.Bank]: t.groupExport.methods.bank,
            [SettlementMethod.Other]: t.groupExport.methods.other,
          },
          untitled: t.expense.untitled,
          roleAdmin: t.groupExport.roleAdmin,
          roleMember: t.groupExport.roleMember,
          notJoined: t.groupExport.notJoined,
          someone: t.misc.someone,
          owed: t.groupExport.owed,
          owes: t.groupExport.owes,
          settled: t.groupExport.settled,
        },
        generatedOnIso,
        locale,
      });

      const base = `waves-${slugify(title)}`;

      if (format === Format.Pdf) {
        const html = renderGroupExportHtml(model, pdfLabels());
        const uri = await printHtmlToFile(html);
        // Null means expo-print is not linked in this build (checked above too,
        // but the module can vanish between the guard and here on a hot reload).
        if (!uri) {
          setError(t.groupExport.updateNeeded);
          return;
        }
        // The rendered PDF holds the same group statement as the workbook —
        // member names, amounts, balances — so it must not linger in the cache
        // after sharing any more than the XLSX file does. Best-effort delete in a
        // finally, the same cleanup the Excel branch below performs.
        const pdf = new FileSystem.File(uri);
        try {
          if (await Sharing.isAvailableAsync()) {
            await Sharing.shareAsync(uri, {
              mimeType: 'application/pdf',
              dialogTitle: t.groupExport.shareTitle,
              UTI: 'com.adobe.pdf',
            });
          }
        } finally {
          try {
            if (pdf.exists) pdf.delete();
          } catch {
            // Best-effort privacy cleanup; the share result still drives the UI.
          }
        }
        setDone(`${base}.pdf`);
      } else {
        const workbook = buildGroupExportWorkbook(model, sheetLabels());
        const base64 = workbookToBase64(workbook);

        // expo-file-system 57 API: File/Paths, base64 decoded to bytes — the
        // exact write+share+cleanup pattern the settings export uses.
        const filename = `${base}.xlsx`;
        const file = new FileSystem.File(FileSystem.Paths.cache, filename);
        if (file.exists) file.delete();
        file.create();
        const bytes = new Uint8Array(decode(base64));
        file.write(bytes);

        try {
          if (await Sharing.isAvailableAsync()) {
            await Sharing.shareAsync(file.uri, {
              mimeType: XLSX_MIME,
              dialogTitle: t.groupExport.shareTitle,
              UTI: XLSX_UTI,
            });
          }
        } finally {
          try {
            if (file.exists) file.delete();
          } catch {
            // Best-effort privacy cleanup; the share result still drives the UI.
          }
        }
        setDone(`${filename} · ${Math.ceil(bytes.byteLength / 1024)} KB`);
      }
    } catch (caught) {
      setError(friendlyError(caught, t.groupExport.exportFailed, 'groupExport.run'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen>
      <ScrollView
        contentContainerStyle={{
          paddingHorizontal: theme.spacing.xl,
          paddingBottom: clearance,
          gap: theme.spacing.xl,
        }}
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
            <Text variant="heading">{t.groupExport.title}</Text>
          </View>
          <View style={{ width: 44 }} />
        </Row>

        <Card style={{ gap: theme.spacing.sm }}>
          <Text variant="subheading" numberOfLines={1}>
            {groupData?.cover_emoji ? `${groupData.cover_emoji} ` : ''}
            {title}
          </Text>
          <Text variant="caption" tone="muted">
            {t.groupExport.intro}
          </Text>
        </Card>

        <View style={{ gap: theme.spacing.md }}>
          <Text variant="caption" tone="muted">
            {t.groupExport.formatLabel}
          </Text>
          <ChipRow<Format>
            value={format}
            onChange={setFormat}
            options={[
              { value: Format.Pdf, label: t.groupExport.pdf },
              { value: Format.Excel, label: t.groupExport.excel },
            ]}
          />
          <Text variant="micro" tone="muted">
            {format === Format.Pdf ? t.groupExport.pdfHint : t.groupExport.excelHint}
          </Text>
        </View>

        <Button
          label={busy ? t.groupExport.preparing : t.groupExport.generate}
          size="lg"
          fullWidth
          disabled={busy || !groupData}
          onPress={() => void run()}
          icon={
            <Ionicons
              name={format === Format.Pdf ? 'document-text-outline' : 'grid-outline'}
              size={iconSize.md}
              color={theme.color.onBrand}
            />
          }
        />
        {busy ? <ActivityIndicator color={theme.color.brand} /> : null}

        {done ? (
          <Card style={{ gap: theme.spacing.sm }}>
            <Text variant="subheading" tone="positive">
              {t.groupExport.ready}
            </Text>
            <Text variant="caption" tone="muted">
              {done}
            </Text>
            {Platform.OS === 'web' ? (
              <Text variant="micro" tone="muted">
                {t.groupExport.webNote}
              </Text>
            ) : null}
          </Card>
        ) : null}

        {error ? <Callout tone="negative">{error}</Callout> : null}
      </ScrollView>
    </Screen>
  );
}
