import type { CustomLayerInterface, CustomRenderMethodInput, Map as MLMap } from 'maplibre-gl';
import { FORECAST_REF_SECONDS } from '../radar/forecast';
import { GRID, type MercatorGrid } from '../radar/grid';
import { PALETTE } from '../radar/palette';
import { pairKey, type FramePick } from '../radar/timeline';
import type { MotionField } from '../worker/motion';

// Draws the radar for any moment, on the GPU, every time the map renders. Observed frames are R8
// textures of quantised rain (palette.ts encoding), motion fields are small RG16F textures, and the
// fragment shader samples frame A back along the motion and frame B forward along it, blends them
// in log-rain space and colours the result. So time is continuous: nothing is precomputed per minute.
// Past the latest frame it extrapolates instead: each pixel is traced back through the (frozen)
// forecast motion field in short semi-Lagrangian steps, and the latest frame is sampled there.

const VERTEX = `#version 300 es
uniform mat4 uMatrix;
uniform vec4 uBounds; // grid corners in Web Mercator 0..1: x0, y0 (top-left), x1, y1 (bottom-right)
uniform vec2 uGrid;   // grid size in pixels
in vec2 aCorner;
out vec2 vPix;        // position in grid pixels, (0,0) = top-left corner
void main() {
  gl_Position = uMatrix * vec4(mix(uBounds.xy, uBounds.zw, aCorner), 0.0, 1.0);
  vPix = aCorner * uGrid;
}`;

const FRAGMENT = `#version 300 es
precision highp float;
uniform sampler2D uA;       // R8: q / 255
uniform sampler2D uB;
uniform sampler2D uField;   // RG16F: displacement A→B in grid pixels, one texel per node
uniform sampler2D uPalette; // 256×1 RGBA, straight alpha
uniform vec2 uGrid;
uniform vec2 uFieldScale;   // grid px → field texture coords
uniform float uAlpha;
uniform float uOpacity;
uniform int uSteps;         // > 0: extrapolate A along uField in this many steps
uniform float uStepScale;   // fraction of uField's displacement per step
in vec2 vPix;
out vec4 outColor;

// Bilinear q at a grid position, ignoring no-data texels. Returns (q, fraction of weight with data).
vec2 sampleQ(sampler2D tex, vec2 p) {
  vec2 f = p - 0.5;
  vec2 base = floor(f);
  vec2 t = f - base;
  float q = 0.0;
  float w = 0.0;
  for (int k = 0; k < 4; k++) {
    vec2 o = vec2(float(k & 1), float(k >> 1));
    vec2 c = base + o;
    float wt = (o.x > 0.5 ? t.x : 1.0 - t.x) * (o.y > 0.5 ? t.y : 1.0 - t.y);
    if (c.x < 0.0 || c.y < 0.0 || c.x >= uGrid.x || c.y >= uGrid.y) continue;
    float v = texelFetch(tex, ivec2(c), 0).r * 255.0;
    if (v > 0.5) { q += v * wt; w += wt; }
  }
  return vec2(w > 0.0 ? q / w : 0.0, w);
}

vec4 colour(float q) {
  return q < 1.5 ? vec4(0.0) : texture(uPalette, vec2((q + 0.5) / 256.0, 0.5));
}

void main() {
  vec4 c;
  vec4 noData = texelFetch(uPalette, ivec2(0, 0), 0);
  if (uSteps > 0) {
    // Backward trajectory: where did the rain now at this pixel come from?
    vec2 p = vPix;
    for (int i = 0; i < 64; i++) {
      if (i >= uSteps) break;
      p -= uStepScale * texture(uField, p * uFieldScale).rg;
    }
    vec2 a = sampleQ(uA, p);
    c = a.y >= 0.5 ? colour(a.x) : noData; // rain arriving from outside coverage is unknown
  } else {
    vec2 d = texture(uField, vPix * uFieldScale).rg;
    vec2 a = sampleQ(uA, vPix - uAlpha * d);
    vec2 b = sampleQ(uB, vPix + (1.0 - uAlpha) * d);
    // Where one side has no data, use the other (as morph() does on the CPU).
    float wa = a.y >= 0.5 ? max(1.0 - uAlpha, 1e-3) : 0.0;
    float wb = b.y >= 0.5 ? max(uAlpha, 1e-3) : 0.0;
    c = wa + wb == 0.0 ? noData : colour((a.x * wa + b.x * wb) / (wa + wb));
  }
  float alpha = c.a * uOpacity;
  outColor = vec4(c.rgb * alpha, alpha); // MapLibre blends premultiplied
}`;

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const s = gl.createShader(type)!;
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(`Radar shader: ${gl.getShaderInfoLog(s)}`);
  return s;
}

