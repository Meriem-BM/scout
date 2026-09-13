"use client";

import { useEffect, useRef } from "react";

const VERTEX_SHADER = `attribute vec2 a_position;

void main() {
  gl_Position = vec4(a_position, 0.0, 1.0);
}`;

const FRAGMENT_SHADER = `#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif

uniform vec3 u_colors[8];
uniform vec4 u_scene;
uniform vec4 u_shape;
uniform vec4 u_surface;
uniform vec4 u_finish;
uniform vec4 u_transform;
uniform vec4 u_space;
uniform vec4 u_cursor;

#define u_resolution u_scene.xy
#define u_time u_scene.z
#define u_colorCount u_scene.w
#define u_scale u_shape.x
#define u_intensity u_shape.y
#define u_warp u_shape.w
#define u_detail u_surface.x
#define u_contrast u_surface.y
#define u_brightness u_surface.z
#define u_saturation u_surface.w
#define u_hue u_finish.x
#define u_vignette u_finish.y
#define u_blur u_finish.z
#define u_grain u_finish.w
#ifdef GL_FRAGMENT_PRECISION_HIGH
#define u_seed u_transform.x
#else
#define u_seed mod(u_transform.x, 31.0)
#endif
#define u_rotate u_transform.y
#define u_drift u_transform.z
#define u_oklab u_transform.w
#define u_offset u_space.xy
#define u_mouse u_space.zw
#define u_cursorPresence u_cursor.x
#define u_cursorEffect u_cursor.y
#define u_cursorStrength u_cursor.z
#define u_cursorRadius u_cursor.w

float hash21(vec2 p) {
#ifndef GL_FRAGMENT_PRECISION_HIGH
  p = mod(p, 31.0);
#endif
  p = fract(p * vec2(234.34, 435.345));
  p += dot(p, p + 34.23);
  return fract(p.x * p.y);
}

float grainHash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p.y) * p3.z);
}

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(hash21(i), hash21(i + vec2(1.0, 0.0)), u.x),
    mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0, 1.0)), u.x),
    u.y
  );
}

float fbm(vec2 p) {
  float value = 0.0;
  float amplitude = 0.5;
  for (int i = 0; i < 5; i++) {
    value += amplitude * noise(p);
    p = p * 2.03 + vec2(17.0, 9.2);
    amplitude *= 0.5;
  }
  return value;
}

vec3 srgbToLinear(vec3 color) {
  return mix(
    color / 12.92,
    pow((color + 0.055) / 1.055, vec3(2.4)),
    step(0.04045, color)
  );
}

vec3 linearToSrgb(vec3 color) {
  return mix(
    color * 12.92,
    1.055 * pow(max(color, vec3(0.0)), vec3(1.0 / 2.4)) - 0.055,
    step(0.0031308, color)
  );
}

vec3 linearToOklab(vec3 color) {
  float l = 0.4122214708 * color.r + 0.5363325363 * color.g + 0.0514459929 * color.b;
  float m = 0.2119034982 * color.r + 0.6806995451 * color.g + 0.1073969566 * color.b;
  float s = 0.0883024619 * color.r + 0.2817188376 * color.g + 0.6299787005 * color.b;
  l = pow(max(l, 0.0), 1.0 / 3.0);
  m = pow(max(m, 0.0), 1.0 / 3.0);
  s = pow(max(s, 0.0), 1.0 / 3.0);
  return vec3(
    0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s
  );
}

vec3 oklabToLinear(vec3 color) {
  float l = color.x + 0.3963377774 * color.y + 0.2158037573 * color.z;
  float m = color.x - 0.1055613458 * color.y - 0.0638541728 * color.z;
  float s = color.x - 0.0894841775 * color.y - 1.2914855480 * color.z;
  l = l * l * l;
  m = m * m * m;
  s = s * s * s;
  return vec3(
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s
  );
}

vec3 mixColor(vec3 a, vec3 b, float amount) {
  if (u_oklab > 0.5) {
    vec3 labA = linearToOklab(srgbToLinear(a));
    vec3 labB = linearToOklab(srgbToLinear(b));
    return clamp(
      linearToSrgb(oklabToLinear(mix(labA, labB, amount))),
      0.0,
      1.0
    );
  }
  return mix(a, b, amount);
}

vec3 palette(float x) {
  float count = max(u_colorCount - 1.0, 1.0);
  float position = clamp(x, 0.0, 1.0) * count;
  vec3 color = u_colors[0];
  for (int i = 0; i < 7; i++) {
    if (float(i) < count) {
      color = mixColor(
        color,
        u_colors[i + 1],
        smoothstep(0.0, 1.0, clamp(position - float(i), 0.0, 1.0))
      );
    }
  }
  return color;
}

vec3 rotateHue(vec3 color, float angle) {
  const mat3 toYiq = mat3(
    0.299, 0.596, 0.211,
    0.587, -0.274, -0.523,
    0.114, -0.322, 0.312
  );
  const mat3 toRgb = mat3(
    1.0, 1.0, 1.0,
    0.956, -0.272, -1.106,
    0.621, -0.647, 1.703
  );
  vec3 yiq = toYiq * color;
  float cosine = cos(angle);
  float sine = sin(angle);
  yiq = vec3(
    yiq.x,
    yiq.y * cosine - yiq.z * sine,
    yiq.y * sine + yiq.z * cosine
  );
  return toRgb * yiq;
}

vec3 shade(vec2 position, float time) {
  float angle = fbm(position * 2.0 + u_seed) * 6.2831;
  vec2 direction = vec2(cos(angle), sin(angle));
  float value = fbm(
    position * 3.0 + direction * (u_intensity * 2.0) + time * 0.12
  );
  return palette(value);
}

void main() {
  vec2 screenUv = gl_FragCoord.xy / u_resolution.xy;
  vec2 position = (gl_FragCoord.xy - 0.5 * u_resolution.xy)
    / min(u_resolution.x, u_resolution.y);
  float cursorMask = 0.0;

  if (u_cursorPresence > 0.001) {
    vec2 cursor = (0.5 * u_mouse * u_resolution.xy)
      / min(u_resolution.x, u_resolution.y);
    vec2 delta = position - cursor;
    if (u_cursorEffect < 0.5) {
      position += cursor * u_cursorPresence * u_cursorStrength * 0.55;
    } else {
      float distanceFromCursor = length(delta);
      vec2 direction = delta / max(distanceFromCursor, 0.0001);
      cursorMask = u_cursorPresence
        * (1.0 - smoothstep(0.0, u_cursorRadius, distanceFromCursor));
      if (u_cursorEffect < 1.5) {
        position -= direction * cursorMask * u_cursorStrength * 0.24;
      } else if (u_cursorEffect < 2.5) {
        float angle = cursorMask * u_cursorStrength * 2.2;
        float cosine = cos(angle);
        float sine = sin(angle);
        position = cursor + mat2(cosine, -sine, sine, cosine) * delta;
      } else if (u_cursorEffect < 3.5) {
        float ripple = sin(
          distanceFromCursor / max(u_cursorRadius, 0.001) * 18.0 - u_time * 5.0
        );
        position -= direction * ripple * cursorMask * u_cursorStrength * 0.07;
      }
    }
  }

  position *= u_scale;
  if (abs(u_rotate) > 0.0001) {
    float cosine = cos(u_rotate);
    float sine = sin(u_rotate);
    position = mat2(cosine, -sine, sine, cosine) * position;
  }
  position += u_offset;
  if (u_drift > 0.0001) {
    position += u_drift * vec2(sin(u_time * 0.31), cos(u_time * 0.23));
  }
  if (u_warp > 0.0) {
    position += u_warp * (
      vec2(
        fbm(position * u_detail + u_seed),
        fbm(position * u_detail + vec2(5.2, 1.3))
      ) - 0.5
    );
  }

  vec3 color;
  if (u_blur > 0.0) {
    float edge = u_blur * u_scale;
    color = shade(position, u_time) * 0.36;
    color += shade(position + vec2(edge, 0.0), u_time) * 0.16;
    color += shade(position - vec2(edge, 0.0), u_time) * 0.16;
    color += shade(position + vec2(0.0, edge), u_time) * 0.16;
    color += shade(position - vec2(0.0, edge), u_time) * 0.16;
  } else {
    color = shade(position, u_time);
  }

  if (abs(u_contrast - 1.0) > 0.0001) {
    color = (color - 0.5) * u_contrast + 0.5;
  }
  if (abs(u_saturation - 1.0) > 0.0001) {
    float luma = dot(color, vec3(0.299, 0.587, 0.114));
    color = mix(vec3(luma), color, u_saturation);
  }
  if (abs(u_hue) > 0.0001) {
    color = rotateHue(color, u_hue);
  }
  if (abs(u_brightness) > 0.0001) {
    color += u_brightness;
  }
  if (u_vignette > 0.0001) {
    float distanceFromCenter = length(screenUv - 0.5) * 1.41421356;
    color *= 1.0 - u_vignette * smoothstep(0.35, 1.0, distanceFromCenter);
  }
  if (u_cursorPresence > 0.001 && u_cursorEffect > 3.5) {
    color += (vec3(0.18) + color * 0.12) * cursorMask * u_cursorStrength;
  }
  if (u_grain > 0.0001) {
    color += (
      grainHash(
        gl_FragCoord.xy + vec2(u_seed * 17.0, u_seed * 31.0)
      ) - 0.5
    ) * u_grain;
  }
  gl_FragColor = vec4(clamp(color, 0.0, 1.0), 1.0);
}`;

