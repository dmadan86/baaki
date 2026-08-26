import AsyncStorage from '@react-native-async-storage/async-storage';
import { Directory, Paths } from 'expo-file-system';
import * as SecureStore from 'expo-secure-store';

/**
 * Local private-data audit used by tests/e2e debug tooling. It reports counts and
 * key presence only, never file names, row ids, tokens, or other sensitive data.
 */
export interface LocalPrivacyAudit {
  readonly mirrorKeyPresent: boolean;
  readonly receiptQueuePresent: boolean;
  readonly pendingReceiptFiles: number;
  readonly cachedImageFiles: number;
}

function countDirectoryFiles(root: string | Directory, name: string): number {
  try {
    const dir = new Directory(root, name);
    if (!dir.exists) return 0;
    const entries = (dir as unknown as { list?: () => unknown[] }).list?.() ?? [];
    return entries.length;
  } catch {
    return 0;
  }
}

export async function localPrivacyAudit(): Promise<LocalPrivacyAudit> {
  const [mirrorKey, receiptQueue] = await Promise.all([
    SecureStore.getItemAsync('waves.mirror.dek.v1').catch(() => null),
    AsyncStorage.getItem('receipt-upload-queue.v1').catch(() => null),
  ]);
  return {
    mirrorKeyPresent: mirrorKey !== null,
    receiptQueuePresent: receiptQueue !== null,
    pendingReceiptFiles: countDirectoryFiles(Paths.document, 'pending-receipts'),
    cachedImageFiles: countDirectoryFiles(Paths.cache, 'receipt-image-cache'),
  };
}
