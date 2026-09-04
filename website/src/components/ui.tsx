import Link from 'next/link';

import { ArrowRight } from './icons';

export function Container({
  className = '',
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return <div className={`mx-auto w-full max-w-6xl px-5 sm:px-8 ${className}`}>{children}</div>;
}

export function Section({
  id,
  className = '',
  children,
}: {
  id?: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className={`relative scroll-mt-24 py-24 sm:py-32 ${className}`}>
      {children}
    </section>
  );
}

export function Eyebrow({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3.5 py-1.5 text-xs font-medium tracking-[0.16em] text-brand-200 uppercase">
      <span className="h-1.5 w-1.5 rounded-full bg-brand-400" />
      {children}
    </span>
  );
}

/**
 * The one heading style the whole page uses. The emphasised phrase arrives as
 * `accent` rather than as markup inside a translated string — a translator
 * moves the emphasis to wherever the sentence puts it in their language.
 */
export function SectionTitle({
  children,
  className = '',
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <h2
      className={`text-balance text-3xl font-semibold tracking-[-0.035em] text-white sm:text-4xl md:text-5xl ${className}`}
    >
      {children}
    </h2>
  );
}

export function Lede({ children }: { children: React.ReactNode }) {
  return (
    <p className="max-w-2xl text-pretty text-base leading-relaxed text-white/60 sm:text-lg">
      {children}
    </p>
  );
}

type ButtonProps = {
  href: string;
  children: React.ReactNode;
  variant?: 'primary' | 'ghost';
  size?: 'md' | 'lg';
  external?: boolean;
  className?: string;
};

export function Button({
  href,
  children,
  variant = 'primary',
  size = 'md',
  external = false,
  className = '',
}: ButtonProps) {
  const sizing = size === 'lg' ? 'h-14 px-7 text-base' : 'h-11 px-5 text-sm';

  const skin =
    variant === 'primary'
      ? 'bg-white text-night-950 shadow-[0_18px_45px_-18px_rgb(122_90_248_/_0.9)] hover:bg-brand-50'
      : 'border border-white/15 bg-white/[0.04] text-white hover:border-white/30 hover:bg-white/[0.08]';

  const classes = `group inline-flex items-center justify-center gap-2 rounded-full font-semibold tracking-[-0.01em] transition-all duration-300 hover:-translate-y-0.5 active:translate-y-0 ${sizing} ${skin} ${className}`;

  const inner = (
    <>
      {children}
      <ArrowRight className="h-4 w-4 transition-transform duration-300 group-hover:translate-x-0.5 rtl:-scale-x-100 rtl:group-hover:-translate-x-0.5" />
    </>
  );

  if (external) {
    return (
      <a href={href} className={classes} rel="noreferrer">
        {inner}
      </a>
    );
  }

  return (
    <Link href={href} className={classes}>
      {inner}
    </Link>
  );
}
