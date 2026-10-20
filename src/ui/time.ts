const clockFmt = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London' });

/** Local UK clock time for a UTC epoch-seconds timestamp. */
export function formatClock(t: number): string {
  return clockFmt.format(new Date(t * 1000));
}

/** Offset from now for the top display: "Now", "−25 min", "+40 min", "+1 h 05". */
export function formatOffset(t: number, now: number): string {
  // Whole minutes, so the current minute's slot reads "Now" for the whole minute.
  const mins = Math.round(t / 60) - Math.floor(now / 60);
  if (mins === 0) return 'Now';
  const sign = mins < 0 ? '−' : '+';
  const abs = Math.abs(mins);
  return abs < 60 ? `${sign}${abs} min` : `${sign}${Math.floor(abs / 60)} h ${String(abs % 60).padStart(2, '0')}`;
}
