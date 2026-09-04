import type { Dictionary } from '@/i18n/dictionaries';
import { Reveal } from './reveal';
import { Container, Eyebrow, Section, SectionTitle } from './ui';

/**
 * Native `<details>` rather than a scripted accordion: it opens with
 * JavaScript off, it is already keyboard-operable and announced correctly, and
 * a browser can find text inside a closed one.
 */
export function Faq({ t }: { t: Dictionary['faq'] }) {
  return (
    <Section id="faq">
      <Container>
        <div className="grid gap-12 lg:grid-cols-[0.8fr_1.2fr] lg:gap-16">
          <div>
            <Reveal>
              <Eyebrow>{t.eyebrow}</Eyebrow>
            </Reveal>
            <Reveal delay={60}>
              <SectionTitle className="mt-6">{t.title}</SectionTitle>
            </Reveal>
          </div>

          <div className="divide-y divide-white/[0.07] border-y border-white/[0.07]">
            {t.items.map((item, index) => (
              <Reveal key={item.q} delay={index * 60}>
                <details className="group py-5">
                  <summary className="flex cursor-pointer list-none items-start justify-between gap-6 text-start text-base font-medium text-white/90 transition-colors hover:text-white [&::-webkit-details-marker]:hidden">
                    {item.q}
                    <span
                      aria-hidden="true"
                      className="relative mt-2 h-3 w-3 shrink-0 text-brand-200"
                    >
                      <span className="absolute top-1/2 left-0 h-px w-3 -translate-y-1/2 bg-current" />
                      <span className="absolute top-1/2 left-0 h-px w-3 -translate-y-1/2 rotate-90 bg-current transition-transform duration-300 group-open:rotate-0" />
                    </span>
                  </summary>
                  <p className="mt-3 max-w-2xl text-sm leading-relaxed text-white/55">{item.a}</p>
                </details>
              </Reveal>
            ))}
          </div>
        </div>
      </Container>
    </Section>
  );
}
