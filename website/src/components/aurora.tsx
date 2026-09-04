/**
 * The canvas: two slow indigo lights and one warm coral one, blurred past the
 * point of being shapes. It sits behind everything and never scrolls with the
 * content, so the page feels lit rather than decorated.
 */
export function Aurora() {
  return (
    <div aria-hidden="true" className="pointer-events-none fixed inset-0 -z-10 overflow-hidden">
      <div className="absolute inset-0 bg-night-950" />
      {/* The layer is fixed, so these are placed in viewport terms rather than
          page terms — a blob parked a hundred rem down the document would be
          off-screen forever and the middle of the page would go flat black. */}
      <div className="animate-drift absolute -top-[22rem] left-1/2 h-[46rem] w-[46rem] -translate-x-1/2 rounded-full bg-brand-600/35 blur-[130px]" />
      <div className="animate-drift absolute top-[28%] -left-56 h-[38rem] w-[38rem] rounded-full bg-brand-800/45 blur-[150px] [animation-delay:-8s]" />
      <div className="animate-drift absolute -right-56 bottom-[6%] h-[34rem] w-[34rem] rounded-full bg-accent-600/22 blur-[150px] [animation-delay:-16s]" />
      <div className="animate-drift absolute -bottom-[18rem] left-1/3 h-[30rem] w-[30rem] rounded-full bg-brand-700/30 blur-[140px] [animation-delay:-12s]" />
      <div
        className="absolute inset-0 opacity-[0.35]"
        style={{
          backgroundImage:
            'linear-gradient(to right, rgb(255 255 255 / 0.045) 1px, transparent 1px), linear-gradient(to bottom, rgb(255 255 255 / 0.045) 1px, transparent 1px)',
          backgroundSize: '72px 72px',
          maskImage: 'radial-gradient(ellipse 90% 55% at 50% 0%, #000 35%, transparent 100%)',
          WebkitMaskImage: 'radial-gradient(ellipse 90% 55% at 50% 0%, #000 35%, transparent 100%)',
        }}
      />
    </div>
  );
}
