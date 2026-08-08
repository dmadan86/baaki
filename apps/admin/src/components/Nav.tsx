import Link from 'next/link';

/** Three pages so far. A row of links is the right amount of navigation for that. */
export function Nav({ here }: { here: 'overview' | 'flags' | 'promotions' }) {
  return (
    <nav className="nav">
      <Link href="/" aria-current={here === 'overview' ? 'page' : undefined}>
        Overview
      </Link>
      <Link href="/flags" aria-current={here === 'flags' ? 'page' : undefined}>
        Experiments
      </Link>
      <Link href="/promotions" aria-current={here === 'promotions' ? 'page' : undefined}>
        Promotions
      </Link>
    </nav>
  );
}