const MERC_HALF = Math.PI * 6378137;
const FORECAST_KEY = 'forecast';
const FORECAST_STEP_SECONDS = 300; // semi-Lagrangian step length
const mercUnit = (x: number, y: number): [number, number] => [(x + MERC_HALF) / (2 * MERC_HALF), (MERC_HALF - y) / (2 * MERC_HALF)];

/**
 * Palette as straight-alpha RGBA bytes. Transparent rain entries borrow the colour of the first
 * visible one, so linear filtering at the threshold fades in that colour rather than through black.
 */
function paletteBytes(): Uint8Array {
  const bytes = new Uint8Array(PALETTE.buffer.slice(0));
  const firstVisible = [...PALETTE.keys()].find((q) => q >= 2 && PALETTE[q] >>> 24 > 0);
  if (firstVisible !== undefined) {
    for (let q = 2; q < firstVisible; q++) bytes.set(bytes.subarray(4 * firstVisible, 4 * firstVisible + 3), 4 * q);
  }
  return bytes;
}

type Upload = { kind: 'frame'; time: number } | { kind: 'field'; key: string };

export class RadarLayer implements CustomLayerInterface {
  readonly id = 'radar';
  readonly type = 'custom' as const;
  readonly renderingMode = '2d' as const;

  private map: MLMap | null = null;
  private gl: WebGL2RenderingContext | null = null;
  private program: WebGLProgram | null = null;
  private vao: WebGLVertexArrayObject | null = null;
  private uniforms: Record<string, WebGLUniformLocation | null> = {};
  private paletteTex: WebGLTexture | null = null;
  private zeroField: WebGLTexture | null = null;

  // CPU copies are kept so textures can be rebuilt if the GL context is recreated.
  private readonly frames = new Map<number, Uint8Array>();
  private readonly fields = new Map<string, MotionField>();
  private readonly frameTex = new Map<number, WebGLTexture>();
  private readonly fieldTex = new Map<string, WebGLTexture>();
  private pending: Upload[] = [];
  private pick: FramePick | null = null;

  constructor(
    private readonly grid: MercatorGrid = GRID,
    private readonly opacity = 0.85,
  ) {}

  setFrame(time: number, data: Uint8Array): void {
    this.frames.set(time, data);
    this.pending.push({ kind: 'frame', time });
  }

  setField(t0: number, t1: number, field: MotionField): void {
    const key = pairKey(t0, t1);
    this.fields.set(key, field);
    this.pending.push({ kind: 'field', key });
  }

  /** The frozen motion (displacement per FORECAST_REF_SECONDS) used to extrapolate the latest frame. */
  setForecastField(field: MotionField | null): void {
    if (field) {
      this.fields.set(FORECAST_KEY, field);
      this.pending.push({ kind: 'field', key: FORECAST_KEY });
    } else this.fields.delete(FORECAST_KEY);
  }

  /** Drop frames and pair fields not listed (GPU textures are freed on the next render). */
  retain(times: Set<number>, keys: { has(key: string): boolean }): void {
    for (const t of this.frames.keys()) if (!times.has(t)) this.frames.delete(t);
    for (const k of this.fields.keys()) if (k !== FORECAST_KEY && !keys.has(k)) this.fields.delete(k);
  }

  show(pick: FramePick | null): void {
    this.pick = pick;
    this.map?.triggerRepaint();
  }

