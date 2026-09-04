import { ImageResponse } from 'next/og';

import { site } from '@/lib/site';

export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';
export const alt = 'Waves';

/**
 * The share card. The wordmark and tagline stay in English in every locale on
 * purpose: the renderer only has a Latin face loaded, and a card of tofu boxes
 * is worse than a card in the wrong language.
 */
export default function OpengraphImage() {
  return new ImageResponse(
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
        padding: 80,
        background: 'linear-gradient(135deg, #08080F 0%, #2E1E6B 55%, #4326A6 100%)',
        color: 'white',
        fontFamily: 'sans-serif',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 20 }}>
        <div
          style={{
            width: 68,
            height: 68,
            borderRadius: 20,
            background: 'linear-gradient(135deg, #B4A5FB 0%, #7A5AF8 55%, #F97316 100%)',
          }}
        />
        <div style={{ fontSize: 46, fontWeight: 700, letterSpacing: -1.5 }}>Waves</div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
        {/* Satori refuses to lay out a node with several children unless it is
            told how, so every wrapper here declares its display explicitly. */}
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            fontSize: 78,
            fontWeight: 700,
            letterSpacing: -3,
            lineHeight: 1.05,
          }}
        >
          <span>Money between friends,</span>
          <span>finally weightless.</span>
        </div>
        <div style={{ fontSize: 30, color: 'rgba(255,255,255,0.66)' }}>
          Split anything. Settle anywhere. Works offline.
        </div>
      </div>

      <div style={{ display: 'flex', fontSize: 26, color: 'rgba(255,255,255,0.5)' }}>
        {site.domain}
      </div>
    </div>,
    size,
  );
}
