import type { Dictionary } from '@/i18n/dictionaries';
import { Compass, Heart, Home, Wallet } from './icons';
import { Reveal } from './reveal';
import { Container, Eyebrow, Section, SectionTitle } from './ui';

const icons = [Compass, Home, Heart, Wallet] as const;

export function Audience({ t }: { t: Dictionary['audience'] }) {
  return (
    <Section className="py-20 sm:py-24">
      <Container>
        <div className="max-w-2xl">
          <Reveal>
            <Eyebrow>{t.eyebrow}</Eyebrow>
          </Reveal>
          <Reveal delay={60}>
            <SectionTitle className="mt-6">{t.title}</SectionTitle>
          </Reveal>
        </div>

        <ul className="mt-14 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {t.items.map((item, index) => {
            const Icon = icons[index] ?? Compass;
            return (
              <li key={item.title}>
                <Reveal delay={index * 80} className="h-full">
                  <div className="group glass h-full rounded-4xl p-6 transition-colors duration-500 hover:border-white/20">
                    <span className="inline-flex h-10 w-10 items-center justify-center rounded-2xl bg-white/[0.06] text-brand-200 ring-1 ring-white/10 transition-colors duration-500 group-hover:bg-brand-500/20">
                      <Icon />
                    </span>
                    <h3 className="mt-5 text-base font-semibold text-white">{item.title}</h3>
                    <p className="mt-2.5 text-sm leading-relaxed text-white/50">{item.body}</p>
                  </div>
                </Reveal>
              </li>
            );
          })}
        </ul>
      </Container>
    </Section>
  );
}
