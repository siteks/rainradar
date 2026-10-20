import type { FrameRef } from '../sources/metoffice';

/** Observed radar, or motion-compensated in-between frames (later: forecast). */
export type FrameKind = 'observed' | 'interpolated';

export type ToWorker =
  /** The observed frames currently in the window. The worker loads missing ones newest first, drops
   *  ones no longer listed, then fills 5-min in-between frames. */
  { type: 'load'; frames: FrameRef[] };

export type FromWorker =
  | { type: 'frame'; time: number; kind: FrameKind; data: Uint8Array }
  | { type: 'error'; time: number; message: string }
  /** All listed observed frames have been attempted (in-between frames may still follow). */
  | { type: 'idle' };