const UNIFORMS = {
  colors: [
    [0.047, 0.039, 0.114],
    [0.071, 0.067, 0.086],
    [0.125, 0.098, 0.259],
    [0.435, 0.298, 1],
    [0.4, 0.847, 1],
    [0.4, 0.847, 1],
    [0.4, 0.847, 1],
    [0.4, 0.847, 1],
  ] as [number, number, number][],
  colorCount: 5,
  scale: 1.5,
  intensity: 0.48,
  warp: 0,
  detail: 2.4,
  contrast: 0.96,
  brightness: -0.18,
  saturation: 0.9,
  hue: 0,
  vignette: 0.7,
  blur: 0.018,
  grain: 0.035,
  seed: 7,
  rotate: 0,
  offsetX: 0,
  offsetY: 0,
  drift: 0.12,
  cursorEnabled: false,
  cursorEffect: 4,
  cursorStrength: 0.65,
  cursorRadius: 0.297,
  oklab: 1,
  timeScale: 0.42,
};

const pendingContextReleases = new WeakMap<HTMLCanvasElement, number>();

function compileShader(
  gl: WebGLRenderingContext,
  type: number,
  source: string,
) {
  const shader = gl.createShader(type);

  if (!shader) {
    return null;
  }

  gl.shaderSource(shader, source);
  gl.compileShader(shader);

  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    console.error("Scout background shader could not compile.");
    gl.deleteShader(shader);

    return null;
  }

  return shader;
}

