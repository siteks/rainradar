// Met Office UK 1 km radar composite (rain rate, mm/h) on AWS open data.
// CC BY-SA 4.0, © Crown copyright Met Office. New frame every 15 min, ~5 min after validity time.

export const BUCKET = 'https://met-office-radar-obs-data.s3.eu-west-2.amazonaws.com';

export interface FrameRef {
  /** Validity time, UTC epoch seconds. */
  time: number;
  url: string;
}

const pad = (n: number): string => String(n).padStart(2, '0');

export function dayPrefix(d: Date): string {
  return `radar/${d.getUTCFullYear()}/${pad(d.getUTCMonth() + 1)}/${pad(d.getUTCDate())}/`;
}

export function listUrl(prefix: string): string {
  return `${BUCKET}/?list-type=2&prefix=${encodeURIComponent(prefix)}`;
}

/** Extract composite keys from an S3 ListObjectsV2 XML response (regex: DOMParser isn't available in workers). */
export function parseKeys(xml: string): string[] {
  return [...xml.matchAll(/<Key>([^<]+_composite_1km_UK\.h5)<\/Key>/g)].map((m) => m[1]);
}

/** Validity time from a key like radar/2026/10/20/202610200845_ODIM_ng_radar_rainrate_composite_1km_UK.h5 */
export function keyTime(key: string): number | null {
  const m = /\/(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})_ODIM/.exec(key);
  if (!m) return null;
  const [y, mo, d, h, mi] = m.slice(1).map(Number);
  return Date.UTC(y, mo - 1, d, h, mi) / 1000;
}

/** Frames with validity time in [now - windowSeconds, now], oldest first. */
export async function listRecentFrames(now: Date, windowSeconds: number, fetchFn: typeof fetch = fetch): Promise<FrameRef[]> {
  const since = now.getTime() / 1000 - windowSeconds;
  const days = [dayPrefix(now)];
  const start = new Date(since * 1000);
  if (dayPrefix(start) !== days[0]) days.unshift(dayPrefix(start));

  const frames: FrameRef[] = [];
  for (const prefix of days) {
    const res = await fetchFn(listUrl(prefix));
    if (!res.ok) throw new Error(`Radar index request failed (${res.status})`);
    for (const key of parseKeys(await res.text())) {
      const time = keyTime(key);
      if (time !== null && time >= since) frames.push({ time, url: `${BUCKET}/${key}` });
    }
  }
  return frames.sort((a, b) => a.time - b.time);
}
