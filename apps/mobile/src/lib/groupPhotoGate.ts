/**
 * The rule the group-photo control obeys: a real photo is a paid feature, a
 * cover emoji is free for everyone. The server answers "is this group (or its
 * creator) paid" over the `baaki_can_upload_group_photo` RPC; this module turns
 * that answer — and its loading state — into the small decisions the two photo
 * screens (new group, group settings) need, kept pure so they can be tested
 * without a renderer or the network.
 */

/** What the photo control should show. */
export type PhotoGateStatus = 'loading' | 'allowed' | 'locked';

/**
 * The gate, from the RPC's boolean and whether it is still in flight. An
 * undefined answer counts as loading: better to hold on the always-safe
 * icon-only affordance for a moment than to flash a picker and snatch it back.
 */
export function photoGateStatus(
  canUpload: boolean | undefined,
  isLoading: boolean,
): PhotoGateStatus {
  if (isLoading || canUpload === undefined) return 'loading';
  return canUpload ? 'allowed' : 'locked';
}

/** What tapping the group photo should do in each state. */
export type PhotoTapAction = 'pick' | 'showLockedHint' | 'ignore';

/**
 * Tapping the photo: open the picker only when allowed; when locked, point the
 * person at how to unlock it; while the answer is still loading, do nothing
 * rather than act on an unknown.
 */
export function photoTapAction(status: PhotoGateStatus): PhotoTapAction {
  switch (status) {
    case 'allowed':
      return 'pick';
    case 'locked':
      return 'showLockedHint';
    case 'loading':
      return 'ignore';
  }
}

/**
 * The `p_group_id` argument for `baaki_can_upload_group_photo`: a group's id for
 * an existing group, or `null` when creating one — a new group has only its
 * creator, so the server gates on the creator's own subscription.
 */
export function photoGateParam(groupId: string | null | undefined): string | null {
  return groupId ?? null;
}

/**
 * Whether an already-picked photo must be dropped. If the gate resolves to
 * locked after an image was chosen — a slow answer, or a paying member leaving
 * the group between screens — the picked photo can no longer be used, so it is
 * cleared rather than silently failing to upload later.
 */
export function shouldClearPickedPhoto(status: PhotoGateStatus, hasPickedPhoto: boolean): boolean {
  return status === 'locked' && hasPickedPhoto;
}
