import { describe, expect, it } from 'vitest';
import { BUCKET, dayPrefix, keyTime, listRecentFrames, parseKeys } from '../src/sources/metoffice';

const key = (stamp: string): string =>
  `radar/${stamp.slice(0, 4)}/${stamp.slice(4, 6)}/${stamp.slice(6, 8)}/${stamp}_ODIM_ng_radar_rainrate_composite_1km_UK.h5`;

const listing = (keys: string[]): string =>
  `<?xml version="1.0"?><ListBucketResult>${keys.map((k) => `<Contents><Key>${k}</Key><Size>1</Size></Contents>`).join('')}</ListBucketResult>`;

describe('metoffice source', () => {
  it('builds UTC day prefixes', () => {
    expect(dayPrefix(new Date(Date.UTC(2026, 0, 5, 23, 59)))).toBe('radar/2026/01/05/');
  });

  it('parses keys and their validity times', () => {
    const k = key('202610200845');
    expect(parseKeys(listing([k, 'radar/other.txt']))).toEqual([k]);
    expect(keyTime(k)).toBe(Date.UTC(2026, 9, 20, 8, 45) / 1000);
    expect(keyTime('nope')).toBeNull();
  });

  it('lists across midnight UTC and filters to the window', async () => {
    const byPrefix: Record<string, string[]> = {
      'radar/2026/10/19/': [key('202610192200'), key('202610192330'), key('202610192345')],
      'radar/2026/10/20/': [key('202610200000'), key('202610200015')],
    };
    const fakeFetch = (async (url: string) => {
      const prefix = decodeURIComponent(new URL(url).searchParams.get('prefix')!);
      return new Response(listing(byPrefix[prefix] ?? []));
    }) as typeof fetch;

    const frames = await listRecentFrames(new Date(Date.UTC(2026, 9, 20, 0, 20)), 3600, fakeFetch);
    expect(frames.map((f) => f.url.slice(BUCKET.length + 1))).toEqual([
      key('202610192330'),
      key('202610192345'),
      key('202610200000'),
      key('202610200015'),
    ]);
  });
});
