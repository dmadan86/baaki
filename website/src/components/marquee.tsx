import type { Dictionary } from '@/i18n/dictionaries';
import { Container } from './ui';

/**
 * A quiet strip rather than a wall of borrowed logos: these are the rails a
 * settlement is handed to, named in words. The track is duplicated once and
 * translated by half its width, which is what makes the loop seamless.
 */
export function Marquee({ t }: { t: Dictionary['marquee'] }) {
  const items = [...t.items, ...t.items];

  return (
    <section className="relative border-y border-white/[0.06] py-10">
      <Container>
        <p className="text-center text-xs tracking-[0.18em] text-white/35 uppercase">{t.label}</p>
      </Container>

      <div
        className="relative mt-6 overflow-hidden"
        style={{
          maskImage: 'linear-gradient(90deg, transparent, #000 12%, #000 88%, transparent)',
          WebkitMaskImage: 'linear-gradient(90deg, transparent, #000 12%, #000 88%, transparent)',
        }}
      >
        <ul
          className="animate-marquee flex w-max items-center gap-4 hover:[animation-play-state:paused]"
          aria-hidden="true"
        >
          {items.map((item, index) => (
            <li
              key={`${item}-${index}`}
              className="rounded-full border border-white/[0.08] bg-white/[0.03] px-5 py-2.5 text-sm whitespace-nowrap text-white/55"
            >
              {item}
            </li>
          ))}
        </ul>
        {/* The visible list is decorative and duplicated, so the real one is
            here for screen readers and for a browser with no animation. */}
        <ul className="sr-only">
          {t.items.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      </div>
    </section>
  );
}
