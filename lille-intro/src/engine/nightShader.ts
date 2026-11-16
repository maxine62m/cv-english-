// Éclairage nocturne procédural partagé :
//  - Google 3D Tiles / Cesium OSM Buildings (CustomShader)
//  - bâtiments OSM extrudés du mode secours (Material)
// Repère : ENU local centré sur la Grand'Place, z = hauteur au-dessus du sol (m).
import * as Cesium from 'cesium';

export const NIGHT_GLSL = /* glsl */ `
float lille_hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

// p : position ENU, n : normale ENU, albedo : couleur de jour, dist : distance caméra,
// urban : 0..1 (probabilité de bâti), photo : 1 si texture photogrammétrique (Google)
vec3 lille_night(vec3 p, vec3 n, vec3 albedo, float dist, float urban, float photo) {
  float up = n.z;
  float wall = 1.0 - smoothstep(0.30, 0.55, abs(up));
  float aboveGround = smoothstep(0.3, 2.5, p.z);

  // Lune froide + ciel rétro-éclairé par la ville
  vec3 col = albedo * (0.045 + 0.075 * max(up, 0.0)) * vec3(0.55, 0.68, 1.0);
  // Rebond chaud des réverbères sur le bas des façades et sur les chaussées
  float low = exp(-max(p.z, 0.0) / 10.0);
  col += albedo * vec3(1.0, 0.56, 0.24) * (0.24 * low * wall + 0.12 * low * (1.0 - wall) * urban);

  // Sol : sodium orangé sur les surfaces horizontales basses et peu saturées (chaussées, places)
  float sat = max(albedo.r, max(albedo.g, albedo.b)) - min(albedo.r, min(albedo.g, albedo.b));
  float grey = 1.0 - smoothstep(0.05, 0.16, sat);
  float ground = (1.0 - wall) * (1.0 - smoothstep(1.5, 6.0, p.z));
  float pool = 0.55 + 0.45 * sin(p.x * 0.19 + sin(p.y * 0.07) * 3.0) * sin(p.y * 0.21 + sin(p.x * 0.05) * 2.0);
  col += vec3(1.0, 0.6, 0.28) * ground * grey * urban * mix(0.10, 0.24, pool) * (0.5 + albedo.g);

  // Fenêtres sur les façades
  vec2 tg = normalize(vec2(-n.y, n.x) + 1e-5);
  float u = dot(p.xy, tg);
  float wallId = floor(dot(p.xy, normalize(n.xy + 1e-5)) * 0.5) + floor(atan(n.y, n.x) * 6.0) * 17.0;
  vec2 g = vec2(u / 2.8, (p.z - 0.4) / 3.3);
  vec2 cell = floor(g);
  vec2 f = fract(g);
  float r = lille_hash12(cell + vec2(wallId * 1.37, wallId * 0.73));
  float win = smoothstep(0.16, 0.24, f.x) * smoothstep(0.84, 0.76, f.x) * smoothstep(0.22, 0.30, f.y) * smoothstep(0.88, 0.80, f.y);
  float lit = step(0.64, r) * (0.35 + 0.75 * lille_hash12(cell * 1.31 + 3.7));
  float shop = 1.0 - step(0.5, cell.y);                    // rez-de-chaussée : vitrines
  lit = mix(lit, 0.9 + 0.5 * lille_hash12(cell + 9.1), shop * step(0.35, r));
  vec3 warm = mix(vec3(1.0, 0.58, 0.24), vec3(1.0, 0.84, 0.58), lille_hash12(cell + 7.3));
  float aa = clamp(1.0 - 1.6 * max(fwidth(g.x), fwidth(g.y)), 0.0, 1.0);
  float avg = 0.11;
  float emit = mix(avg, win * lit, aa) * wall * aboveGround;
  // Façades photo : on module par la luminance d'origine (vitres sombres restent sombres)
  emit *= mix(1.0, 0.55 + 0.9 * dot(albedo, vec3(0.3, 0.5, 0.2)), photo);
  col = col * (1.0 - 0.6 * win * aa * wall) + warm * emit * 0.95 * urban;

  // Lointain : lumière diffuse de la métropole (vue aérienne type « Black Marble »)
  float far = smoothstep(1500.0, 9000.0, dist);
  vec3 cityGlow = vec3(1.0, 0.62, 0.30) * urban * (0.10 + 0.20 * grey) * (0.6 + 0.8 * lille_hash12(floor(p.xy / 90.0)));
  col = mix(col, cityGlow + albedo * 0.03, far * 0.85);
  return col;
}
`;

