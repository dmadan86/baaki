import type { Dictionary } from '@/i18n/dictionaries';
import { Lock } from './icons';
import { Reveal } from './reveal';
import { Container, Eyebrow, Lede, Section, SectionTitle } from './ui';

export function PrivacySection({ t }: { t: Dictionary['privacy'] }) {
  return (
    <Section>
      <Container>
        <div className="glass-strong relative isolate overflow-hidden rounded-5xl p-8 sm:p-12 lg:p-16">
          <div
            aria-hidden="true"
            className="absolute -top-40 start-1/4 -z-10 h-80 w-80 rounded-full bg-brand-500/25 blur-[110px]"
          />

          <div className="grid gap-12 lg:grid-cols-[0.9fr_1.1fr] lg:gap-16">
            <div>
              <Reveal>
                <Eyebrow>{t.eyebrow}</Eyebrow>
              </Reveal>
              <Reveal delay={60}>
                <SectionTitle className="mt-6">{t.title}</SectionTitle>
              </Reveal>
              <Reveal delay={120}>
                <div className="mt-5">
                  <Lede>{t.body}</Lede>
                </div>
              </Reveal>
            </div>

            <ul className="grid gap-4 sm:grid-cols-2">
              {t.points.map((point, index) => (
                <li key={point.title}>
                  <Reveal delay={index * 80} className="h-full">
                    <div className="h-full rounded-3xl border border-white/[0.08] bg-night-950/50 p-5">
                      <span className="inline-flex h-9 w-9 items-center justify-center rounded-xl bg-brand-500/15 text-brand-200 ring-1 ring-brand-400/20">
                        <Lock className="h-4 w-4" />
                      </span>
                      <h3 className="mt-4 text-sm font-semibold text-white">{point.title}</h3>
                      <p className="mt-2 text-sm leading-relaxed text-white/50">{point.body}</p>
                    </div>
                  </Reveal>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </Container>
    </Section>
  );
}
