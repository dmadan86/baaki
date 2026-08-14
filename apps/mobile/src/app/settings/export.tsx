import { useState } from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import * as FileSystem from 'expo-file-system';
import { router } from 'expo-router';
import * as Sharing from 'expo-sharing';
import { ActivityIndicator, Platform, ScrollView, View } from 'react-native';

import {
  Badge,
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
  useTabBarClearance,
  useTheme,
} from '@baaki/ui';

import { exportData } from '@/data/api';
import { useGroups } from '@/data/hooks';
import { groupLabel } from '@/data/types';
import { useStrings } from '@/i18n';

enum Format {
  Json = 'json',
  Csv = 'csv',
}

/**
 * ADR-012: your ledger leaves whenever you want it to, in full, for free.
 * JSON is lossless — versions, settlements, allocations, the lot — so an
 * export can rebuild the ledger exactly.
 */
export default function ExportScreen() {
  const theme = useTheme();
  const clearance = useTabBarClearance();
  const groups = useGroups();
  const { t } = useStrings();

  const [format, setFormat] = useState<Format>(Format.Json);
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
          dialogTitle: t.exportData.shareTitle,
          UTI: format === Format.Json ? 'public.json' : 'public.comma-separated-values-text',
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
            <Text variant="heading">{t.exportData.title}</Text>
          </View>
          <View style={{ width: 44 }} />
        </Row>

        <Card style={{ gap: theme.spacing.sm }}>
          <Row style={{ justifyContent: 'space-between' }}>
            <Text variant="subheading">{t.exportData.everythingFree}</Text>
            <Badge label={t.exportData.noPaywall} tone="positive" />
          </Row>
          <Text variant="caption" tone="muted">
            {t.exportData.explain}
          </Text>
        </Card>

        <View style={{ gap: theme.spacing.md }}>
          <Text variant="caption" tone="muted">
            {t.exportData.format}
          </Text>
          <ChipRow<Format>
            value={format}
            onChange={setFormat}
            options={[
              { value: Format.Json, label: t.exportData.json },
              { value: Format.Csv, label: t.exportData.csv },
            ]}
          />
        </View>

        <View style={{ gap: theme.spacing.md }}>
          <Text variant="caption" tone="muted">
            {t.exportData.whatToExport}
          </Text>
          <ChipRow<string>
            value={scope}
            onChange={setScope}
            options={[
              { value: 'all', label: t.exportData.allMyGroups },
              ...(groups.data ?? []).map((group) => ({
                value: group.id,
                label: groupLabel(group),
              })),
            ]}
          />
        </View>

        <Button
          label={busy ? t.exportData.preparing : t.exportData.action}
          size="lg"
          fullWidth
          disabled={busy}
          onPress={() => void run()}
          icon={<Ionicons name="download-outline" size={iconSize.md} color={theme.color.onBrand} />}
        />
        {busy ? <ActivityIndicator color={theme.color.brand} /> : null}

        {done ? (
          <Card style={{ gap: theme.spacing.sm }}>
            <Text variant="subheading" tone="positive">
              {t.exportData.ready}
            </Text>
            <Text variant="caption" tone="muted">
              {done}
            </Text>
            {Platform.OS === 'web' ? (
              <Text variant="micro" tone="faint">
                {t.exportData.webNote}
              </Text>
            ) : null}
          </Card>
        ) : null}

        {error ? <Callout tone="negative">{error}</Callout> : null}

        <Button
          label={t.exportData.importInstead}
          variant="ghost"
          fullWidth
          onPress={() => router.push('/settings/import')}
          icon={
            <Ionicons name="cloud-upload-outline" size={iconSize.md} color={theme.color.brand} />
          }
        />
      </ScrollView>
    </Screen>
  );
}
