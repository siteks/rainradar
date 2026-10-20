import type { FrameRef } from '../sources/metoffice';

export type ToWorker =
  /** Make sure these frames are available; the worker processes newest first and replaces any older queue. */
  { type: 'load'; frames: FrameRef[] };

export type FromWorker =
  | { type: 'frame'; time: number; data: Uint8Array }
  | { type: 'error'; time: number; message: string }
  | { type: 'idle' };
