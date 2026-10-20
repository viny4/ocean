// The scene is one fragment shader, compiled twice by app.js: once as the half-resolution
// cloud pass (with CLOUD_PASS defined) and once as the main scene.
window.OCEAN_SHADERS = {
  vs: `
attribute vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }
`,
  fs: `
precision highp float;
uniform vec2  uRes;
uniform float uTime;
uniform vec2  uLook;    // yaw, pitch
uniform vec3  uPos;     // camera position
uniform vec3  uSun;     // sun direction (normalized)
uniform vec4  uWave;    // peak amplitude, peak wavenumber, wind direction (rad), choppiness
uniform vec4  uWater;   // foam, murkiness, depth scale, wind speed (m/s)
uniform vec3  uSky;     // cloud amount, cloud time, exposure
uniform vec4  uWeather; // rain, fog density, gloom, lightning flash
uniform vec4  uBolt;    // lightning bolt x, z, visible, seed
uniform vec4  uPrecip;  // snow, hail, dust, rainbow
uniform vec4  uSpout;   // waterspout x, z, strength
uniform vec4  uWind;    // accumulated wind drift x, z, blowing veils
uniform vec4  uNight;   // northern lights, glowing plankton, shooting stars
uniform vec4  uStars;   // moon phase (0 new .. 1 full), stars & milky way, air traffic, satellites
uniform sampler2D uTex; // cloud pass: last frame's clouds; main pass: this frame's clouds
uniform vec4  uCloudView; // previous yaw, previous pitch, frame number, history valid
uniform vec2  uCloudRes;  // size of the cloud buffer
uniform vec4  uBoatA;   // sailboat x, z, heading, type
uniform vec4  uBoatB;   // cargo ship x, z, heading, type
uniform vec4  uBirds[6]; // seagull x, y, z, wing pose
uniform vec2  uLife;    // boats visible, gulls visible
uniform vec4  uDolphin; // dolphin pod x, z, heading, event clock (s, < 0 when none)
uniform vec4  uWhale;   // whale x, z, heading, event clock (s, < 0 when none)
uniform vec4  uShark;   // shark fin x, z, heading, how far the fin is up
uniform vec4  uFauna;   // dolphins in the pod, whale breaches (0) or blows (1), wildlife amount
uniform vec4  uMoon;    // real moon direction, 1 when the real sky is on
uniform vec3  uMoonSun; // true sun direction (unclamped) for lighting the moon's phase
uniform mat3  uSkyRot;  // local sky -> celestial (equatorial) frame, turns the stars with the earth
uniform sampler2D uCat;   // star catalogue: each cube-map cell lists its stars, then the stars themselves
uniform sampler2D uLines; // constellation figures drawn on the six cube faces
uniform vec4  uClimate;   // tropical, polar, constellation lines
uniform vec4  uBergs[4];  // icebergs x, z, size, seed

// lighting set up once per pixel in main()
vec3  SUN;
vec3  SUN_COL;  // direct sunlight colour * intensity
vec3  SKY_AMB;  // overall sky brightness / tint
float DAY;
vec3  MOON;
vec3  MOON_COL;
vec3  RO;       // camera position
float PX;       // angular size of one pixel (radians)

// ---------- noise ----------
float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x),
             mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
}
float fbm(vec2 p) {
  float v = 0.0, a = 0.5;
  mat2 m = mat2(1.6, 1.2, -1.2, 1.6);
  for (int i = 0; i < 5; i++) { v += a * noise(p); p = m * p; a *= 0.5; }
  return v;
}

// ---------- waves: returns (height, dh/dx, dh/dz) ----------
// The wavelengths are fixed; wind only changes how much energy each one carries,
// so the sea can change smoothly with the weather without waves sliding around.
const float K_BASE = 0.04683; // longest wave ~134 m
float CREST; // 0 trough .. 1 crest of the big waves, set by waves()
vec3 waves(vec2 p, float t, float dist) {
  float h = 0.0, cr = 0.0;
  vec2 g = vec2(0.0);
  float A = uWave.x, kp = uWave.y, chop = uWave.w;
  float sharp = 0.6 + 0.4 * chop;                    // peakier crests
  float gam = -log(0.58 + 0.06 * chop) / log(1.52);  // rougher small-scale chop
  // two extra long swells below K_BASE only carry energy in hurricane-force wind
  float k = K_BASE / (1.52 * 1.52);
  for (int j = 0; j < 19; j++) {
    int i = j - 2;
    // skip wavelengths too small to resolve at this distance
    float fade = clamp((6.2832 / k) / (dist * 0.012 + 0.001) - 0.5, 0.0, 1.0);
    if (fade <= 0.0) break;
    float r = k / kp;
    float a = A * (r >= 1.0 ? pow(r, -gam) : r * r * r * r);
    if (a > A * 0.003) {
      // most energy travels with the wind; short waves spread wider
      float spread = mix(0.5, 1.0, smoothstep(1.0, 4.0, r));
      float ang = uWave.z + (fract(float(i) * 0.618034) - 0.5) * 2.2 * spread;
      vec2 d = vec2(cos(ang), sin(ang));
      float x = dot(d, p) * k - t * sqrt(9.8 * k) + float(i) * 1.7;
      float e = exp(sharp * (sin(x) - 1.0));
      h += a * e * fade;
      g += a * sharp * e * cos(x) * k * d * fade;
      cr = max(cr, smoothstep(0.88, 1.0, sin(x)) * smoothstep(0.12, 0.7, a / A));
    }
    k *= 1.52;
  }
  CREST = cr;
  return vec3(h, g);
}

// ---------- 3D noise (clouds) ----------
float hash3(vec3 p) {
  p = fract(p * 0.3183099 + 0.1);
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}
float noise3(vec3 x) {
  vec3 i = floor(x), f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(hash3(i),                  hash3(i + vec3(1, 0, 0)), f.x),
                 mix(hash3(i + vec3(0, 1, 0)), hash3(i + vec3(1, 1, 0)), f.x), f.y),
             mix(mix(hash3(i + vec3(0, 0, 1)), hash3(i + vec3(1, 0, 1)), f.x),
                 mix(hash3(i + vec3(0, 1, 1)), hash3(i + vec3(1, 1, 1)), f.x), f.y), f.z);
}

// ---------- sky ----------
const float CLOUD_LO = 900.0, CLOUD_HI = 2300.0;
const mat3 M3 = mat3(0.00, 0.80, 0.60, -0.80, 0.36, -0.48, -0.60, -0.48, 0.64);

// northern lights: folded curtains high up, green at the base fading to violet above
vec3 aurora(vec3 rd) {
  float amt = uNight.x * (1.0 - DAY) * (1.0 - uWeather.z);
  if (amt < 0.01 || rd.y <= 0.0) return vec3(0.0);
  vec3 acc = vec3(0.0);
  float at = uTime * 0.04;
  float jit = hash(gl_FragCoord.xy + 3.1);
  for (int i = 0; i < 20; i++) {
    float fi = float(i) + jit;
    // where this ray crosses the curtain at increasing heights
    vec2 p = rd.xz / (rd.y + 0.05) * 0.35 * (1.0 + fi * 0.07);
    float b = p.y + sin(p.x * 0.7 + at * 3.0) * 0.8 + (noise(vec2(p.x * 1.3, at)) - 0.5) * 1.6;
    float rib = exp(-abs(b - 3.0) * 7.0) + 0.6 * exp(-abs(b + 2.0) * 6.0);
    // bright vertical rays shimmering along the curtain
    float rays = smoothstep(0.25, 0.85, noise(vec2(p.x * 11.0 + at * 5.0, 0.5))) * 0.75
               + smoothstep(0.4, 0.9, noise(vec2(p.x * 31.0 - at * 9.0, 2.5))) * 0.45 + 0.1;
    vec3 c = mix(vec3(0.15, 1.0, 0.45), vec3(0.6, 0.25, 0.95), smoothstep(4.0, 19.0, fi));
    acc += c * rib * rays * exp(-fi * 0.12);
  }
  return acc * amt * 0.12 * smoothstep(0.0, 0.12, rd.y);
}

// ---------- night sky ----------
// cube-map coordinates give an even, seamless grid of cells over the whole sky
vec2 cubeUV(vec3 d, out float face) {
  vec3 a = abs(d);
  if (a.x >= a.y && a.x >= a.z) { face = d.x > 0.0 ? 0.0 : 1.0; return d.zy / a.x; }
  if (a.y >= a.z)               { face = d.y > 0.0 ? 2.0 : 3.0; return d.xz / a.y; }
  face = d.z > 0.0 ? 4.0 : 5.0;
  return d.xy / a.z;
}

// the Milky Way, in celestial coordinates: galactic north pole and centre (Sagittarius)
const vec3 GAL_N = vec3(-0.86765, -0.19807, 0.45604);
const vec3 GAL_C = vec3(-0.05495, -0.87338, -0.48393);
float galaxyBand(vec3 rd, out vec2 gl) {
  vec3 B = cross(GAL_N, GAL_C);
  float lat = asin(clamp(dot(rd, GAL_N), -1.0, 1.0));
  float lon = atan(dot(rd, B), dot(rd, GAL_C));
  gl = vec2(lon, lat);
  float core = exp(-lon * lon * 1.2);
  float width = 0.11 + 0.12 * core;
  return exp(-lat * lat / (width * width)) * (0.3 + 0.7 * core);
}
vec3 milkyWay(float band, vec2 g) {
  if (band < 0.01) return vec3(0.0);
  float core = exp(-g.x * g.x * 1.2);
  float clouds = fbm(vec2(g.x * 7.0, g.y * 16.0) + 3.0);          // star clouds
  float lum = band * (0.35 + 0.9 * clouds * clouds) * (0.85 + 0.3 * noise(vec2(g.x * 40.0, g.y * 60.0)));
  // dark dust lanes splitting the band (the Great Rift)
  float lane = exp(-pow((g.y - 0.025 * sin(g.x * 5.0)) / (0.03 + 0.05 * core), 2.0));
  float dust = smoothstep(0.35, 0.75, fbm(vec2(g.x * 5.0 + 9.0, g.y * 22.0)));
  lum *= 1.0 - 0.85 * lane * mix(0.5, 1.0, dust);
  return mix(vec3(0.70, 0.78, 1.0), vec3(1.0, 0.86, 0.68), core) * lum;
}

// two layers of faint background stars, below the real catalogue: a scattering of every
// colour, and countless fainter ones crowding into the Milky Way
vec3 starField(vec3 eq, float up, float band, float deep) {
  float face;
  vec2 uv = cubeUV(eq, face);
  vec3 acc = vec3(0.0);
  float low = 1.0 - smoothstep(0.0, 0.35, up); // stars near the horizon twinkle harder
  for (int l = 0; l < 2; l++) {
    float fl = float(l);
    float sc = mix(80.0, 240.0, fl);
    vec2 g = uv * sc;
    vec2 id = floor(g) + face * 173.0 + fl * 59.0;
    float h1 = hash(id), h2 = hash(id + 0.37), h3 = hash(id + 1.91), h4 = hash(id + 3.71), h5 = hash(id + 5.3);
    float dens = l == 0 ? 0.16 : 0.22 + 0.6 * band;
    if (h1 > dens) continue;
    vec2 o = 0.25 + 0.5 * vec2(h2, h3);
    float d = length(fract(g) - o) / sc;
    float b = l == 0 ? 0.008 + pow(h4, 6.0) * 0.03 : (0.006 + 0.025 * h4) * deep; // fainter than magnitude ~4.3
    float tw = 1.0 + (noise(vec2(h1 * 300.0 + uTime * 5.0, fl)) - 0.5) * (0.35 + 0.9 * low);
    vec3 tint = mix(vec3(1.0, 0.72, 0.5), vec3(1.0, 0.96, 0.9), smoothstep(0.1, 0.4, h5));
    tint = mix(tint, vec3(0.72, 0.82, 1.0), smoothstep(0.7, 0.95, h5));
    acc += tint * b * tw * (exp(-d * d / (PX * PX * 0.6)) + exp(-d / (PX * 2.5)) * 0.05 * step(1.0, b));
  }
  return acc;
}

// the real bright stars, from the catalogue texture: the cell this direction falls in lists
// up to six stars whose light reaches it, as 16-bit indices into two rows of star data
const float CAT_G = 32.0, CAT_W = 576.0, CAT_H = 34.0;
const float STAR_R = 0.0105; // how far a star's glow may spread (radians); the catalogue is built to match
float catByte(float v) { return floor(v * 255.0 + 0.5); }
// B-V colour index to a gentle tint: blue-white B stars, white A, yellow G, orange K and M giants
vec3 starTint(float bv) {
  vec3 c = mix(vec3(0.66, 0.77, 1.0), vec3(1.0, 0.98, 0.96), smoothstep(-0.3, 0.35, bv));
  c = mix(c, vec3(1.0, 0.84, 0.64), smoothstep(0.35, 1.2, bv));
  return mix(c, vec3(1.0, 0.64, 0.40), smoothstep(1.2, 1.9, bv));
}
vec3 catStar(vec2 code, vec3 eq, float low) {
  float id = catByte(code.x) * 256.0 + catByte(code.y);
  if (id < 0.5) return vec3(0.0);
  float u = (id - 0.5) / CAT_W;
  vec4 a = texture2D(uCat, vec2(u, (CAT_G + 0.5) / CAT_H));
  vec4 b = texture2D(uCat, vec2(u, (CAT_G + 1.5) / CAT_H));
  vec3 s = vec3(catByte(a.r) * 256.0 + catByte(a.g), catByte(a.b) * 256.0 + catByte(a.a),
                catByte(b.r) * 256.0 + catByte(b.g)) / 32767.5 - 1.0;
  float d = length(eq - normalize(s));
  if (d > STAR_R) return vec3(0.0);
  float mag = catByte(b.b) / 30.0 - 2.0;
  // a gently compressed magnitude scale: Sirius ~3.8, Vega ~1.4, 4th magnitude ~0.09
  float br = 1.4 * pow(10.0, -0.3 * mag);
  float tw = 1.0 + (noise(vec2(id * 1.37 + uTime * 5.0, 7.0)) - 0.5) * (0.3 + 0.9 * low);
  float w = 0.6 + 1.4 * smoothstep(0.3, 3.0, br);              // the brightest look a little bigger
  float g = exp(-d * d / (PX * PX * w)) + exp(-d / (PX * 2.5)) * 0.06 * smoothstep(0.4, 2.0, br);
  return starTint(catByte(b.a) / 100.0 - 0.5) * br * tw * g * smoothstep(STAR_R, STAR_R * 0.5, d);
}
vec3 realStars(vec3 eq, float up) {
  float face;
  vec2 uv = cubeUV(eq, face);
  vec2 cell = min(floor((uv * 0.5 + 0.5) * CAT_G), CAT_G - 1.0);
  float x = (face * CAT_G + cell.x) * 3.0 + 0.5, y = (cell.y + 0.5) / CAT_H;
  vec4 a = texture2D(uCat, vec2(x / CAT_W, y));
  if (a.r + a.g < 0.5 / 255.0) return vec3(0.0); // most of the sky: no bright star nearby
  vec4 b = texture2D(uCat, vec2((x + 1.0) / CAT_W, y));
  vec4 c = texture2D(uCat, vec2((x + 2.0) / CAT_W, y));
  float low = 1.0 - smoothstep(0.0, 0.35, up);
  vec3 acc = catStar(a.rg, eq, low) + catStar(a.ba, eq, low);
  if (b.r + b.g > 0.5 / 255.0) acc += catStar(b.rg, eq, low) + catStar(b.ba, eq, low) + catStar(c.rg, eq, low) + catStar(c.ba, eq, low);
  return acc;
}
// faint stick figures of the constellations, pre-drawn on the cube faces
float figureLines(vec3 eq) {
  float face;
  vec2 uv = cubeUV(eq, face);
  vec2 tc = (vec2(mod(face, 3.0), floor(face / 3.0)) + clamp(uv * 0.5 + 0.5, 0.001, 0.999)) / vec2(3.0, 2.0);
  return texture2D(uLines, tc).r;
}

// satellites gliding silently across; one is the bright space station, and now and then
// a fresh Starlink train goes by as a string of pearls
vec3 satellites(vec3 rd) {
  float amt = uStars.w;
  if (amt < 0.01) return vec3(0.0);
  vec3 acc = vec3(0.0);
  for (int i = 0; i < 6; i++) {
    float fi = float(i);
    float T = 300.0 + fi * 43.0;
    float tt = uTime + fi * 97.0;
    float cyc = floor(tt / T);
    float ph = fract(tt / T);
    float h1 = hash(vec2(cyc, fi * 3.1)), h2 = hash(vec2(cyc + 0.5, fi * 3.1 + 1.3)), h3 = hash(vec2(cyc + 0.25, fi * 3.1 + 2.7));
    if (h3 > amt) continue;
    // a pass from horizon to horizon along a tilted great circle
    float az = h1 * 6.2832;
    vec3 A = vec3(sin(az), 0.0, cos(az));
    float tilt = (h2 - 0.5) * 1.6;
    vec3 B = normalize(vec3(-A.z * tilt, 1.0, A.x * tilt));
    float w = ph * 3.1416 * (i == 0 ? 1.7 : 1.0);
    if (w > 3.1416) continue;
    vec3 s = A * cos(w) + B * sin(w);
    float br = i == 0 ? 2.2 : 0.25 + 0.45 * h2;
    br *= 1.0 - smoothstep(0.0, 0.06, w / 3.1416 - (0.45 + 0.5 * h1)); // slips into Earth's shadow
    if (i == 5 && h1 < 0.5) {
      // nearest member of the train trailing behind the leader
      float wr = atan(dot(rd, B), dot(rd, A));
      float k = clamp(floor((w - wr) / 0.014 + 0.5), 0.0, 17.0);
      float wk = w - k * 0.014;
      s = A * cos(wk) + B * sin(wk);
      br = 0.55;
    }
    float d = length(rd - s);
    acc += vec3(1.0, 0.98, 0.94) * br * exp(-d * d / (PX * PX * 0.5));
  }
  return acc;
}

// shooting stars: brief streaks that flare and fade, a few burning green
vec3 meteors(vec3 rd) {
  float amt = uNight.z;
  if (amt < 0.01) return vec3(0.0);
  vec3 acc = vec3(0.0);
  for (int i = 0; i < 2; i++) {
    float fi = float(i);
    float tt = uTime + fi * 2.9;
    float slot = floor(tt / 6.0);
    float h1 = hash(vec2(slot, 31.0 + fi)), h2 = hash(vec2(slot, 47.0 + fi));
    float h3 = hash(vec2(slot, 59.0 + fi)), h4 = hash(vec2(slot, 71.0 + fi));
    if (h1 > amt * 0.7) continue;
    float dur = 0.4 + 0.8 * h2;
    float age = fract(tt / 6.0) * 6.0 - h3 * (6.0 - dur);
    if (age < 0.0 || age > dur) continue;
    float az = h4 * 6.2832, el = 0.3 + 0.8 * fract(h2 * 7.3);
    vec3 st = vec3(cos(el) * sin(az), sin(el), cos(el) * cos(az));
    vec3 down = normalize(vec3(0.0, -1.0, 0.0) + st * st.y);
    vec3 T = normalize(down * 0.6 + cross(st, down) * (fract(h3 * 13.7) - 0.5) * 2.0);
    float len = 0.15 + 0.2 * h3;
    float head = len * age / dur;
    float tail = max(0.0, head - 0.08 - 0.05 * h2);
    float off = dot(rd, normalize(cross(st, T)));
    float a = atan(dot(rd, T), dot(rd, st));
    if (a < tail || a > head) continue;
    float along = smoothstep(tail, head, a);
    float g = exp(-off * off / (PX * PX * 0.5)) * along * along * sin(3.1416 * age / dur);
    acc += mix(vec3(0.85, 0.92, 1.0), vec3(0.6, 1.0, 0.7), step(0.75, h4)) * g * 3.0;
  }
  return acc;
}

vec3 nightSky(vec3 rd) {
  float dark = (1.0 - smoothstep(-0.12, 0.0, SUN.y)) * (1.0 - uWeather.z);
  if (dark < 0.01) return vec3(0.0);
  // the faint stuff needs a truly dark sky, and a bright moon washes it out
  float deep = (1.0 - smoothstep(-0.3, -0.12, SUN.y)) * (1.0 - 0.7 * uStars.x * step(0.0, MOON.y));
  vec3 eq = uSkyRot * rd; // the stars and the Milky Way are fixed to the turning celestial sphere
  vec2 g;
  float band = galaxyBand(eq, g);
  vec3 c = (milkyWay(band, g) * deep * 0.15 + starField(eq, rd.y, band, deep) + realStars(eq, rd.y)) * uStars.y;
  if (uClimate.z > 0.01) c += vec3(0.45, 0.6, 1.0) * figureLines(eq) * 0.03 * uClimate.z;
  c += satellites(rd) + meteors(rd);
  return c * dark * smoothstep(0.0, 0.2, rd.y);
}

// the moon as a lit sphere: a real phase, its dark seas, bright rayed Tycho, faint earthshine
float mare(vec2 p, vec2 c, vec2 r) { return smoothstep(1.0, 0.6, length((p - c) / r)); }
vec3 moon(vec3 rd, vec3 col) {
  float vis = (1.0 - DAY) * smoothstep(-0.02, 0.02, MOON.y);
  if (vis < 0.01) return col;
  float m = max(dot(rd, MOON), 0.0);
  col += MOON_COL * (pow(m, 600.0) * 0.5 + pow(m, 40.0) * 0.06); // glow in the air around it
  const float R = 0.024; // larger than life, as through a long lens
  if (m < 0.998) return col;
  vec3 U = normalize(vec3(MOON.z, 0.0, -MOON.x));
  vec3 V = cross(MOON, U);
  vec2 p = vec2(dot(rd, U), dot(rd, V)) / R;
  float r = length(p);
  float e = PX / R;
  float a = (1.0 - smoothstep(1.0 - e, 1.0 + e, r)) * vis;
  if (a <= 0.0) return col;
  float z = sqrt(max(1.0 - r * r, 0.0));
  float k = uStars.x;
  float ph = acos(clamp(2.0 * k - 1.0, -1.0, 1.0)); // phase angle from the lit fraction
  float sd = dot(SUN, U) >= 0.0 ? 1.0 : -1.0;
  vec3 L = normalize(vec3(sd * sin(ph), 0.15 * sin(ph), cos(ph)));
  // with the real sky on, light it from where the sun truly is: the exact phase and tilt
  if (uMoon.w > 0.5) L = normalize(vec3(dot(uMoonSun, U), dot(uMoonSun, V), -dot(uMoonSun, MOON)));
  float mu0 = max(dot(vec3(p, z), L), 0.0);
  float lit = 2.0 * mu0 / (mu0 + z + 0.05);        // Lommel-Seeliger: the moon looks flat, not ball-shaded
  vec2 q = p + (vec2(fbm(p * 3.0 + 1.3), fbm(p * 3.0 + 7.7)) - 0.5) * 0.12;
  float maria = mare(q, vec2(-0.25, 0.42), vec2(0.30, 0.25));             // Imbrium
  maria = max(maria, mare(q, vec2(0.17, 0.40), vec2(0.17, 0.16)));       // Serenitatis
  maria = max(maria, mare(q, vec2(0.33, 0.14), vec2(0.22, 0.18)));       // Tranquillitatis
  maria = max(maria, mare(q, vec2(-0.58, 0.05), vec2(0.28, 0.48)));      // Procellarum
  maria = max(maria, mare(q, vec2(0.66, 0.30), vec2(0.11, 0.09)));       // Crisium
  maria = max(maria, mare(q, vec2(0.52, -0.14), vec2(0.13, 0.15)));      // Fecunditatis
  maria = max(maria, mare(q, vec2(0.34, -0.27), vec2(0.09, 0.09)));      // Nectaris
  maria = max(maria, mare(q, vec2(-0.17, -0.33), vec2(0.18, 0.13)));     // Nubium
  maria = max(maria, mare(q, vec2(-0.05, 0.72), vec2(0.40, 0.07)));      // Frigoris
  float alb = mix(1.0, 0.48, maria) * (0.82 + 0.36 * fbm(p * 11.0 + 4.0));
  vec2 ty = p - vec2(-0.12, -0.63);
  vec2 cp = p - vec2(-0.3, 0.12);
  alb += pow(noise(vec2(atan(ty.y, ty.x) * 5.0, 1.0)), 4.0) * exp(-length(ty) * 2.2) * 0.5   // Tycho's rays
       + exp(-dot(ty, ty) * 800.0) * 0.6 + exp(-dot(cp, cp) * 1500.0) * 0.4;           // Tycho, Copernicus
  vec3 c = vec3(1.0, 0.97, 0.92) * alb * lit * 1.7 + vec3(0.025, 0.035, 0.05) * alb * (1.0 - k);
  return mix(col, c, a);
}

// airliners at cruise altitude: contrails by day, nav lights and strobes by night
vec3 airTraffic(vec3 rd, vec3 col) {
  float amt = uStars.z;
  if (amt < 0.01 || rd.y < 0.002) return col;
  const float L = 90000.0, V = 240.0;
  const float T = 2.0 * L / V; // seconds per crossing
  for (int i = 0; i < 4; i++) {
    float fi = float(i);
    float tt = uTime + fi * T * 0.27 + 37.0 * fi;
    float cyc = floor(tt / T);
    float s = fract(tt / T) * 2.0 * L - L;   // along-track position
    float h1 = hash(vec2(cyc, fi + 0.5)), h2 = hash(vec2(cyc, fi + 7.1)), h3 = hash(vec2(cyc, fi + 3.3));
    if (h1 > 0.15 + 0.85 * amt) continue;
    float hd = h2 * 6.2832;
    vec2 dir = vec2(cos(hd), sin(hd));
    vec2 nrm = vec2(-dir.y, dir.x);
    float alt = 9000.0 + 3000.0 * fract(h1 * 13.1);
    vec2 P = RO.xz + nrm * (h3 - 0.5) * 70000.0 + dir * s;
    // contrail where this ray crosses the cruise altitude: widens, drifts and fades behind
    if (DAY > 0.05) {
      float tH = (alt - RO.y) / rd.y;
      vec2 d = RO.xz + rd.xz * tH - P;
      float behind = -dot(d, dir);
      if (behind > 0.0 && behind < 30000.0) {
        float lat = dot(d, nrm) + (noise(vec2(behind * 0.0008, fi * 5.0 + cyc)) - 0.5) * behind * 0.03;
        float w = 15.0 + behind * 0.012;
        float ww = max(w, PX * tH);
        float persist = mix(5000.0, 16000.0, fract(h2 * 31.0));
        float ca = exp(-lat * lat / (ww * ww)) * (w / ww) * smoothstep(80.0, 500.0, behind) * exp(-behind / persist);
        col = mix(col, vec3(0.95) * (SKY_AMB * 0.85 + SUN_COL * 0.6), ca * 0.8 * DAY * amt);
      }
    }
    // the aircraft itself
    vec3 toP = vec3(P.x, alt, P.y) - RO;
    float D = length(toP);
    vec3 pd = toP / D;
    float sz = max(PX, 35.0 / D);
    float dd = length(rd - pd);
    float g = exp(-dd * dd / (sz * sz * 0.8)) * smoothstep(0.0, 0.03, pd.y) * exp(-D / 150000.0);
    if (g > 0.001) {
      col = mix(col, SKY_AMB * 0.3 + SUN_COL * 0.25, g * 0.75 * DAY);      // a tiny silhouette by day
      float tb = uTime + fi * 0.37;
      float beacon = step(fract(tb * 0.9), 0.07);                           // red anti-collision beacon
      float fs = fract(tb * 0.8 + 0.5);
      float strobe = step(fs, 0.03) + step(abs(fs - 0.1), 0.015);           // white double strobe
      float lg = exp(-dd * dd / (PX * PX * 0.6));
      col += (vec3(1.0, 0.95, 0.85) * 0.35 + vec3(1.0, 0.1, 0.05) * beacon * 2.5 + vec3(1.0) * strobe * 5.0)
           * lg * (1.0 - DAY) * smoothstep(0.0, 0.03, pd.y) * exp(-D / 150000.0);
    }
  }
  return col;
}

vec3 skyBase(vec3 rd, bool withSun) {
  float y = max(rd.y, 0.0);
  float s = max(dot(rd, SUN), 0.0);
  float low = 1.0 - smoothstep(0.0, 0.35, SUN.y); // golden-hour amount
  vec3 zen = mix(vec3(0.04, 0.24, 0.72), vec3(0.10, 0.18, 0.42), low * 0.6);
  vec3 warm = mix(vec3(0.95, 0.62, 0.45), vec3(1.0, 0.45, 0.15), pow(s, 2.0));
  vec3 hor = mix(vec3(0.52, 0.76, 0.98), warm, low * (0.25 + 0.75 * pow(s, 1.5)));
  vec3 col = mix(hor, zen, pow(y, 0.5));
  // overcast skies lose their colour
  col = mix(col, vec3(dot(col, vec3(0.3, 0.59, 0.11))) * vec3(0.92, 0.96, 1.03), uWeather.z * 0.85);
  col *= SKY_AMB;
  col += SUN_COL * (pow(s, 6.0) * 0.18 + pow(s, 80.0) * 0.45);
  if (rd.y > 0.0) {
    // stars, milky way, satellites, meteors (direct view only, not in reflections)
    if (withSun) col += nightSky(rd);
    // faint high-altitude cirrus streaks
    vec2 cp = rd.xz / (rd.y + 0.06) * 0.9 + vec2(uSky.y * 0.01, uSky.y * 0.002);
    cp = mat2(0.8, 0.6, -0.6, 0.8) * cp;
    float c = smoothstep(0.55, 0.95, fbm(cp * vec2(0.5, 3.0)));
    vec3 cirrus = vec3(1.0, 0.98, 0.96) * SKY_AMB * 1.05 + SUN_COL * pow(s, 4.0) * 0.4;
    col = mix(col, cirrus, c * 0.35 * smoothstep(0.0, 0.15, rd.y));
    col += aurora(rd);
  }
  if (withSun) {
    col += SUN_COL * smoothstep(0.9994, 0.9998, s) * 12.0;
    col = moon(rd, col);
    if (rd.y > 0.0) col = airTraffic(rd, col);
  }
  return col;
}

// density of the cumulus layer at world point p (0..1)
float DETAIL = 1.0; // fine edge detail, faded out with distance where it would only shimmer
float cloudDensity(vec3 p, int oct) {
  float h = (p.y - CLOUD_LO) / (CLOUD_HI - CLOUD_LO);
  if (h < 0.0 || h > 1.0) return 0.0;
  float ct = uSky.y;
  // wind drift, with tops leaning downwind
  vec3 wind = vec3(16.0, 0.0, 6.0) * ct + vec3(h * 350.0, 0.0, 0.0);
  vec3 q = (p + wind) * 0.0008;
  q.y -= ct * 0.0035; // shapes slowly billow upward and morph
  // coverage drifts too: clouds form and dissolve over the minutes
  float cov = noise(q.xz * 0.3 + vec2(ct * 0.003, -ct * 0.002));
  // threshold rises with height (rounded tops) and varies over large areas (clear gaps)
  float thr = 0.60 + 0.20 * h + (cov - 0.5) * 0.3 + (0.5 - uSky.x) * 0.45;
  float v = 0.0, a = 0.5;
  vec3 qb = q;
  for (int i = 0; i < 4; i++) {
    if (i >= oct) break;
    v += a * noise3(qb);
    if (i == 1 && v + 0.28 < thr) return 0.0; // can't reach threshold: skip detail
    qb = M3 * qb * 2.03;
    a *= 0.5;
  }
  v += a; // mean of skipped octaves
  float d = v - thr;
  if (oct > 4 && d > -0.04 && DETAIL > 0.01) {
    // fine cauliflower billows on the edges, churning faster than the cloud body
    vec3 qd = q * 8.0 + vec3(0.0, -ct * 0.04, ct * 0.015);
    float b = abs(noise3(qd) * 2.0 - 1.0) * 0.6
            + abs(noise3(M3 * qd * 2.1) * 2.0 - 1.0) * 0.4;
    d -= (b * 0.09 * (1.0 - smoothstep(0.0, 0.14, d)) - 0.03) * DETAIL;
  }
  d *= 10.0 * smoothstep(0.0, 0.08, h); // flat cloud bases
  return clamp(d, 0.0, 1.0);
}

float hg(float mu, float g) {
  float g2 = g * g;
  return (1.0 - g2) / pow(1.0 + g2 - 2.0 * g * mu, 1.5);
}

// volumetric clouds along a ray: (light scattered toward the eye, transmittance)
// the step count is set by the quality setting
#ifndef CLOUD_N
#define CLOUD_N 56
#endif
vec4 cloudMarch(vec3 ro, vec3 rd, float jitter) {
  if (rd.y < 0.01) return vec4(0.0, 0.0, 0.0, 1.0);
  float t0 = (CLOUD_LO - ro.y) / rd.y;
  float t1 = min((CLOUD_HI - ro.y) / rd.y, t0 + 7000.0);
  if (t0 > 45000.0) return vec4(0.0, 0.0, 0.0, 1.0);

  const int N = CLOUD_N;
  float dt = (t1 - t0) / float(N);
  float t = t0 + dt * jitter;
  float mu = dot(rd, SUN);
  float phase = 0.7 * hg(mu, 0.55) + 0.3 * hg(mu, -0.2);
  float ext = 1.0 + uWeather.z * 1.5; // storm clouds are thicker and darker
  float T = 1.0;
  vec3 acc = vec3(0.0);

  for (int i = 0; i < N; i++) {
    if (T < 0.02) break;
    vec3 p = ro + rd * t;
    DETAIL = 1.0 - smoothstep(6000.0, 18000.0, t);
    float d = cloudDensity(p, 5);
    if (d > 0.0) {
      float ld = cloudDensity(p + SUN * 70.0, 3)
               + cloudDensity(p + SUN * 200.0, 3)
               + cloudDensity(p + SUN * 450.0, 2) * 1.3;
      float beer = exp(-ld * 1.8 * ext);
      // multiple scattering keeps cloud interiors luminous instead of flat grey
      float ms = exp(-ld * 0.55 * ext) * 0.3 + exp(-ld * 0.18 * ext) * 0.12;
      float powder = 1.0 - exp(-d * 6.0) * 0.5;
      float h = clamp((p.y - CLOUD_LO) / (CLOUD_HI - CLOUD_LO), 0.0, 1.0);
      vec3 amb = mix(vec3(0.30, 0.37, 0.46), vec3(0.76, 0.86, 1.0), pow(h, 0.7)) * SKY_AMB;
      vec3 c = SUN_COL * 3.0 * (beer * phase + ms) * powder + amb;
      // lightning lights the cloud deck from inside, brightest near the strike
      c += vec3(0.75, 0.8, 1.0) * uWeather.w * 4.0 * exp(-length(p.xz - uBolt.xy) / 2000.0);
      float a = 1.0 - exp(-d * 0.04 * ext * dt);
      acc += T * a * c;
      T *= 1.0 - a;
    }
    t += dt;
  }
  DETAIL = 1.0;
  // aerial perspective: distant clouds melt into the sky
  float fade = exp(-t0 * 0.000055);
  return vec4(acc * fade, mix(1.0, T, fade));
}

// cheap single-sample cloud layer for reflections
vec3 skyReflect(vec3 ro, vec3 rd) {
  vec3 bg = skyBase(rd, false); // sun glint is added separately as specular
  if (rd.y < 0.01) return bg;
  float t = (CLOUD_LO + 350.0 - ro.y) / rd.y;
  float d = cloudDensity(ro + rd * t, 2);
  float op = smoothstep(0.0, 0.8, d) * 0.6 * exp(-t * 0.000055);
  return mix(bg, vec3(0.80, 0.84, 0.90) * SKY_AMB + SUN_COL * 0.2, op);
}

// fraction of sunlight blocked by clouds above a point
float cloudShadow(vec3 p) {
  if (SUN.y < 0.02) return 0.0;
  float t = (CLOUD_LO + 350.0 - p.y) / SUN.y;
  return clamp(cloudDensity(p + SUN * t, 3) * 2.5, 0.0, 1.0);
}

// ---------- weather ----------
// jagged lightning channel from the cloud base down to the sea
vec3 lightningBolt(vec3 ro, vec3 rd) {
  if (uWeather.w < 0.01 || uBolt.z < 0.5) return vec3(0.0);
  vec2 rh = rd.xz;
  float rr = dot(rh, rh);
  vec2 v = uBolt.xy - ro.xz;
  float t = dot(v, rh) / rr;   // where the ray passes the bolt
  if (t <= 0.0) return vec3(0.0);
  float y = ro.y + rd.y * t;
  if (y < 0.0 || y > CLOUD_LO) return vec3(0.0);
  float sd = uBolt.w;
  vec2 vj = v + (vec2(fbm(vec2(y * 0.006, sd)), fbm(vec2(y * 0.006, sd + 17.0))) - 0.5) * 700.0;
  float dm = length(vj - rh * dot(vj, rh) / rr);
  float glow = exp(-dm / 8.0) * 10.0 + exp(-dm / 90.0) * 0.6;
  // one side branch forking off partway down
  float yb = CLOUD_LO * (0.45 + 0.3 * fract(sd * 0.37));
  if (y < yb && y > yb - 380.0) {
    vec2 dir = normalize(vec2(fract(sd * 0.71), fract(sd * 0.53)) - 0.5 + 0.01);
    vec2 vb = vj + dir * (yb - y) * 0.7
            + (vec2(fbm(vec2(y * 0.02, sd + 5.0)), fbm(vec2(y * 0.02, sd + 9.0))) - 0.5) * 120.0;
    float db = length(vb - rh * dot(vb, rh) / rr);
    glow += (exp(-db / 4.0) * 4.0 + exp(-db / 60.0) * 0.2) * smoothstep(yb - 380.0, yb - 200.0, y);
  }
  return vec3(0.8, 0.86, 1.0) * glow * uWeather.w;
}

// fraction of light lost to fog / rain haze / spray along a ray (height fog)
float fogAmount(vec3 ro, vec3 rd, float t) {
  float rho = uWeather.y;
  if (rho <= 0.0) return 0.0;
  const float H = 70.0;
  float base = rho * exp(-ro.y / H);
  float k = rd.y / H;
  float tau = abs(k) < 1e-5 ? base * t : base * (1.0 - exp(-k * t)) / k;
  return 1.0 - exp(-tau);
}
vec3 fogColor(vec3 rd) {
  float s = max(dot(rd, SUN), 0.0);
  vec3 base = mix(vec3(0.62, 0.67, 0.73), vec3(0.82, 0.85, 0.89), uPrecip.x); // snow whitens it
  base = mix(base, vec3(0.80, 0.54, 0.30), uPrecip.z);                         // dust turns it ochre
  return base * SKY_AMB + SUN_COL * (0.15 + pow(s, 8.0) * 0.7);
}

// one layer of drifting snowflakes; a = (azimuth, elevation) in radians
float snowLayer(vec2 a, float scale, float speed, float dens, float seed, float px) {
  vec2 p = a * scale;
  float cx = floor(p.x);
  float ph = hash(vec2(cx, seed));
  p.y += uTime * speed * (0.75 + 0.5 * ph) + ph * 17.0;   // columns fall at their own pace
  vec2 c = vec2(cx, floor(p.y));
  vec3 h = vec3(hash(c + seed * 3.1), hash(c + seed * 3.1 + 1.7), hash(c + seed * 3.1 + 4.3));
  if (h.x > dens) return 0.0;
  // flakes flutter side to side as they fall
  vec2 o = vec2(0.32 + 0.36 * h.y + 0.15 * sin(uTime * (1.3 + h.z) + h.y * 6.28), 0.3 + 0.4 * h.z);
  float d = length(fract(p) - o);
  float rad = 0.05 + 0.07 * h.z;
  float w = px * scale;                                    // one pixel in cell units
  return (1.0 - smoothstep(rad * 0.3, rad + w, d)) * min(1.0, (rad + w * 0.5) / (w * 1.5));
}

// rainbow opposite the sun: primary at ~42°, fainter reversed secondary at ~51°
vec3 bowBand(float x) {
  float w = smoothstep(0.0, 0.2, x) * smoothstep(1.0, 0.75, x);
  float h = (1.0 - clamp(x, 0.0, 1.0)) * 0.75;            // red outside .. violet inside
  return clamp(abs(mod(h * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0) * w;
}
vec3 rainbow(vec3 rd, out float dark) {
  float th = degrees(acos(clamp(dot(rd, -SUN), -1.0, 1.0)));
  dark = smoothstep(42.0, 43.5, th) * smoothstep(51.0, 49.5, th); // Alexander's dark band
  return bowBand((th - 40.2) / 2.2) + bowBand((53.6 - th) / 3.2) * 0.4
       + vec3(0.05) * smoothstep(41.0, 38.0, th);            // brighter sky inside the bow
}

// waterspout: a rotating funnel of condensation hanging from the cloud base to the sea.
// Returns colour + opacity; tS = distance along the ray.
vec4 waterspout(vec3 ro, vec3 rd, out float tS) {
  tS = 1e5;
  float st = uSpout.z;
  if (st < 0.01) return vec4(0.0);
  vec2 rh = rd.xz;
  float rr = dot(rh, rh);
  vec2 v = uSpout.xy - ro.xz;
  float t = dot(v, rh) / rr;
  if (t <= 0.0) return vec4(0.0);
  vec2 axis = v;
  for (int i = 0; i < 2; i++) {
    float hy = clamp((ro.y + rd.y * t) / CLOUD_LO, 0.0, 1.0);
    // the funnel snakes about and its top trails downwind
    axis = v + (vec2(noise(vec2(hy * 2.7, uTime * 0.07)), noise(vec2(hy * 2.7 + 7.0, uTime * 0.07))) - 0.5) * 160.0 * hy
             + vec2(cos(uWave.z), sin(uWave.z)) * hy * hy * 300.0;
    t = dot(axis, rh) / rr;
  }
  float y = ro.y + rd.y * t;
  if (y < -2.0 || y > CLOUD_LO + 520.0) return vec4(0.0);
  float hn = clamp(y / CLOUD_LO, 0.0, 1.0);
  vec2 perp = axis - rh * t;
  float dm = length(perp);
  vec2 rhN = rh / sqrt(rr);
  vec2 rgt = vec2(rhN.y, -rhN.x);

  // funnel: a thin rope at the sea flaring into the cloud, lowering as it forms
  float bottom = CLOUD_LO * (1.0 - st);
  float R = (12.0 + 25.0 * hn + 330.0 * pow(hn, 5.0)) * smoothstep(bottom - 20.0, bottom + 150.0, y);
  R *= 0.85 + 0.3 * noise(vec2(y * 0.015, uTime * 0.4));   // ragged, pulsing edges
  vec3 fc = vec3(0.0);
  float fa = 0.0;
  if (dm < R) {
    float sp = clamp(-dot(perp, rgt) / R, -1.0, 1.0);    // where across the funnel we look
    float cp = sqrt(1.0 - sp * sp);
    float lam = max(dot(rgt * sp - rhN * cp, SUN.xz), 0.0);
    // faint spiral striations winding round as it spins
    float sw = noise(vec2(asin(sp) * 2.0 + uTime * 2.5 + y * 0.006, y * 0.004));
    fc = vec3(0.6, 0.63, 0.68) * SKY_AMB * (0.8 + 0.25 * sw) * (0.75 + 0.25 * cp) + SUN_COL * lam * 0.35;
    fa = (1.0 - exp(-cp * 3.0)) * (0.8 + 0.25 * sw) * smoothstep(CLOUD_LO + 40.0, CLOUD_LO - 150.0, y);
  }
  // dark, lowered parent cloud the funnel hangs from
  float wall = 0.0;
  vec3 wc = vec3(0.0);
  if (st > 0.05 && y > CLOUD_LO - 320.0 && dm < 1100.0) {
    float n = noise(perp * 0.004 + vec2(0.0, y * 0.004)) * 0.6 + noise(perp * 0.012 + y * 0.01 + uTime * 0.05) * 0.4;
    vec2 e = vec2(dm / 1000.0, (y - CLOUD_LO - 80.0) / 420.0);
    float blob = smoothstep(1.0, 0.55, length(e) + (n - 0.5) * 0.5);
    float base = CLOUD_LO - 250.0 * st * (1.0 - smoothstep(100.0, 900.0, dm)) + (n - 0.5) * 120.0;
    wall = blob * smoothstep(base, base + 80.0, y) * smoothstep(0.05, 0.4, st);
    wc = mix(vec3(0.36, 0.39, 0.44), vec3(0.62, 0.65, 0.7), smoothstep(CLOUD_LO - 200.0, CLOUD_LO + 400.0, y))
       * SKY_AMB * (0.85 + 0.3 * n);
  }
  // spray vortex kicked up where it touches the water
  float touch = smoothstep(0.85, 1.0, st);
  vec3 sc = vec3(0.0);
  float sa = 0.0;
  if (touch > 0.0 && y < 200.0) {
    float Rs = 45.0 + y * 1.3;
    float xs = dm / Rs;
    float sn = noise(vec2(-dot(perp, rgt) / Rs * 3.0 + uTime * 1.5, y * 0.06 - uTime * 0.6));
    sa = exp(-xs * xs * 2.5) * exp(-y / 50.0) * touch * (0.4 + 0.7 * sn);
    sc = vec3(0.82, 0.85, 0.88) * SKY_AMB + SUN_COL * 0.3;
  }
  fa = max(fa, 0.0);
  vec3 c = fc * fa + sc * sa * (1.0 - fa);
  float a = 1.0 - (1.0 - fa) * (1.0 - sa);
  c = c * (1.0 - wall) + wc * wall;
  a = 1.0 - (1.0 - a) * (1.0 - wall);
  if (a < 0.001) return vec4(0.0);
  tS = t;
  return vec4(c / a, clamp(a, 0.0, 1.0));
}

// gusts of blown dust, spindrift and spray streaming past, sampled at a few depths
float veils(vec3 ro, vec3 rd, float tMax) {
  vec2 wd = vec2(cos(uWave.z), sin(uWave.z));
  float acc = 0.0, t = 6.0;
  for (int i = 0; i < 4; i++) {
    if (t > tMax) break;
    vec3 p = ro + rd * t;
    vec2 q = p.xz - uWind.xy;                                  // carried along by the wind
    vec2 s = vec2(dot(q, wd), dot(q, vec2(-wd.y, wd.x)));      // along / across the wind
    float n = fbm(vec2(s.x * 0.05, s.y * 0.2 + p.y * 0.3) + float(i) * 7.3);
    acc += (1.0 - acc) * smoothstep(0.5, 0.85, n) * exp(-max(p.y, 0.0) / 30.0) * 0.6;
    t *= 2.5;
  }
  return acc;
}

// one layer of falling rain streaks; a = (azimuth, elevation) in radians
float rainLayer(vec2 a, float cols, float len, float speed, float dens, float seed, float px, float amount) {
  float x = a.x * cols;
  float c = floor(x);
  float r1 = hash(vec2(c, seed));
  float r2 = hash(vec2(c, seed + 3.7));
  if (r2 > dens * (0.3 + 0.7 * amount)) return 0.0;
  float fx = fract(x) - 0.2 - 0.6 * r1;            // streak position inside its column
  float y = (a.y + uTime * speed) / len + r1 * 37.0;
  float fy = mod(y, 3.0 + r2 * 8.0);               // one drop, then a gap
  float s = smoothstep(0.0, 0.25, fy) * smoothstep(1.0, 0.35, fy);
  float w = max(0.05, px * cols);                  // at least ~1 pixel wide
  return s * (1.0 - smoothstep(0.5 * w, 1.5 * w, abs(fx))) * min(1.0, 0.07 / w);
}

// expanding rings where raindrops hit the water: (normal perturbation, splash)
vec3 rainRipples(vec2 p, float t) {
  vec2 g = vec2(0.0);
  float spl = 0.0;
  for (int l = 0; l < 3; l++) {
    float fl = float(l);
    vec2 q = p * 1.7 + fl * vec2(0.37, 0.61);
    vec2 c = floor(q);
    vec2 h = vec2(hash(c + fl * 11.3), hash(c + fl * 5.7 + 2.1));
    vec2 dv = fract(q) - (0.35 + 0.3 * h);
    float d = length(dv);
    float age = fract(t * 1.1 + h.x * 5.0 + fl * 0.33);
    float s = (d - age * 0.26) * 30.0;
    g += dv / max(d, 1e-3) * (1.0 - age) * (1.0 - age) * exp(-s * s) * sin(s * 2.0);
    spl += exp(-d * d * 900.0) * smoothstep(0.12, 0.0, age);
  }
  return vec3(g, spl);
}

// ---------- sea floor ----------
float floorDepth(vec2 p) {
  float n = fbm(p * 0.03 + 7.0);
  float d = mix(1.0, 9.0, smoothstep(0.40, 0.66, n));   // shallow sand flats vs deep channels
  d += (fbm(p * 0.45) - 0.5) * 0.5;                       // dunes
  d += 0.04 * sin(p.x * 2.6 + sin(p.y * 1.1) * 2.5);      // sand ripples
  return d * uWater.z;
}

// the same bottom without the dunes and ripples: half the cost, never more than 0.3 m off
float floorBase(vec2 p) {
  return (mix(1.0, 9.0, smoothstep(0.40, 0.66, fbm(p * 0.03 + 7.0))) + 0.3) * uWater.z;
}

float causticLayer(vec2 uv, float t) {
  vec2 p = mod(uv * 6.2832, 6.2832) - 250.0;
  vec2 i = p;
  float c = 1.0, inten = 0.005;
  for (int n = 0; n < 5; n++) {
    float tt = t * (1.0 - (3.5 / float(n + 1)));
    i = p + vec2(cos(tt - i.x) + sin(tt + i.y), sin(tt - i.y) + cos(tt + i.x));
    c += 1.0 / length(vec2(p.x / (sin(i.x + tt) / inten), p.y / (cos(i.y + tt) / inten)));
  }
  c /= 5.0;
  c = 1.17 - pow(c, 1.4);
  return pow(abs(c), 8.0);
}

vec3 seaFloor(vec2 p, float depth, float dist) {
  float grain = fbm(p * 2.2);
  vec3 sand = vec3(0.96, 0.88, 0.70) * (0.82 + 0.3 * grain);
  // scattered darker patches (rocks / seagrass)
  float patchN = fbm(p * 0.25 + 31.0);
  sand = mix(sand, vec3(0.32, 0.40, 0.28) * (0.7 + 0.5 * grain), smoothstep(0.66, 0.74, patchN) * 0.8);
  float t = uTime * 0.55 + 23.0;
  float c = causticLayer(p * 0.45, t) * 0.6 + causticLayer(p * 0.31 + 0.37, t * 0.8) * 0.4;
  c *= exp(-depth * 0.12) * (1.0 - smoothstep(25.0, 70.0, dist)) * smoothstep(0.0, 0.3, SUN.y);
  return sand * (0.62 + 1.7 * c);
}

// ---------- creatures: small blended-ellipsoid SDFs ----------
// Each animal is built in its own frame (x to its side, y up, z forward) and ray-marched only
// inside a bounding sphere, so the pixels that miss it pay one ray-sphere test.
float sdEll(vec3 p, vec3 r) {
  float k0 = length(p / r), k1 = length(p / (r * r));
  return k0 * (k0 - 1.0) / max(k1, 1e-6);
}
float smin(float a, float b, float k) {
  float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0);
  return mix(b, a, h) - k * h * (1.0 - h);
}
float sdCap(vec3 p, vec3 a, vec3 b, float r) {
  vec3 pa = p - a, ba = b - a;
  return length(pa - ba * clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0)) - r;
}

// a bottlenose dolphin, 2.3 m, its flukes beating up and down with w
float dolphinSDF(vec3 p, float w) {
  vec3 q = p;
  q.y -= sin(w) * 0.12 * pow(max(-p.z - 0.2, 0.0), 2.0);
  float d = sdEll(q - vec3(0.0, 0.0, 0.15), vec3(0.21, 0.24, 0.85));
  d = smin(d, sdEll(q - vec3(0.0, 0.02, -0.65), vec3(0.08, 0.14, 0.58)), 0.12);
  d = smin(d, sdCap(q, vec3(0.0, -0.05, 0.85), vec3(0.0, -0.06, 1.12), 0.045), 0.08);  // beak
  vec3 f = q - vec3(0.0, 0.3, -0.08);                                                 // raked dorsal fin
  f.z += f.y * 0.9;
  d = smin(d, sdEll(f, vec3(0.025, 0.15, 0.12)), 0.05);
  vec3 k = q - vec3(0.0, 0.0, -1.15);                                                 // swept flukes
  k.z += abs(k.x) * 0.45;
  d = smin(d, sdEll(k, vec3(0.32, 0.025, 0.1)), 0.04);
  vec3 s = q - vec3(0.0, -0.13, 0.45);                                                // flippers
  s.x = abs(s.x) - 0.2;
  s.y += s.x * 0.6;
  s.z += s.x * 0.5;
  return smin(d, sdEll(s, vec3(0.15, 0.02, 0.07)), 0.04);
}

// a humpback whale, 14 m, with its long white flippers
float whaleSDF(vec3 p, float w) {
  vec3 q = p;
  q.y -= sin(w) * 0.5 * pow(max(-p.z - 2.0, 0.0) / 5.0, 2.0);
  float d = sdEll(q - vec3(0.0, 0.0, 1.0), vec3(1.6, 1.7, 5.0));
  d = smin(d, sdEll(q - vec3(0.0, 0.25, -3.8), vec3(0.6, 1.0, 3.4)), 1.0);
  d = smin(d, sdEll(q - vec3(0.0, 1.35, -2.6), vec3(0.14, 0.4, 0.6)), 0.3);         // small dorsal hump
  vec3 k = q - vec3(0.0, 0.25, -7.0);                                                 // flukes
  k.z += abs(k.x) * 0.35;
  d = smin(d, sdEll(k, vec3(2.3, 0.15, 0.75)), 0.4);
  vec3 s = q - vec3(0.0, -0.8, 2.3);                                                  // flippers, a third of its length
  s.x = abs(s.x) - 2.0;
  s.z += s.x * 0.55;
  s.y += s.x * 0.35;
  return smin(d, sdEll(s, vec3(2.0, 0.13, 0.42)), 0.4);
}

// what shows of a shark: the dorsal fin cutting the water and the tip of the tail swinging behind
float sharkSDF(vec3 p, float w) {
  vec3 f = p - vec3(0.0, 0.0, 0.8);
  float h = clamp(f.y / 0.55, 0.0, 1.0);
  float lead = 0.3 - 0.5 * h, trail = -0.32 + 0.12 * h * h;  // swept leading edge, curved trailing edge
  float plan = max(max(f.z - lead, trail - f.z) * 0.75, max(-f.y - 0.6, f.y - 0.55));
  float d = max(plan, abs(f.x) - 0.035 * (1.0 - h) - 0.006);
  vec3 t = p - vec3(sin(w) * 0.18, 0.0, -0.9);
  float ht = clamp(t.y / 0.35, 0.0, 1.0);
  float planT = max(max(t.z - (0.1 - 0.35 * ht), (-0.12 - 0.3 * ht) - t.z) * 0.75, max(-t.y - 0.6, t.y - 0.35));
  return min(d, max(planT, abs(t.x) - 0.025 * (1.0 - ht) - 0.005));
}

// a manta ray, 4 m across, its wings rippling in slow beats
float mantaSDF(vec3 p, float w) {
  float ax = abs(p.x);
  p.y -= sin(w - ax * 0.9) * 0.16 * ax * ax;
  float zc = p.z + 0.12 * ax * ax;                                 // wings curving back to the tips
  float lead = (1.2 * ax + 2.1 * (zc - 0.9)) / 2.42;               // leading edge
  float trail = (0.6 * (ax - 2.1) - 1.8 * (zc + 0.3)) / 1.9;      // trailing edge back to the tail
  float plan = max(lead, trail) * 0.8;
  float th = 0.1 * pow(max(1.0 - ax / 2.2, 0.0), 1.5) + 0.01 + 0.09 * exp(-ax * ax * 6.0);
  vec2 e = vec2(plan, abs(p.y) - th);
  float d = length(max(e, 0.0)) + min(max(e.x, e.y), 0.0);
  vec3 c = p - vec3(0.0, 0.0, 0.95);                                // the two horn-like head fins
  c.x = abs(c.x) - 0.32;
  d = min(d, sdEll(c, vec3(0.06, 0.04, 0.2)));
  return min(d, sdCap(p, vec3(0.0, 0.0, -0.6), vec3(0.0, 0.05, -1.9), 0.02));
}

// a green sea turtle, 1.2 m, rowing with its long front flippers
float turtleSDF(vec3 p, float w) {
  float d = sdEll(p, vec3(0.42, 0.17, 0.55));
  d = smin(d, sdEll(p - vec3(0.0, -0.02, 0.62), vec3(0.11, 0.09, 0.15)), 0.08);
  vec3 f = p - vec3(0.0, -0.03, 0.25);
  f.x = abs(f.x) - 0.42;
  f.y -= f.x * sin(w) * 0.45;
  f.z += f.x * (0.6 + 0.25 * cos(w));
  d = smin(d, sdEll(f, vec3(0.36, 0.028, 0.09)), 0.05);
  vec3 r = p - vec3(0.0, -0.04, -0.45);
  r.x = abs(r.x) - 0.22;
  r.z += r.x * 0.6;
  return smin(d, sdEll(r, vec3(0.13, 0.025, 0.08)), 0.04);
}

float creatureSDF(vec3 p, int kind, float w) {
  if (kind == 0) return dolphinSDF(p, w);
  if (kind == 1) return whaleSDF(p, w);
  if (kind == 2) return sharkSDF(p, w);
  if (kind == 3) return mantaSDF(p, w);
  return turtleSDF(p, w);
}

// the creature's frame: side, up and forward axes for a heading (radians, 0 along +x),
// a pitch (nose up) and a roll
mat3 creatureBasis(float hd, float pitch, float roll) {
  vec3 Z = vec3(cos(hd) * cos(pitch), sin(pitch), sin(hd) * cos(pitch));
  vec3 X = vec3(-sin(hd), 0.0, cos(hd));
  vec3 Y = cross(X, Z);
  return mat3(X * cos(roll) + Y * sin(roll), Y * cos(roll) - X * sin(roll), Z);
}

// march one creature inside its bounding sphere (centre C, radius R, frame B). Returns the
// distance along the ray (1e5 for a miss) with the pixel's coverage, so silhouettes stay smooth,
// and the closest point and normal in the creature's own frame.
float marchCreature(vec3 ro, vec3 rd, vec3 C, mat3 B, float R, int kind, float w, float maxT,
                    out float cov, out vec3 lp, out vec3 nl) {
  cov = 0.0;
  vec3 oc = ro - C;
  float b = dot(oc, rd);
  float h = b * b - dot(oc, oc) + R * R;
  if (h < 0.0) return 1e5;
  h = sqrt(h);
  float t = max(-b - h, 0.05), t1 = min(-b + h, maxT);
  if (t >= t1) return 1e5;
  vec3 lo = oc * B, ld = rd * B;   // into the creature's frame
  float best = 1e5, bt = t;
  for (int i = 0; i < 36; i++) {
    vec3 q = lo + ld * t;
    float d = creatureSDF(q, kind, w);
    float r = d / (PX * t);
    if (r < best) { best = r; bt = t; lp = q; }
    if (r < 0.3) break;
    t += d * 0.8;
    if (t > t1) break;
  }
  cov = smoothstep(1.3, 0.3, best);
  if (cov <= 0.0 || bt > maxT) { cov = 0.0; return 1e5; }
  float e = 0.004 * R;
  nl = vec3(0.0);
  for (int k = 0; k < 4; k++) {
    vec3 s = k == 0 ? vec3(1.0, -1.0, -1.0) : k == 1 ? vec3(-1.0, -1.0, 1.0) : k == 2 ? vec3(-1.0, 1.0, -1.0) : vec3(1.0);
    nl += s * creatureSDF(lp + s * e, kind, w);
  }
  nl = normalize(nl);
  return bt;
}

// ---------- the reef: coral heads, rocks and kelp ----------
// coral in pinks, oranges, purples, yellows and greens, or a plain rock, lit by its normal
vec3 reefColour(vec3 p, vec2 c, vec3 n) {
  vec2 q = vec2(p.x + p.y, p.z - p.y);
  float k = hash(c + 23.0);
  vec3 cc = k < 0.18 ? vec3(1.3, 0.3, 0.5) : k < 0.34 ? vec3(1.35, 0.55, 0.12) : k < 0.48 ? vec3(0.75, 0.25, 1.0)
          : k < 0.6 ? vec3(1.25, 1.05, 0.2) : k < 0.72 ? vec3(0.25, 0.95, 0.55) : vec3(0.5, 0.47, 0.42);
  if (k < 0.72) {
    // brain-coral grooves on some heads, polyp speckle on the rest
    float g = hash(c + 31.0) < 0.5 ? smoothstep(-0.4, 0.4, sin(noise(q * 4.0 + k * 9.0) * 22.0))
                                   : smoothstep(0.55, 0.75, noise(q * 22.0));
    cc *= 0.72 + 0.35 * g;
  } else {
    cc *= 0.65 + 0.5 * noise(q * 7.0);
    cc = mix(cc, vec3(0.28, 0.4, 0.22), smoothstep(0.5, 0.8, noise(q * 3.0 + 2.0)) * 0.6 * max(n.y, 0.0));  // algae on top
  }
  return cc * (0.35 + 0.65 * max(dot(n, normalize(vec3(SUN.x, max(SUN.y, 0.4), SUN.z))), 0.0));
}

// The reef is laid out on a 3 m grid: a cell may hold a coral head or rock (one or two
// half-buried ellipsoids, hit exactly) and a kelp stalk, tall fronds swaying up from the sand in
// patchy forests. The ray walks the cells it crosses, nearest first, and draws each stalk as a
// ribbon facing the camera, so a pixel pays a few cheap tests per cell and the walk stops at the
// first solid hit or the sand.
vec4 reefAndKelp(vec3 ro, vec3 rd, float maxT, float shift, float t, vec3 light, vec3 waterCol, vec3 absorb, vec3 ext) {
  const float CS = 3.0;
  vec4 acc = vec4(0.0);
  vec2 dxz = rd.xz;
  if (dot(dxz, dxz) < 0.01) return acc;
  dxz = vec2(abs(dxz.x) < 1e-4 ? 1e-4 : dxz.x, abs(dxz.y) < 1e-4 ? 1e-4 : dxz.y);
  vec2 cell = floor(ro.xz / CS);
  vec2 stp = sign(dxz);
  vec2 tDelta = abs(CS / dxz);
  vec2 tMax = ((cell + max(stp, 0.0)) * CS - ro.xz) / dxz;
  vec2 perp = normalize(vec2(-dxz.y, dxz.x));
  float lim = min(maxT, 32.0), tEnter = 0.0;
  for (int i = 0; i < 16; i++) {
    if (tEnter > lim || acc.a > 0.97) break;
    float tR = maxT, covR = 0.0;
    vec3 rc = vec3(0.0);
    if (hash(cell + 17.3) < smoothstep(0.4, 0.68, noise(cell * 0.17 + 4.0)) * 0.75) {
      for (int k = 0; k < 2; k++) {
        float fk = float(k);
        if (k == 1 && hash(cell + 12.9) < 0.4) break;
        vec2 o = (cell + 0.2 + 0.6 * vec2(hash(cell + 3.1 + fk), hash(cell + 5.7 + fk))) * CS;
        float r = (0.55 + 0.6 * hash(cell + 9.2 + fk)) * (1.0 - 0.4 * fk);
        float tall = hash(cell + 1.3 + fk);   // low domes and boulders, a few tall pillars
        vec3 rr = vec3(r, r * (tall > 0.8 ? 1.25 : 0.5 + 0.5 * tall), r * (0.75 + 0.5 * hash(cell + 2.9 + fk)));
        if (tall > 0.8) rr.xz *= 0.7;
        float fb = floorBase(o);
        if (fb > 6.0 * uWater.z) break;                    // coral keeps to the shallows, not the channels
        vec3 c = vec3(o.x, -fb - shift, o.y);             // sunk a little into the sand
        vec3 oc = (ro - c) / rr, dd = rd / rr;
        float a = dot(dd, dd), b = dot(oc, dd), c2 = dot(oc, oc);
        float th = (-b - sqrt(max(b * b - a * (c2 - 1.0), 0.0))) / a;
        float cv = clamp((1.0 - sqrt(max(c2 - b * b / a, 0.0))) * r / (PX * max(th, 0.1)) + 0.5, 0.0, 1.0);
        if (cv > 0.0 && th > 0.2 && th < tR) {
          vec3 hp = ro + rd * th;
          vec3 n = normalize((hp - c) / (rr * rr));
          n = normalize(n + 0.45 * vec3(noise(hp.xz * 7.0 + hp.y) - 0.5, 0.0, noise(hp.zx * 7.0 - hp.y) - 0.5));
          vec3 cc = reefColour(hp, cell + fk * 7.0, n) * (0.55 + 0.45 * smoothstep(c.y, c.y + rr.y, hp.y));
          // coral keeps more of its colour than the sand: the eye adapts to the blue
          cc *= light * exp(-absorb * max(-hp.y, 0.0) * 0.2);
          vec3 T = exp(-mix(ext, vec3(ext.b), 0.8) * th);
          rc = cc * T + waterCol * (1.0 - T);
          tR = th;
          covR = cv;
        }
      }
    }
    float hc = hash(cell + 41.7);
    if (hc < smoothstep(0.48, 0.72, noise(cell * 0.11 + 5.0)) * 0.6) {
      vec2 base = (cell + 0.25 + 0.5 * vec2(hash(cell + 3.3), hash(cell + 8.1))) * CS;
      float fd = floorBase(base) + shift;
      float H = min(fd - 0.7, fd * (0.55 + 0.4 * hash(cell + 2.2)));
      if (H > 0.8) {
        float ph = hc * 40.0;
        // leaning with the current, swaying back and forth
        vec2 sway = (vec2(0.5, 0.25) * (0.6 + 0.5 * sin(t * 0.45 + ph)) + vec2(sin(t * 0.8 + ph), cos(t * 0.6 + ph)) * 0.2) * H * 0.18;
        vec2 b = base;
        float tc = 0.0;
        for (int k = 0; k < 2; k++) {
          tc = dot(b - ro.xz, dxz) / dot(dxz, dxz);           // closest approach to the stalk
          float s = clamp((ro.y + rd.y * tc + fd) / H, 0.0, 1.0);
          b = base + sway * s * s;                             // it bends most near the top
        }
        float yy = ro.y + rd.y * tc + fd;                      // height above the root
        float lat = dot(b - ro.xz, perp);
        // a thin stipe with long blades sprouting off it, alternating sides, fluttering
        float off = 0.06 * sin(yy * 1.7 + ph + t * 0.8);
        float bp = yy / 0.5 + ph;
        float bf = fract(bp);
        float side = mod(floor(bp), 2.0) * 2.0 - 1.0;
        float bw = 0.075 * sin(3.1416 * bf) * smoothstep(0.2, 0.7, yy) * (0.8 + 0.4 * sin(t * 1.4 + bp));
        float rel = lat - off - side * (bw + 0.01);
        float sdf = max(min(abs(lat - off) - 0.018, abs(rel) - bw), max(-yy, yy - H - 0.25 * bf));
        float cov = clamp(0.5 - sdf / (PX * tc), 0.0, 1.0) * step(0.2, tc) * step(tc, tR);
        if (cov > 0.0) {
          float s = yy / H;
          vec3 kc = mix(vec3(0.16, 0.19, 0.045), vec3(0.3, 0.25, 0.07), hash(cell + 6.6));
          kc *= 0.7 + 0.5 * clamp(1.0 - abs(rel) / max(bw, 0.02), 0.0, 1.0) * (0.8 + 0.4 * noise(vec2(rel * 60.0, yy * 4.0)));
          kc *= light * (0.25 + 0.55 * s) + waterCol * 0.5;
          kc += light * vec3(0.25, 0.32, 0.05) * pow(max(rd.y, 0.0), 2.0) * 0.6;   // sunlight glowing through
          vec3 T = exp(-ext * tc);
          kc = kc * T + waterCol * (1.0 - T);
          acc.rgb += (1.0 - acc.a) * cov * kc;
          acc.a += (1.0 - acc.a) * cov;
        }
      }
    }
    acc.rgb += (1.0 - acc.a) * covR * rc;
    acc.a += (1.0 - acc.a) * covR;
    if (tMax.x < tMax.y) { tEnter = tMax.x; tMax.x += tDelta.x; cell.x += stp.x; }
    else { tEnter = tMax.y; tMax.y += tDelta.y; cell.y += stp.y; }
  }
  return acc;
}

// big gliders keeping the diver company: two manta rays flying wide slow circles, one above and
// one below, and a sea turtle paddling round closer in
vec4 seaGliders(vec3 ro, vec3 rd, float t, float maxT, vec3 light, vec3 waterCol, vec3 ext, out float tHit) {
  tHit = 1e5;
  if (uFauna.w < 0.01) return vec4(0.0);
  float bestC = 0.0;
  vec3 bestP = vec3(0.0), bestN = vec3(0.0, 1.0, 0.0);
  mat3 bestB = mat3(1.0);
  int bestK = 3;
  for (int i = 0; i < 3; i++) {
    float fi = float(i);
    bool turtle = i == 2;
    float sg = i == 1 ? -1.0 : 1.0;
    float ca = t * (turtle ? 0.07 : 0.045 + 0.012 * fi) * sg + fi * 2.6;
    float rad = turtle ? 7.5 + 1.5 * sin(t * 0.09) : 12.0 + 4.0 * fi;
    vec3 C = ro + vec3(cos(ca) * rad, 0.0, sin(ca) * rad);
    // one manta high, seen from below against the light, one low, banking to show its back
    C.y = min(ro.y + (turtle ? 0.6 : 3.5 - 4.7 * fi) + sin(t * 0.15 + fi * 2.0), turtle ? -1.2 : -1.8);
    float hd = atan(cos(ca) * sg, -sin(ca) * sg);
    mat3 B = creatureBasis(hd, 0.06 * cos(t * 0.15 + fi * 2.0), turtle ? 0.0 : -0.35 * sg);
    int kind = turtle ? 4 : 3;
    float cv;
    vec3 lp, nl;
    float th = marchCreature(ro, rd, C, B, turtle ? 0.95 : 2.4, kind, t * (turtle ? 1.3 : 1.5) + fi * 2.0, maxT, cv, lp, nl);
    if (cv > 0.0 && th < tHit) { tHit = th; bestC = cv; bestP = lp; bestN = nl; bestB = B; bestK = kind; }
  }
  if (bestC <= 0.0) return vec4(0.0);
  vec3 n = normalize(bestB * bestN);
  vec3 base;
  if (bestK == 3) {
    // dark back with pale shoulder patches, white belly
    float ax = abs(bestP.x);
    vec3 back = mix(vec3(0.07, 0.08, 0.1), vec3(0.6, 0.62, 0.62), smoothstep(0.25, 0.1, abs(ax - 0.6) + max(bestP.z - 0.1, -bestP.z - 0.5) * 0.6));
    base = mix(vec3(0.82, 0.83, 0.82), back, smoothstep(-0.2, 0.2, bestN.y));
  } else {
    // a mottled shell of plates over olive skin
    float shell = sdEll(bestP, vec3(0.42, 0.17, 0.55));
    vec2 pl = bestP.xz * vec2(6.0, 5.0);
    float plates = smoothstep(0.0, 0.15, abs(fract(pl.x + 0.5 * floor(pl.y)) - 0.5) * abs(fract(pl.y) - 0.5) * 4.0);
    vec3 sh = mix(vec3(0.2, 0.15, 0.08), vec3(0.45, 0.33, 0.16), plates * (0.6 + 0.4 * noise(bestP.xz * 9.0)));
    vec3 skin = vec3(0.42, 0.42, 0.3) * (0.7 + 0.5 * noise(bestP.xz * 20.0));
    base = mix(sh, skin, smoothstep(0.0, 0.03, shell));
    base = mix(base, vec3(0.75, 0.68, 0.45), smoothstep(-0.2, -0.6, bestN.y) * step(shell, 0.03));  // pale plastron
  }
  vec3 c = base * (light * (0.2 + 0.7 * max(n.y, 0.0) + 0.3 * max(-n.y, 0.0)) + waterCol * 0.9);
  vec3 T = exp(-ext * tHit);
  return vec4(c * T + waterCol * (1.0 - T), bestC * clamp(uFauna.w * 2.0, 0.0, 1.0));
}

// ---------- under the sea ----------
// a school of small silvery fish milling around in loose rings, keeping company with the
// diver: it slowly circles around you at a curious distance. Fish are lit, countershaded
// slivers pointing the way they swim, with a beating tail and a silver flash as they turn.
vec3 fishSchool(vec3 ro, vec3 rd, float t, float maxT, vec3 col, vec3 waterCol, vec3 light, vec3 ext) {
  float hs = 0.37;
  float ca = t * 0.04;
  vec3 C = ro + vec3(cos(ca), 0.0, sin(ca)) * (9.0 + 3.0 * sin(t * 0.11));
  C.y = min(ro.y + sin(t * 0.13) * 1.2, -1.6);
  for (int i = 0; i < 28; i++) {
    float fi = float(i);
    float h1 = hash(vec2(fi, hs * 31.0)), h2 = hash(vec2(fi + 7.7, hs * 17.0)), h3 = hash(vec2(fi + 3.3, hs * 5.0));
    float R = 2.5 + 4.0 * h1;
    float w = (0.35 + 0.2 * h2) / R * 2.2;                  // all circle the same way, inner ones faster
    float a = t * w + fi * 2.39;
    vec3 P = C + vec3(cos(a) * R, (h3 - 0.5) * 2.5 + sin(t * 0.7 + fi) * 0.3, sin(a) * R);
    vec3 dirF = normalize(vec3(-sin(a), 0.08 * cos(t * 0.7 + fi), cos(a)));
    vec3 v = P - ro;
    float D = length(v);
    if (D > maxT || D < 0.3) continue;
    vec3 dv = v / D;
    if (dot(rd, dv) < 0.985) continue;
    vec3 rgt = normalize(cross(vec3(0.0, 1.0, 0.0), dv));
    vec3 up = cross(dv, rgt);
    float L = 0.16 + 0.08 * h2;                               // half body length in metres
    vec2 q = vec2(dot(rd, rgt), dot(rd, up)) * D;             // offset at the fish, in metres
    vec2 ax = vec2(dot(dirF, rgt), dot(dirF, up));
    float al = length(ax);
    ax = al > 1e-3 ? ax / al : vec2(1.0, 0.0);
    vec2 lq = vec2(dot(q, ax), dot(q, vec2(-ax.y, ax.x)));    // along / across the fish
    float lenA = L * max(al, 0.25);                           // head-on fish look short
    float tail = sin(t * 14.0 + fi * 3.0) * 0.25 * L;
    float bx = lq.x / lenA;
    // slim body, deepest just behind the head and tapering to the tail
    float body = length(vec2(bx, lq.y / (L * 0.2 * (1.0 - 0.45 * max(-bx, 0.0)) * (1.0 - 0.25 * max(bx, 0.0))))) - 1.0;
    float tailT = lq.x < -0.8 * lenA ? abs(lq.y - tail * (-lq.x / lenA - 0.8)) - (-lq.x / lenA - 0.8) * L * 0.55 : 1.0;
    tailT = max(tailT, -1.25 * lenA - lq.x);
    float sdf = min(body * L * 0.25, tailT);
    float cov = clamp(0.5 - sdf / (PX * D), 0.0, 1.0);
    if (cov <= 0.0) continue;
    float flash = pow(max(dot(reflect(rd, normalize(vec3(-dirF.z, 0.3, dirF.x))), SUN), 0.0), 12.0);
    vec3 fc = mix(vec3(0.25, 0.32, 0.38), vec3(0.75, 0.8, 0.82), smoothstep(-0.5, 0.5, lq.y / (L * 0.28) * sign(ax.x + 1e-3)));
    fc = fc * (light * 0.55 + waterCol * 0.8) + light * flash * 1.5;
    vec3 T = exp(-ext * D);
    col = mix(col, fc * T + waterCol * (1.0 - T), cov);
  }
  return col;
}
// Looking up: the wavy surface from below, with the sky squeezed into a bright circle
// (Snell's window) and mirror-like total reflection outside it. Looking down: the sandy
// floor with its caustics. In between: blue-green water, shafts of light, drifting specks.
vec3 underwaterView(vec3 ro, vec3 rd, float t) {
  float murk = uWater.y;
  vec3 absorb = vec3(0.36, 0.068, 0.045) * murk * mix(1.0, 0.5, uClimate.x);
  vec3 light = SUN_COL * 0.85 * smoothstep(-0.02, 0.4, SUN.y) + SKY_AMB * 0.2 + MOON_COL * 0.5;
  float camDepth = -ro.y;
  vec3 deep = mix(vec3(0.02, 0.26, 0.34), vec3(0.06, 0.24, 0.2), smoothstep(1.0, 3.0, murk) * 0.7);
  deep = mix(mix(deep, vec3(0.0, 0.36, 0.40), uClimate.x), vec3(0.02, 0.09, 0.13), uClimate.y);
  // the water glows toward the light above and darkens with depth
  vec3 waterCol = deep * (SKY_AMB * 0.45 + light * 0.55) * (0.25 + 1.3 * pow(rd.y * 0.5 + 0.5, 2.0))
                * exp(-absorb * camDepth * 0.5);
  vec3 ext = absorb * 0.6 + 0.06 * murk; // absorption plus the haze of suspended particles
  vec3 col;
  float dist;
  if (rd.y > 0.0) {
    float ts = camDepth / rd.y;
    vec3 w;
    for (int i = 0; i < 3; i++) {
      vec3 p = ro + rd * ts;
      w = waves(p.xz, t, ts);
      ts = max((w.x - ro.y) / rd.y, 0.0);
    }
    dist = ts;
    vec3 p = ro + rd * ts;
    w = waves(p.xz, t, ts);
    vec3 n = normalize(vec3(-w.y, 1.0, -w.z));
    vec3 tr = refract(rd, -n, 1.333);
    vec3 mirror = waterCol * 1.3;                         // the lit water below, reflected
    if (dot(tr, tr) < 1e-4) {
      col = mirror;                                       // total internal reflection
    } else {
      // reflection rises smoothly toward the window's edge, giving it a bright soft rim
      float F = 0.02 + 0.98 * pow(1.0 - max(dot(tr, n), 0.0), 5.0);
      vec3 sky = skyBase(tr, false) + SUN_COL * pow(max(dot(tr, SUN), 0.0), 200.0) * 25.0
               + MOON_COL * pow(max(dot(tr, MOON), 0.0), 300.0) * 20.0;
      col = mix(sky, mirror, F);
    }
  } else {
    // where the sea is shallower than the diver, the bottom drops away so there is always
    // room to swim: never end up inside the sand
    float shift = max(0.0, camDepth + 2.5 - floorDepth(ro.xz));
    // march the ray down to the sandy bottom in growing steps, then home in on the crossing
    float t0 = 0.0, t1 = 0.0, d = 0.0;
    float stp = 0.4;
    bool hit = false;
    for (int i = 0; i < 28; i++) {
      t1 = t0 + stp;
      vec3 q = ro + rd * t1;
      if (q.y < -floorDepth(q.xz) - shift) { hit = true; break; }
      t0 = t1;
      stp *= 1.15;
    }
    float tf = t1;
    if (hit) {
      for (int i = 0; i < 5; i++) {
        float tm = 0.5 * (t0 + t1);
        vec3 q = ro + rd * tm;
        if (q.y < -floorDepth(q.xz) - shift) t1 = tm; else t0 = tm;
      }
      tf = t1;
    }
    d = floorDepth((ro + rd * tf).xz) + shift;
    dist = tf;
    vec3 q = ro + rd * tf;
    vec3 sand = mix(seaFloor(q.xz, d, tf), vec3(0.85, 0.8, 0.66) * (0.8 + 0.4 * fbm(q.xz * 1.5)), 0.45);
    col = sand * light * exp(-absorb * d * 0.8);
  }
  vec3 T = exp(-ext * dist);
  col = col * T + waterCol * (1.0 - T);

  // god rays: flickering shafts where the waves focus sunlight, fading with distance
  float shafts = 0.0;
  float jit = hash(gl_FragCoord.xy + fract(t));
  for (int i = 0; i < 10; i++) {
    float s = (float(i) + jit) * 2.4;
    if (s > dist) break;
    vec3 q = ro + rd * s;
    if (q.y > 0.0) break;
    vec2 sp = q.xz + SUN.xz / max(SUN.y, 0.25) * q.y;   // trace up the sunbeam to the surface
    shafts += causticLayer(sp * 0.06, t * 0.35) * exp(-s * 0.09);
  }
  col += light * vec3(0.35, 0.75, 0.8) * shafts * 0.07 * smoothstep(0.0, 0.3, SUN.y);

  // mantas and a turtle, then the coral and kelp in front of them, then the little fish
  float tG;
  vec4 gd = seaGliders(ro, rd, t, dist, light, waterCol, ext, tG);
  col = mix(col, gd.rgb, gd.a);
  vec4 kelp = reefAndKelp(ro, rd, gd.a > 0.5 ? tG : dist, max(0.0, camDepth + 2.5 - floorDepth(ro.xz)), t, light, waterCol, absorb, ext);
  col = col * (1.0 - kelp.a) + kelp.rgb;

  col = fishSchool(ro, rd, t, dist, col, waterCol, light, ext);

  // marine snow: tiny specks drifting in the water
  float elv = asin(clamp(rd.y, -1.0, 1.0));
  vec2 a = vec2(atan(rd.x, rd.z), elv);
  float sn = snowLayer(a, 40.0, 0.06, 0.05, 21.0, PX) + snowLayer(a, 90.0, 0.04, 0.07, 22.0, PX) * 0.5;
  col += (light * 0.2 + waterCol) * sn * 0.35;
  return col;
}

// ---------- the island and its lighthouse ----------
const vec3 ISLE = vec3(-500.0, 0.0, 1500.0);
const float ISLE_R = 420.0, ISLE_H = 95.0;
const vec2 LIGHT_XZ = vec2(-418.0, 1253.0);   // on the shore facing the open sea
const vec2 BEACH_DIR = vec2(0.906, -0.423);   // the sandy cove on the south-east shore
const vec3 JETTY = vec3(-192.0, 1356.0, 1.9); // landward end of the jetty, deck height
const float JETTY_L = 72.0;                    // it runs straight out along BEACH_DIR

// how far inland of the ragged coastline a point is (m, negative offshore), and how much
// of the beach it is on
vec2 isleCoast(vec2 p) {
  float n = noise(p * 0.004 + 3.0) * 0.65 + noise(p * 0.011 + 7.0) * 0.35;
  vec2 d = p - ISLE.xz;
  float r = length(d) / ISLE_R + (n - 0.5) * 0.5;
  return vec2((1.0 - r) * ISLE_R, smoothstep(0.80, 0.95, dot(d, BEACH_DIR) / max(length(d), 1.0)));
}
float isleHeight(vec2 p) {
  vec2 c = isleCoast(p);
  float m = noise(p * 0.007 + 13.0);
  float k = max(c.x / ISLE_R, 0.0);
  float h = ISLE_H * pow(k, 1.25) * (0.55 + 0.9 * m);
  h += 14.0 * smoothstep(0.0, 0.08, k);                                 // sea cliffs ringing the coast
  float ridges = 1.0 - abs(noise(p * 0.022 + 5.0) * 2.0 - 1.0);         // sharp ridges and gullies
  h += (ridges * 16.0 + noise(p * 0.06 + 2.0) * 5.0) * smoothstep(0.02, 0.25, k);
  h -= 4.0 + 10.0 * (1.0 - smoothstep(0.0, 0.02, k));
  // in the cove the cliffs give way to a gently shelving beach that runs on under the sea
  float sand = clamp(c.x * 0.045 - 0.8, -6.0, 4.0);
  return mix(h, mix(sand, h, smoothstep(70.0, 260.0, c.x)), c.y);
}
float isleDetail(vec2 p) {
  float h = isleHeight(p);
  return h + (fbm(p * 0.08) - 0.5) * 4.0 * smoothstep(0.0, 10.0, h);  // rocks and gullies
}
float lighthouseBase() { return max(isleHeight(LIGHT_XZ), 4.0); }

// the light to cast shadows from: the sun by day, the moon by night
vec3 shadowLight() { return SUN.y > 0.0 ? SUN : MOON; }

// soft shadow of the island's hills: a few growing steps toward the light (1 = fully shaded)
float isleShadow(vec3 p, vec3 L) {
  if (L.y < 0.01) return 0.0;
  float res = 1.0, s = 1.5;
  for (int i = 0; i < 14; i++) {
    vec3 q = p + L * s;
    if (q.y > 175.0) break;                                   // above the highest peak
    res = min(res, 10.0 * (q.y - isleHeight(q.xz)) / s);
    if (res < 0.0) break;
    s += max(3.0, s * 0.4);
  }
  return 1.0 - smoothstep(0.0, 1.0, res);
}

// shadow of the lighthouse tower: the closest pass of the light ray by its axis
float lighthouseShadow(vec3 p, vec3 L, float hb) {
  if (L.y < 0.01) return 0.0;
  vec2 v = LIGHT_XZ - p.xz;
  float s = dot(v, L.xz) / max(dot(L.xz, L.xz), 1e-4);
  if (s <= 0.0) return 0.0;
  float y = p.y + L.y * s - hb;
  float R = y < 26.0 ? 4.2 - y * 0.06 : 2.7;
  return (1.0 - smoothstep(-0.6, 0.6, length(v - L.xz * s) - R)) * step(-2.0, y) * (1.0 - smoothstep(34.0, 36.0, y));
}

// the jetty in its own frame: x out along the jetty, y up, z across
vec3 jettyLocal(vec3 p) {
  vec2 d = p.xz - JETTY.xy;
  return vec3(dot(d, BEACH_DIR), p.y, dot(d, vec2(-BEACH_DIR.y, BEACH_DIR.x)));
}
// planked deck on two stringers, standing on rows of posts
float jettySDF(vec3 q) {
  float dy = JETTY.z;
  vec3 b = abs(q - vec3(JETTY_L * 0.5, dy - 0.06, 0.0)) - vec3(JETTY_L * 0.5, 0.06, 1.5);
  float deck = min(max(b.x, max(b.y, b.z)), 0.0) + length(max(b, 0.0));
  deck = max(deck, 0.012 - abs(mod(q.x, 0.3) - 0.15));                  // gaps between planks
  vec3 sb = abs(vec3(q.x - JETTY_L * 0.5, q.y - dy + 0.28, abs(q.z) - 1.2)) - vec3(JETTY_L * 0.5, 0.16, 0.09);
  float beam = min(max(sb.x, max(sb.y, sb.z)), 0.0) + length(max(sb, 0.0));
  float xi = clamp(floor(q.x / 4.0 + 0.5), 0.0, JETTY_L / 4.0);
  float top = dy + (xi > JETTY_L / 4.0 - 1.5 ? 0.9 : 0.0);              // mooring posts at the end
  vec2 pc = vec2(q.x - xi * 4.0, abs(q.z) - 1.35);
  float post = max(length(pc) - 0.16, max(q.y - top, -6.0 - q.y));
  return min(min(deck, beam), post);
}
// how much the jetty's deck blocks the light at p (analytic slab test against the deck box)
float jettyShadow(vec3 p, vec3 L) {
  if (L.y < 0.01) return 0.0;
  vec3 q = jettyLocal(p);
  vec3 l = vec3(dot(L.xz, BEACH_DIR), L.y, dot(L.xz, vec2(-BEACH_DIR.y, BEACH_DIR.x)));
  vec3 lo = (vec3(0.0, JETTY.z - 0.45, -1.5) - q) / l, hi = (vec3(JETTY_L, JETTY.z, 1.5) - q) / l;
  vec3 mn = min(lo, hi), mx = max(lo, hi);
  float t0 = max(max(mn.x, mn.y), mn.z), t1 = min(min(mx.x, mx.y), mx.z);
  return t1 > max(t0, 0.0) ? 0.85 : 0.0;   // light leaks between the planks
}

// sun- or moonlight reaching a point on the island or the shallows: hills, tower, jetty, clouds
float isleSunlight(vec3 p, float hb, bool hills) {
  vec3 L = shadowLight();
  float sh = hills ? isleShadow(p, L) : 0.0;
  sh = max(sh, lighthouseShadow(p, L, hb));
  if (length(p.xz - JETTY.xy - BEACH_DIR * JETTY_L * 0.5) < JETTY_L) sh = max(sh, jettyShadow(p, L));
  return (1.0 - sh) * (1.0 - 0.85 * cloudShadow(p));
}

// ray-marched rocky island: cliffs, grass on the gentle slopes, a beach and a line of surf
// (steps: 64 seen directly, fewer for its reflection in the sea)
vec4 island(vec3 ro, vec3 rd, vec3 haze, int steps, out float tI) {
  tI = 1e5;
  vec2 oc = ro.xz - ISLE.xz;
  float a = dot(rd.xz, rd.xz), b = dot(oc, rd.xz), c = dot(oc, oc) - ISLE_R * ISLE_R * 1.7;
  float disc = b * b - a * c;
  if (disc < 0.0 || a < 1e-6) return vec4(0.0);
  float sq = sqrt(disc);
  float t0 = max((-b - sq) / a, 0.0), t1 = (-b + sq) / a;
  if (rd.y > 0.0) t1 = min(t1, (ISLE_H * 2.0 - ro.y) / rd.y);
  else t1 = min(t1, (-4.0 - ro.y) / rd.y);
  if (t1 <= t0) return vec4(0.0);
  float dt = (t1 - t0) / float(steps);
  float t = t0, tp = t0;
  bool hit = false;
  for (int i = 0; i < 64; i++) {
    if (i >= steps) break;
    vec3 p = ro + rd * t;
    if (p.y < isleHeight(p.xz)) { hit = true; break; }
    tp = t;
    t += dt;
  }
  if (!hit) return vec4(0.0);
  bool fine = steps >= 64;                                 // seen directly, not just mirrored in the sea
  for (int i = 0; i < 5; i++) {
    if (!fine && i >= 3) break;
    float tm = 0.5 * (tp + t);
    vec3 p = ro + rd * tm;
    if (p.y < isleHeight(p.xz)) t = tm; else tp = tm;
  }
  vec3 p = ro + rd * t;
  if (p.y < -0.5) return vec4(0.0);                       // under the waterline: the sea covers it
  float e = max(1.0, t * 0.002);
  vec3 n;
  if (fine) {
    float h0 = isleDetail(p.xz);
    n = normalize(vec3(h0 - isleDetail(p.xz + vec2(e, 0.0)), e, h0 - isleDetail(p.xz + vec2(0.0, e))));
  } else {                                                  // the wavering mirror image can't show the rocks
    e *= 4.0;
    float h0 = isleHeight(p.xz);
    n = normalize(vec3(h0 - isleHeight(p.xz + vec2(e, 0.0)), e, h0 - isleHeight(p.xz + vec2(0.0, e))));
  }
  vec3 rock = vec3(0.40, 0.38, 0.35) * (0.8 + 0.4 * noise(p.xz * 0.3 + p.y));
  vec3 grass = mix(vec3(0.24, 0.32, 0.13), vec3(0.34, 0.36, 0.18), noise(p.xz * 0.05));
  grass = mix(grass, vec3(0.09, 0.17, 0.07), smoothstep(0.45, 0.7, noise(p.xz * 0.04 + 9.0)) * 0.85); // stands of trees
  vec3 alb = mix(rock, grass, smoothstep(0.78, 0.9, n.y));
  float cove = isleCoast(p.xz).y;
  // sand in the cove (up into the dunes), a strip of shingle under the cliffs elsewhere
  vec3 sandCol = vec3(0.84, 0.77, 0.6) * (0.9 + 0.2 * noise(p.xz * 0.7));
  alb = mix(sandCol, alb, smoothstep(mix(1.0, 5.0, cove), mix(4.0, 9.0, cove), p.y));
  alb = mix(alb, vec3(0.88, 0.91, 0.95), uClimate.y * smoothstep(0.55, 0.8, n.y) * smoothstep(2.0, 8.0, p.y)); // polar snow
  // the swash runs up the sand with each breaker and leaves it dark and glossy as it drains
  float run = pow(0.5 + 0.5 * sin(uTime * 1.1 - 1.4 + noise(p.xz * 0.02) * 3.0), 3.0);
  float swashY = 0.15 + 0.6 * run * cove;
  float wet = 1.0 - smoothstep(swashY + 0.1, swashY + 0.7 + 0.4 * cove, p.y);
  alb *= 1.0 - 0.45 * wet;
  float lit = isleSunlight(vec3(p.x, max(p.y, isleHeight(p.xz)) + 0.5, p.z), lighthouseBase(), fine);
  vec3 col = alb * (SKY_AMB * 0.45 * (0.6 + 0.4 * n.y) * (0.75 + 0.25 * lit)
                    + (SUN_COL * max(dot(n, SUN), 0.0) * 0.95 + MOON_COL * max(dot(n, MOON), 0.0) * 0.6) * lit);
  vec3 hv = normalize(SUN - rd);
  col += SUN_COL * pow(max(dot(n, hv), 0.0), 60.0) * wet * 0.6 * lit;    // sheen on the wet sand
  // a sheet of foam sliding up the beach, and spray bursting against the rocks
  float tex = noise(p.xz * 0.9 + uTime * 0.3) * 0.6 + noise(p.xz * 3.1 - uTime * 0.5) * 0.4;
  float sheet = (1.0 - smoothstep(swashY - 0.15, swashY + 0.05, p.y)) * smoothstep(0.35, 0.6, tex) * cove;
  float spray = (1.0 - smoothstep(0.0, 1.5 + run * 1.5, p.y)) * (0.5 + 0.5 * run) * (1.0 - cove)
              * smoothstep(0.3, 0.6, tex);
  col = mix(col, vec3(0.92) * (SKY_AMB * 0.6 + SUN_COL * 0.6 * lit), clamp(sheet + spray, 0.0, 0.9));
  col = mix(col, haze, 1.0 - exp(-t * 0.00035));
  tI = t;
  return vec4(col, 1.0);
}

// the lighthouse: a tapering red-and-white tower with a glass lantern room and black cap
vec4 lighthouse(vec3 ro, vec3 rd, vec3 haze, float hb, out float tL) {
  tL = 1e5;
  vec2 v = LIGHT_XZ - ro.xz;
  float rr = dot(rd.xz, rd.xz);
  float t = dot(v, rd.xz) / rr;                 // closest approach to the tower's axis
  if (t <= 0.0) return vec4(0.0);
  float y = ro.y + rd.y * t - hb;
  if (y < -2.0 || y > 36.0) return vec4(0.0);
  vec2 perp = v - rd.xz * t;
  float dm = length(perp);
  float pm = PX * t;
  float R = y < 26.0 ? 4.2 - y * 0.06 : y < 31.0 ? 2.7 : 2.7 * (1.0 - (y - 31.0) / 5.0);
  float cov = clamp(0.5 - (dm - R) / pm, 0.0, 1.0) * clamp(0.5 - (y - 36.0) / pm, 0.0, 1.0);
  if (cov <= 0.0) return vec4(0.0);
  vec2 rgt = normalize(vec2(rd.z, -rd.x));
  float sp = clamp(-dot(perp, rgt) / R, -1.0, 1.0);
  vec2 nrm = rgt * sp - normalize(rd.xz) * sqrt(1.0 - sp * sp);
  float lam = max(dot(nrm, SUN.xz) + SUN.y * 0.3, 0.0);
  vec3 alb = step(0.5, fract(y / 6.5)) > 0.5 ? vec3(0.75, 0.12, 0.1) : vec3(0.92, 0.92, 0.9);
  if (y > 25.0 && y < 26.0) alb = vec3(0.1);                          // gallery rail
  lam *= 1.0 - 0.85 * cloudShadow(ro + rd * t);
  vec3 col = alb * (SKY_AMB * 0.5 + SUN_COL * lam * 0.9);
  if (y >= 26.0 && y < 31.0) col = mix(vec3(0.15, 0.18, 0.2) * SKY_AMB, vec3(1.0, 0.85, 0.5) * 2.5, 1.0 - DAY); // lantern
  if (y >= 31.0) col = vec3(0.06) * (SKY_AMB + SUN_COL * lam);
  col = mix(col, haze, 1.0 - exp(-t * 0.00035));
  tL = t;
  return vec4(col, cov);
}

// the wooden jetty: sphere-traced only where the ray crosses its bounding box
vec4 jetty(vec3 ro, vec3 rd, vec3 haze, out float tJ) {
  tJ = 1e5;
  vec3 q0 = jettyLocal(ro);
  vec3 rl = vec3(dot(rd.xz, BEACH_DIR), rd.y, dot(rd.xz, vec2(-BEACH_DIR.y, BEACH_DIR.x)));
  vec3 lo = (vec3(-0.5, -1.0, -1.8) - q0) / rl, hi = (vec3(JETTY_L + 0.5, JETTY.z + 1.0, 1.8) - q0) / rl;
  vec3 mn = min(lo, hi), mx = max(lo, hi);
  float t0 = max(max(max(mn.x, mn.y), mn.z), 0.0), t1 = min(min(mx.x, mx.y), mx.z);
  if (t1 <= t0 || t0 > 3000.0) return vec4(0.0);
  float t = t0;
  bool hit = false;
  for (int i = 0; i < 48; i++) {
    float d = jettySDF(q0 + rl * t);
    if (d < max(0.003, t * PX * 0.7)) { hit = true; break; }
    t += d;
    if (t > t1) break;
  }
  if (!hit) return vec4(0.0);
  vec3 q = q0 + rl * t;
  vec2 e = vec2(0.01, -0.01);
  vec3 nl = normalize(e.xyy * jettySDF(q + e.xyy) + e.yyx * jettySDF(q + e.yyx)
                    + e.yxy * jettySDF(q + e.yxy) + e.xxx * jettySDF(q + e.xxx));
  vec3 n = vec3(nl.x * BEACH_DIR.x - nl.z * BEACH_DIR.y, nl.y, nl.x * BEACH_DIR.y + nl.z * BEACH_DIR.x);
  vec3 p = ro + rd * t;
  // weathered planks, each a slightly different grey-brown; posts stained dark by the tide
  float plank = hash(vec2(floor(q.x / 0.3), 7.0));
  vec3 alb = vec3(0.42, 0.33, 0.24) * (0.7 + 0.4 * plank) * (0.85 + 0.3 * noise(q.xz * vec2(0.8, 6.0)));
  alb *= 1.0 - 0.55 * (1.0 - smoothstep(-0.2, 0.8, p.y));
  float lit = isleSunlight(p + n * 0.05, lighthouseBase(), false);
  vec3 col = alb * (SKY_AMB * 0.45 * (0.6 + 0.4 * n.y) + (SUN_COL * max(dot(n, SUN), 0.0) * 0.95
                    + MOON_COL * max(dot(n, MOON), 0.0) * 0.6) * lit);
  if (p.y < -0.3) col = mix(col, vec3(0.0, 0.1, 0.12) * SKY_AMB, 0.6);   // seen through the water
  col = mix(col, haze, 1.0 - exp(-t * 0.00035));
  tJ = t;
  return vec4(col, 1.0);
}

// two beams sweeping round from the lantern after dark, glowing where they cut through haze,
// and a dazzling flash each time one swings across you
vec3 lighthouseBeams(vec3 ro, vec3 rd, float hb, float maxT) {
  float night = 1.0 - smoothstep(-0.05, 0.12, SUN.y);
  if (night < 0.01) return vec3(0.0);
  vec3 L = vec3(LIGHT_XZ.x, hb + 28.5, LIGHT_XZ.y);
  vec3 acc = vec3(0.0);
  float ang = uTime * 0.7;
  vec3 toCam = normalize(ro - L);
  for (int i = 0; i < 2; i++) {
    float aa = ang + float(i) * 3.14159;
    vec3 B = normalize(vec3(cos(aa), -0.015, sin(aa)));
    vec3 w0 = ro - L;
    float b = dot(rd, B), d = dot(rd, w0), e = dot(B, w0);
    float den = max(1.0 - b * b, 1e-4);
    float tr = (b * e - d) / den, s = (e - b * d) / den;
    if (s > 0.0 && tr > 0.0 && tr < maxT) {
      float dist = length(ro + rd * tr - (L + B * s));
      float wdt = 1.5 + s * 0.035;
      acc += vec3(1.0, 0.93, 0.75) * exp(-dist * dist / (wdt * wdt)) * exp(-s / 2200.0) * smoothstep(0.0, 30.0, s)
           * (0.12 + uWeather.y * 60.0);
    }
    // looking straight into the beam
    float facing = pow(max(dot(B, toCam), 0.0), 60.0);
    float ga = length(rd - normalize(L - ro));
    acc += vec3(1.0, 0.92, 0.7) * facing * (exp(-ga * ga / (PX * PX * 4.0)) * 30.0 + exp(-ga / (PX * 25.0)) * 1.5);
  }
  return acc * night;
}

// ---------- life on the sea ----------
float cover(float sdf, float px) { return clamp(0.5 - sdf / px, 0.0, 1.0); }
float lamp(vec2 d, float px) { return exp(-dot(d, d) / (px * px * 1.5)); }

// a distant boat drawn as a cut-out standing on the sea, seen from wherever you are:
// type 0 is a sloop under sail, type 1 a container ship. tB = distance along the ray.
vec4 boat(vec3 ro, vec3 rd, vec4 B, vec3 haze, out float tB) {
  tB = 1e5;
  if (uLife.x < 0.01) return vec4(0.0);
  vec2 v = B.xy - ro.xz;
  float D = length(v);
  vec2 nB = v / D;
  float den = dot(rd.xz, nB);
  if (den < 0.05) return vec4(0.0);
  float t = D / den;                       // vertical plane through the boat, facing us
  vec3 P = ro + rd * t;
  vec2 side = vec2(-nB.y, nB.x);
  float lx = dot(P.xz - B.xy, side);
  bool ship = B.w > 0.5;
  vec2 hdir = vec2(cos(B.z), sin(B.z));
  float hs = dot(hdir, side);
  float sq = max(abs(hs), 0.2);            // end-on it looks short, broadside full length
  float halfLen = ship ? 80.0 : 7.0;
  if (abs(lx) > halfLen * sq + 4.0 || P.y > (ship ? 38.0 : 17.0) || P.y < -2.0) return vec4(0.0);
  // pitching and rolling on the swell
  float ly = P.y - sin(uTime * 0.9 + B.x) * (ship ? 0.25 : 0.45) - lx * sin(uTime * 0.7 + B.y) * (ship ? 0.004 : 0.05);
  float u = lx / sq * sign(hs);            // metres along the hull, + toward the bow
  float pm = PX * t;                       // one pixel in metres out there
  float pu = pm / sq;
  vec3 lit = SKY_AMB * 0.6 + SUN_COL * (0.45 + 0.35 * abs(dot(nB, SUN.xz)));
  vec3 c = vec3(0.0);
  float a = 0.0, glow = 0.0;
  vec3 glowC = vec3(0.0);
  float night = 1.0 - DAY;
  if (!ship) {
    float hull = max(max(-0.4 - ly, ly - 0.9), max(u - (6.6 - (0.9 - ly) * 2.4), -5.6 + (0.9 - ly) * 0.9 - u) * sq);
    float mast = max(abs(u - 0.4) * sq - 0.06, max(0.9 - ly, ly - 15.0));
    float main = max(max(1.7 - ly, (u - 0.25) * sq), (0.25 - (15.0 - ly) * 0.40 - u) * sq);
    float jib = max(max(1.5 - ly, (0.6 - u) * sq), (u - 0.6 - (13.6 - ly) * 0.43) * sq);
    float sail = min(main, jib);
    float ah = cover(hull, pm), am = cover(mast, pm), as = cover(sail, pm);
    c = vec3(0.92, 0.93, 0.95) * lit * 0.9;
    c = mix(c, vec3(0.97, 0.95, 0.9) * lit * mix(1.0, 1.15, step(0.0, dot(nB, SUN.xz))), as);
    c = mix(c, vec3(0.3) * lit, am * (1.0 - as));
    a = max(ah, max(as, am));
    // masthead light and a sidelight after dark
    glow = lamp(vec2((u - 0.4) * sq, ly - 15.2), pm) + lamp(vec2((u - 5.5) * sq, ly - 1.0), pm);
    glowC = mix(vec3(1.0, 0.95, 0.85), hs > 0.0 ? vec3(0.1, 1.0, 0.3) : vec3(1.0, 0.15, 0.1),
                step(ly, 8.0)) * glow;
  } else {
    // hull with raked bow, red below the waterline mark
    float hull = max(max(-1.0 - ly, ly - 9.0), max(u - (70.0 + ly * 1.1), -76.0 - u) * sq);
    vec3 hc = mix(vec3(0.45, 0.1, 0.08), vec3(0.09, 0.11, 0.15), step(1.8, ly));
    // stacks of containers in random colours and heights
    float col6 = floor(u / 6.1);
    float rnd = hash(vec2(col6, B.x * 0.01));
    float top = 9.0 + 2.6 * floor(1.0 + rnd * 3.0);
    float boxes = max(max(9.0 - ly, ly - top), max(u - 58.0, -48.0 - u) * sq);
    float ci = hash(vec2(col6, floor((ly - 9.0) / 2.6)));
    vec3 cc = ci < 0.3 ? vec3(0.55, 0.18, 0.1) : ci < 0.55 ? vec3(0.12, 0.25, 0.45) : ci < 0.75 ? vec3(0.5, 0.5, 0.48) : vec3(0.15, 0.4, 0.25);
    cc *= 0.8 + 0.25 * step(0.3, fract((ly - 9.0) / 2.6));    // seams between rows
    // white bridge aft with a dark window band, and the funnel
    float bridge = max(max(9.0 - ly, ly - 30.0), max(u + 52.0, -68.0 - u) * sq);
    float stack = max(max(20.0 - ly, ly - 34.0), max(u + 66.0, -73.0 - u) * sq);
    vec3 bc = mix(vec3(0.85, 0.86, 0.88), vec3(0.08), step(26.0, ly) * step(ly, 27.8));
    float ah = cover(hull, pm), ab = cover(boxes, pm), ar = cover(bridge, pm), af = cover(stack, pm);
    c = hc * lit;
    c = mix(c, cc * lit, ab);
    c = mix(c, bc * lit, ar);
    c = mix(c, vec3(0.1, 0.1, 0.1) * lit, af);
    a = max(max(ah, ab), max(ar, af));
    // deck lights and the bridge lit up at night
    float deck = step(abs(ly - 9.6), pm * 1.2 + 0.4) * step(0.7, fract(u / 9.0)) * step(abs(u), 70.0);
    glow = lamp(vec2((u + 60.0) * sq, ly - 33.0), pm) + lamp(vec2((u - 60.0) * sq, ly - 20.0), pm) + deck * 0.6
         + step(26.0, ly) * step(ly, 27.8) * cover(bridge, pm) * 0.5;
    glowC = vec3(1.0, 0.85, 0.6) * glow;
  }
  if (a <= 0.0 && glow < 0.01) return vec4(0.0);
  c = c * (1.0 - night * 0.6) + glowC * night * 3.0;
  a = max(a, min(glow * night, 1.0));
  c = mix(c, haze, 1.0 - exp(-t * 0.00035));  // distance haze, lighter than the sea's
  tB = t;
  return vec4(c, a * uLife.x);
}

// ---------- polar ice ----------
// an iceberg as a distance field around its centre at the water line: a flat-topped tabular
// slab with sheer cliffs, or a weathered dome, both roughened by noise
float bergSDF(vec3 q, vec4 B) {
  float S = B.z, a = B.w * 2.4;
  q.xz = mat2(cos(a), sin(a), -sin(a), cos(a)) * q.xz;
  vec3 r = q * (5.0 / S);
  float d;
  if (fract(B.w * 0.137) > 0.5) {
    vec3 e = abs(q) - vec3(S, S * 0.3, S * 0.62) + 3.0;
    d = length(max(e, 0.0)) + min(max(e.x, max(e.y, e.z)), 0.0) - 3.0;
    d += (noise3(vec3(r.xz * 1.5, r.y * 0.3)) - 0.5) * S * 0.16;      // vertical fluting on the cliffs
  } else {
    vec3 h = vec3(S, S * 0.5, S * 0.75);
    d = (length(q / h) - 1.0) * S * 0.5;
    d += (noise3(r) - 0.5) * S * 0.3;
  }
  return d + (noise3(r * 3.1 + 5.0) - 0.5) * S * 0.07;
}
// a few icebergs drifting in the polar sea, marched only inside their bounding spheres
vec4 icebergs(vec3 ro, vec3 rd, vec3 haze, out float tI) {
  tI = 1e5;
  if (uClimate.y < 0.01) return vec4(0.0);
  vec3 col = vec3(0.0);
  for (int i = 0; i < 4; i++) {
    vec4 B = uBergs[i];
    vec3 c = vec3(B.x, sin(uTime * 0.35 + B.w) * 0.3, B.y);   // bobbing slowly on the swell
    vec3 oc = ro - c;
    float R = B.z * 1.3;
    float b = dot(oc, rd), h = b * b - dot(oc, oc) + R * R;
    if (h < 0.0) continue;
    h = sqrt(h);
    float t = max(-b - h, 0.0), t1 = min(-b + h, tI);
    if (t >= t1 || (ro.y + rd.y * t < -1.0 && rd.y < 0.0)) continue; // missed, or only under water
    bool hit = false;
    for (int j = 0; j < 48; j++) {
      float d = bergSDF(ro + rd * t - c, B);
      if (d < 0.0015 * t) { hit = true; break; }
      t += max(d * 0.7, 0.002 * t);
      if (t > t1) break;
    }
    if (!hit) continue;
    vec3 q = ro + rd * t - c;
    if (q.y < -0.5) continue;                                 // the sea covers what is under the water line
    float e = max(0.2, t * 0.002);
    vec2 k = vec2(1.0, -1.0);
    vec3 n = normalize(k.xyy * bergSDF(q + k.xyy * e, B) + k.yyx * bergSDF(q + k.yyx * e, B)
                     + k.yxy * bergSDF(q + k.yxy * e, B) + k.xxx * bergSDF(q + k.xxx * e, B));
    float dif = max(dot(n, SUN), 0.0);
    vec3 alb = vec3(0.88, 0.94, 0.98) * (0.9 + 0.1 * noise3(q * 0.4));
    vec3 c2 = alb * (SUN_COL * dif * 1.25 + SKY_AMB * (0.5 + 0.35 * n.y) * vec3(0.82, 0.92, 1.0)
                     + MOON_COL * max(dot(n, MOON), 0.0) * 0.6);
    // dense glacial ice glows blue in the shaded clefts and down by the water
    float blue = (1.0 - smoothstep(0.0, 0.45, dif)) * 0.3 + (1.0 - smoothstep(0.0, B.z * 0.12, q.y)) * 0.25;
    c2 = mix(c2, vec3(0.3, 0.66, 0.85) * (SKY_AMB * 0.6 + SUN_COL * 0.3), clamp(blue, 0.0, 1.0));
    // a lick of surf where the swell washes against it
    c2 = mix(c2, vec3(0.92) * (SKY_AMB * 0.6 + SUN_COL * 0.6), (1.0 - smoothstep(0.0, 1.0, q.y)) * 0.6);
    col = mix(c2, haze, 1.0 - exp(-t * 0.00035));
    tI = t;
  }
  return vec4(col, tI < 1e5 ? smoothstep(0.0, 0.6, uClimate.y) : 0.0);
}

// seagulls: gull-wing silhouettes, flapping in bursts and gliding
void gulls(vec3 ro, vec3 rd, inout vec3 col, inout float hitT) {
  if (uLife.y < 0.01) return;
  for (int i = 0; i < 6; i++) {
    vec4 b = uBirds[i];
    vec3 v = b.xyz - ro;
    float D = length(v);
    if (D > hitT) continue;
    vec3 dir = v / D;
    if (dot(rd, dir) < 0.995) continue;
    vec3 rgt = normalize(cross(vec3(0.0, 1.0, 0.0), dir));
    vec3 up = cross(dir, rgt);
    float hs = 0.75 / D;                       // half wingspan in radians
    vec2 q = vec2(dot(rd, rgt), dot(rd, up)) / hs;
    float ax = abs(q.x);
    if (ax > 1.05 || abs(q.y) > 1.0) continue;
    float f = b.w;                             // wing pose: -0.6 down .. 1 up
    float y = ax < 0.4 ? f * 0.5 * ax : f * 0.2 + (ax - 0.4) * (f * 0.2 - 0.35); // the gull's "M"
    float d = min(abs(q.y - y) - (0.075 * (1.0 - 0.7 * ax) + 0.02), length(q * vec2(0.6, 1.0)) - 0.1);
    float a = cover(d, PX / hs) * step(ax, 1.0) * uLife.y;
    vec3 gc = vec3(0.62, 0.64, 0.68) * SKY_AMB + SUN_COL * 0.3 * max(0.2, SUN.y);
    col = mix(col, gc, a);
  }
}

// ---------- wildlife at sea: dolphins, a whale, a shark ----------
// JS starts each event somewhere in front of you and runs its clock; everything else (the leaps,
// the breach, the splashes) follows from that clock here.
const float DOLPHIN_DUR = 10.0, LEAP_PERIOD = 2.6, LEAP_AIR = 1.04, POD_SPEED = 7.0;

vec2 podCentre() {
  return uDolphin.xy + vec2(cos(uDolphin.z), sin(uDolphin.z)) * POD_SPEED * (uDolphin.w - DOLPHIN_DUR * 0.5);
}

// dolphin i of the pod: where its middle is, its pitch, and its leap clock tau (0 as it breaks
// the surface, LEAP_AIR as it dives back in). False when it sits this leap out.
bool dolphin(int i, out vec3 P, out float pitch, out float tau) {
  float fi = float(i);
  float T = uDolphin.w;
  float u = mod(T + hash(vec2(fi, 1.9)) * LEAP_PERIOD, LEAP_PERIOD);
  float c0 = T - u;                         // when this leap's cycle began
  tau = u - 0.4;
  vec2 dir = vec2(cos(uDolphin.z), sin(uDolphin.z));
  vec2 xz = podCentre() + dir * (hash(vec2(fi, 3.1)) - 0.5) * 5.0 + vec2(-dir.y, dir.x) * (hash(vec2(fi, 7.7)) - 0.5) * 7.0;
  float vy = 4.9 * LEAP_AIR;
  P = vec3(xz.x, vy * tau - 4.9 * tau * tau, xz.y);
  pitch = atan(vy - 9.8 * tau, POD_SPEED);
  return fi < uFauna.x && T >= 0.0 && c0 >= 0.0 && c0 + LEAP_PERIOD <= DOLPHIN_DUR;
}

// the whale: kind 0 breaches, bursting steeply out and crashing down on its side; kind 1
// surfaces to blow twice, rolls its back along the surface and dives showing its flukes.
// s1, s2: splashes (kind 0) or blows (kind 1) as x, y, z, size, with their ages a1, a2
void whaleState(out vec3 P, out float pitch, out float roll, out vec4 s1, out float a1, out vec4 s2, out float a2) {
  float T = uWhale.w;
  vec2 dir = vec2(cos(uWhale.z), sin(uWhale.z));
  if (uFauna.y < 0.5) {
    float tc = max(T - 1.5, 0.0);
    vec2 xz = uWhale.xy + dir * (3.0 * tc - 3.0);
    P = vec3(xz.x, -7.0 + 14.0 * tc - 4.9 * tc * tc, xz.y);
    pitch = mix(1.25, -0.35, smoothstep(0.3, 2.6, tc));
    roll = 1.6 * smoothstep(0.7, 2.3, tc);
    vec2 e = uWhale.xy + dir * 0.5, c = uWhale.xy + dir * 4.0;
    s1 = vec4(e.x, 0.0, e.y, 3.0);
    a1 = T - 1.5;
    s2 = vec4(c.x, 0.0, c.y, 7.0);
    a2 = T - 3.6;
  } else {
    float surf = smoothstep(0.5, 3.0, T);
    float dv = max(T - 7.0, 0.0);
    vec2 xz = uWhale.xy + dir * (2.0 * T - 12.0);
    P = vec3(xz.x, mix(-5.0, -1.3, surf) - 1.7 * dv, xz.y);
    pitch = 0.04 * surf - 1.15 * smoothstep(0.0, 2.2, dv);
    roll = 0.0;
    vec2 b1 = uWhale.xy + dir * (6.0 - 12.0 + 3.8), b2 = uWhale.xy + dir * (11.0 - 12.0 + 3.8);  // the blowhole at 3 s and 5.5 s
    s1 = vec4(b1.x, 0.3, b1.y, 1.0);
    a1 = T - 3.0;
    s2 = vec4(b2.x, 0.3, b2.y, 0.8);
    a2 = T - 5.5;
  }
}

// a burst of white water on a camera-facing card standing on the sea: a lumpy column of spray
// that shoots up, spreads and falls back. size ~ its radius in metres
vec4 spray(vec3 ro, vec3 rd, vec3 S, float size, float age, out float tS) {
  tS = 1e5;
  float life = 0.9 + size * 0.5;
  float k = age / life;
  if (k < 0.0 || k > 1.0) return vec4(0.0);
  vec2 v = S.xz - ro.xz;
  float D = length(v);
  vec2 nB = v / D;
  float den = dot(rd.xz, nB);
  if (den < 0.05) return vec4(0.0);
  float t = D / den;
  vec3 P = ro + rd * t;
  float lx = dot(P.xz - S.xz, vec2(-nB.y, nB.x));
  float ly = P.y - S.y;
  float H = size * 2.3 * sin(min(k * 2.2, 1.0) * 1.5708) * (1.0 - 0.4 * k * k);
  float spread = size * (0.45 + 0.9 * k);
  if (abs(lx) > spread * 2.0 + size || ly > H + size || ly < -0.5) return vec4(0.0);
  float u = clamp(ly / max(H, 1e-3), 0.0, 1.5);
  float w = spread * (0.4 + 0.8 * u * u);                         // flaring out into a crown
  float body = smoothstep(w, w * 0.35, abs(lx)) * smoothstep(1.05, 0.6, u);
  vec2 g = vec2(lx, ly - age * size * 0.7) * 4.0 / size;
  float n = noise(g) * 0.6 + noise(g * 2.7 + 9.0) * 0.4;
  float a = body * smoothstep(0.4, 0.65, n + 0.3 * (1.0 - u));
  // churned white water around the foot
  float foot = smoothstep(spread * 1.8, spread * 0.5, abs(lx)) * smoothstep(size * 0.55, 0.0, ly);
  a = max(a, foot * (0.65 + 0.45 * noise(g * 1.7 + 3.0)));
  a *= pow(1.0 - k, 1.3);
  float back = max(dot(rd, SUN), 0.0);                             // spray glows with the sun behind it
  vec3 c = vec3(0.95) * (SKY_AMB * 0.7 + SUN_COL * (0.5 + 0.6 * back * back));
  tS = t;
  return vec4(c, clamp(a, 0.0, 1.0));
}

// a whale's blow: a bushy plume of mist that rises, drifts downwind and thins out
vec4 blowMist(vec3 ro, vec3 rd, vec3 S, float size, float age, out float tS) {
  tS = 1e5;
  if (age < 0.0 || age > 6.0) return vec4(0.0);
  vec2 v = S.xz - ro.xz;
  float D = length(v);
  vec2 nB = v / D;
  float den = dot(rd.xz, nB);
  if (den < 0.05) return vec4(0.0);
  float t = D / den;
  vec3 P = ro + rd * t;
  vec2 side = vec2(-nB.y, nB.x);
  float H = 6.0 * size * (1.0 - exp(-age * 3.0));
  float ly = P.y - S.y;
  vec2 wd = vec2(cos(uWave.z), sin(uWave.z));
  float lx = dot(P.xz - S.xz, side) - dot(wd, side) * ly * 0.12 * age;   // leaning downwind
  if (ly < 0.0 || ly > H + 3.0 || abs(lx) > 6.0) return vec4(0.0);
  float w = 0.35 + ly * 0.42 + age * 0.45;                          // a bushy V, widening as it rises
  float body = exp(-lx * lx / (w * w) * 2.0) * smoothstep(H + 2.0, H * 0.6, ly) * smoothstep(0.0, 0.5, ly);
  vec2 g = vec2(lx, ly - age * 0.6) * 1.4;
  float a = body * (0.55 + 0.45 * noise(g) + 0.2 * noise(g * 3.1)) * smoothstep(0.0, 0.25, age) * exp(-age * 0.55) * 0.9;
  vec3 c = vec3(0.92, 0.94, 0.96) * (SKY_AMB * 0.75 + SUN_COL * (0.45 + 0.5 * pow(max(dot(rd, SUN), 0.0), 4.0)));
  tS = t;
  return vec4(c, clamp(a, 0.0, 1.0));
}

// an expanding ring of foam with a churned middle where something broke the surface
float foamRing(vec2 d, float age, float size) {
  float life = 1.6 + size * 0.6;
  if (age < 0.0 || age > life) return 0.0;
  float k = age / life;
  float r = length(d) / size;
  float R = 0.6 + 1.6 * k;
  return (exp(-pow((r - R) / 0.28, 2.0)) * 0.8 + exp(-r * r * 2.5) * (1.0 - k)) * (1.0 - k);
}

// white water on the sea where the animals break the surface, and a shark's wake
float faunaFoam(vec2 p) {
  if (uFauna.z < 0.01) return 0.0;
  float f = 0.0;
  if (uDolphin.w >= 0.0 && length(p - podCentre()) < 16.0) {
    vec2 dir = vec2(cos(uDolphin.z), sin(uDolphin.z));
    for (int i = 0; i < 4; i++) {
      vec3 P;
      float pitch, tau;
      if (!dolphin(i, P, pitch, tau)) continue;
      f = max(f, foamRing(p - (P.xz - dir * POD_SPEED * tau), tau, 0.7));
      f = max(f, foamRing(p - (P.xz + dir * POD_SPEED * (LEAP_AIR - tau)), tau - LEAP_AIR, 0.7));
    }
  }
  if (uWhale.w >= 0.0 && length(p - uWhale.xy) < 30.0) {
    vec3 P;
    float pitch, roll, a1, a2;
    vec4 s1, s2;
    whaleState(P, pitch, roll, s1, a1, s2, a2);
    if (uFauna.y < 0.5) {
      f = max(f, foamRing(p - s1.xz, a1, s1.w));
      f = max(f, foamRing(p - s2.xz, a2, s2.w));
    } else {
      // a slick of churned water around the back while it is up, and where the flukes went down
      vec2 dir = vec2(cos(uWhale.z), sin(uWhale.z));
      vec2 q = p - P.xz;
      vec2 lq = vec2(dot(q, dir), dot(q, vec2(-dir.y, dir.x)));
      f = max(f, smoothstep(1.0, 0.5, length(lq / vec2(7.0, 2.2))) * 0.45 * smoothstep(-2.6, -1.4, P.y));
      vec2 fl = uWhale.xy + dir * (2.0 * 10.2 - 12.0 - 3.0);
      f = max(f, foamRing(p - fl, uWhale.w - 10.2, 2.5));
    }
  }
  if (uShark.w > 0.01) {
    // a V of ripples spreading back from the fin
    vec2 dir = vec2(cos(uShark.z), sin(uShark.z));
    vec2 q = p - uShark.xy - dir * 0.8;
    float along = -dot(q, dir), across = abs(dot(q, vec2(-dir.y, dir.x)));
    float vee = exp(-pow((across - 0.08 - along * 0.33) / 0.09, 2.0)) * step(-0.3, along) * smoothstep(7.0, 0.0, along);
    f = max(f, (vee * 0.8 + exp(-dot(q, q) * 8.0) * 0.7) * uShark.w);
  }
  return clamp(f * (0.6 + 0.6 * noise(p * 5.0)), 0.0, 1.0);
}

// wet, shiny hide: sunlight, sky, a glint and a little rim of reflected sky
vec3 hide(vec3 n, vec3 rd, vec3 base) {
  float dif = max(dot(n, SUN), 0.0);
  float spec = pow(max(dot(reflect(rd, n), SUN), 0.0), 40.0);
  float fres = pow(1.0 - max(dot(n, -rd), 0.0), 4.0);
  return base * (SUN_COL * dif * 0.9 + SKY_AMB * (0.22 + 0.3 * (0.5 + 0.5 * n.y))) + SUN_COL * spec * 0.7 + SKY_AMB * fres * 0.12;
}

void wildlife(vec3 ro, vec3 rd, vec3 horizon, inout vec3 col, inout float hitT) {
  float amt = clamp(uFauna.z * 2.0, 0.0, 1.0);
  float bestT = 1e5, bestC = 0.0;
  vec3 bestP = vec3(0.0), bestN = vec3(0.0, 1.0, 0.0);
  mat3 bestB = mat3(1.0);
  int bestK = 0;
  float cv, tt;
  vec3 lp, nl;
  vec3 P;
  float pitch, roll, tau;

  // the pod, inside one sphere around them all first
  bool podSeen = false;
  if (uDolphin.w >= 0.0) {
    vec2 pc = podCentre();
    vec3 oc = ro - vec3(pc.x, 0.0, pc.y);
    float b = dot(oc, rd);
    podSeen = b < 0.0 && b * b - dot(oc, oc) + 120.0 > 0.0;
  }
  if (podSeen) {
    for (int i = 0; i < 4; i++) {
      if (!dolphin(i, P, pitch, tau) || tau < -0.45 || tau > LEAP_AIR + 0.45) continue;
      mat3 B = creatureBasis(uDolphin.z, pitch, 0.0);
      tt = marchCreature(ro, rd, P, B, 1.4, 0, uTime * 9.0 + float(i) * 2.0, hitT, cv, lp, nl);
      if (cv > 0.0 && tt < bestT) { bestT = tt; bestC = cv; bestP = lp; bestN = nl; bestB = B; bestK = 0; }
    }
  }
  vec4 s1, s2;
  float a1 = -1.0, a2 = -1.0;
  if (uWhale.w >= 0.0) {
    whaleState(P, pitch, roll, s1, a1, s2, a2);
    if (P.y > -9.5) {
      mat3 B = creatureBasis(uWhale.z, pitch, roll);
      tt = marchCreature(ro, rd, P, B, 8.6, 1, uTime * 1.3, hitT, cv, lp, nl);
      if (cv > 0.0 && tt < bestT) { bestT = tt; bestC = cv; bestP = lp; bestN = nl; bestB = B; bestK = 1; }
    }
  }
  if (uShark.w > 0.01) {
    P = vec3(uShark.x, -0.15 - (1.0 - uShark.w) * 0.75 + 0.06 * sin(uTime * 0.9), uShark.y);
    mat3 B = creatureBasis(uShark.z, 0.0, 0.0);
    tt = marchCreature(ro, rd, P, B, 1.35, 2, uTime * 2.6, hitT, cv, lp, nl);
    if (cv > 0.0 && tt < bestT) { bestT = tt; bestC = cv; bestP = lp; bestN = nl; bestB = B; bestK = 2; }
  }

  if (bestC > 0.0) {
    vec3 n = normalize(bestB * bestN);
    vec3 base;
    if (bestK == 0) {
      // grey back, pale belly
      base = mix(vec3(0.78, 0.78, 0.76), vec3(0.3, 0.33, 0.38), smoothstep(-0.12, 0.05, bestP.y + 0.04 * bestP.z));
    } else if (bestK == 1) {
      // black humpback, white flippers and fluke undersides, grooved pale throat
      float ax = abs(bestP.x);
      float white = max(smoothstep(1.4, 2.0, ax) * step(bestP.z, 4.5) * step(bestP.y, -0.2), smoothstep(-0.3, -0.8, bestN.y) * step(bestP.z, -6.0));
      float throat = smoothstep(-0.6, -1.2, bestP.y) * step(1.5, bestP.z) * (0.6 + 0.4 * step(0.5, fract(bestP.x * 2.5)));
      base = mix(vec3(0.07, 0.075, 0.09), vec3(0.78, 0.78, 0.76), max(white, throat * 0.7));
      base *= 0.88 + 0.24 * noise(vec2(bestP.z * 1.3, bestP.y * 1.7 + bestP.x));       // scars and barnacles
    } else {
      base = vec3(0.34, 0.37, 0.4) * (1.0 - 0.35 * smoothstep(0.3, 0.55, bestP.y));
    }
    vec3 c = hide(n, rd, base);
    c = mix(c, horizon, 1.0 - exp(-bestT * 0.0022));
    col = mix(col, c, bestC * amt);
    if (bestC > 0.5) hitT = bestT;
  }

  // splashes as they leap out and dive back in, the whale's crash or its blows
  float tS;
  vec4 s;
  if (podSeen) {
    vec2 dir = vec2(cos(uDolphin.z), sin(uDolphin.z));
    for (int i = 0; i < 4; i++) {
      if (!dolphin(i, P, pitch, tau)) continue;
      vec2 e0 = P.xz - dir * POD_SPEED * tau, e1 = P.xz + dir * POD_SPEED * (LEAP_AIR - tau);
      s = spray(ro, rd, vec3(e0.x, 0.0, e0.y), 0.55, tau, tS);
      if (s.a > 0.0 && tS < hitT + 1.0) col = mix(col, s.rgb, s.a * amt);
      s = spray(ro, rd, vec3(e1.x, 0.0, e1.y), 0.7, tau - LEAP_AIR, tS);
      if (s.a > 0.0 && tS < hitT + 1.0) col = mix(col, s.rgb, s.a * amt);
    }
  }
  if (uWhale.w >= 0.0) {
    float haze = 1.0 - exp(-length(uWhale.xy - ro.xz) * 0.0022);
    if (uFauna.y < 0.5) {
      s = spray(ro, rd, s1.xyz, s1.w, a1, tS);
      if (s.a > 0.0 && tS < hitT + 3.0) col = mix(col, mix(s.rgb, horizon, haze), s.a * amt);
      s = spray(ro, rd, s2.xyz, s2.w, a2, tS);
      if (s.a > 0.0 && tS < hitT + 8.0) col = mix(col, mix(s.rgb, horizon, haze), s.a * amt);
    } else {
      s = blowMist(ro, rd, s1.xyz, s1.w, a1, tS);
      if (s.a > 0.0 && tS < hitT + 2.0) col = mix(col, mix(s.rgb, horizon, haze), s.a * amt);
      s = blowMist(ro, rd, s2.xyz, s2.w, a2, tS);
      if (s.a > 0.0 && tS < hitT + 2.0) col = mix(col, mix(s.rgb, horizon, haze), s.a * amt);
    }
  }
}

// ---------- what the sea mirrors ----------
// the island and lighthouse seen along a reflected ray: a coarse march of the island and the
// cheap cut-out tower. a is how much of the sky behind they hide. (The boats are left out:
// a third and fourth copy of their code costs a lot on the GPU for a few far-off pixels.)
vec4 mirrorScene(vec3 p, vec3 rf, vec3 haze, float hb) {
  vec4 m = vec4(0.0);
  float tM = 1e5, tH;
  vec4 h = island(p, rf, haze, 20, tH);
  if (h.a > 0.0) { m = h; tM = tH; }
  h = lighthouse(p, rf, haze, hb, tH);
  if (h.a > 0.0 && tH < tM) { m = vec4(mix(m.rgb, h.rgb, h.a), max(m.a, h.a)); if (h.a > 0.5) tM = tH; }
  return m;
}

// ---------- breaking waves ----------
// The sea is cut into cells, wider across the wind like the crests. Now and then a cell's
// crest spills over: a burst of whitecap that runs on with the wave and curls over at its
// leading edge, then spreads and frays into a fading patch of foam. The harder it blows,
// the bigger the cells and the more of them break.
// Returns (fresh whitecap, old foam, shadow under the curling lip); grow widens the blobs.
vec3 breakers(vec2 p, float t, float tex, float grow) {
  float rate = smoothstep(3.5, 20.0, uWater.w) * min(uWater.x, 1.3); // share of cells breaking
  if (rate < 0.01) return vec3(0.0);
  vec2 wd = vec2(cos(uWave.z), sin(uWave.z));
  vec2 q = vec2(dot(p, wd), dot(p, vec2(-wd.y, wd.x)));   // along / across the wind
  vec2 sz = clamp(2.0 / uWave.y, 6.0, 40.0) * vec2(1.0, 1.6);
  float run = sqrt(9.8 / uWave.y) * 0.3;                   // how fast the broken crest runs on
  vec3 res = vec3(0.0);
  for (int l = 0; l < 3; l++) {
    float fl = float(l);
    vec2 g = q / sz + fl * vec2(0.37, 0.61);
    vec2 c = floor(g) + fl * 31.0;
    float h1 = hash(c), h2 = hash(c + 2.3), h3 = hash(c + 4.1);
    float T = 4.5 + 5.0 * h2;                               // seconds between breaks here
    float ph = t / T + h1;
    float age = fract(ph);
    if (hash(c + floor(ph) * 1.37) > rate) continue;        // this time it didn't break
    vec2 fg = fract(g);
    vec2 d = (fg - vec2(0.2 + 0.15 * h3, 0.3 + 0.4 * h2)) * sz;
    d.x -= min(age * T, 2.5) * run;
    vec2 r = sz * vec2(0.11, 0.27) * (0.45 + 0.75 * sqrt(age)) * (0.7 + 0.5 * h3) * grow
           * mix(0.35, 1.0, smoothstep(6.0, 16.0, uWater.w));  // light airs only break small
    vec2 e = d / r;
    vec2 edge = min(fg, 1.0 - fg);                          // never cut off at the cell's edge
    float blob = smoothstep(1.0, 0.65, length(e) + (tex - 0.5) * 0.9) * smoothstep(0.0, 0.1, min(edge.x, edge.y));
    float fresh = smoothstep(0.0, 0.02, age) * (1.0 - smoothstep(0.15, 0.45, age));
    // the old foam frays into lace and thins out
    float lace = smoothstep(0.4 + 0.25 * age, 0.5 + 0.25 * age, tex);
    float old = blob * pow(1.0 - age, 1.5) * lace * 0.8;
    float curl = smoothstep(0.75, 1.0, e.x) * smoothstep(1.4, 1.05, e.x) * smoothstep(1.0, 0.5, abs(e.y)) * fresh;
    float torn = smoothstep(0.28, 0.6, tex + 0.25 * (1.0 - length(e)));  // torn white water, densest at the heart, never a flat sheet
    res = max(res, vec3(blob * fresh * torn, old, curl));
  }
  return res;
}

// spindrift: in a gale the wind tears spray off the breaking crests and drives it
// downwind in low streaming sheets. Sampled through the spray layer near the camera only.
float spindrift(vec3 ro, vec3 rd, float tMax, float t) {
  float gale = smoothstep(11.0, 19.0, uWater.w) * min(uWater.x, 1.5);
  if (gale < 0.01) return 0.0;
  float top = 1.5 + 2.5 * uWave.x;
  float ta = 0.0, tb = 400.0;
  if (abs(rd.y) > 1e-4) {
    float t0 = -ro.y / rd.y, t1 = (top - ro.y) / rd.y;
    ta = max(min(t0, t1), 0.0);
    tb = min(max(t0, t1), tb);
  } else if (ro.y > top) return 0.0;
  tb = min(tb, tMax);
  if (tb <= ta) return 0.0;
  vec2 wd = vec2(cos(uWave.z), sin(uWave.z));
  float acc = 0.0;
  for (int i = 0; i < 5; i++) {
    float f = (float(i) + 0.5) / 5.0;
    vec3 q = ro + rd * mix(ta, tb, f * f);                  // denser close by
    float y = clamp(q.y / top, 0.0, 1.0);
    vec3 br = breakers(q.xz - wd * y * 14.0, t, 0.5, 1.8);  // blown downwind as it rises
    vec2 s = vec2(dot(q.xz, wd), dot(q.xz, vec2(-wd.y, wd.x)));
    float n = noise(vec2(s.x * 0.1 - t * uWater.w * 0.1, s.y * 0.7 + y * 2.0))
            * (0.4 + 0.8 * noise(vec2(s.x * 0.5 - t * uWater.w * 0.5, s.y * 3.5)));  // finer wisps
    float dens = br.x * smoothstep(0.25, 0.7, n) * 3.0 + 0.06 * smoothstep(0.5, 0.8, n);
    acc += (1.0 - acc) * min(dens * exp(-y * 2.0) * 0.4, 0.6);
  }
  return acc * gale;
}

// ---------- boat wakes ----------
// height of a boat's wake, s metres astern of the bow and ax metres off its track:
// a crest along each arm of Kelvin's 19.5 degree wedge with diverging waves feathering
// off it, and transverse waves across the wedge keeping pace with the boat
float kelvin(float s, float ax, float kT, float beam) {
  float arm = s * 0.354 + beam * 0.5;
  float aw = 0.8 + s * 0.035;
  float da = ax - arm;
  float ridge = exp(-da * da / (aw * aw)) * sin(kT * 1.5 * (s - ax * 1.4));
  float trans = cos(kT * s) * smoothstep(aw, -aw * 3.0, da) * 0.45;
  return (ridge + trans) * smoothstep(-1.0, 2.0, s);
}
// returns foam; adds the wake's slope to g
float boatWake(vec2 p, vec4 B, inout vec2 g) {
  bool ship = B.w > 0.5;
  float L = ship ? 80.0 : 7.0, beam = ship ? 13.0 : 1.6, U = ship ? 7.0 : 3.5;
  float len = ship ? 1500.0 : 320.0;
  vec2 hd = vec2(cos(B.z), sin(B.z)), sd = vec2(-hd.y, hd.x);
  vec2 d = p - B.xy;
  float s = L - dot(d, hd);              // metres astern of the bow
  float x = dot(d, sd);                  // metres off the track
  float ax = abs(x);
  if (s < -4.0 || s > len || ax > s * 0.4 + beam + 8.0) return 0.0;
  float fade = exp(-s / (len * 0.3)) * uLife.x;
  float kT = 9.8 / (U * U);              // waves that travel at the boat's speed
  float amp = (ship ? 0.35 : 0.1) * fade;
  float e = 0.25 / kT;
  float h0 = kelvin(s, ax, kT, beam);
  float hs = (kelvin(s + e, ax, kT, beam) - h0) / e;
  float hx = (kelvin(s, ax + e, kT, beam) - h0) / e * sign(x);
  g += amp * (-hs * hd + hx * sd);
  // white water off the bow and along the arms close astern, churned water down the middle
  float arm = s * 0.354 + beam * 0.5;
  float da = (ax - arm) / (0.6 + s * 0.03);
  float armFoam = exp(-da * da) * exp(-s / (L * 4.0));
  float cw = beam * 0.45 + (s - 2.0 * L) * 0.025;
  float centre = exp(-x * x / (cw * cw)) * smoothstep(1.7 * L, 2.0 * L, s) * exp(-(s - 2.0 * L) / (len * 0.25));
  float lace = noise(p * 0.7) * 0.6 + noise(p * 2.3 + 5.0) * 0.4;
  return clamp((armFoam * 0.8 + centre) * smoothstep(0.25, 0.6, lace + 0.25 * centre), 0.0, 1.0) * fade * 1.3;
}

vec3 aces(vec3 x) {
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
}

void camBasis(vec2 look, out vec3 f, out vec3 r, out vec3 u) {
  f = vec3(sin(look.x) * cos(look.y), sin(look.y), cos(look.x) * cos(look.y));
  r = normalize(cross(vec3(0, 1, 0), f));
  u = cross(f, r);
}

// lighting from sun height and weather: warm near the horizon, dark at night,
// dimmed by storm clouds and fog, lit up by lightning
void setupLighting() {
  SUN = uSun;
  float el = SUN.y;
  float gloom = uWeather.z;
  DAY = smoothstep(-0.15, 0.15, el);
  vec3 tint = mix(vec3(1.0, 0.42, 0.12), vec3(1.0, 0.95, 0.85), smoothstep(0.0, 0.35, el));
  SUN_COL = tint * smoothstep(-0.03, 0.03, el) * mix(0.7, 1.0, smoothstep(0.0, 0.3, el));
  SUN_COL *= (1.0 - gloom * 0.85) * exp(-uWeather.y * 40.0);
  SKY_AMB = mix(vec3(0.03, 0.04, 0.08), vec3(1.0), DAY) * (1.0 - gloom * 0.5);
  SKY_AMB += uWeather.w * vec3(0.55, 0.6, 0.75);
  // dust storms turn all the light ochre
  SUN_COL *= mix(vec3(1.0), vec3(1.0, 0.72, 0.45), uPrecip.z);
  SKY_AMB *= mix(vec3(1.0), vec3(1.0, 0.8, 0.58), uPrecip.z * 0.85);
  // a fierce tropical sun; thin, cold light near the poles
  SUN_COL *= mix(1.0, 1.2, uClimate.x) * mix(vec3(1.0), vec3(0.93, 0.96, 1.0), uClimate.y);
  SKY_AMB *= mix(vec3(1.0), vec3(0.9, 0.96, 1.06), uClimate.y);
  // the moon hangs low, roughly opposite the sun
  float mAz = atan(SUN.x, SUN.z) + 2.6;
  MOON = uMoon.w > 0.5 ? uMoon.xyz : normalize(vec3(sin(mAz), 0.22, cos(mAz)));
  MOON_COL = vec3(0.62, 0.72, 0.92) * (1.0 - DAY) * (1.0 - gloom * 0.95) * 0.4 * (0.12 + 0.88 * uStars.x)
           * smoothstep(-0.02, 0.05, MOON.y);
  PX = 1.0 / (1.4 * uRes.y);
}

#ifdef CLOUD_PASS
// Clouds are marched at half resolution with a fresh random offset every frame and
// blended with the previous frames, re-aimed to where the camera points now: the
// dithering noise averages away into smooth clouds that stay put as you look around.
void main() {
  setupLighting();
  vec2 frag = gl_FragCoord.xy;
  vec3 ro = uPos;
  RO = ro;
  vec3 f, r, u;
  camBasis(uLook, f, r, u);
  vec2 uv = (frag - 0.5 * uCloudRes) / uCloudRes.y;
  vec2 jit = (vec2(hash(vec2(uCloudView.z, 3.7)), hash(vec2(uCloudView.z, 8.1))) - 0.5) / uCloudRes.y;
  vec3 rd = normalize((uv.x + jit.x) * r + (uv.y + jit.y) * u + 1.4 * f);
  vec4 cl = vec4(0.0, 0.0, 0.0, 1.0);
  if (ro.y > 0.0 && rd.y > 0.0 && fogAmount(ro, rd, 1e5) < 0.995)
    cl = cloudMarch(ro, rd, fract(hash(frag) + uCloudView.z * 0.618034));
  vec4 enc = vec4(cl.rgb / (1.0 + cl.rgb), cl.a);

  // where was this direction on screen last frame?
  vec3 pf, pr, pu;
  camBasis(uCloudView.xy, pf, pr, pu);
  vec3 rd0 = normalize(uv.x * r + uv.y * u + 1.4 * f);
  float z = dot(rd0, pf);
  if (uCloudView.w > 0.5 && z > 0.0) {
    vec2 tc = (1.4 * vec2(dot(rd0, pr), dot(rd0, pu)) / z * uCloudRes.y + 0.5 * uCloudRes) / uCloudRes;
    if (tc.x > 0.0 && tc.y > 0.0 && tc.x < 1.0 && tc.y < 1.0) {
      float k = mix(0.12, 0.8, clamp(uWeather.w, 0.0, 1.0)); // lightning must not lag behind
      enc = mix(texture2D(uTex, tc), enc, k);
    }
  }
  gl_FragColor = enc;
}
#else
void main() {
  setupLighting();
  float el = SUN.y;
  float gloom = uWeather.z;

  vec2 uv = (gl_FragCoord.xy - 0.5 * uRes) / uRes.y;
  float t = uTime;

  vec3 ro = uPos + vec3(0.0, 0.08 * sin(t * 0.6), 0.0);
  RO = ro;
  vec3 f, r, u;
  camBasis(uLook, f, r, u);
  vec3 rd = normalize(uv.x * r + uv.y * u + 1.4 * f);

  if (ro.y < 0.0) {
    // diving: a world of its own
    vec3 uc = aces(underwaterView(ro, rd, t) * uSky.z);
    vec2 qv = gl_FragCoord.xy / uRes;
    uc *= 0.8 + 0.2 * pow(16.0 * qv.x * qv.y * (1.0 - qv.x) * (1.0 - qv.y), 0.3);
    gl_FragColor = vec4(uc, 1.0);
    return;
  }

  vec3 horizon = skyBase(normalize(vec3(rd.x, 0.0, rd.z)), false);
  vec3 col;
  vec3 boltCol = vec3(0.0);
  float hitT = 1e5;
  float hb = lighthouseBase();

  if (rd.y >= -0.0005) {
    if (fogAmount(ro, rd, hitT) > 0.995) col = horizon;
    else {
      // clouds come from the smoothed half-resolution cloud pass
      vec4 cl = texture2D(uTex, gl_FragCoord.xy / uRes);
      col = skyBase(rd, true) * cl.a + cl.rgb / max(1.0 - cl.rgb, 0.001);
    }
    boltCol = lightningBolt(ro, rd);
  } else {
    // intersect the wavy surface (plane + refinement)
    float tw = -ro.y / rd.y;
    vec3 w;
    for (int i = 0; i < 3; i++) {
      vec3 p = ro + rd * tw;
      w = waves(p.xz, t, tw);
      tw = (min(w.x, ro.y - 0.1) - ro.y) / rd.y; // never behind the camera on grazing rays
    }
    vec3 p = ro + rd * tw;
    float dist = tw;
    hitT = dist;
    w = waves(p.xz, t, dist);
    vec3 n = normalize(vec3(-w.y, 1.0, -w.z));
    float crest = CREST;

    // raindrop and hailstone rings near the camera
    float drops = max(uWeather.x, uPrecip.y);
    float splash = 0.0;
    if (drops > 0.001 && dist < 40.0) {
      vec3 rp = rainRipples(p.xz, t);
      float nf = 1.0 - smoothstep(10.0, 40.0, dist);
      vec2 rg = rp.xy * drops * 0.35 * nf;
      n = normalize(n + vec3(rg.x, 0.0, rg.y));
      splash = clamp(rp.z * uPrecip.y * nf, 0.0, 1.0);
    }

    // near the island the swell feels the bottom: it swings round to roll in square to the
    // shore and steepens into lines of surf that run up the beach and burst under the cliffs
    vec2 dI = p.xz - ISLE.xz;
    float off = 1e3, ph = 0.0, sandy = 0.0;
    if (dot(dI, dI) < 620.0 * 620.0) {
      vec2 cst = isleCoast(p.xz);
      sandy = cst.y;
      off = mix(12.0, 18.0, sandy) - cst.x;                 // metres out from the waterline
      if (off < 200.0) {
        float near = 1.0 - smoothstep(20.0, 200.0, off);
        ph = off * 0.25 + t * 1.1 + noise(p.xz * 0.015) * 4.0;
        float slope = 1.5 * exp(1.5 * (sin(ph) - 1.0)) * cos(ph) * 0.25;  // d(height)/d(off)
        vec2 g = normalize(dI) * slope * (0.25 + 0.03 * uWater.w) * near * smoothstep(-5.0, 15.0, off);
        n = normalize(vec3(-w.y * (1.0 - 0.7 * near) - g.x, 1.0, -w.z * (1.0 - 0.7 * near) - g.y));
        crest = max(crest * (1.0 - near), smoothstep(0.85, 1.0, sin(ph)) * near);
      }
    }
    // shade cast on the water by the hills, the lighthouse and the jetty
    float isleSh = 0.0;
    vec3 L = shadowLight();
    vec2 Lh = normalize(L.xz + 1e-5);
    float along = -dot(dI, Lh);                           // only where the light passes over the island
    if (dot(dI, dI) < 900.0 * 900.0 && (dot(dI, dI) < 560.0 * 560.0 || (along > 0.0 && length(dI + Lh * along) < 560.0))) {
      isleSh = max(isleShadow(p + vec3(0.0, 0.3, 0.0), L), lighthouseShadow(p, L, hb));
      if (length(p.xz - JETTY.xy - BEACH_DIR * JETTY_L * 0.5) < JETTY_L) isleSh = max(isleSh, jettyShadow(p, L));
    }

    // wakes trailing behind the boats
    float wake = 0.0;
    if (uLife.x > 0.01 && dist < 3000.0) {
      vec2 wg = vec2(0.0);
      wake = max(boatWake(p.xz, uBoatA, wg), boatWake(p.xz, uBoatB, wg));
      n = normalize(n - vec3(wg.x, 0.0, wg.y) * (1.0 - smoothstep(800.0, 3000.0, dist)));
    }

    // reflection: the sky, and the island, lighthouse and boats on rays heading low toward them
    vec3 rf = reflect(rd, n);
    rf.y = abs(rf.y);
    vec3 refl = skyReflect(p, rf);
    // on calm water the moon's own disc shows, broken up by the ripples
    float calm = 1.0 - smoothstep(2.5, 7.0, uWater.w);
    if (calm > 0.0) refl = mix(refl, moon(rf, refl), calm);
    if (rf.y < 0.3 && dist < 4000.0) {
      // off a smoothed surface, as the ripples within a pixel average out: a wavering,
      // vertically smeared image rather than sparkly noise; it breaks up as the sea roughens
      float sm = mix(0.55, 0.3, smoothstep(100.0, 1500.0, dist));
      vec3 rm = reflect(rd, normalize(vec3(n.x * sm, 1.0, n.z * sm)));
      rm.y = abs(rm.y);
      vec4 mir = mirrorScene(p, rm, horizon, hb);
      refl = mix(refl, mir.rgb, mir.a * (1.0 - 0.6 * smoothstep(6.0, 16.0, uWater.w)));
    }
    refl = mix(refl, fogColor(rf), fogAmount(p, rf, 1e5)); // in fog or dust the sea mirrors the murk
    float shadow = max(cloudShadow(p), isleSh);
    float sd = max(dot(rf, SUN), 0.0);
    float spec = (pow(sd, 900.0) * 40.0 + pow(sd, 120.0) * 1.2) * (1.0 - shadow);

    // refraction into the water
    vec3 rr = refract(rd, n, 1.0 / 1.333);
    float d = floorDepth(p.xz);
    float tf = d / -rr.y;
    for (int i = 0; i < 2; i++) {
      vec3 q = p + rr * tf;
      d = floorDepth(q.xz);
      tf = d / -rr.y;
    }
    if (off < 200.0) {                              // the island's beach shelving up under the sea
      d = min(d, max(-isleHeight((p + rr * tf).xz), 0.05));
      tf = d / -rr.y;
    }
    vec3 q = p + rr * tf;
    vec3 light = (SUN_COL * 0.85 * smoothstep(-0.02, 0.4, el)) * (1.0 - 0.7 * isleSh) + SKY_AMB * 0.2;
    vec3 floorCol = seaFloor(q.xz, d, dist) * light * (1.0 - 0.45 * shadow);

    float murk = uWater.y;
    float pathLen = tf + d * 1.15;                 // view path + sunlight path down
    // tropical water is clearer; the polar sea is dark and hides its bottom
    vec3 absorb = vec3(0.36, 0.068, 0.045) * murk * mix(1.0, 0.5, uClimate.x) * (1.0 + 4.0 * uClimate.y);
    vec3 T = exp(-absorb * pathLen);
    vec3 deep = mix(vec3(0.0, 0.10, 0.20), vec3(0.02, 0.14, 0.14), smoothstep(1.0, 3.0, murk) * 0.6);
    deep = mix(deep, vec3(0.0, 0.21, 0.27), uClimate.x);       // warm turquoise
    deep = mix(deep, vec3(0.015, 0.05, 0.075), uClimate.y);    // dark steel-blue polar sea
    deep *= SKY_AMB * 0.6 + light * 0.4;
    vec3 refr = floorCol * T + deep * (1.0 - T);
    refr = mix(refr, deep * 1.1, smoothstep(40.0, 260.0, dist));
    // ice reaching out under the water around each berg glows turquoise
    float ice = 0.0;
    if (uClimate.y > 0.01) {
      for (int i = 0; i < 4; i++) ice += exp(-max(length(p.xz - uBergs[i].xy) / uBergs[i].z - 0.75, 0.0) * 6.0);
      refr = mix(refr, vec3(0.08, 0.42, 0.48) * (SKY_AMB * 0.5 + light * 0.6), min(ice, 1.0) * 0.55 * uClimate.y);
    }

    float cosi = max(dot(n, -rd), 0.0);
    float F = 0.02 + 0.98 * pow(1.0 - cosi, 5.0);
    col = mix(refr, refl, F);

    // light glowing through thin wave crests, strongest when looking toward the sun
    float back = pow(max(dot(normalize(rd.xz), normalize(SUN.xz + 1e-4)), 0.0), 3.0);
    col += vec3(0.05, 0.42, 0.36) * SUN_COL * crest * crest * (0.15 + back) * 0.5 * (1.0 - F);

    // whitecaps on crests once the wind picks up; only some crests break
    float windF = smoothstep(4.0, 12.0, uWater.w);
    float brk = smoothstep(0.55, 0.8, noise(p.xz * 0.045 + vec2(t * 0.04, 0.0)) + windF * 0.3 - 0.15);
    float tex = fbm(p.xz * 2.2 + vec2(t * 0.35, 0.0)) * 0.75 + noise(p.xz * 9.0 - t) * 0.25;
    float foam = crest * brk * windF * uWater.x;
    foam = clamp(foam * smoothstep(0.42, 0.62, tex) * 1.5, 0.0, 1.0);
    // crests spilling over: fresh whitecap on the crest and down its downwind face, a dark
    // hollow under the curling lip, and the foam patches the breaks leave behind
    if (dist < 450.0) {
      vec3 br = breakers(p.xz, t, tex, 1.0);
      vec2 wd = vec2(cos(uWave.z), sin(uWave.z));
      float front = clamp(-dot(w.yz, wd) * 4.0, 0.0, 1.0);
      float onCrest = smoothstep(0.05, 0.5, crest + front * 0.5);
      col *= 1.0 - br.z * front * 0.45;
      foam = max(foam, clamp(br.x * onCrest * smoothstep(0.3, 0.5, tex + 0.15) * 1.6 + br.y, 0.0, 1.0));
    }
    // long foam streaks blown along the wind in a gale
    if (uWater.w > 9.0) {
      vec2 wdir = vec2(cos(uWave.z), sin(uWave.z));
      vec2 wq = vec2(dot(p.xz, wdir), dot(p.xz, vec2(-wdir.y, wdir.x)));
      float streaks = smoothstep(0.62, 0.85, fbm(wq * vec2(0.08, 2.4) - vec2(t * 0.6, 0.0)));
      streaks *= smoothstep(0.4, 0.65, tex); // broken up, not solid bands
      foam = max(foam, streaks * smoothstep(9.0, 16.0, uWater.w) * 0.35 * uWater.x);
    }
    foam *= 1.0 - smoothstep(60.0, 400.0, dist);
    if (off < 200.0) {
      // breakers: a sharp white front with a trail of foam behind, then whitewash and
      // swash in the shallows; under the cliffs a churning band that swells with each wave
      float sea = 0.6 + 0.4 * smoothstep(3.0, 12.0, uWater.w);
      float st = mix(tex, noise(p.xz * 0.12 + vec2(t * 0.1, 0.0)), smoothstep(80.0, 600.0, dist));
      float zone = mix(35.0, 170.0 * sea, sandy);
      float u = fract((ph - 1.5708) / 6.2832);
      float line = exp(-u * 5.0) * (1.0 - smoothstep(0.94, 1.0, u)) * (1.0 - smoothstep(zone * 0.5, zone, off));
      line *= mix(1.0, smoothstep(0.3, 0.6, noise(p.xz * 0.025 + vec2(11.0, t * 0.04))), smoothstep(10.0, zone * 0.6, off));
      float wash = 1.0 - smoothstep(0.0, mix(6.0, 22.0, sandy), off);
      float band = (1.0 - sandy) * (1.0 - smoothstep(0.0, 16.0 + 10.0 * sin(ph), off + (noise(p.xz * 0.05) - 0.5) * 14.0));
      float sf = max(line * smoothstep(0.35, 0.6, st), max(wash * 0.9, band) * smoothstep(0.38, 0.6, st));
      foam = max(foam, clamp(sf * sea * 1.3, 0.0, 1.0) * (1.0 - smoothstep(2000.0, 4500.0, dist)));
    }
    foam = max(foam, max(splash, wake * (1.0 - smoothstep(1500.0, 3000.0, dist))));
    foam = max(foam, faunaFoam(p.xz) * clamp(uFauna.z * 2.0, 0.0, 1.0));
    vec3 foamCol = vec3(0.92) * (SUN_COL * max(el, 0.0) * 1.2 * (1.0 - 0.7 * isleSh) + SKY_AMB * 0.55);
    col = mix(col, foamCol, foam);
    col += SUN_COL * spec * (1.0 - foam);

    // moonlight path on the water: glints off every facet tilted just right to mirror the
    // moon, from ripples too small to see; the rougher the sea and the further off, the
    // wider and more broken up the path
    if (MOON_COL.b > 0.001) {
      vec3 hv = normalize(MOON - rd);
      float nh = max(dot(n, hv), 0.05);
      float s2 = 0.0006 + 0.004 * smoothstep(2.0, 14.0, uWater.w) + min(dist * 0.000004, 0.003);
      float bk = exp(-(1.0 - nh * nh) / (nh * nh * s2)) / (3.1416 * s2 * nh * nh * nh * nh);
      float glit = mix(1.0, smoothstep(0.55, 0.95, noise(p.xz * 2.5 + vec2(t * 1.3, -t))) * 3.5,
                       0.4 + 0.6 * smoothstep(3.0, 8.0, uWater.w));
      col += MOON_COL * bk * glit * 0.015 * (1.0 - foam) * (1.0 - isleSh);
    }

    // polar sea: loose plates of snow-covered pack ice drifting downwind, riding the swell
    if (uClimate.y > 0.01 && dist < 1500.0) {
      vec2 fq = (p.xz - uWind.xy * 0.03) * 0.14;
      float fn = noise(fq) * 0.6 + noise(fq * 2.7 + 3.0) * 0.3 + noise(fq * 9.0 + 7.0) * 0.1;
      float aa = 0.004 + dist * PX * 0.07 / max(-rd.y, 0.03);  // about a pixel, in noise units
      float floe = smoothstep(0.65 - aa, 0.65 + aa, fn) * uClimate.y * (1.0 - smoothstep(700.0, 1500.0, dist));
      float rim = smoothstep(0.61, 0.65, fn) * uClimate.y * (1.0 - floe);
      vec3 snowCol = vec3(0.9, 0.94, 0.98) * (0.92 + 0.08 * noise(p.xz * 1.3))
                   * (SUN_COL * max(dot(n, SUN), 0.0) * 0.95 + SKY_AMB * 0.75 + MOON_COL * 0.5);
      col = mix(col, vec3(0.1, 0.45, 0.5) * (SKY_AMB * 0.5 + light * 0.5), rim * 0.35); // ice just under water
      col = mix(col, snowCol, floe);
    }

    // glowing plankton lights up wherever the water is stirred, after dark
    float bio = uNight.y * (1.0 - DAY);
    if (bio > 0.01) {
      // only some crests flare up, broken into flecks; plus scattered pinpricks
      float patchy = smoothstep(0.55, 0.8, noise(p.xz * 0.06 + vec2(t * 0.05, 3.0)));
      float stir = foam * 2.0 + crest * patchy * smoothstep(0.55, 0.8, tex) + splash;
      float spark = smoothstep(0.9, 0.98, noise(p.xz * 7.0 + t * 0.5)) * smoothstep(0.2, 0.8, crest + 0.3 * patchy);
      col += vec3(0.05, 0.6, 1.0) * (stir * 0.7 + spark * 0.5) * bio * (1.0 - smoothstep(15.0, 180.0, dist));
    }

    // aerial haze toward the horizon
    col = mix(col, horizon, 1.0 - exp(-dist * 0.0022));
  }

  // the island and its lighthouse
  float tI;
  vec4 isl = island(ro, rd, horizon, 64, tI);
  if (isl.a > 0.0 && tI < hitT) { col = isl.rgb; hitT = tI; }
  float tJ;
  vec4 jt = jetty(ro, rd, horizon, tJ);
  if (jt.a > 0.0 && tJ < hitT) { col = jt.rgb; hitT = tJ; }
  float tL;
  vec4 lh = lighthouse(ro, rd, horizon, hb, tL);
  if (lh.a > 0.0 && tL < hitT) { col = mix(col, lh.rgb, lh.a); if (lh.a > 0.5) hitT = tL; }
  float tG;
  vec4 berg = icebergs(ro, rd, horizon, tG);
  if (berg.a > 0.0 && tG < hitT) { col = mix(col, berg.rgb, berg.a); if (berg.a > 0.5) hitT = tG; }

  // boats on the sea and gulls overhead, in front of whatever lies behind them
  float tB;
  vec4 bt = boat(ro, rd, uBoatA, horizon, tB);
  if (bt.a > 0.0 && tB < hitT) { col = mix(col, bt.rgb, bt.a); if (bt.a > 0.5) hitT = tB; }
  bt = boat(ro, rd, uBoatB, horizon, tB);
  if (bt.a > 0.0 && tB < hitT) { col = mix(col, bt.rgb, bt.a); if (bt.a > 0.5) hitT = tB; }
  gulls(ro, rd, col, hitT);
  // dolphins, a whale and a shark, now and then
  if (uFauna.z > 0.01) wildlife(ro, rd, horizon, col, hitT);

  // fog, rain haze and sea spray; lightning is bright enough to punch through it
  float fogA = fogAmount(ro, rd, hitT);
  vec3 fogC = fogColor(rd);
  col = mix(col, fogC, fogA);

  // waterspout in front of the scene, hazed by the air in between
  float tS;
  vec4 spout = waterspout(ro, rd, tS);
  if (spout.a > 0.0 && tS < hitT) col = mix(col, mix(spout.rgb, fogC, fogAmount(ro, rd, tS)), spout.a);

  // spray torn off the breaking crests, glowing when you look toward the sun
  float spr = spindrift(ro, rd, hitT, t);
  if (spr > 0.0) {
    vec3 sprC = vec3(0.9, 0.93, 0.96) * (SKY_AMB * 0.75 + SUN_COL * (0.35 + pow(max(dot(rd, SUN), 0.0), 6.0) * 0.8));
    col = mix(col, sprC, clamp(spr, 0.0, 1.0));
  }

  // pale sun disc glowing through dust or thin fog
  if (rd.y > 0.0) {
    float hz = max(uPrecip.z, smoothstep(0.006, 0.02, uWeather.y) * (1.0 - gloom)) * (1.0 - smoothstep(0.7, 1.0, uSky.x));
    col += mix(vec3(1.0, 0.97, 0.92), vec3(1.0, 0.7, 0.45), uPrecip.z)
         * smoothstep(0.9993, 0.99965, dot(rd, SUN)) * hz * fogA * smoothstep(-0.03, 0.03, el) * 1.4;
  }

  // gusts of blown dust, spindrift and spray streaming past
  if (uWind.z > 0.01) col = mix(col, fogC * 1.08, veils(ro, rd, hitT) * uWind.z);

  col += boltCol * pow(1.0 - fogA, 0.3);
  col += lighthouseBeams(ro, rd, hb, hitT) * pow(1.0 - fogA, 0.4);

  // rainbow in the far rain once the sun breaks through
  if (uPrecip.w > 0.005) {
    float dark;
    vec3 bow = rainbow(rd, dark);
    float b = uPrecip.w * smoothstep(200.0, 2000.0, hitT) * (1.0 - fogA * 0.6);
    col = col * (1.0 - dark * 0.15 * b) + bow * SUN_COL * b * 0.4;
  }

  // falling rain, hail and snow, laid out by view angle so they stay put when you look around
  if (uWeather.x + uPrecip.x + uPrecip.y > 0.001) {
    vec2 wd = vec2(cos(uWave.z), sin(uWave.z));
    float side = dot(r.xz, wd) * uWater.w;           // crosswind as seen from here
    float elv = asin(clamp(rd.y, -1.0, 1.0));
    float az = atan(rd.x, rd.z);
    float px = 1.0 / (1.4 * uRes.y);                 // radians per pixel
    if (uWeather.x > 0.001) {
      vec2 a = vec2(az + elv * side * 0.02, elv);
      float amt = uWeather.x;
      float rn = rainLayer(a, 55.0, 0.10, 2.6, 0.30, 1.0, px, amt) * 0.6
               + rainLayer(a, 130.0, 0.05, 1.4, 0.40, 2.0, px, amt) * 0.4
               + rainLayer(a, 280.0, 0.025, 0.75, 0.50, 3.0, px, amt) * 0.25;
      col += (SKY_AMB * 0.6 + SUN_COL * 0.1) * vec3(0.85, 0.9, 1.0) * rn * amt;
    }
    if (uPrecip.y > 0.001) {
      // hail: short bright pellets falling hard
      vec2 a = vec2(az + elv * side * 0.012, elv);
      float amt = uPrecip.y;
      float hl = rainLayer(a, 45.0, 0.022, 3.0, 0.35, 5.0, px, amt)
               + rainLayer(a, 100.0, 0.012, 2.2, 0.45, 6.0, px, amt) * 0.6;
      col += (SKY_AMB * 1.1 + SUN_COL * 0.3) * hl * amt;
    }
    if (uPrecip.x > 0.001) {
      // snow drifts down slowly and gets driven sideways by strong wind
      vec2 a = vec2(az + elv * side * 0.06, elv);
      float amt = uPrecip.x;
      float fall = 1.0 + uWater.w * 0.05;
      float sn = snowLayer(a, 14.0, 1.8 * fall, 0.25 * amt, 7.0, px) * 0.9
               + snowLayer(a, 30.0, 2.2 * fall, 0.32 * amt, 8.0, px) * 0.8
               + snowLayer(a, 65.0, 2.5 * fall, 0.38 * amt, 9.0, px) * 0.6
               + snowLayer(a, 140.0, 2.8 * fall, 0.42 * amt, 10.0, px) * 0.45;
      col = mix(col, vec3(0.95, 0.97, 1.0) * (SKY_AMB * 0.9 + SUN_COL * 0.35), clamp(sn, 0.0, 1.0));
    }
  }

  col = aces(col * uSky.z);
  // subtle vignette
  vec2 q2 = gl_FragCoord.xy / uRes;
  col *= 0.88 + 0.12 * pow(16.0 * q2.x * q2.y * (1.0 - q2.x) * (1.0 - q2.y), 0.25);
  gl_FragColor = vec4(col, 1.0);
}
#endif
`,
};
