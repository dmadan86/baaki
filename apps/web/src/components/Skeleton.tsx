/**
 * The list's shape held open while its rows load — the same `.item` geometry
 * (lead badge, two stacked lines, a trailing amount) shimmering in place, so the
 * real rows drop in without the panel jumping. Purely decorative: hidden from
 * the accessibility tree, and the page's own loading string still carries the
 * meaning for a screen reader.
 */
export function SkeletonRows({
  rows = 4,
  amount = true,
  lead = true,
}: {
  rows?: number;
  /** Show the trailing money block (friends, settle). */
  amount?: boolean;
  /** Show the leading emoji/avatar badge. */
  lead?: boolean;
}) {
  return (
    <div className="list" aria-hidden>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="item" style={{ cursor: 'default' }}>
          {lead ? <span className="sk sk-emoji" /> : null}
          <span className="grow">
            <span className="sk sk-title" />
            <span className="sk sk-meta" />
          </span>
          {amount ? <span className="sk sk-amount" /> : null}
        </div>
      ))}
    </div>
  );
}
