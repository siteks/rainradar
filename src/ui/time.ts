const clockFmt = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London' });

/** Local UK clock time for a UTC epoch-seconds timestamp. */
export function formatClock(t: number): string {
  return clockFmt.format(new Date(t * 1000));
}

/** "now", "25 min ago", "1 h 10 min ago", "in 40 min". */
export function formatRelative(t: number, now: number): string {
  const mins = Math.round((t - now) / 60);
  if (Math.abs(mins) < 3) return 'now';
  const abs = Math.abs(mins);
  const span = abs < 60 ? `${abs} min` : `${Math.floor(abs / 60)} h${abs % 60 ? ` ${abs % 60} min` : ''}`;
  return mins < 0 ? `${span} ago` : `in ${span}`;
}
