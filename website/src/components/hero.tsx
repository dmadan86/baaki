import type { Dictionary } from '@/i18n/dictionaries';
import { AppPreview } from './app-preview';
import { ArrowRight } from './icons';
import { Reveal } from './reveal';
import { Button, Container } from './ui';

export function Hero({
  t,
  banner,
  appUrl,
}: {
  t: Dictionary['hero'];
  banner: Dictionary['banner'];
  appUrl: string;
}) {
  return (
    <section className="relative overflow-hidden pt-32 pb-20 sm:pt-40 sm:pb-28">
      <Container>
        <div className="grid items-center gap-16 lg:grid-cols-[1.05fr_0.95fr] lg:gap-10">
          <div>
            <Reveal>
              <a
                href="#pricing"
                className="group inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] py-1.5 ps-4 pe-2.5 text-xs text-white/70 transition-colors hover:border-white/25 hover:text-white sm:text-sm"
              >
                <span className="relative flex h-1.5 w-1.5">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-brand-400 opacity-75" />
                  <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-brand-300" />
                </span>
                {banner.text}
                <ArrowRight className="h-3.5 w-3.5 opacity-60 transition-transform group-hover:translate-x-0.5 rtl:-scale-x-100 rtl:group-hover:-translate-x-0.5" />
              </a>
            </Reveal>

            <Reveal delay={60}>
              <p className="mt-8 text-xs font-medium tracking-[0.2em] text-brand-200/80 uppercase">
                {t.eyebrow}
              </p>
            </Reveal>

            <Reveal delay={80}>
              <h1 className="mt-4 text-balance text-[2.6rem] leading-[0.98] font-semibold tracking-[-0.045em] text-white sm:text-6xl lg:text-[4.25rem]">
                {t.titleLine1}{' '}
                <span className="font-display text-gradient italic">{t.titleAccent}</span>
              </h1>
            </Reveal>

            <Reveal delay={160}>
              <p className="mt-6 max-w-xl text-pretty text-base leading-relaxed text-white/60 sm:text-lg">
                {t.subtitle}
              </p>
            </Reveal>

            <Reveal delay={240}>
              <div className="mt-9 flex flex-col gap-3 sm:flex-row sm:items-center">
                <Button href={appUrl} external size="lg">
                  {t.ctaPrimary}
                </Button>
                <Button href="#how" variant="ghost" size="lg">
                  {t.ctaSecondary}
                </Button>
              </div>
            </Reveal>

            <Reveal delay={320}>
              <p className="mt-7 text-sm text-white/40">{t.trust}</p>
            </Reveal>
          </div>

          <Reveal delay={200} className="lg:justify-self-end">
            <AppPreview
              title={t.cardTitle}
              members={t.cardMembers}
              balanceLabel={t.cardBalanceLabel}
              balance={t.cardBalance}
              rows={t.cardRows}
              settle={t.cardSettle}
            />
          </Reveal>
        </div>
      </Container>
    </section>
  );
}