/** Matrice (float32) œil → ENU local, mise à jour à chaque image par le moteur. */
export interface NightUniforms {
  eyeToEnu: Cesium.Matrix4;
}

export function createTilesetNightShader(eyeToEnu: Cesium.Matrix4, photo: boolean): Cesium.CustomShader {
  return new Cesium.CustomShader({
    lightingModel: Cesium.LightingModel.UNLIT,
    uniforms: {
      u_eyeToEnu: { type: Cesium.UniformType.MAT4, value: eyeToEnu },
      u_photo: { type: Cesium.UniformType.FLOAT, value: photo ? 1 : 0 },
    },
    fragmentShaderText: /* glsl */ `
${NIGHT_GLSL}
void fragmentMain(FragmentInput fsInput, inout czm_modelMaterial material) {
  vec3 posEC = fsInput.attributes.positionEC;
  vec3 nEC = normalize(cross(dFdx(posEC), dFdy(posEC)));
  if (dot(nEC, posEC) > 0.0) nEC = -nEC;
  vec3 p = (u_eyeToEnu * vec4(posEC, 1.0)).xyz;
  vec3 n = normalize(mat3(u_eyeToEnu) * nEC);
  vec3 albedo = material.diffuse;
  // Probabilité de bâti : végétation (vert dominant) et champs → éteints
  float green = albedo.g - max(albedo.r, albedo.b);
  float urban = mix(1.0, 1.0 - smoothstep(-0.01, 0.05, green), u_photo);
  vec3 c = lille_night(p, n, albedo, length(posEC), urban, u_photo);
  material.diffuse = c;
  material.emissive = vec3(0.0);
  material.alpha = 1.0;
}
`,
  });
}

/** Matériau des bâtiments extrudés (mode secours) : albédo pierre/brique procédural. */
export function createExtrudedNightMaterial(eyeToEnu: Cesium.Matrix4): Cesium.Material {
  return new Cesium.Material({
    fabric: {
      type: 'LilleNightFacade',
      uniforms: { u_eyeToEnu: Cesium.Matrix4.toArray(eyeToEnu) },
      source: /* glsl */ `
${NIGHT_GLSL}
czm_material czm_getMaterial(czm_materialInput materialInput) {
  czm_material m = czm_getDefaultMaterial(materialInput);
  vec3 posEC = -materialInput.positionToEyeEC;
  vec3 nEC = normalize(cross(dFdx(posEC), dFdy(posEC)));
  if (dot(nEC, posEC) > 0.0) nEC = -nEC;
  vec3 p = (u_eyeToEnu * vec4(posEC, 1.0)).xyz;
  vec3 n = normalize(mat3(u_eyeToEnu) * nEC);
  float id = lille_hash12(floor(p.xy / 7.0) + floor(atan(n.y, n.x) * 2.0));
  vec3 brick = vec3(0.55, 0.30, 0.22), stone = vec3(0.62, 0.56, 0.46), plaster = vec3(0.70, 0.66, 0.60);
  vec3 albedo = id < 0.45 ? brick : (id < 0.8 ? stone : plaster);
  if (n.z > 0.6) albedo = vec3(0.20, 0.20, 0.23); // toitures ardoise
  m.diffuse = vec3(0.0);
  m.emission = lille_night(p, n, albedo, length(posEC), 1.0, 0.0);
  m.alpha = 1.0;
  return m;
}
`,
    },
    translucent: false,
  });
}
