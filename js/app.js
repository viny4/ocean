(() => {
  const canvas = document.getElementById('c');
  // when 3D graphics can't start (or crash for good), say why and how to get them back
  function noWebGL(lost) {
    document.body.innerHTML = `<div style="max-width:560px;margin:12vh auto;padding:0 20px;font:16px/1.55 -apple-system,system-ui,sans-serif;color:#dfe9f2">
      <h1 style="font-size:24px;margin:0 0 12px">🌊 ${lost ? 'The graphics card stopped responding' : 'This browser blocked 3D graphics (WebGL)'}</h1>
      <p style="margin:0 0 14px;color:#a9bccd">The ocean needs WebGL. Usually one of these brings it back:</p>
      <ol style="padding-left:20px;margin:0">
        <li><b>Quit the browser completely and open it again.</b> After a graphics crash, Chrome turns WebGL off for the site until it restarts.</li>
        <li>Turn on hardware acceleration: in Chrome, Settings → System → "Use graphics acceleration when available".</li>
        <li>Open <code>chrome://gpu</code> and check that WebGL says "Hardware accelerated".</li>
        <li>Editor previews (like the one inside VS Code) can't run it: open the page in Chrome, Safari, Edge or Firefox.</li>
      </ol>
      <p style="margin:18px 0 0"><button onclick="location.reload()" style="font:inherit;padding:8px 16px;border-radius:8px;border:0;background:#2b6f9e;color:#fff;cursor:pointer">Try again</button></p></div>`;
    document.body.style.cssText = 'background:#08131d;overflow:auto';
  }
  const gl = canvas.getContext('webgl', { antialias: false, preserveDrawingBuffer: true })
          || canvas.getContext('webgl', { antialias: false })
          || canvas.getContext('experimental-webgl', { antialias: false });
  if (!gl) { noWebGL(false); return; }
  // if the GPU resets mid-flight, come back at Low quality rather than freeze; give up after a few tries
  canvas.addEventListener('webglcontextlost', e => {
    e.preventDefault();
    let tries = 0;
    try { tries = +sessionStorage.getItem('ocean-gl-lost') || 0; sessionStorage.setItem('ocean-gl-lost', tries + 1); } catch (_) {}
    try {
      const saved = JSON.parse(localStorage.getItem('ocean-settings-v1') || '{}');
      saved.quality = 'low';
      localStorage.setItem('ocean-settings-v1', JSON.stringify(saved));
    } catch (_) {}
    if (tries < 2) setTimeout(() => location.reload(), 400); else noWebGL(true);
  });

  function compile(type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  }
  // one shader source, compiled twice: the half-resolution cloud pass and the main scene
  const NAMES = ['uRes', 'uTime', 'uLook', 'uPos', 'uSun', 'uWave', 'uWater', 'uSky', 'uWeather', 'uBolt',
                 'uPrecip', 'uSpout', 'uWind', 'uNight', 'uStars', 'uTex', 'uCloudView', 'uCloudRes',
                 'uBoatA', 'uBoatB', 'uBirds', 'uLife', 'uMoon', 'uMoonSun', 'uSkyRot', 'uCat', 'uLines',
                 'uClimate', 'uBergs', 'uDolphin', 'uWhale', 'uShark', 'uFauna'];
  const vsSrc = window.OCEAN_SHADERS.vs, fsSrc = window.OCEAN_SHADERS.fs;
  function program(defines) {
    const p = gl.createProgram();
    const vs = compile(gl.VERTEX_SHADER, vsSrc), fs = compile(gl.FRAGMENT_SHADER, defines + fsSrc);
    gl.attachShader(p, vs);
    gl.attachShader(p, fs);
    gl.bindAttribLocation(p, 0, 'aPos');
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    gl.deleteShader(vs); gl.deleteShader(fs); // freed along with the program
    const loc = {};
    for (const n of NAMES) loc[n] = gl.getUniformLocation(p, n);
    return { p, loc };
  }
  // rebuilt when the quality setting changes the number of cloud steps
  let mainProg = null, cloudProg = null, progSteps = 0;
  function buildPrograms(steps) {
    if (steps === progSteps) return;
    for (const pr of [mainProg, cloudProg]) if (pr) gl.deleteProgram(pr.p);
    const defs = `#define CLOUD_N ${steps}\n`;
    mainProg = program(defs);
    cloudProg = program(defs + '#define CLOUD_PASS\n');
    progSteps = steps;
    histOk = false;
  }

  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

  // two cloud buffers, swapped every frame (one is written while the other is the history);
  // half-float keeps the slow blending free of banding where the GPU supports it
  const halfExt = gl.getExtension('OES_texture_half_float');
  const halfLinear = gl.getExtension('OES_texture_half_float_linear');
  gl.getExtension('EXT_color_buffer_half_float');
  let texType = halfExt && halfLinear ? halfExt.HALF_FLOAT_OES : gl.UNSIGNED_BYTE;
  function makeTarget(w, h) {
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, texType, null);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    if (texType !== gl.UNSIGNED_BYTE && gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
      texType = gl.UNSIGNED_BYTE; // half-float not renderable here: fall back
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, texType, null);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { tex, fb };
  }
  let targets = [], cloudW = 0, cloudH = 0, cur = 0, histOk = false;

  // render resolution adapts to keep the GPU (and the rest of the machine) responsive
  // (the quality setting below caps both the pixel ratio and the scale range)
  let maxDpr = Math.min(window.devicePixelRatio || 1, 2);
  let renderScale = 0.5, scaleMin = 0.3, scaleMax = 1;
  function resize() {
    const s = maxDpr * renderScale;
    canvas.width = Math.max(1, Math.floor(window.innerWidth * s));
    canvas.height = Math.max(1, Math.floor(window.innerHeight * s));
    const w = Math.ceil(canvas.width / 2), h = Math.ceil(canvas.height / 2);
    if (w !== cloudW || h !== cloudH) {
      for (const t of targets) { gl.deleteTexture(t.tex); gl.deleteFramebuffer(t.fb); }
      targets = [makeTarget(w, h), makeTarget(w, h)];
      cloudW = w; cloudH = h; histOk = false;
    }
  }
  window.addEventListener('resize', resize);
  resize();
  let perfTime = 0, perfFrames = 0;
  function adaptResolution(dt) {
    perfTime += dt; perfFrames++;
    if (perfTime < 1.5) return;
    const fps = perfFrames / perfTime;
    perfTime = 0; perfFrames = 0;
    const old = renderScale;
    if (fps < 45) renderScale = Math.max(scaleMin, renderScale * 0.88);
    else if (fps > 57) renderScale = Math.min(scaleMax, renderScale * 1.06);
    if (renderScale !== old) resize();
  }

  // ---------- settings ----------
  // [key, label, unit, min, max, step, default, section]
  const DEFS = [
    ['windSpeed',  'Wind speed',      ' m/s', 2,   25,  0.1,  5,    'Waves'],
    ['windDir',    'Wind direction',  '°',    0,   360, 1,    20,   'Waves'],
    ['choppy',     'Choppiness',      '',     0.5, 2.5, 0.01, 1,    'Waves'],
    ['foam',       'Foam',            '',     0,   2,   0.01, 1,    'Waves'],
    ['murk',       'Water murkiness', '',     0.3, 3,   0.01, 1,    'Water'],
    ['depth',      'Sea depth',       '×',    0.3, 5,   0.01, 1,    'Water'],
    ['glow',       'Glowing plankton (night)', '', 0, 1, 0.01, 0.7, 'Water'],
    ['sunElev',    'Sun height',      '°',    -18, 90,  0.1,  30,   'Sky'],
    ['sunAzim',    'Sun direction',   '°',    -180, 180, 0.5, 59,   'Sky'],
    ['season',     'Season (winter → summer)', '', 0, 1, 0.01, 0.5, 'Sky'],
    ['clouds',     'Clouds',          '',     0,   1,   0.01, 0.5,  'Sky'],
    ['cloudSpeed', 'Cloud speed',     '×',    0,   4,   0.01, 1,    'Sky'],
    ['planes',     'Air traffic',     '',     0,   1,   0.01, 1,    'Sky'],
    ['moon',       'Moon phase (new → full)', '', 0, 1, 0.01, 0.75, 'Night sky'],
    ['stars',      'Stars & Milky Way', '',   0,   1.5, 0.01, 1,    'Night sky'],
    ['lines',      'Constellation lines', '', 0,   1,   0.01, 0,    'Night sky'],
    ['sats',       'Satellites',      '',     0,   1,   0.01, 1,    'Night sky'],
    ['meteors',    'Shooting stars',  '',     0,   1,   0.01, 0.4,  'Night sky'],
    ['aurora',     'Northern lights', '',     0,   1,   0.01, 0,    'Night sky'],
    ['rain',       'Rain',            '',     0,   1,   0.01, 0,    'Weather effects'],
    ['snow',       'Snow',            '',     0,   1,   0.01, 0,    'Weather effects'],
    ['hail',       'Hail',            '',     0,   1,   0.01, 0,    'Weather effects'],
    ['fog',        'Fog',             '',     0,   1,   0.01, 0,    'Weather effects'],
    ['dust',       'Sand / dust',     '',     0,   1,   0.01, 0,    'Weather effects'],
    ['lightning',  'Lightning',       '',     0,   1,   0.01, 0,    'Weather effects'],
    ['spout',      'Waterspout',      '',     0,   1,   0.01, 0,    'Weather effects'],
    ['life',       'Boats & wildlife', '',    0,   1,   0.01, 1,    'Life & sound'],
    ['volume',     'Sound volume',    '',     0,   1,   0.01, 0.6,  'Life & sound'],
    ['exposure',   'Exposure',        '',     0.4, 2.5, 0.01, 1.05, 'Image'],
  ];
  const DEFAULTS = Object.fromEntries(DEFS.map(d => [d[0], d[6]]));
  const CALM = { rain: 0, snow: 0, hail: 0, fog: 0, dust: 0, lightning: 0, spout: 0, aurora: 0 };
  const sea = (windSpeed, choppy, foam, murk, clouds, cloudSpeed) => ({ ...CALM, windSpeed, choppy, foam, murk, clouds, cloudSpeed });
  const wrapDeg = d => ((d % 360) + 540) % 360 - 180;
  const WEATHER = {
    Sunny:      { icon: '☀️', v: sea(4.5, 1.0, 0.8, 1.0, 0.3, 0.8) },
    Cloudy:     { icon: '⛅', v: { ...sea(6, 1.0, 1.0, 1.2, 0.85, 1.2), fog: 0.05 } },
    Overcast:   { icon: '☁️', v: { ...sea(6.5, 1.1, 1.0, 1.4, 1.0, 0.9), fog: 0.12 } },
    Drizzle:    { icon: '🌦️', v: { ...sea(5, 1.0, 0.9, 1.4, 0.95, 1.0), rain: 0.3, fog: 0.3 } },
    Rainy:      { icon: '🌧️', v: { ...sea(8, 1.2, 1.0, 1.5, 0.95, 1.6), rain: 0.7, fog: 0.15 } },
    Stormy:     { icon: '⛈️', v: { ...sea(17, 1.9, 1.8, 2.0, 1.0, 3.0), rain: 1.0, fog: 0.25, lightning: 0.8 } },
    Foggy:      { icon: '🌫️', v: { ...sea(2.5, 0.9, 0.5, 1.2, 0.6, 0.4), fog: 0.8 } },
    Haze:       { icon: '🌁', v: { ...sea(4, 0.9, 0.7, 1.3, 0.15, 0.6), dust: 0.3, fog: 0.1 } },
    Windy:      { icon: '💨', v: { ...sea(14, 1.6, 1.5, 1.4, 0.45, 3.5), fog: 0.05 } },
    Snowy:      { icon: '🌨️', v: { ...sea(5, 1.0, 0.9, 1.3, 0.95, 0.8), snow: 0.7, fog: 0.25 } },
    Sleet:      { icon: '🧊', v: { ...sea(8, 1.2, 1.1, 1.5, 1.0, 1.4), rain: 0.45, snow: 0.4, fog: 0.2 } },
    Blizzard:   { icon: '❄️', v: { ...sea(18, 1.9, 1.7, 1.6, 1.0, 3.5), snow: 1.0, fog: 0.55 } },
    Hail:       { icon: '🌩️', v: { ...sea(11, 1.5, 1.4, 1.6, 1.0, 2.2), hail: 0.85, rain: 0.35, fog: 0.12, lightning: 0.35 } },
    Sandstorm:  { icon: '🏜️', v: { ...sea(15, 1.5, 1.2, 2.5, 0.2, 3.0), dust: 1.0 } },
    Hurricane:  { icon: '🌀', v: { ...sea(25, 2.4, 2.0, 2.5, 1.0, 4.0), rain: 1.0, fog: 0.35, lightning: 0.35 } },
    Waterspout: { icon: '🌪️', v: { ...sea(9, 1.3, 1.2, 1.5, 0.95, 1.4), spout: 1.0, lightning: 0.1 } },
    // a light shower with the sun behind you; the sun swings round so the bow is in front
    Rainbow:    { icon: '🌈', time: null, v: () => ({ ...sea(5, 1.0, 0.9, 1.1, 0.45, 1.0), rain: 0.15, sunElev: 32, sunAzim: wrapDeg(yaw * 180 / Math.PI + 180), exposure: 1.05 }) },
    Aurora:     { icon: '🌌', time: 'Night', lookUp: true, v: { ...sea(3.5, 0.9, 0.6, 0.9, 0.12, 0.5), aurora: 1.0, glow: 1.0, moon: 0.35, sunElev: -16, sunAzim: 180, exposure: 2.4 } },
    // dark, moonless and clear: the Milky Way at its best
    'Starry night':  { icon: '✨', time: 'Night', lookUp: true, v: { ...sea(3, 0.9, 0.5, 0.9, 0.05, 0.4), moon: 0.03, stars: 1.2, meteors: 0.4, sunElev: -18, sunAzim: 180, exposure: 2.5 } },
    'Meteors':       { icon: '🌠', time: 'Night', lookUp: true, v: { ...sea(3, 0.9, 0.5, 0.9, 0.08, 0.4), moon: 0.1, stars: 1.1, meteors: 1.0, sunElev: -18, sunAzim: 180, exposure: 2.5 } },
    'Full moon':     { icon: '🌕', time: 'Night', lookUp: true, v: { ...sea(4, 1.0, 0.6, 1.0, 0.3, 0.6), moon: 1.0, sunElev: -16, sunAzim: 180, exposure: 2.2 } },
  };
  // where you are on the globe: the latitude sets how high the sun climbs and which stars
  // you see; the rest is the colour of the water, the light and the ice
  const CLIMATES = {
    Temperate: { icon: '🌲', lat: 48, tropic: 0, polar: 0 },
    Tropical:  { icon: '🏝️', lat: 12, tropic: 1, polar: 0 },
    Polar:     { icon: '🧊', lat: 72, tropic: 0, polar: 1 },
  };
  // the sun's height at noon for the chosen latitude and season (northern hemisphere)
  function noonElev() {
    const decl = -23.44 * Math.cos(Math.PI * S.season);
    return 90 - Math.abs(CLIMATES[S.climate].lat - decl);
  }
  const TIMES = {
    'Dawn':        { icon: '🌄', v: { sunElev: 1,  sunAzim: -100, exposure: 1.3 } },
    'Morning':     { icon: '🌤️', v: () => ({ sunElev: Math.round(noonElev() * 0.35), sunAzim: -50, exposure: 1.1 }) },
    'Noon':        { icon: '🌞', v: () => ({ sunElev: Math.round(noonElev()), sunAzim: 59, exposure: 1.05 }) },
    'Golden hour': { icon: '🌅', v: { sunElev: 4,  sunAzim: 8,    exposure: 1.15 } },
    'Twilight':    { icon: '🌆', v: { sunElev: -3, sunAzim: 0,    exposure: 1.6 } },
    'Night':       { icon: '🌙', lookUp: true, v: { sunElev: -16, sunAzim: 180, exposure: 2.4 } },
  };

  const STORE_KEY = 'ocean-settings-v1';
  const S = { ...DEFAULTS, weather: null, time: null }; // targets: what the sliders show
  try { Object.assign(S, JSON.parse(localStorage.getItem(STORE_KEY) || '{}')); } catch (e) {}
  if (!CLIMATES[S.climate]) S.climate = 'Temperate'; // settings saved before climates existed
  function save() { try { localStorage.setItem(STORE_KEY, JSON.stringify(S)); } catch (e) {} }

  // ---------- quality ----------
  // caps on pixel ratio, resolution and cloud detail; Auto is the adaptive resolution,
  // held a little lower on phones and tablets
  const MOBILE = matchMedia('(pointer: coarse)').matches || Math.min(screen.width, screen.height) < 600;
  const QUALITY = {
    auto:   { label: 'Auto',   icon: '🪄', dpr: MOBILE ? 1.5 : 2, min: 0.3, max: MOBILE ? 0.75 : 1, clouds: MOBILE ? 40 : 56 },
    low:    { label: 'Low',    icon: '🔋', dpr: 1,   min: 0.3, max: 0.6, clouds: 28 },
    medium: { label: 'Medium', icon: '⚖️', dpr: 1.5, min: 0.3, max: 0.8, clouds: 40 },
    high:   { label: 'High',   icon: '💎', dpr: 2,   min: 0.5, max: 1,   clouds: 56 },
  };
  if (!Object.prototype.hasOwnProperty.call(QUALITY, S.quality)) S.quality = 'auto';
  function applyQuality() {
    const q = QUALITY[S.quality];
    maxDpr = Math.min(window.devicePixelRatio || 1, q.dpr);
    scaleMin = q.min; scaleMax = q.max;
    renderScale = Math.min(scaleMax, Math.max(scaleMin, renderScale));
    buildPrograms(q.clouds);
    resize();
    for (const n in qualityBtns) qualityBtns[n].setAttribute('aria-pressed', String(S.quality === n));
  }
  const qualityBtns = {};
  for (const name in QUALITY) {
    const b = document.createElement('button');
    b.innerHTML = `<span class="ic">${QUALITY[name].icon}</span><span>${QUALITY[name].label}</span>`;
    b.title = name === 'auto' ? 'Resolution adapts to keep things smooth' : `${QUALITY[name].label} detail`;
    b.addEventListener('click', () => { S.quality = name; save(); applyQuality(); });
    document.getElementById('quality').appendChild(b);
    qualityBtns[name] = b;
  }
  applyQuality();

  const C = { ...S }; // what the scene shows right now; eases toward S
  const clim = { ...CLIMATES[S.climate] }; // the climate the scene shows, easing toward the chosen one
  const rate = Object.fromEntries(Object.keys(DEFAULTS).map(k => [k, 8]));

  const panel = document.getElementById('panel');
  const sliders = document.getElementById('sliders');
  const inputs = {};
  let section = null, group = null;
  for (const [key, label, unit, min, max, step, , sec] of DEFS) {
    if (sec !== section) {
      // each slider section folds away so the panel stays tidy
      section = sec;
      group = document.createElement('details');
      group.className = 'group';
      group.innerHTML = `<summary>${sec}</summary>`;
      sliders.appendChild(group);
    }
    const row = document.createElement('div');
    row.className = 'row';
    row.innerHTML = `<label for="s-${key}">${label}</label><output></output>
      <input id="s-${key}" type="range" min="${min}" max="${max}" step="${step}">`;
    const input = row.querySelector('input');
    const out = row.querySelector('output');
    const decimals = step < 0.1 ? 2 : step < 1 ? 1 : 0;
    const show = () => { out.textContent = (+S[key]).toFixed(decimals) + unit; };
    input.value = S[key];
    show();
    input.addEventListener('input', () => {
      const noon = noonElev();
      S[key] = +input.value; rate[key] = 8; show(); save();
      if (key === 'sunElev' || key === 'sunAzim' || key === 'moon') setReal(false);
      if (key === 'season') followSun(noon);
    });
    inputs[key] = { input, show };
    group.appendChild(row);
  }
  // presets ease in slowly, so a weather change rolls in over a few seconds
  function setTargets(values, speed) {
    for (const k in values) { S[k] = values[k]; rate[k] = speed; }
    for (const k in inputs) { inputs[k].input.value = S[k]; inputs[k].show(); }
    save();
  }
  function applyPreset(defs, key, name, speed) {
    const p = defs[name];
    S[key] = name;
    if ('time' in p) S.time = p.time; // presets that also move the sun
    if (key === 'time' || 'time' in p) setReal(false); // a chosen time replaces the real one
    if (p.lookUp) tPitch = Math.max(tPitch, 0.14); // tilt the view up to the night sky
    setTargets(typeof p.v === 'function' ? p.v() : p.v, speed);
    markPresets();
  }
  function presetButtons(id, defs, key) {
    const box = document.getElementById(id);
    const btns = {};
    for (const name in defs) {
      const b = document.createElement('button');
      b.innerHTML = `<span class="ic">${defs[name].icon}</span><span>${name}</span>`;
      b.addEventListener('click', () => { applyPreset(defs, key, name, 0.7); autoTimer = AUTO_EVERY; });
      box.appendChild(b);
      btns[name] = b;
    }
    return btns;
  }
  const weatherBtns = presetButtons('weather', WEATHER, 'weather');
  const timeBtns = presetButtons('times', TIMES, 'time');
  // a new climate or season stretches the sun's daily arc to the new noon height
  // (the real sky keeps the true sun)
  function followSun(oldNoon) {
    if (real.on) return;
    const noon = noonElev();
    let e = S.sunElev;
    if (e > 0) e = oldNoon > 0.5 && noon > 0.5 ? e * noon / oldNoon : Math.min(e, noon);
    setTargets({ sunElev: Math.max(-18, Math.min(90, e)) }, 1.2);
  }
  const climateBtns = {};
  for (const name in CLIMATES) {
    const b = document.createElement('button');
    b.innerHTML = `<span class="ic">${CLIMATES[name].icon}</span><span>${name}</span>`;
    b.addEventListener('click', () => {
      const noon = noonElev();
      S.climate = name;
      followSun(noon);
      save();
      markPresets();
    });
    document.getElementById('climates').appendChild(b);
    climateBtns[name] = b;
  }
  function markPresets() {
    for (const n in weatherBtns) weatherBtns[n].setAttribute('aria-pressed', String(S.weather === n));
    for (const n in timeBtns) timeBtns[n].setAttribute('aria-pressed', String(S.time === n));
    for (const n in climateBtns) climateBtns[n].setAttribute('aria-pressed', String(S.climate === n));
    autoBtn.setAttribute('aria-pressed', String(!!S.auto));
  }

  // live weather: the sky drifts from one plausible weather to the next by itself
  const NEXT = {
    Sunny: ['Cloudy', 'Windy', 'Haze', 'Cloudy'],     Cloudy: ['Overcast', 'Drizzle', 'Sunny', 'Windy'],
    Overcast: ['Rainy', 'Drizzle', 'Snowy', 'Foggy'], Drizzle: ['Rainy', 'Rainbow', 'Foggy'],
    Rainy: ['Stormy', 'Rainbow', 'Hail', 'Sleet'],    Stormy: ['Rainy', 'Hurricane', 'Hail', 'Waterspout'],
    Foggy: ['Cloudy', 'Sunny', 'Drizzle'],            Haze: ['Sandstorm', 'Sunny'],
    Windy: ['Sandstorm', 'Stormy', 'Cloudy'],         Snowy: ['Blizzard', 'Sleet', 'Overcast'],
    Sleet: ['Snowy', 'Rainy'],                        Blizzard: ['Snowy', 'Overcast'],
    Hail: ['Rainy', 'Stormy'],                        Sandstorm: ['Haze', 'Windy'],
    Hurricane: ['Stormy', 'Rainy'],                   Waterspout: ['Stormy', 'Rainy', 'Cloudy'],
    Rainbow: ['Sunny', 'Cloudy'],                     Aurora: ['Cloudy', 'Snowy'],
  };
  const AUTO_EVERY = 50;
  let autoTimer = AUTO_EVERY;
  const autoBtn = document.getElementById('auto');
  autoBtn.addEventListener('click', () => {
    S.auto = !S.auto;
    autoTimer = 0.5; // first change right away
    save();
    markPresets();
  });
  function autoStep() {
    const opts = NEXT[S.weather] || ['Cloudy'];
    applyPreset(WEATHER, 'weather', opts[Math.floor(Math.random() * opts.length)], 0.3);
  }

  // ---------- the real sky: sun, moon and stars for your place and time ----------
  const RAD = Math.PI / 180, OBL = 23.4397 * RAD;
  const eqVec = (ra, dec) => [Math.cos(dec) * Math.cos(ra), Math.cos(dec) * Math.sin(ra), Math.sin(dec)];
  function eclToEq(l, b) {
    return eqVec(Math.atan2(Math.sin(l) * Math.cos(OBL) - Math.tan(b) * Math.sin(OBL), Math.cos(l)),
                 Math.asin(Math.sin(b) * Math.cos(OBL) + Math.cos(b) * Math.sin(OBL) * Math.sin(l)));
  }
  function sunEq(d) { // low-precision solar position, d = days since J2000
    const M = RAD * (357.5291 + 0.98560028 * d);
    const C = RAD * (1.9148 * Math.sin(M) + 0.02 * Math.sin(2 * M) + 0.0003 * Math.sin(3 * M));
    return eclToEq(M + C + RAD * 102.9372 + Math.PI, 0);
  }
  function moonEq(d) { // good to about a degree
    const L = RAD * (218.316 + 13.176396 * d), M = RAD * (134.963 + 13.064993 * d), F = RAD * (93.272 + 13.229350 * d);
    return eclToEq(L + RAD * 6.289 * Math.sin(M), RAD * 5.128 * Math.sin(F));
  }
  // celestial unit vector -> local sky (x east, y up, z north) at sidereal time lst and latitude lat
  function toLocal(v, lst, lat) {
    const ra = Math.atan2(v[1], v[0]), dec = Math.asin(v[2]), H = lst - ra;
    return [-Math.cos(dec) * Math.sin(H),
            Math.sin(dec) * Math.sin(lat) + Math.cos(dec) * Math.cos(H) * Math.cos(lat),
            Math.sin(dec) * Math.cos(lat) - Math.cos(dec) * Math.cos(H) * Math.sin(lat)];
  }
  const cross3 = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  // matrix taking the frame (a1, b1, c1) onto (a2, b2, c2), column-major for GLSL. The local
  // sky (east, up, north) is left-handed, so the third axes are passed in rather than taken as
  // cross products: otherwise the whole sky would come out mirror-imaged
  function frameRot(a1, b1, c1, a2, b2, c2) {
    const F1 = [a1, b1, c1], F2 = [a2, b2, c2];
    const m = new Float32Array(9);
    for (let c = 0; c < 3; c++) for (let r = 0; r < 3; r++) {
      let s = 0;
      for (let k = 0; k < 3; k++) s += F2[k][r] * F1[k][c];
      m[c * 3 + r] = s;
    }
    return m;
  }
  const GAL_N = [-0.86765, -0.19807, 0.45604], GAL_C = [-0.05495, -0.87338, -0.48393];
  const GAL_B = cross3(GAL_N, GAL_C);
  const skyAt = (lst, lat) => frameRot(toLocal(GAL_N, lst, lat), toLocal(GAL_C, lst, lat), toLocal(GAL_B, lst, lat),
                                       GAL_N, GAL_C, GAL_B);
  // with the real sky off: the stars over the chosen climate's latitude at about 10 pm in the
  // chosen season (winter: Orion high in the south-east; summer: Scorpius and the Milky Way's core)
  const climateSky = () => skyAt((4 + 12 * C.season) * 15 * RAD, clim.lat * RAD);
  const real = { on: false, lat: 20, lon: 0, place: '', located: false, skyRot: null, moon: [0, -1, 0], sun: [0, 1, 0], timer: 0 };
  const realBtn = document.getElementById('realsky'), realInfo = document.getElementById('realinfo');
  const fmtPlace = () => `${Math.abs(real.lat).toFixed(1)}°${real.lat >= 0 ? 'N' : 'S'} ${Math.abs(real.lon).toFixed(1)}°${real.lon >= 0 ? 'E' : 'W'}`;
  function locate() {
    // a first guess from the clock's time zone, refined if the browser shares your location
    real.located = true;
    const tz = (Intl.DateTimeFormat().resolvedOptions().timeZone || '');
    real.lon = -new Date().getTimezoneOffset() / 4;
    real.lat = /Kolkata|Calcutta|Colombo/.test(tz) ? 13 : /America/.test(tz) ? 38 : /Europe/.test(tz) ? 48
             : /Australia/.test(tz) ? -30 : /Tokyo|Seoul|Shanghai/.test(tz) ? 35 : 20;
    real.place = fmtPlace() + ' (approx.)';
    if (navigator.geolocation) navigator.geolocation.getCurrentPosition(p => {
      real.lat = p.coords.latitude;
      real.lon = p.coords.longitude;
      real.place = fmtPlace();
      if (real.on) updateRealSky();
    }, () => {}, { timeout: 10000, maximumAge: 3600000 });
  }
  function updateRealSky() {
    const now = new Date();
    const d = now.valueOf() / 86400000 - 10957.5;                       // days since J2000
    const lat = real.lat * RAD, lst = RAD * (280.16 + 360.9856235 * d) + real.lon * RAD;
    const s = sunEq(d), m = moonEq(d);
    real.sun = toLocal(s, lst, lat);
    real.moon = toLocal(m, lst, lat);
    real.skyRot = skyAt(lst, lat);
    const elev = Math.asin(real.sun[1]) / RAD;
    const lit = (1 - (s[0] * m[0] + s[1] * m[1] + s[2] * m[2])) / 2; // fraction of the moon lit
    setTargets({
      sunElev: Math.max(-18, elev), sunAzim: Math.atan2(real.sun[0], real.sun[2]) / RAD, moon: lit,
      exposure: elev < -8 ? 2.4 : elev < -2 ? 1.7 : elev < 6 ? 1.2 : 1.05,
    }, 0.6);
    const hm = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    realInfo.textContent = `${real.place} · ${hm} · sun ${elev.toFixed(0)}° · moon ${Math.round(lit * 100)}% lit`
      + (real.moon[1] < 0 ? ' (set)' : '');
  }
  function setReal(on) {
    real.on = on;
    if (S.real !== on) { S.real = on; save(); }
    realBtn.setAttribute('aria-pressed', String(on));
    realInfo.hidden = !on;
    if (on) {
      if (!real.located) locate();
      S.time = null;
      markPresets();
      updateRealSky();
    }
  }
  realBtn.addEventListener('click', () => setReal(!real.on));

  // STARS and FIGURES (the star catalogue and constellation lines) come from stars.js
  // pack the catalogue into a small texture for the shader. The sky is cut into the cells of a
  // cube map; each cell lists (as 16-bit indices) up to six stars whose glow reaches into it,
  // so a pixel only ever looks at a handful. Two more rows hold each star's direction
  // (16 bits per axis), magnitude and colour.
  const CAT_G = 32, CAT_W = CAT_G * 6 * 3, CAT_H = CAT_G + 2, STAR_R = 0.0105; // as in the shader
  const catalog = STARS.split(/[\n,]/).map(e => e.replace(/^\s*\w+:/, '').trim()).filter(Boolean).map(e => {
    const t = e.split(/\s+/);
    const ra = (+t[1] + t[2] / 60 + t[3] / 3600) * 15 * RAD;
    const dec = (t[4][0] === '-' ? -1 : 1) * (Math.abs(+t[4]) + t[5] / 60 + t[6] / 3600) * RAD;
    return { name: t[0], v: eqVec(ra, dec), mag: +t[7], bv: +t[8] };
  }).sort((a, b) => a.mag - b.mag); // brightest first, so they win any crowded cell
  function cubeCell(d) { // the same cells as cubeUV() in the shader
    const a = d.map(Math.abs);
    const [f, u, v] = a[0] >= a[1] && a[0] >= a[2] ? [d[0] > 0 ? 0 : 1, d[2] / a[0], d[1] / a[0]]
                    : a[1] >= a[2] ? [d[1] > 0 ? 2 : 3, d[0] / a[1], d[2] / a[1]]
                    : [d[2] > 0 ? 4 : 5, d[0] / a[2], d[1] / a[2]];
    const cell = x => Math.min(CAT_G - 1, Math.floor((x * 0.5 + 0.5) * CAT_G));
    return [f, cell(u), cell(v)];
  }
  // two unit vectors at right angles to v, for drawing small circles around a star
  function tangents(v) {
    let e1 = Math.abs(v[2]) < 0.9 ? [-v[1], v[0], 0] : [0, -v[2], v[1]];
    const l = Math.hypot(...e1);
    e1 = e1.map(x => x / l);
    return [e1, cross3(v, e1)];
  }
  {
    const data = new Uint8Array(CAT_W * CAT_H * 4), fill = new Map();
    const put16 = (i, x) => { const q = Math.round(x); data[i] = q >> 8; data[i + 1] = q & 255; };
    catalog.forEach((s, i) => {
      const id = i + 1, v = s.v;
      put16((CAT_G * CAT_W + i) * 4, (v[0] + 1) * 32767.5);
      put16((CAT_G * CAT_W + i) * 4 + 2, (v[1] + 1) * 32767.5);
      put16(((CAT_G + 1) * CAT_W + i) * 4, (v[2] + 1) * 32767.5);
      data[((CAT_G + 1) * CAT_W + i) * 4 + 2] = Math.max(0, Math.min(255, Math.round((s.mag + 2) * 30)));
      data[((CAT_G + 1) * CAT_W + i) * 4 + 3] = Math.max(0, Math.min(255, Math.round((s.bv + 0.5) * 100)));
      // every cell touched by the disc the star's glow may cover
      const [e1, e2] = tangents(v), seen = new Set();
      for (let r = 0; r <= 2; r++) for (let k = 0; k < (r ? 16 : 1); k++) {
        const a = k / 16 * 2 * Math.PI, o = Math.tan(STAR_R * r / 2);
        const [f, cx, cy] = cubeCell(v.map((x, j) => x + (e1[j] * Math.cos(a) + e2[j] * Math.sin(a)) * o));
        seen.add((f * CAT_G + cx) * CAT_G + cy);
      }
      for (const c of seen) {
        const n = fill.get(c) || 0;
        if (n >= 6) continue;
        fill.set(c, n + 1);
        const cx = Math.floor(c / CAT_G), cy = c % CAT_G;
        put16((cy * CAT_W + cx * 3 + (n >> 1)) * 4 + (n & 1) * 2, id);
      }
    });
    const tex = gl.createTexture();
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    for (const p of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER]) gl.texParameteri(gl.TEXTURE_2D, p, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, CAT_W, CAT_H, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
    gl.activeTexture(gl.TEXTURE0);
  }
  // the constellation figures, drawn once (when first wanted) onto the six cube faces as
  // straight lines: on a cube face, great circles are straight
  let figuresTex = null;
  function drawFigures() {
    const N = 1024, cv = document.createElement('canvas');
    cv.width = N * 3; cv.height = N * 2;
    const g = cv.getContext('2d');
    g.fillStyle = '#000';
    g.fillRect(0, 0, cv.width, cv.height);
    const byName = Object.fromEntries(catalog.map(s => [s.name, s.v]));
    const segs = [];
    for (const chain of FIGURES.trim().split(/\s+/)) {
      const n = chain.split('-').map(k => byName[k]);
      for (let i = 0; i + 1 < n.length; i++) if (n[i] && n[i + 1]) segs.push([n[i], n[i + 1]]);
    }
    for (let f = 0; f < 6; f++) {
      const ax = f >> 1, sg = f & 1 ? -1 : 1;
      const [iu, iv] = ax === 0 ? [2, 1] : ax === 1 ? [0, 2] : [0, 1];
      const ox = (f % 3) * N, oy = Math.floor(f / 3) * N;
      const px = d => [ox + (d[iu] / (sg * d[ax]) * 0.5 + 0.5) * N, oy + (d[iv] / (sg * d[ax]) * 0.5 + 0.5) * N];
      g.save();
      g.beginPath();
      g.rect(ox, oy, N, N);
      g.clip();
      g.strokeStyle = '#fff';
      g.lineWidth = 1.3;
      g.beginPath();
      for (let [a, b] of segs) {
        const wa = sg * a[ax], wb = sg * b[ax], W = 0.05;
        if (wa < W && wb < W) continue;
        // cut the segment where it passes behind this face
        if (wa < W) a = a.map((x, j) => x + (b[j] - x) * (W - wa) / (wb - wa));
        if (wb < W) b = b.map((x, j) => x + (a[j] - x) * (W - wb) / (wa - wb));
        g.moveTo(...px(a));
        g.lineTo(...px(b));
      }
      g.stroke();
      // leave a little gap around each star
      g.fillStyle = '#000';
      for (const s of catalog) {
        const w = sg * s.v[ax];
        if (w < 0.3) continue;
        const [x, y] = px(s.v), u = s.v[iu] / w, v = s.v[iv] / w;
        g.beginPath();
        g.arc(x, y, 0.75 * RAD * N * 0.5 * Math.pow(1 + u * u + v * v, 0.75), 0, 2 * Math.PI);
        g.fill();
      }
      g.restore();
    }
    figuresTex = gl.createTexture();
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, figuresTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, gl.LUMINANCE, gl.UNSIGNED_BYTE, cv);
    gl.activeTexture(gl.TEXTURE0);
  }

  markPresets();
  if (S.real) setReal(true);
  document.getElementById('reset').addEventListener('click', () => {
    S.weather = null; S.time = null; S.climate = 'Temperate';
    setTargets(DEFAULTS, 1.5);
    markPresets();
  });
  const togglePanel = () => panel.classList.toggle('hidden');
  document.getElementById('gear').addEventListener('click', togglePanel);
  document.getElementById('close').addEventListener('click', togglePanel);

  // ---------- camera controls ----------
  // drag to look around
  // drag to look around (one finger at a time; with the camera on a boat, dragging swings it round the boat)
  let yaw = 0, pitch = -0.16, tYaw = yaw, tPitch = pitch, drag = null;
  canvas.addEventListener('pointerdown', e => {
    if (e.pointerType === 'touch') useTouch(true);
    if (drag) return;
    if (camMode === 'tour') setCam('free');
    drag = { id: e.pointerId, x: e.clientX, y: e.clientY };
    canvas.setPointerCapture(e.pointerId);
  });
  const endDrag = e => { if (drag && e.pointerId === drag.id) drag = null; };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);
  canvas.addEventListener('pointermove', e => {
    if (!drag || e.pointerId !== drag.id) return;
    const k = e.pointerType === 'touch' ? 0.005 : 0.004;
    const dx = (e.clientX - drag.x) * k, dy = (e.clientY - drag.y) * k;
    if (CAMS[camMode].boat !== undefined) {
      follow.orbit -= dx;
      follow.tilt = Math.max(-0.2, Math.min(1, follow.tilt + dy));
    } else {
      tYaw -= dx;
      tPitch = Math.max(-1.2, Math.min(0.5, tPitch + dy));
    }
    drag = { id: drag.id, x: e.clientX, y: e.clientY };
  });

  // keyboard movement
  const keys = new Set();
  const MOVE_KEYS = ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'];
  window.addEventListener('keydown', e => {
    const inControl = e.target instanceof HTMLElement && e.target.closest('#panel, #gear');
    if (inControl && (e.code.startsWith('Arrow') || e.code === 'Space' || e.code === 'Enter')) return;
    if (e.code === 'KeyH' && !e.repeat) { togglePanel(); return; }
    if (e.code === 'KeyM' && !e.repeat) { toggleSound(); return; }
    if (e.code === 'KeyP' && !e.repeat) { takePhoto(); return; }
    if (e.code === 'KeyC' && !e.repeat && !e.metaKey && !e.ctrlKey) { cycleCam(); return; }
    keys.add(e.code);
    if (MOVE_KEYS.includes(e.code)) { e.preventDefault(); setCam('free'); }
  });
  window.addEventListener('keyup', e => keys.delete(e.code));
  window.addEventListener('blur', () => keys.clear());
  // scroll wheel also changes height (but scrolls the panel when over it)
  let wheelLift = 0;
  window.addEventListener('wheel', e => {
    if (e.target instanceof HTMLElement && e.target.closest('#panel')) return;
    wheelLift -= e.deltaY * 0.01;
    e.preventDefault();
    setCam('free');
  }, { passive: false });

  // ---------- touch controls ----------
  // a virtual joystick to move, buttons to rise and dive, and a toggle to go faster
  const TOUCH = matchMedia('(pointer: coarse)').matches || (navigator.maxTouchPoints > 0 && matchMedia('(hover: none)').matches);
  const joy = { x: 0, y: 0, id: null };
  let fastLock = false;
  const stick = document.getElementById('stick'), knob = document.getElementById('knob');
  function moveStick(e) {
    const r = stick.getBoundingClientRect(), R = r.width / 2;
    let x = (e.clientX - r.left - R) / R, y = (e.clientY - r.top - R) / R;
    const len = Math.hypot(x, y), cl = Math.min(len, 1);
    if (len > 1) { x /= len; y /= len; }
    knob.style.transform = `translate(${x * R * 0.62}px, ${y * R * 0.62}px)`;
    const live = cl > 1e-6 ? Math.max(0, (cl - 0.12) / 0.88) / cl : 0; // a small dead zone in the middle
    joy.x = x * live; joy.y = -y * live;
  }
  function releaseStick() {
    joy.id = null; joy.x = 0; joy.y = 0;
    knob.style.transform = '';
  }
  stick.addEventListener('pointerdown', e => {
    e.preventDefault();
    if (joy.id !== null) return;
    joy.id = e.pointerId;
    stick.setPointerCapture(e.pointerId);
    setCam('free');
    moveStick(e);
  });
  stick.addEventListener('pointermove', e => { if (e.pointerId === joy.id) moveStick(e); });
  for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) {
    stick.addEventListener(ev, e => { if (e.pointerId === joy.id) releaseStick(); });
  }
  // rise / dive hold a virtual E / Q key, so the surface rules are the same as on a keyboard
  function holdButton(id, code) {
    const b = document.getElementById(id);
    b.addEventListener('pointerdown', e => {
      e.preventDefault();
      b.setPointerCapture(e.pointerId);
      keys.add(code); b.classList.add('on');
      setCam('free');
    });
    const up = () => { keys.delete(code); b.classList.remove('on'); };
    for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) b.addEventListener(ev, up);
    b.addEventListener('contextmenu', e => e.preventDefault());
  }
  holdButton('rise', 'KeyE');
  holdButton('dive', 'KeyQ');
  const fastBtn = document.getElementById('fast');
  fastBtn.addEventListener('click', () => {
    fastLock = !fastLock;
    fastBtn.setAttribute('aria-pressed', String(fastLock));
  });
  const HINT_KEYS = document.getElementById('hint').textContent;
  const HINT_TOUCH = 'Joystick to move · drag to look · ▲ ▼ up & down (▼ at the surface to dive) · ⚡ faster · 🎥 camera';
  function useTouch(on) {
    if (document.body.classList.contains('touch') === on) return;
    document.body.classList.toggle('touch', on);
    document.getElementById('hint').textContent = on ? HINT_TOUCH : HINT_KEYS;
    if (!on) releaseStick();
  }
  useTouch(TOUCH);

  // ---------- camera modes ----------
  // free flight, riding along behind one of the boats, or a slow automatic tour;
  // moving yourself always drops back to free flight
  const CAMS = {
    free:  { label: 'Free',  icon: '🕹️', title: 'Fly yourself' },
    // trailing from a three-quarter angle: the boats are drawn for viewing from a distance
    sloop: { label: 'Sloop', icon: '⛵', title: 'Follow the sailboat', boat: 0, back: 75, up: 6, ahead: 40, orbit: 0.6 },
    ship:  { label: 'Ship',  icon: '🚢', title: 'Follow the cargo ship', boat: 1, back: 420, up: 30, ahead: 150, orbit: 0.6 },
    tour:  { label: 'Tour',  icon: '🎬', title: 'A slow flyover: the island, the lighthouse and the boats' },
  };
  const CAM_ORDER = Object.keys(CAMS);
  let camMode = 'free';
  const follow = { orbit: 0, tilt: 0 };
  const camBtns = {};
  for (const name of CAM_ORDER) {
    const b = document.createElement('button');
    b.innerHTML = `<span class="ic">${CAMS[name].icon}</span><span>${CAMS[name].label}</span>`;
    b.title = CAMS[name].title;
    b.addEventListener('click', () => setCam(name));
    document.getElementById('cams').appendChild(b);
    camBtns[name] = b;
  }
  function setCam(mode) {
    if (mode === camMode) return;
    camMode = mode;
    follow.orbit = CAMS[mode].orbit || 0; follow.tilt = 0;
    if (mode === 'tour') { tour.leg = -1; nextLeg(); }
    for (const n in camBtns) camBtns[n].setAttribute('aria-pressed', String(camMode === n));
    const touch = document.body.classList.contains('touch');
    flashHint(`Camera: ${CAMS[mode].title.toLowerCase()}`
      + (CAMS[mode].boat !== undefined && !boatsOut() ? ' (the boats stay in port in this weather)' : '')
      + (mode === 'free' ? '' : touch ? ' · move to take over' : ' · C to switch, move to take over'));
  }
  const cycleCam = () => setCam(CAM_ORDER[(CAM_ORDER.indexOf(camMode) + 1) % CAM_ORDER.length]);
  camBtns.free.setAttribute('aria-pressed', 'true');
  document.getElementById('cam').addEventListener('click', e => { e.stopPropagation(); cycleCam(); });
  // the boat the camera is busy with (followed, or being passed on the tour), which must not be swapped out
  function heldBoat() {
    if (CAMS[camMode].boat !== undefined) return boats[CAMS[camMode].boat];
    if (camMode === 'tour') return TOUR[tour.leg] === 'sloop' ? boats[0] : TOUR[tour.leg] === 'ship' ? boats[1] : null;
    return null;
  }
  const boatsOut = () => S.life * (1 - smooth(15, 21, S.windSpeed)) > 0.2; // as boatAmt, for the chosen weather
  const wrapRad = a => Math.atan2(Math.sin(a), Math.cos(a));
  // turn the view smoothly toward a point
  function lookToward(x, y, z, k, pitchBias = 0) {
    const dx = x - pos.x, dy = y - pos.y, dz = z - pos.z;
    tYaw += wrapRad(Math.atan2(dx, dz) - tYaw) * k;
    const p = Math.max(-1.2, Math.min(0.5, Math.atan2(dy, Math.hypot(dx, dz)) + pitchBias));
    tPitch += (p - tPitch) * k;
  }
  function followStep(dt, minY) {
    const c = CAMS[camMode], b = boats[c.boat];
    const hx = Math.cos(b.hd), hz = Math.sin(b.hd);
    const ca = Math.cos(follow.orbit), sa = Math.sin(follow.orbit);
    const bx = -hx * ca + hz * sa, bz = -hz * ca - hx * sa; // "behind", swung round by dragging
    const back = c.back * (1 - follow.tilt * 0.3);
    const gx = b.x + bx * back, gz = b.z + bz * back;
    const gy = Math.max(minY + 1, c.up + follow.tilt * c.back * 0.8);
    // trail the boat closely; from far away, swoop in at a capped speed
    const e = 1 - Math.exp(-dt * 1.5);
    let mx = (gx - pos.x) * e, my = (gy - pos.y) * e, mz = (gz - pos.z) * e;
    const len = Math.hypot(mx, my, mz), cap = 260 * dt;
    if (len > cap) { mx *= cap / len; my *= cap / len; mz *= cap / len; }
    pos.x += mx; pos.y += my; pos.z += mz;
    vel.x = mx / dt; vel.y = my / dt; vel.z = mz / dt;
    lookToward(b.x + hx * c.ahead, c.up * 0.15, b.z + hz * c.ahead, 1 - Math.exp(-dt * 3));
  }

  // the tour: a loop of legs, each flying to a sight and lingering there for a while
  const TOUR = ['sea', 'sloop', 'island', 'lighthouse', 'ship'];
  const LIGHT = { x: -418, z: 1253 };
  const tour = { leg: -1, t: 0, total: 0, arrived: false, a: 0, side: 1, dir: 0, x: 0, z: 0 };
  function nextLeg() {
    for (let i = 0; i < TOUR.length; i++) {
      tour.leg = (tour.leg + 1) % TOUR.length;
      const kind = TOUR[tour.leg];
      if (!((kind === 'sloop' || kind === 'ship') && !boatsOut())) break; // no boats out in this weather
    }
    tour.t = 0; tour.total = 0; tour.arrived = false;
    tour.side = Math.random() < 0.5 ? -1 : 1;
    tour.dir = yaw; tour.x = pos.x; tour.z = pos.z;
    tour.a = Math.atan2(pos.z - ISLE.z, pos.x - ISLE.x);
  }
  function tourStep(dt, minY) {
    const kind = TOUR[tour.leg], t = tour.t;
    let gx, gy, gz, lx, ly, lz, dwell;
    if (kind === 'sea') {
      // drift low over open water, rising and dipping with a lazy turn
      dwell = 26;
      tour.dir += dt * 0.025 * tour.side;
      tour.x += Math.sin(tour.dir) * 8 * dt; tour.z += Math.cos(tour.dir) * 8 * dt;
      gx = tour.x; gz = tour.z; gy = 3 + 2.5 * (1 - Math.cos(t * 0.3));
      lx = gx + Math.sin(tour.dir) * 120; lz = gz + Math.cos(tour.dir) * 120; ly = gy * 0.5;
      tour.arrived = true;
    } else if (kind === 'sloop' || kind === 'ship') {
      // slide past the boat, from astern to ahead of her, at a respectful distance
      const ship = kind === 'ship', b = boats[ship ? 1 : 0];
      dwell = ship ? 40 : 32;
      const hx = Math.cos(b.hd), hz = Math.sin(b.hd);
      const off = ship ? 230 : 45, span = ship ? 320 : 110;
      const along = -span + 2 * span * Math.min(1, t / dwell);
      gx = b.x - hz * off * tour.side + hx * along;
      gz = b.z + hx * off * tour.side + hz * along;
      gy = ship ? 24 + 8 * Math.sin(t * 0.15) : 5 + 2 * Math.sin(t * 0.25);
      lx = b.x; lz = b.z; ly = ship ? 12 : 4;
    } else if (kind === 'island') {
      // a wide, slow circle round the island, climbing and sinking
      dwell = 55;
      if (tour.arrived) tour.a += dt * 0.035 * tour.side;
      gx = ISLE.x + Math.cos(tour.a) * 720; gz = ISLE.z + Math.sin(tour.a) * 720;
      gy = 55 + 25 * Math.sin(t * 0.11);
      lx = ISLE.x; lz = ISLE.z; ly = 30;
    } else {
      // swing round the seaward side of the lighthouse
      dwell = 30;
      const base = Math.max(isleHeightJS(LIGHT.x, LIGHT.z), 4);
      const sea = Math.atan2(LIGHT.z - ISLE.z, LIGHT.x - ISLE.x);
      const a = sea + tour.side * (-0.7 + 1.4 * Math.min(1, t / dwell));
      gx = LIGHT.x + Math.cos(a) * 420; gz = LIGHT.z + Math.sin(a) * 420; // off the shore
      gy = base + 12 + 6 * Math.sin(t * 0.3);
      lx = LIGHT.x; lz = LIGHT.z; ly = base + 18;
    }
    // stay well clear of the land on the way, looking a few seconds ahead
    const ahead = Math.max(isleHeightJS(pos.x, pos.z), isleHeightJS(pos.x + vel.x * 3, pos.z + vel.z * 3),
                           isleHeightJS(pos.x + vel.x * 6, pos.z + vel.z * 6));
    gy = Math.max(gy, minY + 1, ahead > -1 ? ahead + 22 : 0);
    // ease the velocity (not the position) toward the goal, for unhurried, curving moves
    const dx = gx - pos.x, dy = gy - pos.y, dz = gz - pos.z, dist = Math.hypot(dx, dz);
    let wx = dx * 0.4, wy = dy * 0.6, wz = dz * 0.4;
    const sp = Math.hypot(wx, wz), cap = 45 + 75 * smooth(1500, 4000, dist); // hurry over long empty stretches
    if (sp > cap) { wx *= cap / sp; wz *= cap / sp; }
    wy = Math.max(-8, Math.min(12, wy));
    const e = 1 - Math.exp(-dt * 0.7);
    vel.x += (wx - vel.x) * e; vel.y += (wy - vel.y) * e; vel.z += (wz - vel.z) * e;
    pos.x += vel.x * dt; pos.y += vel.y * dt; pos.z += vel.z * dt;
    // look at the sight once near it; on the way, mostly where we're heading
    const w = smooth(250, 700, dist), vs = Math.hypot(vel.x, vel.z);
    if (w > 0 && vs > 1) {
      const tx = pos.x + vel.x / vs * 200, tz = pos.z + vel.z / vs * 200;
      lx += (tx - lx) * w; lz += (tz - lz) * w; ly += (pos.y - 25 - ly) * w;
    }
    lookToward(lx, ly, lz, 1 - Math.exp(-dt * 1.2));
    if (!tour.arrived && dist < (kind === 'ship' ? 150 : 90)) tour.arrived = true;
    if (tour.arrived) tour.t += dt;
    tour.total += dt;
    if ((tour.arrived && tour.t > dwell) || tour.total > 150) nextLeg();
  }

  const pos = { x: 0, y: 2.3, z: 0 };
  let underwater = false;
  // the shader's seabed height, mirrored in 32-bit maths so the diver stops right above the sand
  const f32 = Math.fround, fr = x => x - Math.floor(x);
  function hashJS(x, y) {
    let px = fr(f32(x * 123.34)), py = fr(f32(y * 456.21));
    const d = f32(f32(px * f32(px + 45.32)) + f32(py * f32(py + 45.32)));
    px = f32(px + d); py = f32(py + d);
    return fr(f32(px * py));
  }
  function noiseJS(x, y) {
    const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy;
    const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
    const a = hashJS(ix, iy), b = hashJS(ix + 1, iy), c = hashJS(ix, iy + 1), d = hashJS(ix + 1, iy + 1);
    return (a + (b - a) * ux) * (1 - uy) + (c + (d - c) * ux) * uy;
  }
  function fbmJS(x, y) {
    let v = 0, a = 0.5;
    for (let i = 0; i < 5; i++) { v += a * noiseJS(x, y); [x, y] = [1.6 * x - 1.2 * y, 1.2 * x + 1.6 * y]; a *= 0.5; }
    return v;
  }
  // the island's height, mirrored from the shader so you fly over it rather than through it
  const ISLE = { x: -500, z: 1500, r: 420, h: 95 };
  const BEACH = { x: 0.906, z: -0.423 };
  const JETTY = { x: -192, z: 1356, deck: 1.9, len: 72 };
  function isleHeightJS(x, z) {
    const n = noiseJS(x * 0.004 + 3, z * 0.004 + 3) * 0.65 + noiseJS(x * 0.011 + 7, z * 0.011 + 7) * 0.35;
    const dx = x - ISLE.x, dz = z - ISLE.z, dl = Math.hypot(dx, dz);
    const r = dl / ISLE.r + (n - 0.5) * 0.5;
    const s = (1 - r) * ISLE.r, cove = smooth(0.80, 0.95, (dx * BEACH.x + dz * BEACH.z) / Math.max(dl, 1));
    const m = noiseJS(x * 0.007 + 13, z * 0.007 + 13);
    const k = Math.max(1 - r, 0);
    let h = ISLE.h * Math.pow(k, 1.25) * (0.55 + 0.9 * m) + 14 * smooth(0, 0.08, k);
    const ridges = 1 - Math.abs(noiseJS(x * 0.022 + 5, z * 0.022 + 5) * 2 - 1);
    h += (ridges * 16 + noiseJS(x * 0.06 + 2, z * 0.06 + 2) * 5) * smooth(0.02, 0.25, k);
    h -= 4 + 10 * (1 - smooth(0, 0.02, k));
    const sand = Math.max(-6, Math.min(4, s * 0.045 - 0.8));
    const mix = (a, b, f) => a + (b - a) * f;
    return mix(h, mix(sand, h, smooth(70, 260, s)), cove);
  }
  // standing on the jetty's deck: its top, or -Infinity off it
  function jettyTopJS(x, z) {
    const dx = x - JETTY.x, dz = z - JETTY.z;
    const along = dx * BEACH.x + dz * BEACH.z, across = -dx * BEACH.z + dz * BEACH.x;
    return along > -0.5 && along < JETTY.len + 0.5 && Math.abs(across) < 1.6 ? JETTY.deck : -Infinity;
  }
  function floorDepthJS(x, z) {
    const n = fbmJS(x * 0.03 + 7, z * 0.03 + 7);
    let d = 1 + 8 * smooth(0.40, 0.66, n);
    d += (fbmJS(x * 0.45, z * 0.45) - 0.5) * 0.5;
    d += 0.04 * Math.sin(x * 2.6 + Math.sin(z * 1.1) * 2.5);
    return d;
  }
  const vel = { x: 0, y: 0, z: 0 };
  const MAX_Y = 80;

  const hint = document.getElementById('hint');
  let hintTimer = setTimeout(() => { hint.style.opacity = '0'; }, 6000);
  function flashHint(text) { // a short message in the hint bubble
    hint.textContent = text;
    hint.style.opacity = '1';
    clearTimeout(hintTimer);
    hintTimer = setTimeout(() => { hint.style.opacity = '0'; }, 3500);
  }

  const fpsEl = document.getElementById('fps');
  let fpsFrames = 0, fpsTime = 0;

  // ---------- lightning ----------
  // each strike is a few quick flickers; the bolt lands somewhere ahead of the viewer
  const PULSES = [[0, 1.0], [0.08, 0.45], [0.19, 0.85], [0.34, 0.3]];
  const bolt = { x: 0, z: 0, vis: 0, seed: 0, power: 1 };
  let strikeT = -1, nextStrike = 2 + Math.random() * 4;

  const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

  const spout = { x: 0, z: 0, placed: false, grow: 0 };
  const windOff = { x: 0, z: 0 };
  let wet = 0;

  let prevLook = [yaw, pitch], frameNo = 0;

  // ---------- photo mode ----------
  // hides the controls, renders one full-resolution frame and downloads it as a PNG
  let photoPending = false;
  const flashEl = document.getElementById('flash');
  function takePhoto() {
    if (photoPending) return;
    document.body.classList.add('shooting');
    photoPending = true;
  }
  function savePhoto() {
    const d = new Date(), p = n => String(n).padStart(2, '0');
    const name = `ocean-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.png`;
    canvas.toBlob(blob => {
      if (blob) {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = name;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 2000);
      }
      document.body.classList.remove('shooting');
      flashEl.style.transition = 'none';
      flashEl.style.opacity = '0.7';
      requestAnimationFrame(() => { flashEl.style.transition = ''; flashEl.style.opacity = '0'; });
    }, 'image/png');
  }
  document.getElementById('photo').addEventListener('click', e => { e.stopPropagation(); takePhoto(); });

  // ---------- boats and seagulls ----------
  // a sloop a kilometre or two out and a container ship further off, both cruising past;
  // when one wanders too far it is replaced by another somewhere ahead of you
  const boats = [
    { x: 0, z: 0, hd: 0, speed: 3.5, dist: 700 },
    { x: 0, z: 0, hd: 0, speed: 7, dist: 2600 },
  ];
  function placeBoat(b) {
    let a, d;
    for (let tries = 0; tries < 8; tries++) { // somewhere ahead, clear of the island
      a = yaw + (Math.random() - 0.5) * 1.3;
      d = b.dist * (0.8 + Math.random() * 0.5);
      b.x = pos.x + Math.sin(a) * d;
      b.z = pos.z + Math.cos(a) * d;
      if (Math.hypot(b.x - -500, b.z - 1500) > 750) break;
    }
    b.hd = a + Math.PI / 2 + (Math.random() - 0.5) * 1.2 + (Math.random() < 0.5 ? Math.PI : 0); // mostly crossing
  }
  boats.forEach(placeBoat);
  // a loose flock circling ahead, slowly following wherever you look
  const birds = Array.from({ length: 6 }, () => ({
    a: Math.random() * 6.28, r: 20 + Math.random() * 55, h: 14 + Math.random() * 28,
    w: (0.12 + Math.random() * 0.15) * (Math.random() < 0.5 ? -1 : 1), ph: Math.random() * 20,
  }));
  const birdBuf = new Float32Array(24);
  let flockX = 0, flockZ = 80, boatAmt = 0, birdAmt = 0;
  // icebergs in the polar sea: scattered all around at first, later turning up ahead
  const bergs = Array.from({ length: 4 }, () => ({ x: 0, z: 0, size: 0, seed: 0 }));
  const bergBuf = new Float32Array(16);
  function placeBerg(b, first) {
    for (let tries = 0; tries < 8; tries++) { // clear of the island
      const a = yaw + (Math.random() - 0.5) * (first ? 2.2 : 1.4);
      const d = first ? 250 + Math.random() * 1800 : 2400 + Math.random() * 1500;
      b.x = pos.x + Math.sin(a) * d;
      b.z = pos.z + Math.cos(a) * d;
      if (Math.hypot(b.x - -500, b.z - 1500) > 800) break;
    }
    b.size = 18 + Math.random() * 45;
    b.seed = Math.random() * 100;
  }

  // ---------- wildlife ----------
  // now and then a pod of dolphins leaps past, a whale breaches or blows further out, or a
  // shark's fin cuts by. Each turns up somewhere in front of you, more often with more life;
  // the shader plays out each event from its clock (t, -1 when nothing is happening).
  const DOLPHIN_DUR = 10, WHALE_DUR = 13, SHARK_DUR = 18;
  const pod = { x: 0, z: 0, hd: 0, t: -1, n: 3, next: 15 + Math.random() * 25 };
  const whale = { x: 0, z: 0, hd: 0, t: -1, kind: 0, next: 40 + Math.random() * 50 };
  const shark = { x: 0, z: 0, hd: 0, t: -1, up: 0, seed: 0, next: 30 + Math.random() * 40 };
  let faunaAmt = 0;
  // somewhere ahead within the view, clear of the island, heading across it
  function placeAhead(o, dMin, dMax, spread) {
    let a;
    for (let tries = 0; tries < 8; tries++) {
      a = yaw + (Math.random() - 0.5) * spread;
      const d = dMin + Math.random() * (dMax - dMin);
      o.x = pos.x + Math.sin(a) * d;
      o.z = pos.z + Math.cos(a) * d;
      if (Math.hypot(o.x - ISLE.x, o.z - ISLE.z) > ISLE.r + 250) break;
    }
    o.hd = -a + (Math.random() < 0.5 ? Math.PI : 0) + (Math.random() - 0.5) * 0.6;
  }

  // ---------- sound: all synthesized, no audio files ----------
  const soundBtn = document.getElementById('sound');
  const audio = { ctx: null };
  function startAudio() {
    if (S.muted) return;
    if (audio.ctx) { if (audio.ctx.state === 'suspended') audio.ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = new AC();
    const master = ctx.createGain();
    master.gain.value = 0;
    const muffle = ctx.createBiquadFilter(); // everything sounds dull and distant underwater
    muffle.type = 'lowpass';
    muffle.frequency.value = 20000;
    master.connect(muffle);
    muffle.connect(ctx.destination);
    audio.muffle = muffle;
    // four seconds of white noise: the raw material for surf, wind, rain and thunder
    const buf = ctx.createBuffer(1, ctx.sampleRate * 4, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    // sounds heard from inside the water (bubbles, hum, the splash) skip the muffle
    const dry = ctx.createGain();
    dry.gain.value = 0;
    dry.connect(ctx.destination);
    const layer = (rate, type, freq, q, out = master) => {
      const s = ctx.createBufferSource();
      s.buffer = buf; s.loop = true; s.playbackRate.value = rate;
      const f = ctx.createBiquadFilter();
      f.type = type; f.frequency.value = freq; f.Q.value = q;
      const g = ctx.createGain();
      g.gain.value = 0;
      s.connect(f); f.connect(g); g.connect(out);
      s.start();
      return { f, g };
    };
    const panner = out => {
      const p = ctx.createStereoPanner ? ctx.createStereoPanner() : ctx.createGain();
      p.connect(out);
      return p;
    };
    // a long, echoing tail for the foghorn: decaying stereo noise with a few cliff echoes
    const verb = ctx.createConvolver();
    const ir = ctx.createBuffer(2, ctx.sampleRate * 4, ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const d = ir.getChannelData(c);
      for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / d.length, 3.5) * 0.5;
      for (const [at, a] of [[0.31, 0.5], [0.72, 0.35], [1.25, 0.22]]) {
        const j = Math.floor((at + c * 0.023) * ctx.sampleRate);
        for (let i = 0; i < 2000; i++) d[j + i] += (Math.random() * 2 - 1) * a * (1 - i / 2000);
      }
    }
    verb.buffer = ir;
    verb.connect(master);
    // the shore: one noise voice whose envelope is re-shaped for each breaking swell
    const shorePan = panner(master);
    const shoreAir = ctx.createBiquadFilter(); // air soaks up the highs of a distant shore
    shoreAir.type = 'lowpass'; shoreAir.frequency.value = 1200;
    shoreAir.connect(shorePan);
    const shoreLvl = ctx.createGain();
    shoreLvl.gain.value = 0;
    shoreLvl.connect(shoreAir);
    const shore = layer(0.9, 'lowpass', 300, 0.6, shoreLvl); // g = swell envelope, f = brightness
    // the foghorn bus: distance level, then panned dry plus a send into the echo
    const hornPan = panner(master);
    const hornAir = ctx.createBiquadFilter();
    hornAir.type = 'lowpass'; hornAir.frequency.value = 900;
    hornAir.connect(hornPan);
    const hornSend = ctx.createGain();
    hornSend.gain.value = 0.7;
    hornAir.connect(hornSend); hornSend.connect(verb);
    // a diesel putter per boat: sawtooth + rumble noise, beaten by a firing-rate LFO
    const engine = (freq, fire) => {
      const pan = panner(master);
      const g = ctx.createGain();
      g.gain.value = 0;
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass'; lp.frequency.value = 240; lp.Q.value = 1.5;
      lp.connect(g); g.connect(pan);
      const am = ctx.createGain();
      am.gain.value = 0.55;
      am.connect(lp);
      const o = ctx.createOscillator();
      o.type = 'sawtooth'; o.frequency.value = freq;
      o.connect(am);
      const rumble = layer(0.5, 'lowpass', 110, 1, am);
      rumble.g.gain.value = 2.2;
      const lfo = ctx.createOscillator();
      lfo.frequency.value = fire;
      const depth = ctx.createGain();
      depth.gain.value = 0.45;
      lfo.connect(depth); depth.connect(am.gain);
      o.start(); lfo.start();
      return { g, pan, o, lfo, freq, fire };
    };
    // underwater: a low pressure hum from two detuned sines and a deep noise bed
    const hum = ctx.createGain();
    hum.gain.value = 0;
    hum.connect(dry);
    for (const f of [47, 71.5]) {
      const o = ctx.createOscillator();
      o.frequency.value = f;
      o.connect(hum); o.start();
    }
    const deep = layer(0.3, 'lowpass', 120, 0.8, dry);
    // the roar of a waterspout or hurricane
    const roarPan = panner(master);
    Object.assign(audio, {
      ctx, master, buf, dry, verb, panner,
      surf: layer(1, 'lowpass', 400, 0.7),      // deep roll of the swell
      hiss: layer(0.8, 'bandpass', 2500, 0.6),  // fizz of breaking crests
      wind: layer(1.3, 'bandpass', 500, 1.5),
      whistle: layer(1.1, 'bandpass', 1100, 22), // tonal howl through rigging and rocks
      whistle2: layer(0.9, 'bandpass', 1700, 30),
      rain: layer(1, 'highpass', 2200, 0.5),
      shore, shoreLvl, shoreAir, shorePan,
      hornAir, hornPan,
      engines: [engine(41, 5.2), engine(28, 3.1)], // sloop's auxiliary, the ship's big slow diesel
      hum, deep,
      roar: layer(0.35, 'lowpass', 150, 1.1, roarPan),
      roarHi: layer(0.6, 'bandpass', 380, 0.9, roarPan),
      roarPan,
    });
  }
  // stereo position of a world point: -1 hard left, 1 hard right, from the way you face
  function panTo(x, z) {
    const dx = x - pos.x, dz = z - pos.z, d = Math.hypot(dx, dz) || 1;
    return Math.max(-1, Math.min(1, (dx * Math.cos(yaw) - dz * Math.sin(yaw)) / d));
  }
  function setPan(node, v, now) { if (node.pan) node.pan.setTargetAtTime(v, now, 0.1); }
  const snd = {
    shoreT: 2, hornT: 8, creakT: 6, bubbleT: 1, bubbles: 0, creaking: false,
    gust: 0.5, gustTo: 0.5, gustT: 0, wasUnder: false, mutedFor: 0,
  };
  function updateAudio(t, dt) {
    if (!audio.ctx) return;
    const ctx = audio.ctx, now = ctx.currentTime, k = 0.3;
    audio.master.gain.setTargetAtTime(S.muted ? 0 : C.volume, now, 0.4);
    audio.dry.gain.setTargetAtTime(S.muted ? 0 : C.volume, now, 0.4);
    // once muted and faded out, stop the whole graph; unmuting resumes it
    if (S.muted) {
      if ((snd.mutedFor += dt) > 2 && ctx.state === 'running') ctx.suspend();
      return;
    }
    snd.mutedFor = 0;
    audio.muffle.frequency.setTargetAtTime(underwater ? 380 : 20000, now, 0.15);
    const near = Math.max(0.15, 1 - (pos.y - 2) / 60);            // the sea fades as you climb
    const sea = 0.3 + 0.7 * smooth(3, 22, C.windSpeed);
    const swell = 0.55 + 0.45 * Math.sin(t * 0.7) * Math.sin(t * 0.23 + 1.3);
    audio.surf.g.gain.setTargetAtTime(0.55 * sea * swell * near, now, k);
    audio.surf.f.frequency.setTargetAtTime(220 + 380 * swell * sea, now, k);
    audio.hiss.g.gain.setTargetAtTime(0.05 * sea * Math.max(0, swell - 0.35) * near * (0.4 + C.foam * 0.5), now, k);
    const w = smooth(4, 24, C.windSpeed);
    // gusts: a new target every few seconds; they swell in quicker than they die away
    if ((snd.gustT -= dt) <= 0) {
      snd.gustT = 1.5 + Math.random() * 4.5 * (1.2 - w);
      snd.gustTo = Math.random() < 0.35 ? 0.15 + Math.random() * 0.3 : 0.55 + Math.random() * (0.45 + 0.4 * w);
    }
    snd.gust += (snd.gustTo - snd.gust) * (1 - Math.exp(-dt * (snd.gustTo > snd.gust ? 1.1 : 0.45)));
    const gust = (0.45 + 0.6 * snd.gust) * (0.92 + 0.08 * Math.sin(t * 1.3));
    audio.wind.g.gain.setTargetAtTime(0.4 * w * w * gust, now, k);
    audio.wind.f.frequency.setTargetAtTime(280 + 750 * w * gust, now, k);
    // the whistle only comes in with strong wind, its pitch riding the gusts
    const howl = smooth(12, 24, C.windSpeed) * smooth(0.3, 0.9, snd.gust);
    audio.whistle.g.gain.setTargetAtTime(1.1 * howl, now, 0.5);
    audio.whistle.f.frequency.setTargetAtTime(700 + 650 * snd.gust + 120 * Math.sin(t * 0.53), now, 0.4);
    audio.whistle2.g.gain.setTargetAtTime(0.7 * howl * (0.5 + 0.5 * Math.sin(t * 0.31 + 1)), now, 0.6);
    audio.whistle2.f.frequency.setTargetAtTime(1300 + 900 * snd.gust + 200 * Math.sin(t * 0.77 + 2), now, 0.4);
    audio.rain.g.gain.setTargetAtTime(0.22 * Math.min(1, C.rain + C.hail * 1.3 + C.snow * 0.08), now, k);

    // shore surf: louder as you near the coast, coming from the island's direction
    const toShore = Math.max(0, Math.hypot(pos.x - ISLE.x, pos.z - ISLE.z) - ISLE.r * 0.95);
    const shoreNear = 1 / (1 + Math.pow(toShore / 220, 1.4));
    audio.shoreLvl.gain.setTargetAtTime(0.9 * shoreNear * (0.45 + 0.55 * sea), now, k);
    audio.shoreAir.frequency.setTargetAtTime(500 + 4500 * shoreNear, now, k);
    setPan(audio.shorePan, panTo(ISLE.x, ISLE.z) * smooth(0, 250, toShore), now);
    if ((snd.shoreT -= dt) <= 0) {
      snd.shoreT = 6 + Math.random() * 6;
      const peak = (0.55 + 0.45 * Math.random()) * (0.6 + 0.4 * sea);
      const g = audio.shore.g.gain, f = audio.shore.f.frequency;
      g.cancelScheduledValues(now); f.cancelScheduledValues(now);
      g.setTargetAtTime(peak, now, 0.7);            // the swell builds and breaks...
      g.setTargetAtTime(0.06, now + 1.8, 1.9);      // ...then washes back over the rocks
      f.setTargetAtTime(1600 + 1200 * Math.random(), now, 0.6);
      f.setTargetAtTime(280, now + 1.6, 1.4);
    }

    // the lighthouse foghorn sounds in fog and at night
    const hornOn = C.fog > 0.3 || C.sunElev < -6;
    if (hornOn && (snd.hornT -= dt) <= 0) {
      snd.hornT = 30 + Math.random() * 30;
      foghorn(Math.hypot(pos.x - LIGHT.x, pos.z - LIGHT.z));
    }
    if (!hornOn) snd.hornT = Math.min(snd.hornT, 4 + Math.random() * 4);
    setPan(audio.hornPan, panTo(LIGHT.x, LIGHT.z) * 0.8, now);

    // boats: engines throbbing faintly across the water, creaks when one is close
    let creakLvl = 0, creakPan = 0;
    boats.forEach((b, i) => {
      const e = audio.engines[i], d = Math.hypot(b.x - pos.x, b.z - pos.z);
      const v = boatAmt * Math.pow(Math.min(1, (i ? 500 : 260) / d), 1.3) * (i ? 0.3 : 0.2);
      e.g.gain.setTargetAtTime(v, now, k);
      e.o.frequency.setTargetAtTime(e.freq * (1 + 0.025 * Math.sin(t * 0.21 + i * 3)), now, k);
      e.lfo.frequency.setTargetAtTime(e.fire * (1 + 0.025 * Math.sin(t * 0.21 + i * 3)), now, k);
      setPan(e.pan, panTo(b.x, b.z), now);
      const c = boatAmt * Math.min(1, 300 / d) * (i ? 0.6 : 1);
      if (c > creakLvl) { creakLvl = c; creakPan = panTo(b.x, b.z); }
    });
    if (creakLvl > 0.3 && !snd.creaking && (snd.creakT -= dt) <= 0) {
      snd.creakT = 4 + Math.random() * 9;
      creak(creakLvl, creakPan, sea);
    }

    // underwater: a pressure hum, deeper as you dive, and bubbles drifting past
    const depth = Math.max(0, -pos.y);
    audio.hum.gain.setTargetAtTime(underwater ? 0.05 + 0.1 * smooth(0, 8, depth) : 0, now, 0.25);
    audio.deep.g.gain.setTargetAtTime(underwater ? 0.6 + 0.6 * smooth(0, 8, depth) : 0, now, 0.25);
    if (underwater && (snd.bubbleT -= dt) <= 0) {
      snd.bubbleT = Math.random() < 0.3 ? 0.05 + Math.random() * 0.12 : 0.3 + Math.random() * 1.4;
      bubble();
    }
    if (underwater !== snd.wasUnder) splash(underwater);
    snd.wasUnder = underwater;

    // a deep roar from a waterspout or a hurricane
    const sd = Math.hypot(spout.x - pos.x, spout.z - pos.z);
    const sp = spout.placed ? spout.grow * Math.min(1, 1800 / sd) : 0;
    const hur = smooth(19, 25, C.windSpeed);
    const roar = Math.min(1, sp + hur) * (0.8 + 0.2 * snd.gust);
    audio.roar.g.gain.setTargetAtTime(1.3 * roar, now, 0.5);
    audio.roarHi.g.gain.setTargetAtTime(0.35 * roar, now, 0.5);
    audio.roarHi.f.frequency.setTargetAtTime(260 + 220 * snd.gust + 60 * Math.sin(t * 0.4), now, 0.5);
    setPan(audio.roarPan, sp > 0 ? panTo(spout.x, spout.z) * sp / (sp + hur + 1e-3) : 0, now);

    // gulls call now and then while they are around
    if (birdAmt > 0.3 && (gullTimer -= dt) <= 0) {
      gullTimer = 5 + Math.random() * 14;
      gullCall(birdAmt);
    }
  }
  // the foghorn: a diaphone's high "bee" dropping to a low grunting "oh", heard late from afar
  function foghorn(dist) {
    const ctx = audio.ctx;
    const t0 = ctx.currentTime + Math.min(dist / 343, 6);
    const v = 0.35 / (1 + dist / 1200);
    audio.hornAir.frequency.setTargetAtTime(500 + 1400 / (1 + dist / 1500), ctx.currentTime, 0.2);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(v, t0 + 0.25);
    g.gain.setValueAtTime(v, t0 + 2.6);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + 3.4);
    g.connect(audio.hornAir);
    for (const det of [0, 4]) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.detune.value = det;
      o.frequency.setValueAtTime(150, t0);
      o.frequency.linearRampToValueAtTime(178, t0 + 0.2);   // the tearing start
      o.frequency.setValueAtTime(178, t0 + 1.35);
      o.frequency.linearRampToValueAtTime(132, t0 + 1.5);   // down to the grunt
      o.frequency.linearRampToValueAtTime(118, t0 + 3.4);
      o.connect(g);
      o.start(t0); o.stop(t0 + 3.5);
    }
  }
  // wooden creaks and rope groans: a slow stick-slip buzz through a resonant body
  function creak(level, pan, sea) {
    const ctx = audio.ctx;
    snd.creaking = true;
    const t0 = ctx.currentTime, rope = Math.random() < 0.4;
    const dur = 0.5 + Math.random() * (rope ? 1.2 : 0.7);
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    const f0 = rope ? 70 + Math.random() * 40 : 18 + Math.random() * 22;
    o.frequency.setValueAtTime(f0, t0);
    o.frequency.linearRampToValueAtTime(f0 * (0.6 + Math.random() * 0.9), t0 + dur);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = rope ? 260 + Math.random() * 120 : 700 + Math.random() * 600;
    bp.Q.value = rope ? 5 : 8;
    const g = ctx.createGain();
    const v = 0.12 * level * (0.6 + 0.4 * sea);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(v, t0 + dur * 0.3);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    const p = audio.panner(audio.master);
    if (p.pan) p.pan.value = pan;
    o.connect(bp); bp.connect(g); g.connect(p);
    o.start(t0); o.stop(t0 + dur + 0.05);
    o.onended = () => { snd.creaking = false; p.disconnect(); };
  }
  // a bubble: a short rising sine chirp
  function bubble() {
    if (snd.bubbles >= 6) return;
    const ctx = audio.ctx;
    snd.bubbles++;
    const t0 = ctx.currentTime, dur = 0.03 + Math.random() * 0.08;
    const f0 = 350 + Math.random() * 900;
    const o = ctx.createOscillator();
    o.frequency.setValueAtTime(f0, t0);
    o.frequency.exponentialRampToValueAtTime(f0 * (1.5 + Math.random()), t0 + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(0.03 + Math.random() * 0.05, t0 + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    const p = audio.panner(audio.dry);
    if (p.pan) p.pan.value = Math.random() * 1.4 - 0.7;
    o.connect(g); g.connect(p);
    o.start(t0); o.stop(t0 + dur + 0.02);
    o.onended = () => { snd.bubbles--; p.disconnect(); };
  }
  // crossing the surface: a plunge with a deep thump going in, a sloshing wash coming out
  function splash(into) {
    const ctx = audio.ctx, t0 = ctx.currentTime;
    const s = ctx.createBufferSource();
    s.buffer = audio.buf; s.playbackRate.value = into ? 0.8 : 1.1;
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass'; f.Q.value = 0.8;
    f.frequency.setValueAtTime(into ? 2600 : 1800, t0);
    f.frequency.exponentialRampToValueAtTime(into ? 300 : 700, t0 + (into ? 0.6 : 0.9));
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(into ? 0.7 : 0.45, t0 + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + (into ? 0.8 : 1.1));
    s.connect(f); f.connect(g); g.connect(audio.dry);
    s.start(t0, Math.random() * 2.5); s.stop(t0 + 1.2);
    if (into) {
      const o = ctx.createOscillator();
      o.frequency.setValueAtTime(160, t0);
      o.frequency.exponentialRampToValueAtTime(45, t0 + 0.35);
      const og = ctx.createGain();
      og.gain.setValueAtTime(0.0001, t0);
      og.gain.exponentialRampToValueAtTime(0.4, t0 + 0.015);
      og.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.4);
      o.connect(og); og.connect(audio.dry);
      o.start(t0); o.stop(t0 + 0.45);
      for (let i = 0; i < 4; i++) setTimeout(() => audio.ctx && bubble(), 80 + i * (60 + Math.random() * 90));
    }
  }
  let gullTimer = 3;
  function gullCall(level) {
    const ctx = audio.ctx;
    let t0 = ctx.currentTime;
    const out = ctx.createGain();
    out.gain.value = 0.05 * level;
    const pan = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
    if (pan) { pan.pan.value = Math.random() * 1.6 - 0.8; out.connect(pan); pan.connect(audio.master); }
    else out.connect(audio.master);
    const n = 2 + Math.floor(Math.random() * 4);
    const f0 = 1150 + Math.random() * 400;
    for (let i = 0; i < n; i++) {
      // "kyow": a quick rise then a falling, nasal glide
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.setValueAtTime(f0 * 0.7, t0);
      o.frequency.linearRampToValueAtTime(f0, t0 + 0.05);
      o.frequency.exponentialRampToValueAtTime(f0 * 0.55, t0 + 0.3);
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass'; bp.frequency.value = 1900; bp.Q.value = 2.2;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(1, t0 + 0.03);
      g.gain.exponentialRampToValueAtTime(0.001, t0 + 0.32);
      o.connect(bp); bp.connect(g); g.connect(out);
      o.start(t0); o.stop(t0 + 0.35);
      t0 += 0.2 + Math.random() * 0.18;
    }
  }
  // thunder rolls in after the flash: a sharp crack for close strikes, then a long rumble
  function thunder(dist, power) {
    if (!audio.ctx) return;
    const ctx = audio.ctx;
    const t0 = ctx.currentTime + dist / 900;
    const s = ctx.createBufferSource();
    s.buffer = audio.buf; s.loop = true; s.playbackRate.value = 0.45;
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.setValueAtTime(dist < 4000 ? 1400 : 500, t0);
    f.frequency.exponentialRampToValueAtTime(110, t0 + 1.8);
    const g = ctx.createGain();
    const v = Math.min(1.2, power * 3500 / dist);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(v, t0 + 0.06);
    g.gain.setTargetAtTime(v * 0.45, t0 + 0.15, 0.4);
    g.gain.setTargetAtTime(0.0001, t0 + 1.4, 1.3);
    s.connect(f); f.connect(g); g.connect(audio.master);
    s.start(t0); s.stop(t0 + 8);
  }
  // a whale crashing back down, or its blow, heard across the water a moment later
  function whaleSound(dist, crash) {
    if (!audio.ctx) return;
    const ctx = audio.ctx;
    const t0 = ctx.currentTime + dist / 340;
    const s = ctx.createBufferSource();
    s.buffer = audio.buf; s.loop = true; s.playbackRate.value = crash ? 0.5 : 0.9;
    const f = ctx.createBiquadFilter();
    f.type = crash ? 'lowpass' : 'bandpass';
    f.frequency.setValueAtTime(crash ? 900 : 700, t0);
    f.frequency.exponentialRampToValueAtTime(crash ? 150 : 400, t0 + (crash ? 2 : 1.2));
    const g = ctx.createGain();
    const v = Math.min(0.8, (crash ? 60 : 18) / dist);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(v, t0 + (crash ? 0.05 : 0.15));
    g.gain.setTargetAtTime(0.0001, t0 + (crash ? 0.3 : 0.5), crash ? 0.7 : 0.35);
    s.connect(f); f.connect(g); g.connect(audio.master);
    s.start(t0); s.stop(t0 + 4);
  }
  function markSound() { soundBtn.textContent = S.muted ? '🔇' : '🔊'; }
  function toggleSound() {
    S.muted = !S.muted;
    save();
    markSound();
    if (!S.muted) startAudio();
  }
  markSound();
  soundBtn.addEventListener('click', e => { e.stopPropagation(); toggleSound(); });
  // browsers only allow sound after you interact with the page
  for (const ev of ['pointerdown', 'keydown']) window.addEventListener(ev, startAudio, { passive: true });

  const start = performance.now();
  let last = start;
  let cloudT = 0;
  function frame(now) {
    const rawDt = (now - last) / 1000;
    const dt = Math.min(rawDt, 0.1);
    last = now;
    if (rawDt < 1) adaptResolution(rawDt); // ignore pauses (hidden tab)
    yaw += (tYaw - yaw) * 0.08;
    pitch += (tPitch - pitch) * 0.08;

    // ease the scene toward the chosen settings
    for (const k in DEFAULTS) {
      if (k === 'windDir') { C[k] = S[k]; continue; }
      let diff = S[k] - C[k];
      if (k === 'sunAzim') diff = ((diff % 360) + 540) % 360 - 180; // shortest way round
      C[k] += diff * (1 - Math.exp(-dt * rate[k]));
    }
    const goal = CLIMATES[S.climate], ce = 1 - Math.exp(-dt * 0.8);
    for (const k of ['tropic', 'polar', 'lat']) clim[k] += (goal[k] - clim[k]) * ce;
    if (C.lines > 0.01 && !figuresTex) drawFigures();

    // waves: stronger wind -> more energy in longer, taller waves
    const amp = 0.1 * Math.pow(C.windSpeed / 5, 2);
    const kPeak = 9.5 / (C.windSpeed * C.windSpeed);
    const minY = 0.6 + amp * 2.2;

    const clamp1 = v => Math.max(-1, Math.min(1, v));
    const fwd = clamp1((keys.has('KeyW') || keys.has('ArrowUp') ? 1 : 0) - (keys.has('KeyS') || keys.has('ArrowDown') ? 1 : 0) + joy.y);
    const side = clamp1((keys.has('KeyD') || keys.has('ArrowRight') ? 1 : 0) - (keys.has('KeyA') || keys.has('ArrowLeft') ? 1 : 0) + joy.x);
    const up = (keys.has('KeyE') || keys.has('Space') ? 1 : 0) - (keys.has('KeyQ') ? 1 : 0);
    const speed = (keys.has('ShiftLeft') || keys.has('ShiftRight') || fastLock) ? 18 : 5;
    const fx = Math.sin(yaw), fz = Math.cos(yaw);   // horizontal forward
    const rx = Math.cos(yaw), rz = -Math.sin(yaw);  // horizontal right
    const ease = 1 - Math.exp(-dt * 4);
    if (camMode === 'free') {
      vel.x += ((fx * fwd + rx * side) * speed - vel.x) * ease;
      vel.z += ((fz * fwd + rz * side) * speed - vel.z) * ease;
      vel.y += (up * speed * 0.6 - vel.y) * ease;
      pos.x += vel.x * dt;
      pos.z += vel.z * dt;
      pos.y += vel.y * dt + wheelLift * ease;
    } else if (camMode === 'tour') tourStep(dt, minY);
    else followStep(dt, minY);
    wheelLift -= wheelLift * ease;
    // the surface is a one-way door: pass straight through the wave band, stop above the sand
    const below = 0.5 + amp * 1.6;
    if (pos.y < minY && pos.y > -below) pos.y = vel.y < 0 ? -below : minY;
    // dive no deeper than the sand (the shader keeps the bottom at least 2.5 m below you)
    pos.y = Math.max(-Math.max(floorDepthJS(pos.x, pos.z) * C.depth - 0.6, below + 0.5), Math.min(MAX_Y, pos.y));
    // eye height over the sand and the jetty, a little more over the rocky ground
    const ground = isleHeightJS(pos.x, pos.z);
    if (ground > -1) pos.y = Math.max(pos.y, ground + 1.7 + 1.3 * smooth(2, 10, ground));
    const deck = jettyTopJS(pos.x, pos.z);
    if (pos.y > deck - 0.6) pos.y = Math.max(pos.y, deck + 1.7);
    underwater = pos.y < 0;

    // lightning strikes
    if (C.lightning > 0.02 && strikeT < 0) {
      nextStrike -= dt * C.lightning;
      if (nextStrike <= 0) {
        strikeT = 0;
        nextStrike = 3 + Math.random() * 9;
        const az = yaw + (Math.random() - 0.5) * 1.8;
        const d = 2500 + Math.random() * 5000;
        bolt.x = pos.x + Math.sin(az) * d;
        bolt.z = pos.z + Math.cos(az) * d;
        bolt.vis = Math.random() < 0.75 ? 1 : 0; // some strikes stay hidden in the clouds
        bolt.seed = Math.random() * 100;
        bolt.power = 0.6 + Math.random() * 0.6;
        thunder(d, bolt.power);
      }
    }
    let flash = 0;
    if (strikeT >= 0) {
      for (const [t0, a] of PULSES) if (strikeT >= t0) flash += a * Math.exp(-(strikeT - t0) * 18);
      flash *= bolt.power;
      strikeT += dt;
      if (strikeT > 1.2) strikeT = -1;
    }

    // weather: fog/rain haze/spray density and how much the clouds darken everything
    const fogRho = C.fog * C.fog * 0.03 + C.rain * 0.004 + smooth(10, 20, C.windSpeed) * 0.0015
                 + smooth(18, 25, C.windSpeed) * 0.004 + C.snow * 0.007 + C.hail * 0.003 + C.dust * C.dust * 0.028;
    const gloom = Math.min(0.92, smooth(0.55, 1, C.clouds) * 0.5 + C.rain * 0.3 + C.lightning * 0.15 + C.fog * 0.15
                 + C.snow * 0.2 + C.hail * 0.25 + C.dust * 0.35);
    // blowing dust, spindrift in a blizzard, spume in a hurricane, wisps of fog
    const veil = Math.min(1, C.dust * 0.75 + C.snow * smooth(8, 16, C.windSpeed) * 0.6
                 + smooth(17, 25, C.windSpeed) * 0.45 + C.fog * 0.2);
    const wr = C.windDir * Math.PI / 180;
    windOff.x = (windOff.x + Math.cos(wr) * C.windSpeed * dt) % 20000;
    windOff.z = (windOff.z + Math.sin(wr) * C.windSpeed * dt) % 20000;

    // a rainbow shows up while the air is still wet and the sun comes out
    wet = Math.max(C.rain + C.hail * 0.5, wet * Math.exp(-dt / 45));
    const bow = smooth(0.03, 0.2, wet) * (1 - smooth(0.4, 0.9, C.rain)) * (1 - smooth(0.25, 0.7, gloom))
              * (1 - C.snow) * (1 - C.dust) * smooth(0, 4, C.sunElev);

    // the waterspout forms ahead of you, lowers slowly from the cloud, then drifts downwind
    if (C.spout > 0.01) {
      if (!spout.placed) {
        spout.placed = true;
        spout.x = pos.x + Math.sin(yaw + 0.2) * 3200;
        spout.z = pos.z + Math.cos(yaw + 0.2) * 3200;
      }
      spout.x += Math.cos(wr) * 3 * dt;
      spout.z += Math.sin(wr) * 3 * dt;
    } else spout.placed = false;
    spout.grow += Math.max(-0.2 * dt, Math.min(0.07 * dt, C.spout - spout.grow));

    if (S.auto && (autoTimer -= dt) <= 0) { autoTimer = AUTO_EVERY; autoStep(); }
    if (real.on && (real.timer -= dt) <= 0) { real.timer = 20; updateRealSky(); }

    // boats stay in port in a gale; gulls only fly in daylight and decent weather
    boatAmt = C.life * (1 - smooth(15, 21, C.windSpeed));
    birdAmt = C.life * smooth(0, 8, C.sunElev) * (1 - smooth(0.25, 0.6, C.rain + C.snow + C.hail + C.dust))
            * (1 - smooth(13, 19, C.windSpeed)) * (1 - C.fog * 0.7);
    const held = heldBoat();
    for (const b of boats) {
      b.x += Math.cos(b.hd) * b.speed * dt;
      b.z += Math.sin(b.hd) * b.speed * dt;
      const d = Math.hypot(b.x - pos.x, b.z - pos.z);
      if (b === held) {
        // the camera's boat is never swapped out: she bears away from the island instead
        b.near = true;
        const ix = b.x - ISLE.x, iz = b.z - ISLE.z, di = Math.hypot(ix, iz);
        if (di < 1300 && Math.cos(b.hd) * ix + Math.sin(b.hd) * iz < 0.5 * di) {
          b.hd += wrapRad(Math.atan2(iz, ix) - b.hd) * Math.min(1, dt * 0.15);
        }
        continue;
      }
      if (b.near && d > 260) b.near = false; // just let go by the camera: no popping out of sight
      if (d > b.dist * 2.5 || (d < 200 && !b.near) || Math.hypot(b.x + 500, b.z - 1500) < 650) placeBoat(b);
    }
    // icebergs drift slowly downwind; one that falls far behind is replaced somewhere ahead
    if (clim.polar > 0.01) {
      bergs.forEach((b, i) => {
        if (!b.size) placeBerg(b, true);
        b.x += Math.cos(wr) * 0.4 * dt;
        b.z += Math.sin(wr) * 0.4 * dt;
        if (Math.hypot(b.x - pos.x, b.z - pos.z) > 4200) placeBerg(b, false);
        bergBuf.set([b.x, b.z, b.size, b.seed], i * 4);
      });
    } else bergs.forEach(b => { b.size = 0; });
    const fe = 1 - Math.exp(-dt * 0.15);
    flockX += (pos.x + Math.sin(yaw) * 90 - flockX) * fe;
    flockZ += (pos.z + Math.cos(yaw) * 90 - flockZ) * fe;
    birds.forEach((b, i) => {
      b.a += b.w * dt;
      b.ph += dt;
      // bursts of flapping between long glides
      const flap = (b.ph * 0.22) % 1 < 0.35 ? Math.sin(b.ph * 9) * 0.8 + 0.2 : 0.28 + 0.05 * Math.sin(b.ph * 2);
      birdBuf.set([flockX + Math.cos(b.a) * b.r, b.h + Math.sin(b.ph * 0.4) * 4, flockZ + Math.sin(b.a) * b.r, flap], i * 4);
    });

    // wildlife stays away in a gale, and only turns up while you are at the surface to see it
    faunaAmt = C.life * (1 - smooth(13, 19, C.windSpeed));
    const spawn = underwater ? 0 : faunaAmt;
    if (pod.t >= 0) { pod.t += dt; if (pod.t > DOLPHIN_DUR) pod.t = -1; }
    else if ((pod.next -= dt * spawn) <= 0) {
      pod.next = 25 + Math.random() * 45;
      placeAhead(pod, 35, 75, 0.7);
      pod.n = 2 + Math.floor(Math.random() * 3);
      pod.t = 0;
    }
    if (whale.t >= 0) {
      const t0 = whale.t, d = Math.hypot(whale.x - pos.x, whale.z - pos.z);
      whale.t += dt;
      const at = x => t0 < x && whale.t >= x;
      if (whale.kind === 0 ? at(3.6) : at(3.0) || at(5.5)) whaleSound(d, whale.kind === 0);
      if (whale.t > WHALE_DUR) whale.t = -1;
    } else if ((whale.next -= dt * spawn) <= 0) {
      whale.next = 50 + Math.random() * 70;
      placeAhead(whale, 140, 260, 0.8);
      whale.kind = Math.random() < 0.5 ? 0 : 1;
      whale.t = 0;
    }
    if (shark.t >= 0) {
      shark.t += dt;
      shark.hd += Math.sin(shark.t * 0.4 + shark.seed) * 0.25 * dt;   // weaving lazily
      shark.x += Math.cos(shark.hd) * 2.2 * dt;
      shark.z += Math.sin(shark.hd) * 2.2 * dt;
      shark.up = smooth(0, 2, shark.t) * (1 - smooth(SHARK_DUR - 2.5, SHARK_DUR, shark.t));
      if (shark.t > SHARK_DUR) { shark.t = -1; shark.up = 0; }
    } else if ((shark.next -= dt * spawn) <= 0) {
      shark.next = 35 + Math.random() * 50;
      placeAhead(shark, 22, 45, 0.6);
      shark.x -= Math.cos(shark.hd) * 20;   // it swims through the spot halfway through
      shark.z -= Math.sin(shark.hd) * 20;
      shark.seed = Math.random() * 6;
      shark.t = 0;
    }

    updateAudio((now - start) / 1000, dt);

    cloudT += dt * C.cloudSpeed;
    const el = C.sunElev * Math.PI / 180, az = C.sunAzim * Math.PI / 180;
    const skyRot = real.on ? null : climateSky();

    const setCommon = U => {
      gl.uniform2f(U.uRes, canvas.width, canvas.height);
      gl.uniform1f(U.uTime, (now - start) / 1000);
      gl.uniform2f(U.uLook, yaw, pitch);
      gl.uniform3f(U.uPos, pos.x, pos.y, pos.z);
      gl.uniform3f(U.uSun, Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az));
      gl.uniform4f(U.uWave, amp, kPeak, C.windDir * Math.PI / 180, C.choppy);
      gl.uniform4f(U.uWater, C.foam, C.murk, C.depth, C.windSpeed);
      gl.uniform3f(U.uSky, C.clouds, cloudT, C.exposure);
      gl.uniform4f(U.uWeather, C.rain, fogRho, gloom, flash);
      gl.uniform4f(U.uBolt, bolt.x, bolt.z, bolt.vis, bolt.seed);
      gl.uniform4f(U.uPrecip, C.snow, C.hail, C.dust, bow);
      gl.uniform4f(U.uSpout, spout.x, spout.z, spout.grow, 0);
      gl.uniform4f(U.uWind, windOff.x, windOff.z, veil, 0);
      gl.uniform4f(U.uNight, C.aurora, C.glow, C.meteors, 0);
      gl.uniform4f(U.uStars, C.moon, C.stars, C.planes, C.sats);
      gl.uniform1i(U.uTex, 0);
      gl.uniform4f(U.uBoatA, boats[0].x, boats[0].z, boats[0].hd, 0);
      gl.uniform4f(U.uBoatB, boats[1].x, boats[1].z, boats[1].hd, 1);
      gl.uniform4fv(U.uBirds, birdBuf);
      gl.uniform2f(U.uLife, boatAmt, birdAmt);
      gl.uniform4f(U.uDolphin, pod.x, pod.z, pod.hd, pod.t);
      gl.uniform4f(U.uWhale, whale.x, whale.z, whale.hd, whale.t);
      gl.uniform4f(U.uShark, shark.x, shark.z, shark.hd, shark.up);
      gl.uniform4f(U.uFauna, pod.n, whale.kind, faunaAmt, C.life);
      gl.uniform4f(U.uMoon, real.moon[0], real.moon[1], real.moon[2], real.on ? 1 : 0);
      gl.uniform3f(U.uMoonSun, real.sun[0], real.sun[1], real.sun[2]);
      gl.uniformMatrix3fv(U.uSkyRot, false, real.on ? real.skyRot : skyRot);
      gl.uniform1i(U.uCat, 1);
      gl.uniform1i(U.uLines, 2);
      gl.uniform4f(U.uClimate, clim.tropic, clim.polar, figuresTex ? C.lines : 0, 0);
      gl.uniform4fv(U.uBergs, bergBuf);
    };
    gl.activeTexture(gl.TEXTURE0);

    // a photo is rendered at full resolution, with the clouds settled over many passes
    const shooting = photoPending;
    let oldScale = renderScale;
    if (shooting) { renderScale = 1; resize(); }

    // pass 1: clouds at half resolution, blended into last frame's clouds
    gl.useProgram(cloudProg.p);
    setCommon(cloudProg.loc);
    gl.uniform2f(cloudProg.loc.uCloudRes, cloudW, cloudH);
    for (let i = 0; i < (shooting ? 24 : 1); i++) {
      if (i > 0) { cur = 1 - cur; histOk = true; frameNo++; }
      gl.uniform4f(cloudProg.loc.uCloudView, i > 0 ? yaw : prevLook[0], i > 0 ? pitch : prevLook[1], frameNo % 997, histOk ? 1 : 0);
      gl.bindTexture(gl.TEXTURE_2D, targets[1 - cur].tex);
      gl.bindFramebuffer(gl.FRAMEBUFFER, targets[cur].fb);
      gl.viewport(0, 0, cloudW, cloudH);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    // pass 2: the full scene, reading this frame's clouds
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.useProgram(mainProg.p);
    setCommon(mainProg.loc);
    gl.bindTexture(gl.TEXTURE_2D, targets[cur].tex);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    if (shooting) {
      photoPending = false;
      savePhoto();
      renderScale = oldScale;
      resize();
    }
    cur = 1 - cur;
    histOk = true;
    prevLook = [yaw, pitch];
    frameNo++;

    fpsFrames++;
    fpsTime += dt;
    if (fpsTime >= 0.5) {
      fpsEl.textContent = Math.round(fpsFrames / fpsTime) + ' fps · ' + Math.round(renderScale * 100) + '%';
      fpsFrames = 0; fpsTime = 0;
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
})();
