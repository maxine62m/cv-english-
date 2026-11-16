// Chaîne de post-traitement cinématique (Cesium PostProcessStage) :
// nuages volumétriques (demi-résolution) → profondeur de champ + brume atmosphérique
// → flou radial de vitesse, aberration chromatique, étalonnage, vignette, grain.
import * as Cesium from 'cesium';

const RAY_GLSL = /* glsl */ `
uniform mat3 u_worldToEnu;
uniform vec3 u_camEnu;

vec4 lille_eyePos(vec2 uv, float depth) {
  vec2 xy = 2.0 * uv - vec2(1.0);
  vec4 posEC = czm_inverseProjection * vec4(xy, depth, 1.0);
  return posEC / posEC.w;
}
vec3 lille_rayDirEnu(vec2 uv) {
  vec3 dirEC = normalize(lille_eyePos(uv, 0.5).xyz);
  return normalize(u_worldToEnu * (czm_inverseViewRotation * dirEC));
}
float lille_sceneDist(vec2 uv, out float depthOut) {
  float depth = czm_readDepth(depthTexture, uv);
  depthOut = depth;
  if (depth >= 1.0) return 1.0e9;
  return length(lille_eyePos(uv, depth).xyz);
}
`;

const CLOUDS_FS = /* glsl */ `
uniform sampler2D colorTexture;
uniform sampler2D depthTexture;
uniform float u_time;
uniform float u_base;
uniform float u_top;
uniform float u_coverage;
uniform float u_density;
uniform float u_cityGlow;
in vec2 v_textureCoordinates;
${RAY_GLSL}

float c_hash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float c_noise(vec3 x) {
  vec3 i = floor(x); vec3 f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(c_hash(i), c_hash(i + vec3(1,0,0)), f.x), mix(c_hash(i + vec3(0,1,0)), c_hash(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(c_hash(i + vec3(0,0,1)), c_hash(i + vec3(1,0,1)), f.x), mix(c_hash(i + vec3(0,1,1)), c_hash(i + vec3(1,1,1)), f.x), f.y), f.z);
}
float c_fbm(vec3 p, int oct) {
  float a = 0.5, s = 0.0;
  for (int i = 0; i < 6; i++) { if (i >= oct) break; s += a * c_noise(p); p = p * 2.07 + vec3(1.7, 9.2, 3.1); a *= 0.5; }
  return s;
}
float c_density(vec3 p, int oct) {
  float hN = (p.z - u_base) / (u_top - u_base);
  if (hN < 0.0 || hN > 1.0) return 0.0;
  float shape = smoothstep(0.0, 0.18, hN) * smoothstep(1.0, 0.45, hN);
  vec3 q = vec3(p.xy * 0.00038, p.z * 0.0009) + vec3(u_time * 0.012, u_time * 0.005, 0.0);
  float n = c_fbm(q, oct);
  float d = (n - (1.0 - u_coverage)) * 2.2 - (1.0 - shape) * 0.6;
  return clamp(d, 0.0, 1.0) * u_density;
}

void main() {
  vec2 uv = v_textureCoordinates;
  float depth;
  float sceneDist = lille_sceneDist(uv, depth);
  vec3 ro = u_camEnu;
  vec3 rd = lille_rayDirEnu(uv);
  float t0, t1;
  if (abs(rd.z) < 1e-4) {
    if (ro.z < u_base || ro.z > u_top) { out_FragColor = vec4(0.0); return; }
    t0 = 0.0; t1 = 30000.0;
  } else {
    float ta = (u_base - ro.z) / rd.z, tb = (u_top - ro.z) / rd.z;
    t0 = max(min(ta, tb), 0.0); t1 = max(ta, tb);
  }
  t1 = min(min(t1, sceneDist), t0 + 30000.0);
  if (t1 <= t0) { out_FragColor = vec4(0.0); return; }

  const int STEPS = 56;
  float dt = (t1 - t0) / float(STEPS);
  float jitter = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
  float T = 1.0;
  vec3 col = vec3(0.0);
  for (int i = 0; i < STEPS; i++) {
    float t = t0 + (float(i) + jitter) * dt;
    vec3 p = ro + rd * t;
    float d = c_density(p, 5);
    if (d > 0.0) {
      float hN = clamp((p.z - u_base) / (u_top - u_base), 0.0, 1.0);
      float shadow = exp(-c_density(p + vec3(40.0, 20.0, 160.0), 3) * 260.0);
      vec3 moon = vec3(0.50, 0.58, 0.78) * (0.10 + 0.55 * shadow) * mix(0.45, 1.0, hN);
      // Dessous des nuages éclairé par la pollution lumineuse de la ville (orange)
      float r = length(p.xy) / 14000.0;
      vec3 city = vec3(1.0, 0.52, 0.22) * u_cityGlow * pow(1.0 - hN, 2.0) * exp(-r * r);
      vec3 lum = moon + city;
      float a = 1.0 - exp(-d * dt);
      col += T * a * lum;
      T *= 1.0 - a;
      if (T < 0.01) break;
    }
  }
  // Traînée de distance : les nuages lointains se fondent dans le ciel
  float fade = exp(-t0 / 26000.0);
  out_FragColor = vec4(col * fade, (1.0 - T) * fade);
}
`;

