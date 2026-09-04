import type { Dictionary } from '@/i18n/dictionaries';
import { Reveal } from './reveal';
import { Button, Container, Section } from './ui';

export function FinalCta({ t, appUrl }: { t: Dictionary['cta']; appUrl: string }) {
  return (
    <Section className="pb-28">
      <Container>
        <div className="relative isolate overflow-hidden rounded-5xl border border-white/10 bg-[linear-gradient(135deg,#2E1E6B_0%,#4326A6_45%,#6C4EE3_100%)] px-6 py-16 text-center sm:px-12 sm:py-20">
          <div
            aria-hidden="true"
            className="absolute -top-24 left-1/2 -z-10 h-72 w-[36rem] -translate-x-1/2 rounded-full bg-accent-400/25 blur-[100px]"
          />
          <div
            aria-hidden="true"
            className="absolute inset-0 -z-10 opacity-20"
            style={{
              backgroundImage:
                'radial-gradient(circle at 20% 20%, rgb(255 255 255 / 0.4) 1px, transparent 1px)',
              backgroundSize: '28px 28px',
            }}
          />

          <Reveal>
            <h2 className="mx-auto max-w-2xl text-balance text-3xl font-semibold tracking-[-0.04em] text-white sm:text-5xl">
              {t.title}
            </h2>
          </Reveal>

          <Reveal delay={80}>
            <p className="mx-auto mt-5 max-w-xl text-pretty text-white/70">{t.subtitle}</p>
          </Reveal>

          <Reveal delay={160}>
            <div className="mt-10 flex flex-col items-center justify-center gap-3 sm:flex-row">
              <Button href={appUrl} external size="lg">
                {t.primary}
              </Button>
              <Button href={appUrl} external variant="ghost" size="lg">
                {t.secondary}
              </Button>
            </div>
          </Reveal>

          <Reveal delay={220}>
            <p className="mt-7 text-xs text-white/50">{t.note}</p>
          </Reveal>
        </div>
      </Container>
    </Section>
  );
}
