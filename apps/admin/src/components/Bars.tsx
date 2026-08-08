/**
 * A bar per day, scaled to the busiest one.
 *
 * Hand-drawn divs rather than a charting library, and the same reasoning as
 * amendment A8 gave for the app's own charts: a dependency that renders one
 * shape is a dependency that has to be upgraded forever. Days with nothing in
 * them keep a visible floor bar, so a gap reads as "zero" rather than as
 * "missing".
 */
export function Bars({
  rows,
  label,
}: {
  rows: readonly { day: string; value: number }[];
  label: string;
}) {
  const peak = Math.max(1, ...rows.map((row) => row.value));

  return (
    <div className="bars" role="img" aria-label={`${label}: ${describe(rows)}`}>
      {rows.map((row) => (
        <div
          key={row.day}
          className={row.value === 0 ? 'bar zero' : 'bar'}
          style={{ height: row.value === 0 ? 2 : `${Math.max(4, (row.value / peak) * 100)}%` }}
          title={`${row.day}: ${row.value}`}
        />
      ))}
    </div>
  );
}

/** A chart is an image to a screen reader; this is what it says. */
function describe(rows: readonly { day: string; value: number }[]): string {
  if (rows.length === 0) return 'no data';
  const total = rows.reduce((sum, row) => sum + row.value, 0);
  const peak = rows.reduce((best, row) => (row.value > best.value ? row : best), rows[0]!);
  return `${total} across ${rows.length} days, busiest ${peak.day} with ${peak.value}`;
}
