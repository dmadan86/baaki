import { useEffect, useState } from 'react';
import { ScrollView } from 'react-native';

import { Card, Screen, Text, useTheme } from '@waves/ui';

import { localPrivacyAudit, type LocalPrivacyAudit } from '@/lib/localPrivacyAudit';

/**
 * Dev/e2e-only local privacy audit surface. It exposes aggregate counts only —
 * no file names, tokens, row ids or ledger contents — so Maestro can verify that
 * sign-out cleanup removed private local state that is otherwise invisible to UI.
 */
export default function LocalPrivacyAuditScreen() {
  const theme = useTheme();
  const [audit, setAudit] = useState<LocalPrivacyAudit | null>(null);

  useEffect(() => {
    void localPrivacyAudit().then(setAudit);
  }, []);

  if (!__DEV__) {
    return (
      <Screen>
        <Card>
          <Text testID="local-privacy-audit-disabled">Not available</Text>
        </Card>
      </Screen>
    );
  }

  return (
    <Screen>
      <ScrollView contentContainerStyle={{ padding: theme.spacing.xl, gap: theme.spacing.md }}>
        <Text variant="heading">Local privacy audit</Text>
        <Card style={{ gap: theme.spacing.sm }}>
          <Text testID="local-privacy-mirror-key">
            mirrorKeyPresent:{audit?.mirrorKeyPresent ? 'true' : 'false'}
          </Text>
          <Text testID="local-privacy-receipt-queue">
            receiptQueuePresent:{audit?.receiptQueuePresent ? 'true' : 'false'}
          </Text>
          <Text testID="local-privacy-pending-files">
            pendingReceiptFiles:{audit?.pendingReceiptFiles ?? 0}
          </Text>
          <Text testID="local-privacy-cached-files">
            cachedImageFiles:{audit?.cachedImageFiles ?? 0}
          </Text>
        </Card>
      </ScrollView>
    </Screen>
  );
}
