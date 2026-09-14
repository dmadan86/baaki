import { beforeEach, describe, expect, it, vi } from 'vitest';

const sharing = {
  available: true,
  shareAsync: vi.fn(),
};
const files: { uri: string; bytes: number[] }[] = [];
const capture = vi.fn();

vi.mock('expo-sharing', () => ({
  isAvailableAsync: async () => sharing.available,
  shareAsync: sharing.shareAsync,
}));

vi.mock('expo-file-system', () => ({
  File: class {
    readonly uri: string;
    exists = false;

    constructor(_cache: string, name: string) {
      this.uri = `cache://${name}`;
    }

    delete(): void {
      this.exists = false;
    }

    create(): void {
      this.exists = true;
    }

    write(bytes: Uint8Array): void {
      files.push({ uri: this.uri, bytes: [...bytes] });
    }
  },
  Paths: { cache: 'cache://' },
}));

vi.mock('react-native-view-shot', () => ({
  captureRef: capture,
}));

const { shareInviteCard } = await import('../src/lib/shareInviteCard');

describe('sharing an invite card image', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    files.length = 0;
    sharing.available = true;
    capture.mockResolvedValue('aW52aXRlLWNhcmQ=');
  });

  it('captures the whole invitation card and shares that PNG', async () => {
    const fallback = vi.fn();

    await shareInviteCard({
      cardRef: null,
      filename: 'waves-invite-card.png',
      dialogTitle: 'Join Goa trip',
      fallback,
    });

    expect(capture).toHaveBeenCalledWith(null, {
      format: 'png',
      quality: 1,
      result: 'base64',
    });
    expect(files).toEqual([
      { uri: 'cache://waves-invite-card.png', bytes: [...Buffer.from('invite-card')] },
    ]);
    expect(sharing.shareAsync).toHaveBeenCalledWith('cache://waves-invite-card.png', {
      mimeType: 'image/png',
      dialogTitle: 'Join Goa trip',
      UTI: 'public.png',
    });
    expect(fallback).not.toHaveBeenCalled();
  });

  it('falls back to the link when native image sharing is unavailable', async () => {
    sharing.available = false;
    const fallback = vi.fn();

    await shareInviteCard({
      cardRef: null,
      filename: 'invite.png',
      dialogTitle: 'Invite',
      fallback,
    });

    expect(capture).not.toHaveBeenCalled();
    expect(sharing.shareAsync).not.toHaveBeenCalled();
    expect(fallback).toHaveBeenCalledTimes(1);
  });

  it('falls back to the link when card capture fails', async () => {
    capture.mockRejectedValue(new Error('capture failed'));
    const fallback = vi.fn();

    await shareInviteCard({
      cardRef: null,
      filename: 'invite.png',
      dialogTitle: 'Invite',
      fallback,
    });

    expect(sharing.shareAsync).not.toHaveBeenCalled();
    expect(fallback).toHaveBeenCalledTimes(1);
  });
});
