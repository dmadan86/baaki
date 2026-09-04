import type { Dictionary } from '@/i18n/dictionaries';
import { Check, Lock, Receipt, Scan } from './icons';

/**
 * One drawn panel per feature. They are deliberately not screenshots: a
 * screenshot cannot be translated, goes stale the week the UI moves, and ships
 * a 400 KB PNG. These are a few dozen elements each, sharp on any display, and
 * they mirror correctly under `dir="rtl"` because they are laid out with
 * logical properties rather than left/right.
 *
 * Every word inside them comes from the dictionary too — a Tamil page with an
 * English illustration in the middle of it is still an English page.
 */

type Visuals = Dictionary['visuals'];

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div className="glass relative isolate overflow-hidden rounded-4xl p-6 sm:p-8">
      <div
        aria-hidden="true"
        className="absolute -top-24 -end-16 -z-10 h-56 w-56 rounded-full bg-brand-500/25 blur-3xl"
      />
      {children}
    </div>
  );
}

function Chip({
  children,
  tone = 'muted',
}: {
  children: React.ReactNode;
  tone?: 'muted' | 'brand';
}) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[0.7rem] font-medium ${
        tone === 'brand'
          ? 'bg-brand-500/20 text-brand-100 ring-1 ring-brand-400/30'
          : 'bg-white/[0.06] text-white/60 ring-1 ring-white/10'
      }`}
    >
      {children}
    </span>
  );
}

/** 1 — one bill, four ways. */
function SplitVisual({ t }: { t: Visuals }) {
  const people = ['Y', 'M', 'A', 'R'];

  return (
    <Frame>
      <div className="rounded-2xl border border-white/10 bg-white/[0.04] p-4">
        <div className="flex items-baseline justify-between gap-3">
          <span className="min-w-0 truncate text-sm text-white/60">{t.split.bill}</span>
          <span className="shrink-0 text-xl font-semibold text-white">₹3,200</span>
        </div>
        <div className="mt-3 flex gap-1.5">
          {people.map((p) => (
            <span key={p} className="h-1.5 flex-1 rounded-full bg-brand-400/70" />
          ))}
        </div>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-2.5 sm:grid-cols-4">
        {people.map((initial) => (
          <div
            key={initial}
            className="rounded-2xl border border-white/[0.07] bg-white/[0.03] p-3 text-center"
          >
            <span className="mx-auto flex h-8 w-8 items-center justify-center rounded-full bg-gradient-to-br from-brand-400 to-brand-700 text-xs font-semibold text-white">
              {initial}
            </span>
            <p className="mt-2 text-sm font-semibold text-white">₹800</p>
            <p className="text-[0.68rem] text-white/40">25%</p>
          </div>
        ))}
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        {t.split.types.map((type, index) => (
          <Chip key={type} tone={index === 0 ? 'brand' : 'muted'}>
            {type}
          </Chip>
        ))}
      </div>
    </Frame>
  );
}

/** 2 — the queue that survives no signal. */
function OfflineVisual({ t }: { t: Visuals }) {
  return (
    <Frame>
      <div className="flex items-center justify-between gap-3">
        <Chip>{t.offline.noSignal}</Chip>
        <span className="text-[0.7rem] text-white/40">{t.offline.waiting}</span>
      </div>

      <ul className="mt-5 space-y-2.5">
        {t.offline.rows.map((label, index) => (
          <li
            key={label}
            className="flex items-center justify-between gap-3 rounded-2xl border border-white/[0.07] bg-white/[0.03] px-4 py-3"
          >
            <span className="min-w-0 truncate text-sm text-white/80">{label}</span>
            {index === 0 ? (
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-brand-500/25 text-brand-100">
                <Check className="h-3.5 w-3.5" />
              </span>
            ) : (
              <span className="flex shrink-0 gap-1">
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-white/50" />
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-white/35 [animation-delay:200ms]" />
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-white/20 [animation-delay:400ms]" />
              </span>
            )}
          </li>
        ))}
      </ul>

      <div className="mt-5 flex items-center gap-2.5 rounded-2xl border border-white/[0.07] bg-white/[0.02] px-4 py-3 text-xs text-white/50">
        <Lock className="h-4 w-4 shrink-0 text-brand-200" />
        {t.offline.encrypted}
      </div>
    </Frame>
  );
}

/** 3 — one trip, four currencies. */
function TripVisual({ t }: { t: Visuals }) {
  const used = [72, 48, 91];

  return (
    <Frame>
      <div className="flex flex-wrap items-center gap-2">
        <Chip tone="brand">₹ INR</Chip>
        <Chip>$ USD</Chip>
        <Chip>€ EUR</Chip>
        <Chip>﷼ AED</Chip>
      </div>

      <div className="mt-5 rounded-2xl border border-white/10 bg-white/[0.04] p-4">
        <p className="text-[0.7rem] tracking-wide text-white/45 uppercase">{t.trip.rateLabel}</p>
        <p className="mt-1.5 text-lg font-semibold text-white" dir="ltr">
          1 USD = <span className="text-brand-200">83.40</span> INR
        </p>
        <p className="mt-1 text-xs text-white/40">{t.trip.rateNote}</p>
      </div>

      <div className="mt-4 space-y-3">
        {t.trip.categories.map((label, index) => (
          <div key={label}>
            <div className="flex justify-between text-xs text-white/55">
              <span>{label}</span>
              <span>{used[index]}%</span>
            </div>
            <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-white/[0.08]">
              <span
                className={`block h-full rounded-full ${
                  used[index] > 85
                    ? 'bg-[#E84A66]'
                    : 'bg-gradient-to-r from-brand-400 to-accent-400'
                }`}
                style={{ width: `${used[index]}%` }}
              />
            </div>
          </div>
        ))}
      </div>
    </Frame>
  );
}

/** 4 — scan it, or say it. */
function CaptureVisual({ t }: { t: Visuals }) {
  const amounts = ['₹280', '₹160', '₹44'];

  return (
    <Frame>
      <div className="grid gap-4 sm:grid-cols-[1.1fr_0.9fr]">
        <div className="rounded-2xl border border-white/10 bg-white/[0.04] p-4">
          <div className="flex items-center gap-2 text-white/50">
            <Receipt className="h-4 w-4" />
            <span className="text-xs">{t.capture.receipt}</span>
            <Scan className="ms-auto h-4 w-4 text-brand-200" />
          </div>
          <ul className="mt-3 space-y-2">
            {t.capture.items.map((item, index) => (
              <li key={item} className="flex justify-between gap-2 text-[0.78rem]">
                <span className="min-w-0 truncate text-white/70">{item}</span>
                <span className="shrink-0 font-medium text-white">{amounts[index]}</span>
              </li>
            ))}
          </ul>
          <div className="mt-3 flex justify-between border-t border-white/10 pt-2.5 text-[0.78rem]">
            <span className="text-white/50">{t.capture.total}</span>
            <span className="font-semibold text-white">₹484</span>
          </div>
        </div>

        <div className="flex flex-col items-center justify-center rounded-2xl border border-white/10 bg-white/[0.04] p-4 text-center">
          <span className="relative flex h-14 w-14 items-center justify-center rounded-full bg-gradient-to-br from-brand-400 to-brand-700">
            <span className="absolute inset-0 animate-ping rounded-full bg-brand-400/40" />
            <svg
              viewBox="0 0 24 24"
              className="relative h-6 w-6"
              fill="none"
              stroke="#fff"
              strokeWidth="1.7"
              strokeLinecap="round"
              aria-hidden="true"
            >
              <rect x="9" y="3" width="6" height="11" rx="3" />
              <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
            </svg>
          </span>
          <p className="mt-3 text-[0.78rem] leading-snug text-white/60">
            {t.capture.quoteLine1}
            <br />
            {t.capture.quoteLine2}
          </p>
          <div className="mt-3 flex items-end gap-0.5">
            {[6, 12, 20, 14, 26, 10, 18, 8].map((height, index) => (
              <span
                key={index}
                className="w-1 animate-pulse rounded-full bg-brand-300/70"
                style={{ height, animationDelay: `${index * 90}ms` }}
              />
            ))}
          </div>
        </div>
      </div>
    </Frame>
  );
}

/** 5 — the handoff to the payment app. */
function SettleVisual({ t }: { t: Visuals }) {
  return (
    <Frame>
      <div className="rounded-2xl border border-white/10 bg-[linear-gradient(135deg,#1D4ED8_0%,#2563EB_60%,#4F80F5_100%)] p-5">
        <p className="text-[0.7rem] text-white/70">{t.settle.simplified}</p>
        <p className="mt-1.5 text-2xl font-semibold tracking-[-0.03em] text-white">
          {t.settle.line}
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          {['UPI', 'PayPal', 'PayID', 'Bank'].map((rail) => (
            <span
              key={rail}
              className="rounded-full bg-black/25 px-3 py-1.5 text-[0.7rem] font-medium text-white"
            >
              {rail}
            </span>
          ))}
        </div>
      </div>

      <div className="mt-4 grid gap-2.5 sm:grid-cols-2">
        <div className="rounded-2xl border border-white/[0.07] bg-white/[0.03] px-4 py-3">
          <p className="text-[0.7rem] text-white/45">{t.settle.paidLabel}</p>
          <p className="mt-1 text-sm font-semibold text-white">{t.settle.paidValue}</p>
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/[0.08]">
            <span className="block h-full w-[58%] rounded-full bg-[#2563EB]" />
          </div>
        </div>
        <div className="flex items-center gap-2.5 rounded-2xl border border-white/[0.07] bg-white/[0.03] px-4 py-3">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand-500/20 text-brand-100">
            <Check className="h-4 w-4" />
          </span>
          <span className="text-xs leading-snug text-white/60">
            {t.settle.proof}
            <br />
            {t.settle.awaiting}
          </span>
        </div>
      </div>
    </Frame>
  );
}

/** 6 — the private half. */
function PersonalVisual({ t }: { t: Visuals }) {
  const amounts = ['₹18,000', '₹5,000', '₹2,340'];

  return (
    <Frame>
      <div className="flex items-center justify-between gap-3">
        <Chip tone="brand">
          <Lock className="h-3 w-3" />
          {t.personal.onlyYou}
        </Chip>
        <span className="text-[0.7rem] text-white/40">{t.personal.month}</span>
      </div>

      <div className="mt-5 grid gap-2.5 sm:grid-cols-2">
        <div className="rounded-2xl border border-white/[0.07] bg-white/[0.03] p-4">
          <p className="text-[0.7rem] text-white/45">{t.personal.spent}</p>
          <p className="mt-1 text-xl font-semibold text-white">₹42,180</p>
        </div>
        <div className="rounded-2xl border border-white/[0.07] bg-white/[0.03] p-4">
          <p className="text-[0.7rem] text-white/45">{t.personal.left}</p>
          <p className="mt-1 text-xl font-semibold text-[#2563EB]">₹7,820</p>
        </div>
      </div>

      <ul className="mt-3 space-y-2">
        {t.personal.rows.map((row, index) => (
          <li
            key={row.title}
            className="flex items-center justify-between gap-3 rounded-2xl border border-white/[0.07] bg-white/[0.03] px-4 py-3"
          >
            <span className="min-w-0">
              <span className="block truncate text-[0.8rem] font-medium text-white/85">
                {row.title}
              </span>
              <span className="block truncate text-[0.68rem] text-white/40">{row.meta}</span>
            </span>
            <span className="shrink-0 text-[0.8rem] font-semibold text-white">
              {amounts[index]}
            </span>
          </li>
        ))}
      </ul>
    </Frame>
  );
}

/** In the order the feature list reads. */
export const featureVisuals = [
  SplitVisual,
  OfflineVisual,
  TripVisual,
  CaptureVisual,
  SettleVisual,
  PersonalVisual,
] as const;
