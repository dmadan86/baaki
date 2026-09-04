/**
 * A size a person reads, localised.
 *
 * Two screens now say how big something is — the storage meter and the backup's
 * "last backup" line — and a number formatted two ways in one app is the kind of
 * inconsistency nobody reports and everybody notices. Binary units (a KB is
 * 1024 bytes) because that is what both the storage cap and the file sizes are
 * counted in.
 */
export function formatBytes(bytes: number, locale: string): string {
  const number = (value: number, fractionDigits: number): string =>
    new Intl.NumberFormat(locale, { maximumFractionDigits: fractionDigits }).format(value);
  if (bytes > 0 && bytes < 1024 * 1024) return `${number(bytes / 1024, 0)} KB`;
  const mb = bytes / (1024 * 1024);
  return `${number(mb, mb < 10 ? 1 : 0)} MB`;
}
