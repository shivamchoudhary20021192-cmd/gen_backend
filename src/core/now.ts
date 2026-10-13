/**
 * A timestamp safe to write into a DATETIME(0) column.
 *
 * `new Date()` carries milliseconds. MySQL does not store them in a DATETIME
 * with no fractional precision — it **rounds**, so 19:08:10.700 lands as
 * 19:08:11, up to a second in the future. Anything read back through a
 * `published_at <= NOW()` gate then treats the row as not yet live.
 *
 * The visible symptom was small and bad: an editor pressed Publish, clicked
 * View, and got "page not found" for a second. Flooring to the second means a
 * row is never stored ahead of the clock that will be compared against it.
 */
export function nowForDb(date: Date = new Date()): Date {
  const floored = new Date(date.getTime());
  floored.setMilliseconds(0);
  return floored;
}