  onAdd(map: MLMap, gl: WebGLRenderingContext | WebGL2RenderingContext): void {
    this.map = map;
    const g = gl as WebGL2RenderingContext;
    this.gl = g;

    const program = g.createProgram()!;
    g.attachShader(program, compile(g, g.VERTEX_SHADER, VERTEX));
    g.attachShader(program, compile(g, g.FRAGMENT_SHADER, FRAGMENT));
    g.linkProgram(program);
    if (!g.getProgramParameter(program, g.LINK_STATUS)) throw new Error(`Radar program: ${g.getProgramInfoLog(program)}`);
    this.program = program;
    for (const name of ['uMatrix', 'uBounds', 'uGrid', 'uA', 'uB', 'uField', 'uPalette', 'uFieldScale', 'uAlpha', 'uOpacity', 'uSteps', 'uStepScale']) {
      this.uniforms[name] = g.getUniformLocation(program, name);
    }

    this.vao = g.createVertexArray();
    g.bindVertexArray(this.vao);
    const buf = g.createBuffer();
    g.bindBuffer(g.ARRAY_BUFFER, buf);
    g.bufferData(g.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), g.STATIC_DRAW);
    const loc = g.getAttribLocation(program, 'aCorner');
    g.enableVertexAttribArray(loc);
    g.vertexAttribPointer(loc, 2, g.FLOAT, false, 0, 0);
    g.bindVertexArray(null);

