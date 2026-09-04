import type { Dictionary } from '@/i18n/dictionaries';
import { Reveal } from './reveal';
import { Container, Section, SectionTitle } from './ui';

export function Stats({ t }: { t: Dictionary['stats'] }) {
  return (
    <Section className="py-20 sm:py-24">
      <Container>
        <Reveal>
          <SectionTitle className="max-w-xl">{t.title}</SectionTitle>
        </Reveal>

        <dl className="mt-12 grid gap-px overflow-hidden rounded-4xl border border-white/[0.08] bg-white/[0.06] sm:grid-cols-2 lg:grid-cols-4">
          {t.items.map((item, index) => (
            <Reveal key={item.label} delay={index * 70}>
              <div className="h-full bg-night-950/85 p-7">
                <dt className="text-4xl font-semibold tracking-[-0.04em] text-white">
                  {item.value}
                </dt>
                <dd className="mt-3 text-sm font-medium text-white/75">{item.label}</dd>
                <dd className="mt-2 text-sm leading-relaxed text-white/40">{item.note}</dd>
              </div>
            </Reveal>
          ))}
        </dl>
      </Container>
    </Section>
  );
}