const COMPOSITE_FS = /* glsl */ `
uniform sampler2D colorTexture;
uniform sampler2D depthTexture;
uniform sampler2D cloudTexture;
uniform float u_hazeDensity;
uniform float u_hazeHeight;
uniform float u_starDim;
uniform float u_focus;
uniform float u_dof;
in vec2 v_textureCoordinates;
${RAY_GLSL}

const vec2 DISK[12] = vec2[12](
  vec2(-0.326, -0.406), vec2(-0.840, -0.074), vec2(-0.696, 0.457), vec2(-0.203, 0.621),
  vec2(0.962, -0.195), vec2(0.473, -0.480), vec2(0.519, 0.767), vec2(0.185, -0.893),
  vec2(0.507, 0.064), vec2(0.896, 0.412), vec2(-0.322, -0.933), vec2(-0.792, -0.598));

void main() {
  vec2 uv = v_textureCoordinates;
  float depth;
  float dist = min(lille_sceneDist(uv, depth), 60000.0);
  vec4 scene = texture(colorTexture, uv);
  // Profondeur de champ subtile (cercle de confusion physique simplifié)
  float coc = u_dof * clamp(abs(1.0 - u_focus / max(dist, 0.1)), 0.0, 1.0);
  if (coc > 0.02) {
    vec2 px = coc * 3.5 / czm_viewport.zw;
    vec3 acc = scene.rgb;
    for (int i = 0; i < 12; i++) acc += texture(colorTexture, uv + DISK[i] * px).rgb;
    scene.rgb = acc / 13.0;
  }
  vec3 rd = lille_rayDirEnu(uv);
  float z0 = max(u_camEnu.z, 0.0);
  float H = u_hazeHeight;
  // Brouillard exponentiel en hauteur (intégrale analytique le long du rayon)
  float k = rd.z * dist / H;
  float od = u_hazeDensity * dist * exp(-z0 / H) * (abs(k) < 1e-3 ? 1.0 : (1.0 - exp(-k)) / k);
  float fog = 1.0 - exp(-od);
  float horizon = pow(1.0 - clamp(abs(rd.z), 0.0, 1.0), 6.0);
  vec3 hazeCol = mix(vec3(0.03, 0.04, 0.07), vec3(0.20, 0.12, 0.07), 0.1 + 0.9 * horizon);
  vec3 col = scene.rgb;
  if (depth >= 1.0) {
    // Ciel : halo orangé de la pollution lumineuse à l'horizon, étoiles atténuées en ville
    float up = clamp(rd.z, 0.0, 1.0);
    vec3 sky = mix(vec3(0.05, 0.045, 0.05), vec3(0.004, 0.008, 0.02), smoothstep(0.0, 0.4, up));
    col = col * u_starDim + sky + vec3(0.17, 0.09, 0.045) * horizon * (0.4 + 0.6 * exp(-z0 / 4000.0));
  } else {
    col = mix(col, hazeCol, fog);
  }
  vec4 c = texture(cloudTexture, uv);
  col = col * (1.0 - c.a) + c.rgb;
  out_FragColor = vec4(col, 1.0);
}
`;

