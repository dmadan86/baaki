import type { Dictionary } from '@/i18n/dictionaries';
import { featureVisuals } from './feature-visuals';
import { Check, Compass, Handshake, Lock, OfflineBolt, Scan, Split } from './icons';
import { Reveal } from './reveal';
import { Container, Eyebrow, Lede, Section, SectionTitle } from './ui';

const kickerIcons = [Split, OfflineBolt, Compass, Scan, Handshake, Lock] as const;

/** The trip feature is what the "Trips" nav link points at. */
const anchors: Record<number, string> = { 2: 'trips' };

export function Features({
  t,
  visuals,
}: {
  t: Dictionary['features'];
  visuals: Dictionary['visuals'];
}) {
  return (
    <Section id="features">
      <Container>
        <div className="max-w-3xl">
          <Reveal>
            <Eyebrow>{t.eyebrow}</Eyebrow>
          </Reveal>
          <Reveal delay={60}>
            <SectionTitle className="mt-6">{t.title}</SectionTitle>
          </Reveal>
          <Reveal delay={120}>
            <div className="mt-5">
              <Lede>{t.subtitle}</Lede>
            </div>
          </Reveal>
        </div>

        <div className="mt-20 space-y-24 sm:mt-24 sm:space-y-32">
          {t.items.map((item, index) => {
            const Icon = kickerIcons[index] ?? Split;
            const Visual = featureVisuals[index] ?? featureVisuals[0];
            const flipped = index % 2 === 1;

            return (
              <div
                key={item.title}
                id={anchors[index]}
                className="grid scroll-mt-28 items-center gap-10 lg:grid-cols-2 lg:gap-16"
              >
                <Reveal className={flipped ? 'lg:order-2' : undefined}>
                  <span className="inline-flex items-center gap-2 text-xs font-medium tracking-[0.16em] text-brand-200 uppercase">
                    <Icon className="h-4 w-4" />
                    {item.kicker}
                  </span>

                  <h3 className="mt-5 text-balance text-2xl font-semibold tracking-[-0.03em] text-white sm:text-3xl md:text-[2.1rem] md:leading-[1.1]">
                    {item.title}
                  </h3>

                  <p className="mt-4 max-w-lg text-pretty leading-relaxed text-white/55">
                    {item.body}
                  </p>

                  <ul className="mt-7 space-y-3">
                    {item.points.map((point) => (
                      <li key={point} className="flex items-start gap-3 text-sm text-white/70">
                        <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-brand-500/20 text-brand-100 ring-1 ring-brand-400/25">
                          <Check className="h-3 w-3" />
                        </span>
                        {point}
                      </li>
                    ))}
                  </ul>
                </Reveal>

                <Reveal delay={120} className={flipped ? 'lg:order-1' : undefined}>
                  <Visual t={visuals} />
                </Reveal>
              </div>
            );
          })}
        </div>
      </Container>
    </Section>
  );
}
