/**
 * The mark is the name: three crests of a wave that also read as the rise and
 * fall of a balance. It scales down to a favicon without losing the shape.
 */
export function WaveMark({ className = 'h-7 w-7' }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" fill="none" className={className} aria-hidden="true">
      <defs>
        <linearGradient id="wave-mark" x1="0" y1="0" x2="32" y2="32" gradientUnits="userSpaceOnUse">
          <stop stopColor="#B4A5FB" />
          <stop offset="0.55" stopColor="#7A5AF8" />
          <stop offset="1" stopColor="#F97316" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="9" fill="url(#wave-mark)" />
      <path
        d="M5 20.5c2.2 0 2.2-4.6 4.4-4.6s2.2 4.6 4.4 4.6 2.2-4.6 4.4-4.6 2.2 4.6 4.4 4.6 2.2-4.6 4.4-4.6"
        stroke="#0E0E1A"
        strokeOpacity="0.85"
        strokeWidth="2.1"
        strokeLinecap="round"
      />
      <path
        d="M7.5 12.4c1.9 0 1.9-3.4 3.8-3.4s1.9 3.4 3.8 3.4 1.9-3.4 3.8-3.4 1.9 3.4 3.8 3.4"
        stroke="#FFFFFF"
        strokeOpacity="0.7"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function Wordmark({ className = '' }: { className?: string }) {
  return (
    <span className={`inline-flex items-center gap-2.5 ${className}`}>
      <WaveMark />
      <span className="text-[1.35rem] font-semibold tracking-[-0.03em] text-white">Waves</span>
    </span>
  );
}