    // Everything is (re)uploaded on the next render, inside MapLibre's frame.
    this.frameTex.clear();
    this.fieldTex.clear();
    this.paletteTex = null;
    this.zeroField = null;
    this.pending = [
      ...[...this.frames.keys()].map((time) => ({ kind: 'frame' as const, time })),
      ...[...this.fields.keys()].map((key) => ({ kind: 'field' as const, key })),
    ];
  }

  onRemove(): void {
    const g = this.gl;
    if (!g) return;
    for (const t of [...this.frameTex.values(), ...this.fieldTex.values()]) g.deleteTexture(t);
    if (this.paletteTex) g.deleteTexture(this.paletteTex);
    if (this.zeroField) g.deleteTexture(this.zeroField);
    if (this.program) g.deleteProgram(this.program);
    if (this.vao) g.deleteVertexArray(this.vao);
    this.frameTex.clear();
    this.fieldTex.clear();
    this.map = null;
    this.gl = null;
  }

  private texture(g: WebGL2RenderingContext, filter: number): WebGLTexture {
    const t = g.createTexture()!;
    g.bindTexture(g.TEXTURE_2D, t);
    g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MIN_FILTER, filter);
    g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MAG_FILTER, filter);
    g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_S, g.CLAMP_TO_EDGE);
    g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_T, g.CLAMP_TO_EDGE);
    return t;
  }

  /** Apply queued uploads and deletions. Runs inside render() so MapLibre resyncs its GL state after. */
  private sync(g: WebGL2RenderingContext): void {
    // MapLibre leaves unpack state set for its own images; uploads here need plain, tightly packed data.
    const prevAlign = g.getParameter(g.UNPACK_ALIGNMENT) as number;
    const prevFlip = g.getParameter(g.UNPACK_FLIP_Y_WEBGL) as boolean;
    const prevPremul = g.getParameter(g.UNPACK_PREMULTIPLY_ALPHA_WEBGL) as boolean;
    g.pixelStorei(g.UNPACK_ALIGNMENT, 1);
    g.pixelStorei(g.UNPACK_FLIP_Y_WEBGL, false);
    g.pixelStorei(g.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);

    if (!this.paletteTex) {
      this.paletteTex = this.texture(g, g.LINEAR);
      g.texImage2D(g.TEXTURE_2D, 0, g.RGBA8, 256, 1, 0, g.RGBA, g.UNSIGNED_BYTE, paletteBytes());
    }
    if (!this.zeroField) {
      this.zeroField = this.texture(g, g.NEAREST);
      g.texImage2D(g.TEXTURE_2D, 0, g.RG16F, 1, 1, 0, g.RG, g.FLOAT, new Float32Array(2));
    }

    for (const up of this.pending) {
      if (up.kind === 'frame') {
        const data = this.frames.get(up.time);
        if (!data) continue;
        let tex = this.frameTex.get(up.time);
        if (!tex) this.frameTex.set(up.time, (tex = this.texture(g, g.NEAREST)));
        else g.bindTexture(g.TEXTURE_2D, tex);
        g.texImage2D(g.TEXTURE_2D, 0, g.R8, this.grid.width, this.grid.height, 0, g.RED, g.UNSIGNED_BYTE, data);
      } else {
        const f = this.fields.get(up.key);
        if (!f) continue;
        const rg = new Float32Array(f.cols * f.rows * 2);
        for (let k = 0; k < f.u.length; k++) {
          rg[2 * k] = f.u[k];
          rg[2 * k + 1] = f.v[k];
        }
        let tex = this.fieldTex.get(up.key);
        if (!tex) this.fieldTex.set(up.key, (tex = this.texture(g, g.LINEAR)));
        else g.bindTexture(g.TEXTURE_2D, tex);
        g.texImage2D(g.TEXTURE_2D, 0, g.RG16F, f.cols, f.rows, 0, g.RG, g.FLOAT, rg);
      }
    }
    this.pending = [];

    for (const [t, tex] of this.frameTex) if (!this.frames.has(t)) (g.deleteTexture(tex), this.frameTex.delete(t));
    for (const [k, tex] of this.fieldTex) if (!this.fields.has(k)) (g.deleteTexture(tex), this.fieldTex.delete(k));

    g.pixelStorei(g.UNPACK_ALIGNMENT, prevAlign);
    g.pixelStorei(g.UNPACK_FLIP_Y_WEBGL, prevFlip);
    g.pixelStorei(g.UNPACK_PREMULTIPLY_ALPHA_WEBGL, prevPremul);
  }

  render(gl: WebGLRenderingContext | WebGL2RenderingContext, options: CustomRenderMethodInput): void {
    const g = gl as WebGL2RenderingContext;
    if (!this.program) return;
    this.sync(g);

    const pick = this.pick;
    const texA = pick && this.frameTex.get(pick.a);
    const texB = pick && this.frameTex.get(pick.b);
    if (!pick || !texA || !texB) return;
    // Forecast: extrapolate frame A along the forecast field. Otherwise blend A→B along the pair field.
    const forecast = pick.lead > 0 && this.fieldTex.has(FORECAST_KEY) ? this.fields.get(FORECAST_KEY) : undefined;
    const fieldKey = forecast ? FORECAST_KEY : pairKey(pick.a, pick.b);
    const field = forecast ?? (pick.alpha > 0 ? this.fields.get(fieldKey) : undefined);
    const fieldTex = (field && this.fieldTex.get(fieldKey)) || this.zeroField;
    const steps = forecast ? Math.min(64, Math.max(1, Math.ceil(pick.lead / FORECAST_STEP_SECONDS))) : 0;

    const gr = this.grid;
    const [x0, y0] = mercUnit(gr.x0, gr.y0);
    const [x1, y1] = mercUnit(gr.x0 + gr.width * gr.res, gr.y0 - gr.height * gr.res);
    const u = this.uniforms;

    g.useProgram(this.program);
    // Maps Web Mercator 0..1 to clip space (sufficient for a mercator-only layer, per MapLibre docs).
    g.uniformMatrix4fv(u.uMatrix, false, new Float32Array(options.defaultProjectionData.mainMatrix));
    g.uniform4f(u.uBounds, x0, y0, x1, y1);
    g.uniform2f(u.uGrid, gr.width, gr.height);
    g.uniform2f(u.uFieldScale, field ? 1 / (field.step * field.cols) : 0, field ? 1 / (field.step * field.rows) : 0);
    g.uniform1f(u.uAlpha, field && !forecast ? pick.alpha : 0);
    g.uniform1i(u.uSteps, steps);
    g.uniform1f(u.uStepScale, steps ? pick.lead / FORECAST_REF_SECONDS / steps : 0);
    g.uniform1f(u.uOpacity, this.opacity);

    const bind = (unit: number, tex: WebGLTexture, name: string): void => {
      g.activeTexture(g.TEXTURE0 + unit);
      g.bindTexture(g.TEXTURE_2D, tex);
      g.uniform1i(u[name], unit);
    };
    bind(0, texA, 'uA');
    bind(1, field && !forecast ? texB : texA, 'uB');
    bind(2, fieldTex!, 'uField');
    bind(3, this.paletteTex!, 'uPalette');

    g.disable(g.DEPTH_TEST);
    g.disable(g.STENCIL_TEST);
    g.enable(g.BLEND);
    g.blendFunc(g.ONE, g.ONE_MINUS_SRC_ALPHA);
    g.bindVertexArray(this.vao);
    g.drawArrays(g.TRIANGLE_STRIP, 0, 4);
    g.bindVertexArray(null);
  }
}
