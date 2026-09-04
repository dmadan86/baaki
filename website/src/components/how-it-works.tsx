import type { Dictionary } from '@/i18n/dictionaries';
import { Reveal } from './reveal';
import { Container, Eyebrow, Section, SectionTitle } from './ui';

export function HowItWorks({ t }: { t: Dictionary['how'] }) {
  return (
    <Section id="how">
      <Container>
        <div className="max-w-2xl">
          <Reveal>
            <Eyebrow>{t.eyebrow}</Eyebrow>
          </Reveal>
          <Reveal delay={60}>
            <SectionTitle className="mt-6">{t.title}</SectionTitle>
          </Reveal>
        </div>

        <ol className="relative mt-16 grid gap-6 md:grid-cols-3">
          {/* the thread the three steps hang from */}
          <span
            aria-hidden="true"
            className="absolute inset-x-0 top-[3.25rem] hidden h-px bg-gradient-to-r from-transparent via-white/15 to-transparent md:block"
          />

          {t.steps.map((step, index) => (
            <li key={step.number} className="relative">
              <Reveal delay={index * 110} className="h-full">
                <div className="glass h-full rounded-4xl p-7">
                  <span className="inline-flex h-11 w-11 items-center justify-center rounded-2xl bg-gradient-to-br from-brand-400 to-brand-700 text-sm font-semibold text-white shadow-[0_12px_30px_-12px_rgb(122_90_248_/_0.9)]">
                    {step.number}
                  </span>
                  <h3 className="mt-6 text-lg font-semibold tracking-[-0.02em] text-white">
                    {step.title}
                  </h3>
                  <p className="mt-3 text-sm leading-relaxed text-white/55">{step.body}</p>
                </div>
              </Reveal>
            </li>
          ))}
        </ol>
      </Container>
    </Section>
  );
}
