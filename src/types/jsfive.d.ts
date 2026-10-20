// Minimal typings for the parts of jsfive we use.
declare module 'jsfive' {
  export interface Node {
    attrs: Record<string, unknown>;
  }
  export interface Dataset extends Node {
    shape: number[];
    value: ArrayLike<number>;
  }
  export class File implements Node {
    constructor(buffer: ArrayBuffer, filename?: string);
    attrs: Record<string, unknown>;
    get(path: string): Dataset;
  }
}
