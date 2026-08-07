import { useState } from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import * as FileSystem from 'expo-file-system';
import { router } from 'expo-router';
import * as Sharing from 'expo-sharing';
import { ActivityIndicator, Platform, ScrollView, View } from 'react-native';

import { Badge, Button, Card, ChipRow, directionalIcon, IconButton, Row, Screen, Text, useTheme } from '@baaki/ui';

import { exportData } from '@/data/api';
import { useGroups } from '@/data/hooks';
import { groupLabel } from '@/data/types';

type Format = 'json' | 'csv';

/**
 * ADR-012: your ledger leaves whenever you want it to, in full, for free.
 * JSON is lossless — versions, settlements, allocations, the lot — so an
 * export can rebuild the ledger exactly.
 */
export default function ExportScreen() {
  const theme = useTheme();
  const groups = useGroups();

  const [format, setFormat] = useState<Format>('json');
  const [scope, setScope] = useState<string>('all');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const run = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      const result = await exportData({
        format,
        groupId: scope === 'all' ? undefined : scope,
      });

      // expo-file-system 57 API: File/Paths rather than the old string paths.
      const file = new FileSystem.File(FileSystem.Paths.cache, result.filename);
      if (file.exists) file.delete();
      file.create();
      file.write(result.content);

      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(file.uri, {
          mimeType: result.contentType,
          dialogTitle: 'Your Baaki export',
          UTI: format === 'json' ? 'public.json' : 'public.comma-separated-values-text',
        });
      }
      setDone(`${result.filename} · ${Math.ceil(result.content.length / 1024)} KB`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen>
      <ScrollView
        contentContainerStyle={{
          paddingHorizontal: theme.spacing.xl,
          paddingBottom: theme.spacing.xxxl,
          gap: theme.spacing.xl,
        }}
        showsVerticalScrollIndicator={false}
      >
        <Row style={{ paddingTop: theme.spacing.md }}>
          <IconButton label="Back" onPress={() => router.back()}>
            <Ionicons name={directionalIcon('chevron-back')} size={20} color={theme.color.text} />
          </IconButton>
          <View style={{ flex: 1, alignItems: 'center' }}>
            <Text variant="heading">Export your data</Text>
          </View>
          <View style={{ width: 44 }} />
        </Row>

        <Card style={{ gap: theme.spacing.sm }}>
          <Row style={{ justifyContent: 'space-between' }}>
            <Text variant="subheading">Everything, always free</Text>
            <Badge label="no paywall" tone="positive" />
          </Row>
          <Text variant="caption" tone="muted">
            JSON includes every version of every expense, who paid, who owed, settlements with their
            per-expense allocations, and the activity trail — enough to rebuild your ledger exactly.
            CSV is the spreadsheet view, including per-person settlement detail.
          </Text>
        </Card>

        <View style={{ gap: theme.spacing.md }}>
          <Text variant="caption" tone="muted">
            Format
          </Text>
          <ChipRow<Format>
            value={format}
            onChange={setFormat}
            options={[
              { value: 'json', label: 'JSON (lossless)' },
              { value: 'csv', label: 'CSV (spreadsheet)' },
            ]}
          />
        </View>

        <View style={{ gap: theme.spacing.md }}>
          <Text variant="caption" tone="muted">
            What to export
          </Text>
          <ChipRow<string>
            value={scope}
            onChange={setScope}
            options={[
              { value: 'all', label: 'All my groups' },
              ...(groups.data ?? []).map((group) => ({
                value: group.id,
                label: groupLabel(group),
              })),
            ]}
          />
        </View>

        <Button
          label={busy ? 'Preparing…' : 'Export'}
          size="lg"
          fullWidth
          disabled={busy}
          onPress={() => void run()}
          icon={<Ionicons name="download-outline" size={18} color={theme.color.onBrand} />}
        />
        {busy ? <ActivityIndicator color={theme.color.brand} /> : null}

        {done ? (
          <Card style={{ gap: theme.spacing.sm }}>
            <Text variant="subheading" tone="positive">
              Export ready
            </Text>
            <Text variant="caption" tone="muted">
              {done}
            </Text>
            {Platform.OS === 'web' ? (
              <Text variant="micro" tone="faint">
                On web the file is written to the app cache; use a device to share it onward.
              </Text>
            ) : null}
          </Card>
        ) : null}

        {error ? (
          <Text variant="caption" tone="negative">
            {error}
          </Text>
        ) : null}

        <Button
          label="Import from Splitwise"
          variant="ghost"
          fullWidth
          onPress={() => router.push('/settings/import')}
          icon={<Ionicons name="cloud-upload-outline" size={18} color={theme.color.brand} />}
        />
      </ScrollView>
    </Screen>
  );
}
