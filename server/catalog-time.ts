import { assert } from './errors.ts';
/** Resolve academy-local wall time; reject missing/repeated DST times unless explicitly chosen. */
export function catalogTime(
  value: string,
  zone: string,
  fold: 'reject' | 'earlier' | 'later' = 'reject',
) {
  if (/T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
    const calendar =
      /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.exec(
        value,
      );
    assert(calendar, 'Enter a valid ISO date and time');
    const [y, m, d, h, min, sec] = calendar.slice(1).map((v) => Number(v || 0));
    assert(
      y >= 2000 &&
        y <= 2100 &&
        m >= 1 &&
        m <= 12 &&
        d >= 1 &&
        h <= 23 &&
        min <= 59 &&
        sec <= 59 &&
        new Date(Date.UTC(y, m - 1, d)).getUTCDate() === d,
      'Enter a valid calendar date and time',
    );
    const date = new Date(value);
    assert(Number.isFinite(date.getTime()), 'Enter a valid date and time');
    return date;
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value);
  assert(match, 'Enter a date and time');
  const [year, month, day, hour, minute, second] = match.slice(1).map((v) => Number(v || 0));
  const naive = Date.UTC(year, month - 1, day, hour, minute, second);
  assert(
    year >= 2000 &&
      year <= 2100 &&
      month >= 1 &&
      month <= 12 &&
      day >= 1 &&
      hour <= 23 &&
      minute <= 59 &&
      second <= 59 &&
      new Date(naive).getUTCDate() === day,
    'Enter a valid calendar date and time',
  );
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  const parts = (date: Date) =>
    Object.fromEntries(
      fmt
        .formatToParts(date)
        .filter((p) => p.type !== 'literal')
        .map((p) => [p.type, Number(p.value)]),
    );
  const offsets = new Set<number>();
  for (const delta of [-172800000, -86400000, 0, 86400000, 172800000]) {
    const time = naive + delta,
      p = parts(new Date(time));
    offsets.add(Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - time);
  }
  const candidates = [...offsets]
    .map((offset) => new Date(naive - offset))
    .filter((date) => {
      const p = parts(date);
      return (
        p.year === year &&
        p.month === month &&
        p.day === day &&
        p.hour === hour &&
        p.minute === minute &&
        p.second === second
      );
    })
    .sort((a, b) => a.getTime() - b.getTime());
  assert(
    candidates.length > 0,
    `This time does not exist in ${zone} because the clocks change. Choose another time.`,
  );
  assert(
    candidates.length === 1 || fold !== 'reject',
    `This time occurs twice in ${zone}. Choose the earlier or later occurrence.`,
  );
  return fold === 'later' ? candidates.at(-1)! : candidates[0];
}

/** Advance by academy calendar days/hours so a multi-day run keeps its wall-clock schedule across DST. */
export function shiftCatalogTime(date: Date, zone: string, days: number, hours = 0) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(date)
      .filter((p) => p.type !== 'literal')
      .map((p) => [p.type, Number(p.value)]),
  );
  const wall = new Date(
    Date.UTC(p.year, p.month - 1, p.day + days, p.hour + hours, p.minute, p.second),
  );
  return catalogTime(wall.toISOString().slice(0, 19), zone);
}
