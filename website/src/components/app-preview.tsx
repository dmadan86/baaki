import { ArrowRight, Users, Wallet } from './icons';

type Row = { title: string; meta: string; amount: string };

/**
 * The product, drawn rather than screenshotted: a real device frame with the
 * group ledger inside it, built from the same balance-card gradient the app
 * uses. Drawing it means it translates, it stays sharp on every display, and it
 * weighs nothing.
 */
export function AppPreview({
  title,
  members,
  balanceLabel,
  balance,
  rows,
  settle,
}: {
  title: string;
  members: string;
  balanceLabel: string;
  balance: string;
  rows: Row[];
  settle: string;
}) {
  return (
    <div className="relative mx-auto w-full max-w-[19.5rem]">
      {/* the light the device sits in */}
      <div
        aria-hidden="true"
        className="absolute -inset-10 -z-10 rounded-full bg-brand-500/25 blur-3xl"
      />

      <div className="animate-float rounded-[2.6rem] border border-white/15 bg-night-900/80 p-2.5 shadow-[0_60px_120px_-40px_rgb(0_0_0_/_0.9)] backdrop-blur-xl">
        <div className="relative overflow-hidden rounded-[2.1rem] bg-night-950">
          {/* status bar */}
          <div className="flex items-center justify-between px-5 pt-4 pb-2 text-[0.65rem] font-medium text-white/50">
            <span>9:41</span>
            <span className="h-5 w-20 rounded-full bg-black/60" />
            <span className="flex items-center gap-1">
              <span className="h-1.5 w-1.5 rounded-full bg-white/50" />
              <span className="h-1.5 w-1.5 rounded-full bg-white/50" />
              <span className="h-1.5 w-3 rounded-[2px] bg-white/50" />
            </span>
          </div>

          <div className="px-4 pb-5">
            <div className="flex items-center justify-between px-1 py-3">
              <div>
                <p className="text-sm font-semibold text-white">{title}</p>
                <p className="mt-0.5 flex items-center gap-1 text-[0.7rem] text-white/45">
                  <Users className="h-3 w-3" />
                  {members}
                </p>
              </div>
              <span className="flex h-8 w-8 items-center justify-center rounded-full bg-white/8 text-white/60">
                <Wallet className="h-4 w-4" />
              </span>
            </div>

            {/* the balance deck — the app's owed-to-you blue wash */}
            <div className="relative overflow-hidden rounded-3xl bg-[linear-gradient(135deg,#1D4ED8_0%,#2563EB_55%,#4F80F5_100%)] p-5">
              <div
                aria-hidden="true"
                className="absolute -top-16 -right-10 h-36 w-36 rounded-full bg-white/15 blur-2xl"
              />
              <p className="text-[0.7rem] tracking-wide text-white/70">{balanceLabel}</p>
              <p className="mt-1 text-3xl font-semibold tracking-[-0.03em] text-white">{balance}</p>
              <div className="mt-4 inline-flex items-center gap-1.5 rounded-full bg-black/25 px-3 py-1.5 text-[0.7rem] font-medium text-white">
                {settle}
                <ArrowRight className="h-3 w-3 rtl:-scale-x-100" />
              </div>
            </div>

            <ul className="mt-4 space-y-2">
              {rows.map((row) => (
                <li
                  key={row.title}
                  className="flex items-center justify-between gap-3 rounded-2xl border border-white/[0.06] bg-white/[0.035] px-3.5 py-3"
                >
                  <span className="min-w-0">
                    <span className="block truncate text-[0.8rem] font-medium text-white/90">
                      {row.title}
                    </span>
                    <span className="mt-0.5 block truncate text-[0.68rem] text-white/40">
                      {row.meta}
                    </span>
                  </span>
                  <span className="shrink-0 text-[0.8rem] font-semibold text-white">
                    {row.amount}
                  </span>
                </li>
              ))}
            </ul>

            <div className="mt-5 flex items-center justify-center gap-6 border-t border-white/[0.06] pt-4">
              <span className="h-1.5 w-8 rounded-full bg-white/25" />
              <span className="h-1.5 w-1.5 rounded-full bg-white/15" />
              <span className="h-1.5 w-1.5 rounded-full bg-white/15" />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