const LENS_FS = /* glsl */ `
uniform sampler2D colorTexture;
uniform float u_speed;
uniform float u_time;
uniform float u_exposure;
uniform float u_vignette;
uniform float u_grain;
uniform vec2 u_shake;
in vec2 v_textureCoordinates;

vec3 grade(vec3 c) {
  c *= u_exposure;
  c = c / (1.0 + c * 0.35) * 1.35;                     // épaule douce
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  vec3 shadows = vec3(0.020, 0.040, 0.065);             // ombres bleu pétrole
  vec3 highs = vec3(1.06, 0.98, 0.88);                  // hautes lumières chaudes
  c = mix(c + shadows * (1.0 - smoothstep(0.0, 0.35, l)), c * highs, smoothstep(0.25, 0.9, l));
  c = mix(vec3(l), c, 1.12);                            // légère saturation
  c = smoothstep(vec3(-0.02), vec3(1.02), c);           // contraste
  return c;
}

void main() {
  vec2 uv = v_textureCoordinates + u_shake;
  vec2 dir = uv - vec2(0.5);
  float r2 = dot(dir, dir);
  vec3 acc = vec3(0.0);
  float wsum = 0.0;
  const int N = 14;
  float blur = u_speed * 0.06 * smoothstep(0.0, 0.25, r2);
  for (int i = 0; i < N; i++) {
    float s = float(i) / float(N - 1);
    float w = 1.0 - 0.6 * s;
    vec2 o = dir * blur * s;
    float ca = (0.0015 + 0.004 * u_speed) * r2 * 4.0;
    vec3 c;
    c.r = texture(colorTexture, uv - o + dir * ca).r;
    c.g = texture(colorTexture, uv - o).g;
    c.b = texture(colorTexture, uv - o - dir * ca).b;
    acc += c * w;
    wsum += w;
  }
  vec3 col = grade(acc / wsum);
  col *= 1.0 - u_vignette * smoothstep(0.08, 0.55, r2 * 1.3);
  float n = fract(sin(dot(gl_FragCoord.xy + u_time * 61.7, vec2(12.9898, 78.233))) * 43758.5453) - 0.5;
  col += n * u_grain;
  out_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
`;

export interface PostFx {
  clouds: Cesium.PostProcessStage;
  composite: Cesium.PostProcessStage;
  lens: Cesium.PostProcessStage;
  frame: {
    worldToEnu: Cesium.Matrix3;
    camEnu: Cesium.Cartesian3;
  };
}

export function createPostFx(scene: Cesium.Scene): PostFx {
  const worldToEnu = new Cesium.Matrix3();
  const camEnu = new Cesium.Cartesian3();
  const frame = { worldToEnu, camEnu };

  const shared = {
    u_worldToEnu: () => frame.worldToEnu,
    u_camEnu: () => frame.camEnu,
  };

  const clouds = new Cesium.PostProcessStage({
    name: 'lille_clouds',
    fragmentShader: CLOUDS_FS,
    textureScale: 0.5,
    pixelDatatype: Cesium.PixelDatatype.UNSIGNED_BYTE,
    clearColor: Cesium.Color.TRANSPARENT,
    uniforms: {
      ...shared,
      u_time: 0,
      u_base: 2700,
      u_top: 4300,
      u_coverage: 0.62,
      u_density: 0.012,
      u_cityGlow: 0.55,
    },
  });

  const composite = new Cesium.PostProcessStage({
    name: 'lille_composite',
    fragmentShader: COMPOSITE_FS,
    uniforms: {
      ...shared,
      cloudTexture: 'lille_clouds',
      u_hazeDensity: 0.00007,
      u_hazeHeight: 650,
      u_starDim: 0.6,
      u_focus: 200,
      u_dof: 0,
    },
  });

  const lens = new Cesium.PostProcessStage({
    name: 'lille_lens',
    fragmentShader: LENS_FS,
    uniforms: {
      u_speed: 0,
      u_time: 0,
      u_exposure: 1.15,
      u_vignette: 0.55,
      u_grain: 0.03,
      u_shake: new Cesium.Cartesian2(0, 0),
    },
  });

  // Le composite lit la sortie des nuages sans être enchaîné derrière eux.
  const cloudPass = new Cesium.PostProcessStageComposite({
    stages: [clouds, composite],
    inputPreviousStageTexture: false,
  });

  scene.postProcessStages.add(cloudPass);
  scene.postProcessStages.add(lens);
  scene.postProcessStages.fxaa.enabled = true;

  const bloom = scene.postProcessStages.bloom;
  bloom.enabled = true;
  bloom.uniforms.glowOnly = false;
  bloom.uniforms.contrast = 200;
  bloom.uniforms.brightness = -0.45;
  bloom.uniforms.delta = 1.0;
  bloom.uniforms.sigma = 2.2;
  bloom.uniforms.stepSize = 1.6;

  return { clouds, composite, lens, frame };
}
