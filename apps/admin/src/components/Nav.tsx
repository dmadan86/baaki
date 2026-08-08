import Link from 'next/link';

/** Five pages so far. A row of links is the right amount of navigation for that. */
export function Nav({
  here,
}: {
  here: 'overview' | 'flags' | 'promotions' | 'campaigns' | 'feedback';
}) {
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
      <Link href="/campaigns" aria-current={here === 'campaigns' ? 'page' : undefined}>
        Campaigns
      </Link>
      <Link href="/feedback" aria-current={here === 'feedback' ? 'page' : undefined}>
        Feedback
      </Link>
    </nav>
  );
}
