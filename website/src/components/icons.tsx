type IconProps = { className?: string };

const base = 'h-5 w-5';

/**
 * One stroke weight, one cap style, one 24-grid — a set that looks drawn by the
 * same hand. Arrows are the only directional glyphs here, and every place that
 * uses one flips it under `dir="rtl"` (see the `rtl:` variant in globals.css):
 * an icon is content, and RTL does not mirror content for you.
 */
function Svg({ className, children }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className ?? base}
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

export const ArrowRight = (p: IconProps) => (
  <Svg {...p}>
    <path d="M5 12h14M13 6l6 6-6 6" />
  </Svg>
);

export const Check = (p: IconProps) => (
  <Svg {...p}>
    <path d="m4.5 12.5 5 5 10-11" />
  </Svg>
);

export const Chevron = (p: IconProps) => (
  <Svg {...p}>
    <path d="m6 9 6 6 6-6" />
  </Svg>
);

export const Globe = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M3 12h18M12 3c2.5 2.7 3.8 5.7 3.8 9S14.5 21.3 12 21c-2.5-2.7-3.8-5.7-3.8-9S9.5 5.7 12 3Z" />
  </Svg>
);

export const Split = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 6h5l6 12h5M20 6h-5" />
    <path d="m17 3 3 3-3 3M17 15l3 3-3 3" />
  </Svg>
);

export const OfflineBolt = (p: IconProps) => (
  <Svg {...p}>
    <path d="M13 2 4.5 13.5H11L10 22l8.5-11.5H12L13 2Z" />
  </Svg>
);

export const Compass = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="m15.5 8.5-2 5.2-5.2 2 2-5.2 5.2-2Z" />
  </Svg>
);

export const Scan = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 8V6a2 2 0 0 1 2-2h2M16 4h2a2 2 0 0 1 2 2v2M20 16v2a2 2 0 0 1-2 2h-2M8 20H6a2 2 0 0 1-2-2v-2M4 12h16" />
  </Svg>
);

export const Handshake = (p: IconProps) => (
  <Svg {...p}>
    <path d="m3 11 4-4 4 3 2-1 4 4-2 2-3-2" />
    <path d="m21 13-4 4-3-2M7 7 3 11l4 4" />
  </Svg>
);

export const Lock = (p: IconProps) => (
  <Svg {...p}>
    <rect x="4" y="10" width="16" height="10" rx="2.5" />
    <path d="M8 10V7.5a4 4 0 0 1 8 0V10" />
  </Svg>
);

export const Wallet = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3" y="6" width="18" height="13" rx="3" />
    <path d="M3 10h18M16.5 14.5h.01" />
  </Svg>
);

export const Users = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="9" cy="8" r="3.2" />
    <path d="M3 19c0-3 2.7-4.8 6-4.8s6 1.8 6 4.8" />
    <path d="M16 5.4a3.2 3.2 0 0 1 0 5.2M17.5 14.6c2 .7 3.5 2.2 3.5 4.4" />
  </Svg>
);

export const Home = (p: IconProps) => (
  <Svg {...p}>
    <path d="m4 10.5 8-6.5 8 6.5V19a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 19v-8.5Z" />
    <path d="M10 20.5V14h4v6.5" />
  </Svg>
);

export const Heart = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 20s-7-4.4-7-9.2A3.9 3.9 0 0 1 12 8.4a3.9 3.9 0 0 1 7 2.4C19 15.6 12 20 12 20Z" />
  </Svg>
);

export const Receipt = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6 3h12v18l-3-1.6L12 21l-3-1.6L6 21V3Z" />
    <path d="M9.5 8.5h5M9.5 12.5h5" />
  </Svg>
);

export const Menu = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 7h16M4 12h16M4 17h16" />
  </Svg>
);

export const Close = (p: IconProps) => (
  <Svg {...p}>
    <path d="m6 6 12 12M18 6 6 18" />
  </Svg>
);
