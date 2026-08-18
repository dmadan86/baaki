/**
 * Waves' own storage as a receipt destination — the paid alternative to a
 * personal cloud.
 *
 * Unlike Drive/Dropbox/OneDrive there is no OAuth here: the account is already
 * signed in to Supabase, so "connecting" is only a question of entitlement —
 * are you on Plus. Receipts land in the private `receipts` bucket under a
 * per-user prefix (`personal/<uid>/…`) that the storage policies added in
 * 20260818140000 read: a paid user may write their own folder, read and delete
 * it, and nobody else can touch it (ADR-013).
 *
 * The sidecar JSON the personal clouds also upload is skipped on purpose — the
 * bucket only admits image mime types, and the scan metadata already lives in
 * the row the receipt-parse function wrote. Here we keep the photo, nothing
 * more.
 */

import { File } from 'expo-file-system';
import { decode } from 'base64-arraybuffer';

import { canUploadGroupPhoto } from '@/data/api';
import { supabase } from '@/lib/supabase';
import type { CloudProvider, CloudTokens, CloudUploadInput, CloudUploadResult } from './types';

const BUCKET = 'receipts';

// A stand-in for the OAuth tokens the queue expects to persist. Waves has no
// bearer of its own — the Supabase session carries the auth — so a fixed marker
// is stored purely to record "this destination is switched on".
const MARKER: CloudTokens = { accessToken: 'waves', refreshToken: null, expiresAt: null };

async function currentUserId(): Promise<string> {
  const { data } = await supabase.auth.getSession();
  const id = data.session?.user?.id;
  if (!id) throw new Error('Not signed in, so receipts cannot be stored on Waves.');
  return id;
}

export const wavesCloud: CloudProvider = {
  id: 'waves',
  label: 'Waves cloud',
  // Always available in the build — there is no client id to miss. Whether it
  // can actually be used is the paid question, answered in connect().
  isConfigured: () => true,
  // "Connecting" is a paid check. Not on Plus → no marker, so nothing is stored
  // and the row stays offered rather than silently becoming a primary that every
  // upload would bounce off the storage policy.
  connect: async () => ((await canUploadGroupPhoto(null)) ? MARKER : null),
  // Nothing to refresh: the live Supabase session authorises each upload.
  ensureValid: (tokens) => Promise.resolve(tokens),
  async upload(_tokens: CloudTokens, input: CloudUploadInput): Promise<CloudUploadResult> {
    const uid = await currentUserId();
    const path = `personal/${uid}/${input.captureId}.jpg`;
    const base64 = await new File(input.imageUri).base64();
    const { error } = await supabase.storage
      .from(BUCKET)
      .upload(path, decode(base64), { contentType: 'image/jpeg', upsert: true });
    if (error) throw new Error(error.message);
    return { remoteId: path };
  },
};
