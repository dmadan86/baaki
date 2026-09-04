import type { Dictionary } from '@/i18n/dictionaries';
import { Check } from './icons';
import { Reveal } from './reveal';
import { Container, Eyebrow, Lede, Section, SectionTitle } from './ui';

export function Pricing({ t, appUrl }: { t: Dictionary['pricing']; appUrl: string }) {
  return (
    <Section id="pricing">
      <Container>
        <div className="max-w-2xl">
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

        <div className="mt-14 grid gap-5 lg:grid-cols-2">
          {t.plans.map((plan, index) => (
            <Reveal key={plan.name} delay={index * 110}>
              <div
                className={`relative flex h-full flex-col overflow-hidden rounded-4xl p-8 sm:p-10 ${
                  plan.featured ? 'glass-strong ring-1 ring-brand-400/30' : 'glass'
                }`}
              >
                {plan.featured ? (
                  <div
                    aria-hidden="true"
                    className="absolute -top-28 -end-16 h-56 w-56 rounded-full bg-brand-500/30 blur-3xl"
                  />
                ) : null}

                <div className="relative">
                  <p className="text-sm font-medium tracking-[0.14em] text-brand-200 uppercase">
                    {plan.name}
                  </p>

                  <p className="mt-5 flex items-baseline gap-2">
                    <span className="text-4xl font-semibold tracking-[-0.04em] text-white sm:text-5xl">
                      {plan.price}
                    </span>
                    {plan.period ? (
                      <span className="text-sm text-white/45">{plan.period}</span>
                    ) : null}
                  </p>

                  <p className="mt-3 text-sm text-white/55">{plan.tagline}</p>

                  <ul className="mt-8 space-y-3.5">
                    {plan.features.map((feature) => (
                      <li key={feature} className="flex items-start gap-3 text-sm text-white/70">
                        <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-brand-500/20 text-brand-100 ring-1 ring-brand-400/25">
                          <Check className="h-3 w-3" />
                        </span>
                        {feature}
                      </li>
                    ))}
                  </ul>
                </div>

                <a
                  href={appUrl}
                  className={`relative mt-10 flex h-12 items-center justify-center rounded-full text-sm font-semibold transition-all duration-300 hover:-translate-y-0.5 ${
                    plan.featured
                      ? 'bg-white text-night-950 hover:bg-brand-50'
                      : 'border border-white/15 bg-white/[0.04] text-white hover:border-white/30'
                  }`}
                >
                  {plan.cta}
                </a>
              </div>
            </Reveal>
          ))}
        </div>

        <Reveal delay={200}>
          <p className="mt-6 text-center text-xs text-white/35">{t.billedNote}</p>
        </Reveal>
      </Container>
    </Section>
  );
}
