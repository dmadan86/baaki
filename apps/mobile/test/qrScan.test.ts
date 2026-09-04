import { beforeEach, describe, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => ({
  platform: { OS: 'ios' },
  requireOptionalNativeModule: vi.fn(),
}));

vi.mock('react-native', () => ({ Platform: native.platform }));
vi.mock('expo', () => ({ requireOptionalNativeModule: native.requireOptionalNativeModule }));

const { cameraAvailable, tokenFromScan } = await import('../src/lib/qrScan');

beforeEach(() => {
  native.platform.OS = 'ios';
  native.requireOptionalNativeModule.mockReset();
});

describe('cameraAvailable', () => {
  it('requires an iOS or Android binary that actually includes ExpoCamera', () => {
    native.requireOptionalNativeModule.mockReturnValue({});
    native.platform.OS = 'ios';
    expect(cameraAvailable()).toBe(true);

    native.platform.OS = 'android';
    expect(cameraAvailable()).toBe(true);

    native.platform.OS = 'web';
    expect(cameraAvailable()).toBe(false);
    expect(native.requireOptionalNativeModule).toHaveBeenCalledTimes(2);
  });

  it('returns false for native dev clients built without the camera module', () => {
    native.platform.OS = 'android';
    native.requireOptionalNativeModule.mockReturnValue(null);

    expect(cameraAvailable()).toBe(false);
  });
});

describe('tokenFromScan', () => {
  it('extracts tokens from the supported HTTPS and app deep-link invite URLs', () => {
    expect(tokenFromScan(' https://wavs.co.in/join?token=abc123 ')).toBe('abc123');
    expect(tokenFromScan('https://WAVS.CO.IN/join/?token=a%20b')).toBe('a b');
    expect(tokenFromScan('waves://join?token=wave-token')).toBe('wave-token');
    expect(tokenFromScan('waves:///join?token=triple-slash')).toBe('triple-slash');
  });

  it('rejects unrelated hosts, paths, schemes and blank token values', () => {
    for (const data of [
      '',
      'not a url',
      'http://wavs.co.in/join?token=abc',
      'https://evil.example/join?token=abc',
      'https://wavs.co.in/not-join?token=abc',
      'waves://evil.example/join?token=abc',
      'mailto:test@example.com?token=abc',
      'https://wavs.co.in/join?token=',
      'https://wavs.co.in/join?token=%20%20',
    ]) {
      expect(tokenFromScan(data)).toBeNull();
    }
  });

  it('does not let fragments leak into the invite token', () => {
    expect(tokenFromScan('https://wavs.co.in/join?token=abc#token=evil')).toBe('abc');
    expect(tokenFromScan('https://wavs.co.in/join?other=1&token=abc#frag')).toBe('abc');
  });

  it('keeps malformed percent-encoding as the trimmed raw non-empty token', () => {
    expect(tokenFromScan('https://wavs.co.in/join?token=%E0%A4%A')).toBe('%E0%A4%A');
    expect(tokenFromScan('https://wavs.co.in/join?token=%E0%A4%A%20')).toBe('%E0%A4%A%20');
  });

  it('rejects non-invite QR payloads quickly even in a large scan batch', () => {
    const payloads = Array.from({ length: 1_000 }, (_, index) =>
      index === 999 ? 'https://wavs.co.in/join?token=last' : `https://example.com/${index}`,
    );

    const tokens = payloads.map(tokenFromScan).filter((token): token is string => token !== null);

    expect(tokens).toEqual(['last']);
  });
});