export function ShaderBackground({ className = "" }: { className?: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;

    if (!canvas) {
      return;
    }

    const pendingRelease = pendingContextReleases.get(canvas);

    if (pendingRelease !== undefined) {
      window.clearTimeout(pendingRelease);
    }

    pendingContextReleases.delete(canvas);

    const gl = canvas.getContext("webgl", {
      alpha: false,
      antialias: false,
      powerPreference: "low-power",
    });

    if (!gl) {
      return;
    }

    const vertexShader = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
    const fragmentShader = compileShader(
      gl,
      gl.FRAGMENT_SHADER,
      FRAGMENT_SHADER,
    );

    if (!vertexShader || !fragmentShader) {
      if (vertexShader) {
        gl.deleteShader(vertexShader);
      }

      if (fragmentShader) {
        gl.deleteShader(fragmentShader);
      }

      return;
    }

    const program = gl.createProgram();

    if (!program) {
      gl.deleteShader(vertexShader);
      gl.deleteShader(fragmentShader);

      return;
    }

    gl.attachShader(program, vertexShader);
    gl.attachShader(program, fragmentShader);
    gl.linkProgram(program);
    gl.deleteShader(vertexShader);
    gl.deleteShader(fragmentShader);

    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      console.error("Scout background shader could not link.");
      gl.deleteProgram(program);

      return;
    }

    gl.useProgram(program);

    const buffer = gl.createBuffer();

    if (!buffer) {
      gl.deleteProgram(program);

      return;
    }

    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 3, -1, -1, 3]),
      gl.STATIC_DRAW,
    );

    const position = gl.getAttribLocation(program, "a_position");

    if (position < 0) {
      gl.deleteBuffer(buffer);
      gl.deleteProgram(program);

      return;
    }

    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);

    const uniforms = {
      colors: gl.getUniformLocation(program, "u_colors"),
      scene: gl.getUniformLocation(program, "u_scene"),
      shape: gl.getUniformLocation(program, "u_shape"),
      surface: gl.getUniformLocation(program, "u_surface"),
      finish: gl.getUniformLocation(program, "u_finish"),
      transform: gl.getUniformLocation(program, "u_transform"),
      space: gl.getUniformLocation(program, "u_space"),
      cursor: gl.getUniformLocation(program, "u_cursor"),
    };

    gl.uniform3fv(uniforms.colors, new Float32Array(UNIFORMS.colors.flat()));
    gl.uniform4f(
      uniforms.shape,
      UNIFORMS.scale,
      UNIFORMS.intensity,
      0.5,
      UNIFORMS.warp,
    );
    gl.uniform4f(
      uniforms.surface,
      UNIFORMS.detail,
      UNIFORMS.contrast,
      UNIFORMS.brightness,
      UNIFORMS.saturation,
    );
    gl.uniform4f(
      uniforms.finish,
      UNIFORMS.hue,
      UNIFORMS.vignette,
      UNIFORMS.blur,
      UNIFORMS.grain,
    );
    gl.uniform4f(
      uniforms.transform,
      UNIFORMS.seed,
      UNIFORMS.rotate,
      UNIFORMS.drift,
      UNIFORMS.oklab,
    );
    gl.uniform4f(
      uniforms.cursor,
      0,
      UNIFORMS.cursorEffect,
      UNIFORMS.cursorStrength,
      UNIFORMS.cursorRadius,
    );

    let bounds = canvas.getBoundingClientRect();
    let animationFrame = 0;
    let lastFrame: number | null = null;
    let visible = document.visibilityState === "visible";
    let inView = true;
    let disposed = false;
    let motionAllowed = !window.matchMedia("(prefers-reduced-motion: reduce)")
      .matches;
    const startedAt = performance.now();
    const motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");

    const resizeCanvas = () => {
      const density = Math.min(window.devicePixelRatio || 1, 2);
      const rawWidth = Math.max(1, Math.round(bounds.width * density));
      const rawHeight = Math.max(1, Math.round(bounds.height * density));
      const pixelScale = Math.min(
        1,
        Math.sqrt(2_000_000 / Math.max(1, rawWidth * rawHeight)),
      );
      const width = Math.max(1, Math.round(rawWidth * pixelScale));
      const height = Math.max(1, Math.round(rawHeight * pixelScale));

      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
        gl.viewport(0, 0, width, height);
      }
    };

    function requestRender() {
      if (!disposed && visible && inView && animationFrame === 0) {
        animationFrame = requestAnimationFrame(render);
      }
    }

    function render(now: number) {
      animationFrame = 0;

      if (!gl || !canvas || disposed || !visible || !inView) {
        return;
      }

      if (motionAllowed && lastFrame !== null && now - lastFrame < 1000 / 30) {
        requestRender();

        return;
      }

      lastFrame = now;
      resizeCanvas();
      gl.uniform4f(
        uniforms.scene,
        canvas.width,
        canvas.height,
        motionAllowed ? ((now - startedAt) / 1000) * UNIFORMS.timeScale : 0,
        UNIFORMS.colorCount,
      );
      gl.uniform4f(uniforms.space, UNIFORMS.offsetX, UNIFORMS.offsetY, 0, 0);
      gl.drawArrays(gl.TRIANGLES, 0, 3);

      if (motionAllowed && Math.abs(UNIFORMS.timeScale) > 0.0001) {
        requestRender();
      }
    }

    const updateLayout = () => {
      bounds = canvas.getBoundingClientRect();
      resizeCanvas();
      requestRender();
    };

    const onVisibilityChange = () => {
      visible = document.visibilityState === "visible";

      if (visible) {
        requestRender();
      } else if (animationFrame !== 0) {
        cancelAnimationFrame(animationFrame);
        animationFrame = 0;
        lastFrame = null;
      }
    };

    const onMotionChange = () => {
      motionAllowed = !motionQuery.matches;
      lastFrame = null;
      requestRender();
    };

    window.addEventListener("resize", updateLayout);
    document.addEventListener("visibilitychange", onVisibilityChange);
    motionQuery.addEventListener("change", onMotionChange);

    const resizeObserver = new ResizeObserver(updateLayout);

    resizeObserver.observe(canvas);

    const intersectionObserver = new IntersectionObserver(([entry]) => {
      inView = entry?.isIntersecting ?? true;

      if (inView) {
        requestRender();
      } else if (animationFrame !== 0) {
        cancelAnimationFrame(animationFrame);
        animationFrame = 0;
        lastFrame = null;
      }
    });

    intersectionObserver.observe(canvas);
    requestRender();

    return () => {
      disposed = true;
      cancelAnimationFrame(animationFrame);
      resizeObserver.disconnect();
      intersectionObserver.disconnect();
      document.removeEventListener("visibilitychange", onVisibilityChange);
      motionQuery.removeEventListener("change", onMotionChange);
      window.removeEventListener("resize", updateLayout);
      gl.deleteBuffer(buffer);
      gl.deleteProgram(program);

      const releaseTimer = window.setTimeout(() => {
        if (pendingContextReleases.get(canvas) !== releaseTimer) {
          return;
        }

        pendingContextReleases.delete(canvas);
        gl.getExtension("WEBGL_lose_context")?.loseContext();
        canvas.width = 1;
        canvas.height = 1;
      }, 0);

      pendingContextReleases.set(canvas, releaseTimer);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      className={className}
      aria-hidden="true"
      data-scout-shader="flow-field"
    />
  );
}
