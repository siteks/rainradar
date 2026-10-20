import type { FrameRef } from '../sources/metoffice';
import type { MotionField } from './motion';

export type ToWorker =
  /** The observed frames currently in the window. The worker loads missing ones newest first, drops
   *  ones no longer listed, then estimates motion between consecutive frames. */
  { type: 'load'; frames: FrameRef[] };

export type FromWorker =
  | { type: 'frame'; time: number; data: Uint8Array }
  /** Motion from observed frame t0 to t1; in-between moments are drawn on the GPU from these. */
  | { type: 'motion'; t0: number; t1: number; field: MotionField }
  | { type: 'error'; time: number; message: string }
  /** All listed observed frames have been attempted (motion fields may still follow). */
  | { type: 'idle' };
