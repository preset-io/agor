import { useLayoutEffect, useRef } from 'react';
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from 'remotion';

// agor.live's aurora (React Bits "Aurora", components/Aurora/Aurora.tsx on
// the site): the same fragment shader and color stops, driven by the frame
// instead of requestAnimationFrame so every render is identical. Drawn with
// plain WebGL2 into a canvas each frame.

const VERT = `#version 300 es
in vec2 position;
void main() {
  gl_Position = vec4(position, 0.0, 1.0);
}
`;

const FRAG = `#version 300 es
precision highp float;

uniform float uTime;
uniform float uAmplitude;
uniform vec3 uColorStops[3];
uniform vec2 uResolution;
uniform float uBlend;

out vec4 fragColor;

vec3 permute(vec3 x) {
  return mod(((x * 34.0) + 1.0) * x, 289.0);
}

float snoise(vec2 v){
  const vec4 C = vec4(
      0.211324865405187, 0.366025403784439,
      -0.577350269189626, 0.024390243902439
  );
  vec2 i  = floor(v + dot(v, C.yy));
  vec2 x0 = v - i + dot(i, C.xx);
  vec2 i1 = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
  vec4 x12 = x0.xyxy + C.xxzz;
  x12.xy -= i1;
  i = mod(i, 289.0);

  vec3 p = permute(
      permute(i.y + vec3(0.0, i1.y, 1.0))
    + i.x + vec3(0.0, i1.x, 1.0)
  );

  vec3 m = max(
      0.5 - vec3(
          dot(x0, x0),
          dot(x12.xy, x12.xy),
          dot(x12.zw, x12.zw)
      ), 
      0.0
  );
  m = m * m;
  m = m * m;

  vec3 x = 2.0 * fract(p * C.www) - 1.0;
  vec3 h = abs(x) - 0.5;
  vec3 ox = floor(x + 0.5);
  vec3 a0 = x - ox;
  m *= 1.79284291400159 - 0.85373472095314 * (a0*a0 + h*h);

  vec3 g;
  g.x  = a0.x  * x0.x  + h.x  * x0.y;
  g.yz = a0.yz * x12.xz + h.yz * x12.yw;
  return 130.0 * dot(m, g);
}

struct ColorStop {
  vec3 color;
  float position;
};

#define COLOR_RAMP(colors, factor, finalColor) {              \
  int index = 0;                                            \
  for (int i = 0; i < 2; i++) {                               \
     ColorStop currentColor = colors[i];                    \
     bool isInBetween = currentColor.position <= factor;    \
     index = int(mix(float(index), float(i), float(isInBetween))); \
  }                                                         \
  ColorStop currentColor = colors[index];                   \
  ColorStop nextColor = colors[index + 1];                  \
  float range = nextColor.position - currentColor.position; \
  float lerpFactor = (factor - currentColor.position) / range; \
  finalColor = mix(currentColor.color, nextColor.color, lerpFactor); \
}

void main() {
  vec2 uv = gl_FragCoord.xy / uResolution;
  
  ColorStop colors[3];
  colors[0] = ColorStop(uColorStops[0], 0.0);
  colors[1] = ColorStop(uColorStops[1], 0.5);
  colors[2] = ColorStop(uColorStops[2], 1.0);
  
  vec3 rampColor;
  COLOR_RAMP(colors, uv.x, rampColor);
  
  float height = snoise(vec2(uv.x * 2.0 + uTime * 0.1, uTime * 0.25)) * 0.5 * uAmplitude;
  height = exp(height);
  height = (uv.y * 2.0 - height + 0.2);
  float intensity = 0.6 * height;
  
  float midPoint = 0.20;
  float auroraAlpha = smoothstep(midPoint - uBlend * 0.5, midPoint + uBlend * 0.5, intensity);
  
  vec3 auroraColor = intensity * rampColor;
  
  fragColor = vec4(auroraColor * auroraAlpha, auroraAlpha);
}
`;

const hex = (h: string) => [1, 3, 5].map((i) => Number.parseInt(h.slice(i, i + 2), 16) / 255);

interface GL {
  gl: WebGL2RenderingContext;
  uniforms: Record<string, WebGLUniformLocation | null>;
}

export const Aurora: React.FC<{
  colorStops?: [string, string, string];
  amplitude?: number;
  blend?: number;
  speed?: number;
  /** Flip it to rise from the bottom edge instead of hanging from the top. */
  flip?: boolean;
  style?: React.CSSProperties;
}> = ({
  colorStops = ['#2e9a92', '#34e6c4', '#7ad9ff'],
  amplitude = 0.9,
  blend = 1,
  speed = 0.6,
  flip = false,
  style,
}) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const canvas = useRef<HTMLCanvasElement>(null);
  const ctx = useRef<GL | null>(null);

  useLayoutEffect(() => {
    const el = canvas.current;
    if (!el) return;
    if (!ctx.current) {
      const gl = el.getContext('webgl2', { premultipliedAlpha: true, preserveDrawingBuffer: true });
      if (!gl) return;
      const shader = (type: number, source: string) => {
        const s = gl.createShader(type) as WebGLShader;
        gl.shaderSource(s, source);
        gl.compileShader(s);
        return s;
      };
      const program = gl.createProgram() as WebGLProgram;
      gl.attachShader(program, shader(gl.VERTEX_SHADER, VERT));
      gl.attachShader(program, shader(gl.FRAGMENT_SHADER, FRAG));
      gl.linkProgram(program);
      // biome-ignore lint/correctness/useHookAtTopLevel: WebGL's useProgram, not a React hook
      gl.useProgram(program);
      // One big triangle covering the viewport (ogl's Triangle).
      const buffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
      const loc = gl.getAttribLocation(program, 'position');
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      const uniforms = Object.fromEntries(
        ['uTime', 'uAmplitude', 'uColorStops', 'uResolution', 'uBlend'].map((n) => [
          n,
          gl.getUniformLocation(program, n),
        ])
      );
      ctx.current = { gl, uniforms };
    }
    const { gl, uniforms } = ctx.current;
    gl.viewport(0, 0, el.width, el.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    // The site: uTime = elapsed ms * 0.001 * speed.
    gl.uniform1f(uniforms.uTime, (frame / fps) * speed);
    gl.uniform1f(uniforms.uAmplitude, amplitude);
    gl.uniform1f(uniforms.uBlend, blend);
    gl.uniform2f(uniforms.uResolution, el.width, el.height);
    gl.uniform3fv(uniforms.uColorStops, colorStops.flatMap(hex));
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }, [frame, fps, amplitude, blend, speed, colorStops]);

  return (
    <AbsoluteFill style={{ transform: flip ? 'scaleY(-1)' : undefined, ...style }}>
      <canvas
        ref={canvas}
        width={width}
        height={height}
        style={{ width: '100%', height: '100%' }}
      />
    </AbsoluteFill>
  );
};
