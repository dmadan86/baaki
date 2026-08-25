import { beforeEach, describe, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => ({
  platform: { OS: 'ios' },
  recognize: vi.fn(),
}));

vi.mock('react-native', () => ({ Platform: native.platform }));
vi.mock('@react-native-ml-kit/text-recognition', () => ({
  default: { recognize: native.recognize },
}));

const { recogniseReceipt } = await import('../src/lib/ocr');

beforeEach(() => {
  native.platform.OS = 'ios';
  native.recognize.mockReset();
});

describe('recogniseReceipt', () => {
  it('does not load ML Kit on web', async () => {
    native.platform.OS = 'web';

    await expect(recogniseReceipt('file://receipt.jpg')).resolves.toBeNull();

    expect(native.recognize).not.toHaveBeenCalled();
  });

  it('returns normalized text and block count for receipt-like OCR output', async () => {
    native.recognize.mockResolvedValue({
      blocks: [
        { text: 'Cafe Baaki   \n' },
        { text: 'Masala dosa      180.00' },
        { text: 'Filter coffee     60.00' },
        { text: 'Total            240.00' },
      ],
    });

    await expect(recogniseReceipt('file://receipt.jpg')).resolves.toEqual({
      text: [
        'Cafe Baaki',
        'Masala dosa      180.00',
        'Filter coffee     60.00',
        'Total            240.00',
      ].join('\n'),
      lines: 4,
    });
    expect(native.recognize).toHaveBeenCalledWith('file://receipt.jpg');
  });

  it('falls back to image upload for thin, non-bill, or failed recognizer results', async () => {
    native.recognize.mockResolvedValueOnce({ blocks: [{ text: 'abc 1' }] });
    await expect(recogniseReceipt('file://thin.jpg')).resolves.toBeNull();

    native.recognize.mockResolvedValueOnce({
      blocks: [{ text: 'This is a long paragraph without any receipt-style amount at all.' }],
    });
    await expect(recogniseReceipt('file://words.jpg')).resolves.toBeNull();

    native.recognize.mockRejectedValueOnce(new Error('native recognizer unavailable'));
    await expect(recogniseReceipt('file://broken.jpg')).resolves.toBeNull();
  });

  it('ignores malformed native blocks rather than failing the whole OCR attempt', async () => {
    native.recognize.mockResolvedValue({
      blocks: [
        { text: 'Cafe Baaki' },
        { text: null },
        {},
        { text: 'A receipt line that is long enough to pass the OCR threshold' },
        { text: 'Total 123.45' },
      ],
    });

    const result = await recogniseReceipt('file://receipt.jpg');

    expect(result?.lines).toBe(5);
    expect(result?.text).toContain('Cafe Baaki');
    expect(result?.text).toContain('Total 123.45');
  });

  it('handles a large OCR result in one linear pass', async () => {
    const blocks = Array.from({ length: 1_000 }, (_, index) => ({
      text: `Item ${index} ${index}.00`,
    }));
    native.recognize.mockResolvedValue({ blocks });

    const result = await recogniseReceipt('file://long-receipt.jpg');

    expect(result?.lines).toBe(1_000);
    expect(result?.text.startsWith('Item 0 0.00')).toBe(true);
    expect(result?.text.endsWith('Item 999 999.00')).toBe(true);
  });
});
