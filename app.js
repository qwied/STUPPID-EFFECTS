/* STUPPID EFECTS — everything renders in the browser (WebGL + WebCodecs). */
(() => {
  'use strict';

  // ---------- templates ----------
  // bg: the template background that is always removed — 'green' (green screen), 'black' or 'none'
  // mode: how the effect is blended over the media — 'normal', 'screen' or 'add'
  const TEMPLATES = [
    { id: 'explosion', name: 'Explosion', url: 'explosion.mp4', bg: 'black', mode: 'screen' },
    { id: 'lightning', name: 'Lightning', url: 'lightning.mp4', bg: 'black', mode: 'screen' },
  ];
  // built-in processing effect (no template video): destroys picture and sound quality
  const SHAKAL = { id: 'shakal', name: 'Shakal', kind: 'shakal' };
  const MODES = { normal: 'Normal', screen: 'Screen', add: 'Add (glow)' };
  const PREVIEW_MAX = 720;      // preview short side
  const PHOTO_SECONDS = 5;      // default clip length for a photo
  const MAX_SECONDS = 120;      // longest clip a photo / GIF can be stretched to
  const MIN_CLIP = 0.1;         // shortest burst on the timeline, seconds
  const FPS = 30;

  const $ = (id) => document.getElementById(id);
  const ui = {
    stage: $('stage'), view: $('view'), emptyBtn: $('emptyBtn'), dropHint: $('dropHint'),
    busy: $('busy'), busyText: $('busyText'), busyBar: $('busyBar'), cancelBtn: $('cancelBtn'),
    transport: $('transport'), playBtn: $('playBtn'), icPlay: $('icPlay'), icPause: $('icPause'),
    time: $('time'), meta: $('meta'), timeline: $('timeline'), tl: $('tl'),
    attachBtn: $('attachBtn'), quality: $('quality'), format: $('format'), exportBtn: $('exportBtn'),
    templates: $('templates'), layers: $('layers'), layerCount: $('layerCount'),
    noLayers: $('noLayers'), clearBtn: $('clearBtn'), fileInput: $('fileInput'), tplInput: $('tplInput'),
  };

  const state = {
    src: null,          // { kind: 'video'|'image'|'gif', el, w, h, duration, frames, name }
    length: PHOTO_SECONDS, // output length in seconds (the black bar)
    layers: [],
    playing: true,
    t0: 0,              // performance.now() at t=0
    pausedAt: 0,
    exporting: null,
  };
  let layerSeq = 0;

  // ---------- WebGL renderer ----------
  const gl = ui.view.getContext('webgl', { alpha: false, premultipliedAlpha: true, preserveDrawingBuffer: true, antialias: false });
  if (!gl) alert('Your browser does not support WebGL — effects will not work.');

  const VS = `attribute vec2 p; uniform vec2 s; varying vec2 uv;
    void main(){ uv = p*0.5+0.5; gl_Position = vec4(p*s, 0.0, 1.0); }`;
  // output is premultiplied: the removed background ends up as (0,0,0,0) in every blend mode
  const FS = `precision mediump float; varying vec2 uv; uniform sampler2D t; uniform int k; uniform float o;
    void main(){
      vec4 c = texture2D(t, uv);
      float a = 1.0;
      if (k == 1) {                                   // green screen
        float mx = max(c.r, c.b);
        float g = (c.g - mx) / max(c.g, 0.01);        // share of excess green
        a = (1.0 - smoothstep(-0.02, 0.07, g))        // green and green mixes become transparent
          * smoothstep(0.2, 0.55, mx);                // so do dim olive leftovers
        c.g = min(c.g, mx * 0.9);                     // push remaining green spill to orange
        c.rgb *= a;
      } else if (k == 2) {                            // black background: light on black is already premultiplied
        a = max(c.r, max(c.g, c.b));                  // brightness is opacity, so dark glow never darkens the media
      }
      gl_FragColor = vec4(c.rgb, a) * o;
    }`;
  // Shakal: pixel blocks + JPEG-like macroblock smear + chroma bleed + deep-fry + banding + block noise.
  // amt goes from 0 (clean) to 2 (destroyed); the low frame rate is done in shakalPass().
  const SHAKAL_FS = `#ifdef GL_FRAGMENT_PRECISION_HIGH
    precision highp float;
    #else
    precision mediump float;
    #endif
    varying vec2 uv; uniform sampler2D t; uniform vec2 rs; uniform float amt; uniform float seed;
    float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233)) + seed) * 43758.5453); }
    vec3 at(vec2 px) { return texture2D(t, clamp(px / rs, 0.0, 1.0)).rgb; }
    void main() {
      vec2 p = uv * rs;
      float a = clamp(amt, 0.0, 1.0);
      float blk = floor(1.0 + amt * amt * min(rs.x, rs.y) / 64.0);
      vec2 cell = floor(p / blk);
      vec3 col = at((cell + 0.5) * blk);
      float mb = blk * 8.0; vec2 m0 = floor(p / mb) * mb;
      vec3 avg = (at(m0 + mb * vec2(.25, .25)) + at(m0 + mb * vec2(.75, .25)) + at(m0 + mb * vec2(.25, .75)) + at(m0 + mb * vec2(.75, .75))) * .25;
      col = mix(col, avg, a * 0.55);
      vec3 cc = at((floor(p / (blk * 2.0)) + 0.5) * blk * 2.0);
      float y = dot(col, vec3(.299, .587, .114)), yc = dot(cc, vec3(.299, .587, .114));
      col = mix(col, clamp(cc - yc + y, 0.0, 1.0), a);
      col = (col - 0.5) * (1.0 + amt * 0.7) + 0.5;
      float l = dot(col, vec3(.299, .587, .114)); col = mix(vec3(l), col, 1.0 + amt * 1.1);
      col += (hash(cell) - 0.5) * amt * 0.12;
      float lv = max(2.0, mix(48.0, 7.0, a) - 2.5 * max(amt - 1.0, 0.0)); col = floor(clamp(col, 0.0, 1.0) * lv + 0.5) / lv;
      gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
    }`;
  function shader(type, src) {
    const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  }
  const prog = gl.createProgram();
  gl.attachShader(prog, shader(gl.VERTEX_SHADER, VS));
  gl.attachShader(prog, shader(gl.FRAGMENT_SHADER, FS));
  gl.bindAttribLocation(prog, 0, 'p');
  gl.linkProgram(prog);
  const shakalProg = gl.createProgram();
  gl.attachShader(shakalProg, shader(gl.VERTEX_SHADER, VS));
  gl.attachShader(shakalProg, shader(gl.FRAGMENT_SHADER, SHAKAL_FS));
  gl.bindAttribLocation(shakalProg, 0, 'p');
  gl.linkProgram(shakalProg);
  if (!gl.getProgramParameter(shakalProg, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(shakalProg));
  const SK = { s: gl.getUniformLocation(shakalProg, 's'), rs: gl.getUniformLocation(shakalProg, 'rs'), amt: gl.getUniformLocation(shakalProg, 'amt'), seed: gl.getUniformLocation(shakalProg, 'seed') };
  gl.useProgram(prog);
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const aP = gl.getAttribLocation(prog, 'p');
  gl.enableVertexAttribArray(aP); gl.vertexAttribPointer(aP, 2, gl.FLOAT, false, 0, 0);
  const uS = gl.getUniformLocation(prog, 's'), uK = gl.getUniformLocation(prog, 'k'), uO = gl.getUniformLocation(prog, 'o');
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
  gl.enable(gl.BLEND);

  function makeTex() {
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }
  const baseTex = makeTex();

  const BG = { none: 0, green: 1, black: 2 };
  function drawQuad(tex, source, bg, mode, opacity, sx, sy) {
    gl.useProgram(prog);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    try { gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source); } catch { return; }
    if (mode === 'screen') gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_COLOR);
    else if (mode === 'add') gl.blendFunc(gl.ONE, gl.ONE);
    else gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.uniform1i(uK, BG[bg] || 0); gl.uniform1f(uO, opacity); gl.uniform2f(uS, sx, sy);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  // ---------- Shakal (post-process): the frame is composed off-screen, crunched, then shown ----------
  function makeTarget(w, h) {
    const tex = makeTex();
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { tex, fb, w, h, stamp: -1 };
  }
  const freeTarget = (tg) => { if (tg) { gl.deleteFramebuffer(tg.fb); gl.deleteTexture(tg.tex); } };
  let pingPong = [];
  function targets(w, h) {
    if (!pingPong.length || pingPong[0].w !== w || pingPong[0].h !== h) {
      pingPong.forEach(freeTarget);
      pingPong = [makeTarget(w, h), makeTarget(w, h)];
    }
    return pingPong;
  }
  // copies a texture onto the bound framebuffer as is
  function drawTex(tex) {
    gl.useProgram(prog);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.blendFunc(gl.ONE, gl.ZERO);
    gl.uniform1i(uK, 0); gl.uniform1f(uO, 1); gl.uniform2f(uS, 1, 1);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }
  // one Shakal layer: crunches src into the layer's own frame, which is only refreshed at a low
  // frame rate (the stutter of a bad stream), then copies that frame to dst
  function shakalPass(l, src, dst, t, w, h) {
    if (!l.cache || l.cache.w !== w || l.cache.h !== h) { freeTarget(l.cache); l.cache = makeTarget(w, h); }
    const fps = Math.max(3, 30 - 25 * l.vq), stamp = Math.floor(t * fps + 1e-6);
    if (l.cache.stamp !== stamp) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, l.cache.fb);
      gl.useProgram(shakalProg);
      gl.bindTexture(gl.TEXTURE_2D, src.tex);
      gl.blendFunc(gl.ONE, gl.ZERO);
      gl.uniform2f(SK.s, 1, 1); gl.uniform2f(SK.rs, w, h); gl.uniform1f(SK.amt, l.vq); gl.uniform1f(SK.seed, (stamp % 97) * 1.37);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      l.cache.stamp = stamp;
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fb);
    drawTex(l.cache.tex);
  }
  const shakalOn = (l, t) => l.kind === 'shakal' && t >= l.start && t < l.end;
  // stacked Shakal layers add up (and can go past 100%)
  const shakalAudioAt = (t) => Math.min(3, state.layers.reduce((a, l) => a + (shakalOn(l, t) ? l.aq : 0), 0));

  // ---------- layers: a blue span with green bursts inside ----------
  // layer.start / layer.end — where the effect is allowed (blue bar)
  // layer.clips = [{ at, len }] — each burst plays the whole template once, stretched to len seconds (green boxes)
  // layer.auto — bursts are laid back to back over the whole span; any manual burst edit turns it off
  const burstLen = (l) => l.duration / l.speed;
  function fill(l) {
    const len = burstLen(l);
    l.clips = [];
    for (let at = l.start; at < l.end - 0.02; at += len) l.clips.push({ at, len });
  }
  const sortClips = (l) => l.clips.sort((a, b) => a.at - b.at);
  // which burst plays at time t, and where inside the template video it is
  function layerAt(l, t) {
    if (t < l.start || t >= l.end) return null;
    let hit = null;
    for (const c of l.clips) if (t >= c.at && t < c.at + c.len) hit = c;
    if (!hit) return null;
    const rate = l.duration / hit.len;
    return { local: (t - hit.at) * rate, rate };
  }
  // output length (black bar); full-length effects keep covering the whole media
  function setLength(len) {
    const old = state.length;
    state.length = len;
    for (const l of state.layers) {
      if (Math.abs(l.end - old) < 1e-3 || l.end > len) l.end = len;
      if (l.start > len - MIN_CLIP) l.start = Math.max(0, len - MIN_CLIP);
      if (l.auto) fill(l);
    }
  }
  const maxLength = () => (state.src?.kind === 'video' ? state.src.duration : MAX_SECONDS);

  // ---------- time ----------
  const totalDuration = () => (state.src ? state.length : 0);
  const now = () => performance.now();
  function currentTime() {
    if (!state.playing) return state.pausedAt;
    return (now() - state.t0) / 1000;
  }
  function setTime(t) {
    state.t0 = now() - t * 1000;
    state.pausedAt = t;
    const s = state.src;
    if (s && s.kind === 'video') s.el.currentTime = Math.min(t, s.duration);
    for (const l of state.layers) { syncLayer(l, t, true); if (l.cache) l.cache.stamp = -1; }
  }

  // keep each effect <video> in sync with the shared clock
  function syncLayer(l, t, force) {
    if (l.kind) return;   // processing effects (Shakal) have no video of their own
    const v = l.video, at = layerAt(l, t);
    if (!at || at.local >= l.duration) {
      if (!v.paused) v.pause();
      if (!at && !v.seeking && v.currentTime > 0.01) v.currentTime = 0;   // ready for the next burst
      return;
    }
    const rate = Math.min(16, Math.max(0.0625, at.rate));
    if (Math.abs(v.playbackRate - rate) > 1e-3) v.playbackRate = rate;
    // re-seek only when clearly off and not already seeking — avoids endless seeking at high speed
    if (force || (!v.seeking && Math.abs(v.currentTime - at.local) > 0.25 * Math.max(1, rate))) v.currentTime = at.local;
    if (state.playing && v.paused) v.play().catch(() => {});
    if (!state.playing && !v.paused) v.pause();
  }

  // ---------- frame ----------
  function render(t) {
    const s = state.src;
    const W = ui.view.width, H = ui.view.height;
    // Shakal is applied on top of everything (media + all effect layers), so compose off-screen first
    const shakals = s ? state.layers.filter((l) => shakalOn(l, t) && l.vq > 0) : [];
    const pp = shakals.length ? targets(W, H) : null;
    gl.bindFramebuffer(gl.FRAMEBUFFER, pp ? pp[0].fb : null);
    gl.viewport(0, 0, W, H);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    if (!s) return;

    let frame = s.el;
    if (s.kind === 'gif') {
      let x = t % s.duration, i = 0;
      while (i < s.frames.length - 1 && x >= s.frames[i].d) { x -= s.frames[i].d; i++; }
      frame = s.frames[i].bmp;
    }
    if (s.kind !== 'video' || s.el.readyState >= 2) drawQuad(baseTex, frame, 'none', 'normal', 1, 1, 1);

    const outA = W / H;
    for (const l of state.layers) {
      if (l.kind) continue;
      const at = layerAt(l, t);
      if (!at || at.local >= l.duration || l.video.readyState < 2) continue;
      // auto fit: the effect keeps its proportions and is stretched to cover the whole frame
      const fa = l.video.videoWidth / l.video.videoHeight;
      let sx = 1, sy = 1;
      if (fa > outA) sx = fa / outA; else sy = outA / fa;
      drawQuad(l.tex, l.video, l.tpl.bg, l.mode, l.opacity, sx * l.scale, sy * l.scale);
    }

    if (pp) {
      // every active Shakal layer crunches the result again (stacking = worse quality)
      let cur = 0;
      for (const l of shakals) { shakalPass(l, pp[cur], pp[1 - cur], t, W, H); cur = 1 - cur; }
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, W, H);
      drawTex(pp[cur].tex);
    }
  }

  function tick() {
    requestAnimationFrame(tick);
    if (!state.exporting) step();             // while exporting, a timer drives step() instead
  }
  function step() {
    const s = state.src;
    if (!s || state.exporting?.offline) return;   // MP4 / GIF render frame by frame themselves
    const total = totalDuration();
    let t = currentTime();

    if (s.kind === 'video' && state.playing) {
      // video is the master clock (keeps audio smooth)
      if (!s.el.paused && !s.el.ended && t < s.duration) {
        t = s.el.currentTime;
        state.t0 = now() - t * 1000;
      } else if (t < s.duration && s.el.paused) s.el.play().catch(() => {});
    }

    if (t >= total) {
      if (state.exporting) { finishExport(); return; }
      setTime(0); t = 0;
      if (s.kind === 'video' && state.playing) s.el.play().catch(() => {});
    }
    for (const l of state.layers) syncLayer(l, t, false);
    liveShakal = shakalAudioAt(t);
    render(t);

    movePlayhead(t);
    ui.time.textContent = `${fmt(t)} / ${fmt(total)}`;
    if (state.exporting) {
      const p = Math.min(1, t / total);
      ui.busyBar.style.width = (p * 100).toFixed(1) + '%';
      ui.busyText.textContent = `Rendering ${state.exporting.label}… ${Math.round(p * 100)}%`;
    }
  }
  const fmt = (x) => { x = Math.max(0, x); const m = Math.floor(x / 60), s = Math.floor(x % 60); return `${m}:${String(s).padStart(2, '0')}`; };

  // ---------- sizes ----------
  function outSize(short) {
    const s = state.src;
    if (!s) return [0, 0];
    if (!short) return [s.w & ~1, s.h & ~1];
    const even = (n) => Math.max(2, Math.round(n / 2) * 2);
    return s.w >= s.h ? [even(short * s.w / s.h), short] : [short, even(short * s.h / s.w)];
  }
  function setCanvasSize(short) {
    const [w, h] = outSize(short);
    ui.view.width = w; ui.view.height = h;
    // stage becomes landscape / portrait / square to match the file
    ui.stage.style.aspectRatio = `${w} / ${h}`;
    ui.stage.style.width = `min(100%, 960px, calc(72vh * ${(w / h).toFixed(4)}))`;
  }
  function orientation() {
    const { w, h } = state.src;
    return w > h ? 'landscape' : w < h ? 'portrait' : 'square';
  }
  function previewShort() {
    const q = +ui.quality.value || Math.min(state.src.w, state.src.h);
    return Math.min(q, PREVIEW_MAX);
  }
  function updateMeta() {
    if (!state.src) return;
    const [w, h] = outSize(+ui.quality.value);
    const kind = { video: 'video', image: 'photo', gif: 'GIF' }[state.src.kind];
    ui.meta.textContent = `${kind} · ${orientation()} · ${state.src.w}×${state.src.h} → ${w}×${h}`;
  }

  // ---------- media loading ----------
  async function loadSource(file) {
    if (!file || state.exporting) return;
    const url = URL.createObjectURL(file);
    let src;
    try {
      if (file.type.startsWith('video/') || /\.(mp4|webm|mov|mkv|m4v|ogv)$/i.test(file.name)) {
        const v = document.createElement('video');
        v.src = url; v.playsInline = true; v.preload = 'auto'; v.crossOrigin = 'anonymous';
        await new Promise((ok, fail) => { v.onloadeddata = ok; v.onerror = () => fail(new Error('cannot read video')); });
        if (!isFinite(v.duration)) {
          // screen-recorded WebM has unknown duration — seek to the end so the browser computes it
          v.currentTime = 1e9;
          await new Promise((ok) => { v.ondurationchange = () => isFinite(v.duration) && ok(); setTimeout(ok, 3000); });
          v.currentTime = 0;
        }
        src = { kind: 'video', el: v, w: v.videoWidth, h: v.videoHeight, duration: isFinite(v.duration) && v.duration > 0 ? v.duration : 1 };
      } else if (file.type === 'image/gif' && 'ImageDecoder' in window) {
        src = await decodeGif(file);
      } else {
        const img = new Image();
        img.src = url;
        await img.decode();
        src = { kind: 'image', el: img, w: img.naturalWidth, h: img.naturalHeight, duration: PHOTO_SECONDS };
      }
    } catch (e) {
      alert('Could not open file: ' + e.message);
      return;
    }
    if (state.src) disposeSource(state.src);
    src.name = file.name.replace(/\.[^.]+$/, '');
    src.url = url;
    src.file = file;
    state.src = src;
    if (src.kind === 'video') routeAudio(src.el);
    setLength(src.duration);

    ui.emptyBtn.hidden = true;
    ui.view.hidden = false;
    ui.transport.hidden = false;
    ui.exportBtn.disabled = false;
    setCanvasSize(previewShort());
    updateMeta();
    renderTimeline();
    state.playing = true; updatePlayIcon();
    setTime(0);
    if (src.kind === 'video') src.el.play().catch(() => {});
  }
  async function decodeGif(file) {
    const dec = new ImageDecoder({ data: file.stream(), type: 'image/gif' });
    await dec.tracks.ready;
    const n = dec.tracks.selectedTrack.frameCount;
    const frames = [];
    let dur = 0;
    for (let i = 0; i < n; i++) {
      const { image } = await dec.decode({ frameIndex: i });
      const d = Math.max(0.02, (image.duration || 100000) / 1e6);
      frames.push({ bmp: await createImageBitmap(image), d });
      dur += d;
      image.close();
    }
    const f0 = frames[0].bmp;
    return { kind: 'gif', el: f0, frames, w: f0.width, h: f0.height, duration: dur };
  }
  function disposeSource(s) {
    if (s.kind === 'video') { s.el.pause(); s.el.removeAttribute('src'); s.el.load(); }
    if (s.frames) s.frames.forEach((f) => f.bmp.close());
    URL.revokeObjectURL(s.url);
  }

  // ---------- audio ----------
  // Shakal sound: cheap-mic band (high-pass + low-pass), overdrive, bit crush and sample-rate drop.
  // a = 0 leaves the sound untouched; 1 is a broken phone call; 2-3 is pure crunch.
  function makeCrusher(rate) {
    const ch = [0, 1].map(() => ({ lp: 0, hp: 0, prev: 0, held: 0, n: 0 }));
    return (x, c, a) => {
      const s = ch[c];
      if (a <= 0.001) { s.prev = x; s.lp = x; s.hp = 0; s.n = 0; return x; }
      const f = Math.min(1, a);
      const kHp = 1 - Math.exp(-2 * Math.PI * (40 + 560 * f) / rate);
      const kLp = 1 - Math.exp(-2 * Math.PI * (1800 + 18000 * (1 - f) * (1 - f)) / rate);
      s.hp += kHp * (x - s.hp);                    // follows the lows; subtracting it removes them
      let y = x - s.hp;
      s.lp += kLp * (y - s.lp); y = s.lp;
      y = Math.tanh(y * (1 + 10 * a)) * 0.85;      // overdrive
      const q = Math.pow(2, Math.max(1, 15 - 11 * a));
      y = Math.round(y * q) / q;                   // fewer bits
      const hold = 1 + Math.floor(a * a * 24);     // lower sample rate
      if (s.n++ % hold === 0) s.held = y;
      return s.held;
    };
  }
  // applies the Shakal sound of the layers to a finished (exported) mix
  function shakalBuffer(buf) {
    const rate = buf.sampleRate, crush = makeCrusher(rate);
    for (let c = 0; c < Math.min(2, buf.numberOfChannels); c++) {
      const d = buf.getChannelData(c);
      let a = 0;
      for (let i = 0; i < d.length; i++) {
        if ((i & 255) === 0) a = shakalAudioAt(i / rate);
        d[i] = crush(d[i], c, a);
      }
    }
  }
  let ac = null, recDest = null, bus = null, liveShakal = 0;
  function audioCtx() {
    if (!ac) {
      ac = new (window.AudioContext || window.webkitAudioContext)();
      recDest = ac.createMediaStreamDestination();
      // every sound goes through the Shakal processor before the speakers / the recorder
      bus = ac.createGain();
      const crush = makeCrusher(ac.sampleRate);
      const proc = ac.createScriptProcessor(1024, 2, 2);
      let a = 0;
      proc.onaudioprocess = (e) => {
        const ib = e.inputBuffer, ob = e.outputBuffer, n = ib.length;
        const target = state.playing ? liveShakal : 0;
        for (let c = 0; c < 2; c++) {
          const inp = ib.getChannelData(Math.min(c, ib.numberOfChannels - 1)), out = ob.getChannelData(c);
          let k = a;
          for (let i = 0; i < n; i++) { k += (target - k) * 0.002; out[i] = crush(inp[i], c, k); }
          if (c === 1) a = k;
        }
      };
      bus.connect(proc);
      proc.connect(ac.destination);
      proc.connect(recDest);
    }
    if (ac.state === 'suspended') ac.resume();
    return ac;
  }
  function routeAudio(el) {
    if (el._routed) return;
    try {
      const ctx = audioCtx();
      const node = ctx.createMediaElementSource(el);
      node.connect(bus);
      el._routed = true;
    } catch { /* no audio */ }
  }

  // ---------- templates ----------
  function tplTile(tpl) {
    const b = document.createElement('button');
    b.className = 'tpl';
    b.title = `Add "${tpl.name}"`;
    const c = document.createElement('canvas');
    c.width = 200; c.height = 150;
    const v = document.createElement('video');
    v.src = tpl.url; v.muted = true; v.loop = true; v.playsInline = true; v.autoplay = true; v.crossOrigin = 'anonymous';
    v.play().catch(() => {});
    const x = c.getContext('2d', { willReadFrequently: true });
    const draw = () => {
      if (!b.isConnected) return;
      requestAnimationFrame(draw);
      if (v.readyState < 2) return;
      const cw = c.width, ch = c.height, va = v.videoWidth / v.videoHeight;
      let w = cw, h = cw / va; if (h < ch) { h = ch; w = ch * va; }
      x.fillStyle = '#0b0b0b'; x.fillRect(0, 0, cw, ch);
      x.drawImage(v, (cw - w) / 2, (ch - h) / 2, w, h);
      if (tpl.bg === 'green') {
        const d = x.getImageData(0, 0, cw, ch), p = d.data;
        // same key as the shader
        const sm = (e0, e1, v) => { const t = Math.min(1, Math.max(0, (v - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };
        for (let i = 0; i < p.length; i += 4) {
          const mx = Math.max(p[i], p[i + 2]), k = (p[i + 1] - mx) / Math.max(p[i + 1], 2.5);
          const a = (1 - sm(-0.02, 0.07, k)) * sm(51, 140, mx), bg = 11 * (1 - a);
          p[i] = p[i] * a + bg; p[i + 1] = Math.min(p[i + 1], mx * 0.9) * a + bg; p[i + 2] = p[i + 2] * a + bg;
        }
        x.putImageData(d, 0, 0);
      }
      // brightest frame so far becomes the layer thumbnail
      if (v.currentTime < v.duration * 0.6) {
        const p = x.getImageData(cw >> 1, ch >> 1, 1, 1).data, light = p[0] + p[1] + p[2];
        if (!tpl.poster || light > tpl.posterLight) {
          tpl.poster ||= document.createElement('canvas');
          tpl.poster.width = cw; tpl.poster.height = ch;
          tpl.poster.getContext('2d').drawImage(c, 0, 0);
          tpl.posterLight = light;
        }
      }
    };
    requestAnimationFrame(draw);
    b.append(c);
    const label = document.createElement('div');
    label.className = 'name';
    label.innerHTML = `<span></span><span class="add"><svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg></span>`;
    label.firstChild.textContent = tpl.name;
    b.append(label);
    b.onclick = () => addLayer(tpl, tpl.poster || c);
    return b;
  }
  // Shakal tile: a picture drawn on the spot, then crushed into big blocks and few colours
  function shakalTile() {
    const b = document.createElement('button');
    b.className = 'tpl';
    b.title = 'Add "Shakal" — destroys video and sound quality (stack several for more)';
    const c = document.createElement('canvas');
    c.width = 200; c.height = 150;
    const x = c.getContext('2d');
    const g = x.createLinearGradient(0, 0, 200, 150);
    g.addColorStop(0, '#ff3d00'); g.addColorStop(0.5, '#ffd500'); g.addColorStop(1, '#00b7ff');
    x.fillStyle = g; x.fillRect(0, 0, 200, 150);
    x.fillStyle = '#fff'; x.beginPath(); x.arc(150, 45, 26, 0, 7); x.fill();
    x.fillStyle = '#111'; x.fillRect(0, 105, 200, 45);
    x.font = '900 34px Impact, "Arial Black", sans-serif'; x.textAlign = 'center';
    x.lineWidth = 6; x.strokeStyle = '#000'; x.strokeText('360p', 70, 70); x.fillStyle = '#fff'; x.fillText('360p', 70, 70);
    const small = document.createElement('canvas'); small.width = 25; small.height = 19;
    const sx = small.getContext('2d'); sx.drawImage(c, 0, 0, 25, 19);
    const d = sx.getImageData(0, 0, 25, 19);
    for (let i = 0; i < d.data.length; i += 4) for (let k = 0; k < 3; k++) d.data[i + k] = Math.round((d.data[i + k] + (Math.random() - 0.5) * 60) / 64) * 64;
    sx.putImageData(d, 0, 0);
    x.imageSmoothingEnabled = false; x.drawImage(small, 0, 0, 200, 150);
    b.append(c);
    const label = document.createElement('div');
    label.className = 'name';
    label.innerHTML = `<span>Shakal</span><span class="add"><svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg></span>`;
    b.append(label);
    b.onclick = () => addShakal(c);
    return b;
  }
  function renderTemplates() {
    ui.templates.innerHTML = '';
    TEMPLATES.forEach((t) => ui.templates.append(tplTile(t)));
    ui.templates.append(shakalTile());
    const add = document.createElement('button');
    add.className = 'tpl custom';
    add.innerHTML = `<div><svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>Custom template</div>`;
    add.title = 'Upload your own video template (green screen or black background)';
    add.onclick = () => ui.tplInput.click();
    ui.templates.append(add);
  }

  async function addCustomTemplate(file) {
    const url = URL.createObjectURL(file);
    const bg = await guessBackground(url);
    const tpl = { id: 'custom' + Date.now(), name: file.name.replace(/\.[^.]+$/, '').slice(0, 24), url, bg, mode: bg === 'black' ? 'screen' : 'normal' };
    TEMPLATES.push(tpl);
    renderTemplates();
  }
  // guess the background from the frame corners: green screen, black, or none
  async function guessBackground(url) {
    const v = document.createElement('video');
    v.src = url; v.muted = true;
    try {
      await new Promise((ok, fail) => { v.onloadeddata = ok; v.onerror = fail; });
      v.currentTime = Math.min(0.1, v.duration / 2);
      await new Promise((ok) => (v.onseeked = ok));
      const c = document.createElement('canvas'); c.width = 32; c.height = 32;
      const x = c.getContext('2d'); x.drawImage(v, 0, 0, 32, 32);
      const px = [[0, 0], [31, 0], [0, 31], [31, 31]].map(([a, b]) => x.getImageData(a, b, 1, 1).data);
      if (px.filter((p) => p[1] > 60 && p[1] - Math.max(p[0], p[2]) > 40).length >= 2) return 'green';
      if (px.filter((p) => p[0] + p[1] + p[2] < 60).length >= 2) return 'black';
    } catch { /* ignore */ }
    return 'none';
  }

  // ---------- layer list ----------
  function addLayer(tpl, thumbCanvas) {
    const v = document.createElement('video');
    v.src = tpl.url; v.playsInline = true; v.preload = 'auto'; v.crossOrigin = 'anonymous';
    const l = {
      id: ++layerSeq, tpl, video: v, tex: makeTex(), mode: tpl.mode,
      opacity: 1, scale: 1, speed: 1, duration: 1,
      start: 0, end: state.length, clips: [], auto: true, thumb: null, thumbUrl: '',
    };
    if (thumbCanvas) {
      l.thumb = document.createElement('canvas');
      l.thumb.width = 108; l.thumb.height = 72;
      l.thumb.getContext('2d').drawImage(thumbCanvas, 0, 0, 108, 72);
      l.thumbUrl = l.thumb.toDataURL('image/jpeg', 0.7);
    }
    v.addEventListener('loadedmetadata', () => {
      l.duration = v.duration || 1;
      if (l.auto) fill(l); else l.clips.forEach((c) => (c.len = burstLen(l)));
      renderAll();
    });
    v.addEventListener('loadeddata', () => routeAudio(v), { once: true });
    fill(l);
    state.layers.push(l);
    renderAll();
  }
  // Shakal layer: no video, just two strengths (0..2) over its blue range
  function addShakal(thumbCanvas) {
    const l = {
      id: ++layerSeq, tpl: SHAKAL, kind: 'shakal', vq: 0.6, aq: 0.6, cache: null,
      duration: 1, speed: 1, start: 0, end: state.length, clips: [], auto: false, thumb: null, thumbUrl: '',
    };
    l.thumb = document.createElement('canvas');
    l.thumb.width = 108; l.thumb.height = 72;
    l.thumb.getContext('2d').drawImage(thumbCanvas, 0, 0, 108, 72);
    l.thumbUrl = l.thumb.toDataURL('image/jpeg', 0.7);
    state.layers.push(l);
    renderAll();
    if (!state.playing) render(currentTime());
  }
  function removeLayer(l) {
    if (l.video) { l.video.pause(); l.video.removeAttribute('src'); l.video.load(); }
    if (l.tex) gl.deleteTexture(l.tex);
    if (l.cache) freeTarget(l.cache);
    state.layers = state.layers.filter((x) => x !== l);
    if (TL.sel?.l === l) TL.sel = null;
    renderAll();
  }
  function renderAll() { renderLayers(); renderTimeline(); }

  const ICON = {
    fill: '<svg viewBox="0 0 24 24"><path d="M17 2l4 4-4 4"/><path d="M3 11V9a3 3 0 0 1 3-3h15M7 22l-4-4 4-4"/><path d="M21 13v2a3 3 0 0 1-3 3H3"/></svg>',
    up: '<svg viewBox="0 0 24 24"><path d="M18 15l-6-6-6 6"/></svg>',
    down: '<svg viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg>',
    del: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  };
  function renderLayers() {
    ui.layers.innerHTML = '';
    ui.layerCount.textContent = state.layers.length;
    ui.noLayers.hidden = state.layers.length > 0;
    ui.clearBtn.hidden = state.layers.length === 0;

    state.layers.forEach((l, i) => {
      const li = document.createElement('li');
      li.className = 'layer';
      if (l.kind === 'shakal') return ui.layers.append(shakalRow(l, i));
      li.innerHTML = `
        <span class="idx">${i + 1}</span>
        <span class="thumb"></span>
        <span class="lname"></span>
        <label class="field"><span>Opacity <b data-o="opacity"></b></span><input type="range" data-k="opacity" min="0" max="1" step="0.01"></label>
        <label class="field"><span>Size <b data-o="scale"></b></span><input type="range" data-k="scale" min="0.3" max="2.5" step="0.05"></label>
        <label class="field"><span>Speed <b data-o="speed"></b></span><input type="range" data-k="speed" min="0.25" max="3" step="0.05"></label>
        <label class="field"><span>Mode</span><select data-k="mode">${Object.entries(MODES).map(([k, n]) => `<option value="${k}">${n}</option>`).join('')}</select></label>
        <span class="actions">
          <button class="mini${l.auto ? ' on' : ''}" data-a="fill" title="Fill the blue bar with bursts back to back (endless loop)">${ICON.fill}</button>
          <button class="mini" data-a="up" title="Move up" ${i === 0 ? 'disabled' : ''}>${ICON.up}</button>
          <button class="mini" data-a="down" title="Move down" ${i === state.layers.length - 1 ? 'disabled' : ''}>${ICON.down}</button>
          <button class="mini" data-a="del" title="Remove">${ICON.del}</button>
        </span>`;
      li.querySelector('.lname').textContent = l.tpl.name;
      if (l.thumb) li.querySelector('.thumb').append(l.thumb);
      const out = () => {
        li.querySelector('[data-o=opacity]').textContent = Math.round(l.opacity * 100) + '%';
        li.querySelector('[data-o=scale]').textContent = Math.round(l.scale * 100) + '%';
        li.querySelector('[data-o=speed]').textContent = +l.speed.toFixed(2) + '×';
      };
      li.querySelectorAll('[data-k]').forEach((inp) => {
        inp.value = l[inp.dataset.k];
        inp.addEventListener('input', () => {
          const k = inp.dataset.k;
          l[k] = k === 'mode' ? inp.value : +inp.value;
          out();
          if (k === 'speed') {
            // speed = how long every burst lasts
            if (l.auto) fill(l); else l.clips.forEach((c) => (c.len = burstLen(l)));
            renderTimeline();
            syncLayer(l, currentTime(), true);
          }
        });
      });
      li.querySelector('.actions').addEventListener('click', (e) => {
        const a = e.target.closest('[data-a]')?.dataset.a;
        if (!a) return;
        if (a === 'del') return removeLayer(l);
        if (a === 'fill') { l.auto = true; fill(l); syncLayer(l, currentTime(), true); return renderAll(); }
        const j = a === 'up' ? i - 1 : i + 1;
        [state.layers[i], state.layers[j]] = [state.layers[j], state.layers[i]];
        renderAll();
      });
      out();
      ui.layers.append(li);
    });
  }
  // Shakal row: how hard to destroy the picture and the sound (0..200%)
  function shakalRow(l, i) {
    const li = document.createElement('li');
    li.className = 'layer';
    li.innerHTML = `
      <span class="idx">${i + 1}</span>
      <span class="thumb"></span>
      <span class="lname">Shakal</span>
      <label class="field"><span>Video <b data-o="vq"></b></span><input type="range" data-k="vq" min="0" max="2" step="0.05"></label>
      <label class="field"><span>Sound <b data-o="aq"></b></span><input type="range" data-k="aq" min="0" max="2" step="0.05"></label>
      <span></span><span></span>
      <span class="actions">
        <button class="mini" data-a="up" title="Move up" ${i === 0 ? 'disabled' : ''}>${ICON.up}</button>
        <button class="mini" data-a="down" title="Move down" ${i === state.layers.length - 1 ? 'disabled' : ''}>${ICON.down}</button>
        <button class="mini" data-a="del" title="Remove">${ICON.del}</button>
      </span>`;
    li.querySelector('.thumb').append(l.thumb);
    const out = () => {
      li.querySelector('[data-o=vq]').textContent = Math.round(l.vq * 100) + '%';
      li.querySelector('[data-o=aq]').textContent = Math.round(l.aq * 100) + '%';
    };
    li.querySelectorAll('[data-k]').forEach((inp) => {
      inp.value = l[inp.dataset.k];
      inp.addEventListener('input', () => {
        l[inp.dataset.k] = +inp.value;
        if (l.cache) l.cache.stamp = -1;
        out();
        if (!state.playing) render(currentTime());
      });
    });
    li.querySelector('.actions').addEventListener('click', (e) => {
      const a = e.target.closest('[data-a]')?.dataset.a;
      if (!a) return;
      if (a === 'del') return removeLayer(l);
      const j = a === 'up' ? i - 1 : i + 1;
      [state.layers[i], state.layers[j]] = [state.layers[j], state.layers[i]];
      renderAll();
    });
    out();
    return li;
  }

  // ---------- timeline ----------
  // black bar = media length; every effect gets its own group of rows:
  // "Range" (blue bar = where the effect is on) and "Bursts" (green boxes, overlapping ones on sub-rows)
  const LABEL = 112;                    // px reserved for row labels
  const LANE_H = 26;                    // height of one burst sub-row
  const TL = { view: 10, pps: 50, drag: null, sel: null };
  function computeView() {
    const s = state.src;
    if (!s) return 10;
    if (s.kind === 'video') return s.duration;
    const end = Math.max(state.length, ...state.layers.map((l) => l.end));
    return Math.min(MAX_SECONDS, Math.max(end * 1.25, end + 2));
  }
  function tickStep(pps) {
    return [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60].find((s) => s * pps >= 56) || 60;
  }
  const px = (t) => (t * TL.pps).toFixed(1) + 'px';
  const esc = (t) => t.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]);
  function renderTimeline() {
    if (!state.src) { ui.timeline.hidden = true; return; }
    ui.timeline.hidden = false;
    if (!TL.drag) TL.view = computeView();
    const lane = Math.max(100, ui.tl.clientWidth - LABEL - 24);
    TL.pps = lane / TL.view;
    const step = tickStep(TL.pps);
    let ticks = '';
    for (let t = 0; t <= TL.view + 1e-6; t += step) {
      ticks += `<span class="tl-tick" style="left:${px(t)}">${step < 1 ? t.toFixed(step < 0.5 ? 2 : 1) : Math.round(t)}s</span>`;
    }
    const media = { video: 'Video', image: 'Photo', gif: 'GIF' }[state.src.kind];
    let rows = `
      <div class="tl-row ruler"><div class="tl-label"></div><div class="tl-lane" data-drag="seek">${ticks}</div></div>
      <div class="tl-row media"><div class="tl-label">${media}</div><div class="tl-lane" data-drag="seek">
        <div class="tl-media" data-drag="seek" style="width:${px(state.length)}" title="Media length — drag the right end to change it">
          <span class="tl-h r" data-drag="len" title="Drag to set the length"></span>
          <span class="tl-len">${state.length.toFixed(1)}s</span>
        </div></div></div>`;
    state.layers.forEach((l, li) => {
      if (l.kind === 'shakal') {
        // processing effect: only the blue range (where the quality is destroyed), no bursts
        rows += `
        <div class="tl-group">
          <div class="tl-row range"><div class="tl-label"><img src="${l.thumbUrl}" alt=""><span class="tl-name">${li + 1}. Shakal</span></div>
            <div class="tl-lane" data-drag="seek">
              <div class="tl-span" data-drag="span-move" data-l="${li}" style="left:${px(l.start)};width:${px(l.end - l.start)}"
                title="Where Shakal is on — drag to move, drag the ends to resize">
                <span class="tl-h l" data-drag="span-l" data-l="${li}"></span>
                <span class="tl-span-txt">${(l.end - l.start).toFixed(1)}s</span>
                <span class="tl-h r" data-drag="span-r" data-l="${li}"></span>
              </div>
            </div></div>
        </div>`;
        return;
      }
      // overlapping bursts go to separate sub-rows (kept as they are while dragging so nothing jumps)
      const vis = l.clips.map((c, ci) => ({ c, ci, a: Math.max(c.at, l.start), b: Math.min(c.at + c.len, l.end) })).filter((v) => v.b - v.a > 0.001);
      if (!TL.drag) {
        const ends = [];
        for (const v of [...vis].sort((p, q) => p.a - q.a)) {
          let k = ends.findIndex((e) => e <= v.a + 1e-6);
          if (k < 0) k = ends.length;
          ends[k] = v.b;
          v.c.lane = k;
        }
      }
      const lanes = Math.max(1, ...vis.map((v) => (v.c.lane || 0) + 1));
      let clips = '';
      vis.forEach(({ c, ci, a, b }) => {
        const sel = TL.sel && TL.sel.l === l && TL.sel.c === c;
        const rate = l.duration / c.len;
        clips += `<div class="tl-clip${sel ? ' sel' : ''}${a > c.at ? ' cut-l' : ''}${b < c.at + c.len ? ' cut-r' : ''}" data-drag="clip-move" data-l="${li}" data-c="${ci}"
          style="left:${px(a)};width:${px(b - a)};top:${4 + (c.lane || 0) * LANE_H}px;height:${LANE_H - 4}px" title="Burst ${c.len.toFixed(2)}s (${+rate.toFixed(2)}×) — drag to move, drag edges to stretch">
          <span class="tl-h l" data-drag="clip-l" data-l="${li}" data-c="${ci}"></span>
          <span class="tl-rate">${+rate.toFixed(2)}×</span>
          <span class="tl-h r" data-drag="clip-r" data-l="${li}" data-c="${ci}"></span>
          ${sel ? `<button class="tl-x" data-act="del-clip" title="Delete burst (Delete key)">×</button>` : ''}
        </div>`;
      });
      rows += `
        <div class="tl-group">
          <div class="tl-row range"><div class="tl-label">${l.thumbUrl ? `<img src="${l.thumbUrl}" alt="">` : ''}<span class="tl-name">${li + 1}. ${esc(l.tpl.name)}</span></div>
            <div class="tl-lane" data-drag="seek">
              <div class="tl-span" data-drag="span-move" data-l="${li}" style="left:${px(l.start)};width:${px(l.end - l.start)}"
                title="Where ${esc(l.tpl.name)} is on — drag to move, drag the ends to resize">
                <span class="tl-h l" data-drag="span-l" data-l="${li}"></span>
                <span class="tl-span-txt">${(l.end - l.start).toFixed(1)}s</span>
                <span class="tl-h r" data-drag="span-r" data-l="${li}"></span>
              </div>
            </div></div>
          <div class="tl-row bursts" data-l="${li}" style="height:${8 + lanes * LANE_H}px">
            <div class="tl-label"><span>Bursts</span><button class="tl-add" data-act="add-clip" data-l="${li}" title="Add a burst at the playhead">+ Burst</button></div>
            <div class="tl-lane" data-drag="seek">
              <div class="tl-zone" style="left:${px(l.start)};width:${px(l.end - l.start)}"></div>
              ${clips}
            </div></div>
        </div>`;
    });
    ui.tl.innerHTML = rows + `<div class="tl-head" id="tlHead"></div>`;
    movePlayhead(currentTime());
  }
  function movePlayhead(t) {
    const head = ui.tl.querySelector('#tlHead');
    if (head) head.style.left = `${LABEL + 12 + t * TL.pps - 1}px`;   // 12 = .tl padding
  }

  // snapping to nearby edges makes it easy to line bursts up
  // skip: what is being dragged ('len', a layer's span, or a clip), so it never snaps to itself
  function snap(t, skip) {
    const pts = [0, currentTime()];
    if (skip !== 'len') pts.push(state.length);
    for (const x of state.layers) {
      if (x !== skip) pts.push(x.start, x.end);
      for (const c of x.clips) if (c !== skip) pts.push(c.at, c.at + c.len);
    }
    const tol = 8 / TL.pps;
    let best = t, d = tol;
    for (const p of pts) if (Math.abs(p - t) < d) { d = Math.abs(p - t); best = p; }
    return best;
  }
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  function laneTime(e) {
    const lane = ui.tl.querySelector('.tl-lane');
    return (e.clientX - lane.getBoundingClientRect().left) / TL.pps;
  }

  ui.tl.addEventListener('pointerdown', (e) => {
    if (!state.src || state.exporting || e.button > 0) return;
    const add = e.target.closest('[data-act=add-clip]');
    if (add) {
      const l = state.layers[+add.dataset.l];
      return addBurst(l, clamp(currentTime(), l.start, l.end), true);
    }
    if (e.target.closest('[data-act=del-clip]')) {
      const { l, c } = TL.sel;
      l.clips = l.clips.filter((x) => x !== c); l.auto = false; TL.sel = null;
      syncLayer(l, currentTime(), true);
      return renderAll();
    }
    const ms = performance.now();
    const dbl = TL.last && ms - TL.last.ms < 400 && Math.abs(e.clientX - TL.last.x) < 6;
    TL.last = { ms, x: e.clientX };
    if (dbl && addBurstAt(e)) { TL.last = null; return; }
    const el = e.target.closest('[data-drag]');
    if (!el) return;
    const kind = el.dataset.drag;
    const l = state.layers[+el.dataset.l];
    const c = l && el.dataset.c != null ? l.clips[+el.dataset.c] : null;
    TL.drag = {
      kind, l, c, x0: e.clientX, moved: false,
      len: state.length, start: l?.start, end: l?.end,
      at: c?.at, clen: c?.len, clips: l?.clips.map((k) => ({ k, at: k.at })),
    };
    if (kind.startsWith('clip')) { TL.sel = { l, c }; renderTimeline(); }
    else if (TL.sel) { TL.sel = null; renderTimeline(); }
    if (kind === 'seek') seekTo_(laneTime(e));
    try { ui.tl.setPointerCapture(e.pointerId); } catch { /* pointer already gone */ }
    e.preventDefault();
  });
  ui.tl.addEventListener('pointermove', (e) => {
    const d = TL.drag;
    if (!d) return;
    const dt = (e.clientX - d.x0) / TL.pps;
    if (Math.abs(e.clientX - d.x0) > 2) d.moved = true;
    const { l, c } = d;
    switch (d.kind) {
      case 'seek': seekTo_(laneTime(e)); break;
      case 'len': setLength(clamp(snap(d.len + dt, 'len'), 0.5, maxLength())); updateTime(); break;
      case 'span-move': {
        const k = clamp(dt, -d.start, state.length - d.end);
        l.start = d.start + k; l.end = d.end + k;
        d.clips.forEach((o) => (o.k.at = o.at + k));
        break;
      }
      case 'span-l': l.start = clamp(snap(d.start + dt, l), 0, l.end - MIN_CLIP); if (l.auto) fill(l); break;
      case 'span-r': l.end = clamp(snap(d.end + dt, l), l.start + MIN_CLIP, state.length); if (l.auto) fill(l); break;
      case 'clip-move': {
        const raw = d.at + dt, byLeft = snap(raw, c), byRight = snap(raw + c.len, c) - c.len;   // either edge may snap
        c.at = Math.abs(byRight - raw) > 1e-9 && (byLeft === raw || Math.abs(byRight - raw) < Math.abs(byLeft - raw)) ? byRight : byLeft;
        l.auto = false; break;
      }
      case 'clip-l': {
        const end = d.at + d.clen;
        const minLen = Math.max(MIN_CLIP, l.duration / 16);
        c.at = Math.min(snap(d.at + dt, c), end - minLen); c.len = end - c.at; l.auto = false; break;
      }
      case 'clip-r': c.len = Math.max(Math.max(MIN_CLIP, l.duration / 16), snap(d.at + d.clen + dt, c) - d.at); l.auto = false; break;
    }
    if (d.kind !== 'seek') { if (l) syncLayer(l, currentTime(), true); renderTimeline(); if (!state.playing) render(currentTime()); }
  });
  const endDrag = () => {
    const d = TL.drag;
    if (!d) return;
    TL.drag = null;
    if (d.l) { sortClips(d.l); syncLayer(d.l, currentTime(), true); }
    if (d.kind.startsWith('clip') || d.kind.startsWith('span')) renderLayers();   // the fill button reflects auto mode
    renderTimeline();
  };
  ui.tl.addEventListener('pointerup', endDrag);
  ui.tl.addEventListener('pointercancel', endDrag);
  // double-click inside a blue bar (where there is no burst yet) adds a burst there.
  // Detected from two quick presses: pointer capture keeps the browser from sending dblclick.
  function addBurstAt(e) {
    const hit = document.elementFromPoint(e.clientX, e.clientY);
    const row = hit?.closest('.tl-row.bursts, .tl-row.range');
    if (!row || hit.closest('.tl-clip, .tl-h, .tl-label')) return false;
    const l = state.layers[+(row.dataset.l ?? row.nextElementSibling?.dataset.l)];
    const t = laneTime(e);
    if (!l || t < l.start || t > l.end) return false;
    return addBurst(l, t);
  }
  // a new burst starts at t (button) or is centred on t (double-click), kept inside the blue range
  function addBurst(l, t, fromStart = false) {
    const len = burstLen(l);
    const at = clamp(fromStart ? t : t - len / 2, l.start, Math.max(l.start, l.end - len));
    const c = { at, len };
    l.clips.push(c); sortClips(l); l.auto = false;
    TL.sel = { l, c };
    syncLayer(l, currentTime(), true);
    renderAll();
    return true;
  }
  function seekTo_(t) {
    const total = totalDuration();
    t = clamp(t, 0, total * 0.999);
    setTime(t);
    if (!state.playing) render(t);
    movePlayhead(t);
    updateTime();
  }
  const updateTime = () => { ui.time.textContent = `${fmt(currentTime())} / ${fmt(totalDuration())}`; };
  addEventListener('resize', () => renderTimeline());

  // ---------- export ----------
  function pickMime() {
    const list = [
      'video/mp4;codecs=avc1.640033,mp4a.40.2',
      'video/mp4;codecs=avc1,mp4a.40.2',
      'video/mp4',
      'video/webm;codecs=vp9,opus',
      'video/webm;codecs=vp8,opus',
      'video/webm',
    ];
    return list.find((m) => window.MediaRecorder && MediaRecorder.isTypeSupported(m)) || '';
  }
  const BITRATE = { 144: 0.5e6, 240: 1e6, 360: 2e6, 480: 3.5e6, 720: 8e6, 1080: 16e6, 1440: 28e6, 2160: 50e6 };
  function bitrateFor(w, h) {
    const short = Math.min(w, h);
    const key = Object.keys(BITRATE).map(Number).find((k) => short <= k) || 2160;
    return BITRATE[key];
  }
  function download(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 60000);
  }
  function fileBase() {
    const q = ui.quality.value === '0' ? 'orig' : ui.quality.selectedOptions[0].text;
    return `${state.src.name}_stuppid_${q}`;
  }

  async function startExport() {
    const s = state.src;
    if (!s || state.exporting) return;
    const short = +ui.quality.value;
    if (ui.format.value === 'gif') return exportGif(short);
    // frame-by-frame MP4 is smooth on any device; real-time recording is the fallback
    if (await canEncodeMp4()) return exportMp4(short);
    return recordRealtime(short);
  }

  // ---------- frame-by-frame rendering (shared by MP4 and GIF) ----------
  // lets the page repaint between frames; unlike setTimeout it is not slowed down in background tabs
  const yieldUI = () => new Promise((r) => { const ch = new MessageChannel(); ch.port1.onmessage = () => r(); ch.port2.postMessage(0); });
  function seekTo(v, t) {
    t = Math.max(0, Math.min(t, (v.duration || t) - 0.05));
    if (Math.abs(v.currentTime - t) < 0.001 && v.readyState >= 2) return Promise.resolve();
    return new Promise((ok) => {
      const done = () => { clearTimeout(timer); ok(); };
      const timer = setTimeout(done, 3000);
      v.addEventListener('seeked', done, { once: true });
      v.currentTime = t;
    });
  }
  async function renderAt(t) {
    const s = state.src;
    const waits = [];
    if (s.kind === 'video') waits.push(seekTo(s.el, t));
    for (const l of state.layers) {
      const at = layerAt(l, t);
      if (at && at.local < l.duration - 0.05) waits.push(seekTo(l.video, at.local));
    }
    await Promise.all(waits);
    render(t);
  }
  // runs work(job, w, h) with the canvas at export size and the preview stopped
  async function offlineJob(short, title, work) {
    const s = state.src;
    const job = { offline: true, cancelled: false };
    state.exporting = job;
    ui.busy.hidden = false;
    ui.busyBar.style.width = '0%';
    ui.busyText.textContent = title;
    ui.exportBtn.disabled = true;
    if (s.kind === 'video') s.el.pause();
    state.layers.forEach((l) => l.video?.pause());
    try {
      setCanvasSize(short);
      await work(job, ui.view.width, ui.view.height);
    } catch (e) {
      alert('Could not save the file: ' + e.message);
    } finally {
      state.exporting = null;
      ui.busy.hidden = true;
      ui.exportBtn.disabled = false;
      setCanvasSize(previewShort());
      setTime(0);
      if (s.kind === 'video' && state.playing) s.el.play().catch(() => {});
    }
  }
  function progress(label, i, n) {
    ui.busyBar.style.width = (((i + 1) / n) * 100).toFixed(1) + '%';
    ui.busyText.textContent = `${label}… ${Math.round(((i + 1) / n) * 100)}%`;
  }

  // ---------- MP4: WebCodecs H.264 + AAC ----------
  const AVC = ['avc1.640034', 'avc1.640033', 'avc1.640028', 'avc1.4d0028', 'avc1.42e01f'];
  let mp4mux = null;
  async function pickAvc(w, h) {
    for (const codec of AVC) {
      const cfg = { codec, width: w, height: h, bitrate: bitrateFor(w, h), framerate: FPS, avc: { format: 'avc' } };
      try { if ((await VideoEncoder.isConfigSupported(cfg)).supported) return cfg; } catch { /* try next */ }
    }
    return null;
  }
  async function canEncodeMp4() {
    if (!('VideoEncoder' in window) || !('VideoFrame' in window)) return false;
    try { mp4mux ||= await import('https://cdn.jsdelivr.net/npm/mp4-muxer@5.1.3/+esm'); } catch { return false; }
    const [w, h] = outSize(+ui.quality.value);
    return !!(await pickAvc(w, h));
  }

  // decoded audio of a file or URL, or null when it has none
  const audioCache = new Map();
  function decodeAudio(src) {
    if (!audioCache.has(src)) {
      audioCache.set(src, (async () => {
        try {
          const buf = src instanceof Blob ? await src.arrayBuffer() : await fetch(src).then((r) => r.arrayBuffer());
          const b = await audioCtx().decodeAudioData(buf);
          const d = b.getChannelData(0);
          for (let i = 0; i < d.length; i += 64) if (Math.abs(d[i]) > 1e-4) return b;
        } catch { /* no audio track */ }
        return null;
      })());
    }
    return audioCache.get(src);
  }
  // original sound + the sound of every burst (stretched like its picture) mixed into one track
  async function mixAudio(total, rate) {
    const s = state.src;
    const base = s.kind === 'video' ? await decodeAudio(s.file) : null;
    const fx = await Promise.all(state.layers.map((l) => (l.kind ? null : decodeAudio(l.tpl.url))));
    if (!base && !fx.some(Boolean)) return null;
    const off = new OfflineAudioContext(2, Math.ceil(total * rate), rate);
    if (base) { const n = off.createBufferSource(); n.buffer = base; n.connect(off.destination); n.start(0); }
    state.layers.forEach((l, i) => {
      if (!fx[i]) return;
      for (const c of l.clips) {
        const from = Math.max(c.at, l.start), to = Math.min(c.at + c.len, l.end, total);
        if (to <= from) continue;
        const speed = l.duration / c.len;
        const n = off.createBufferSource(), g = off.createGain();
        n.buffer = fx[i]; n.playbackRate.value = speed; g.gain.value = l.opacity;
        n.connect(g).connect(off.destination);
        n.start(from, (from - c.at) * speed);
        n.stop(to);
      }
    });
    return off.startRendering();
  }
  async function pickAudio(rate) {
    for (const codec of ['mp4a.40.2', 'opus']) {
      const cfg = { codec, sampleRate: rate, numberOfChannels: 2, bitrate: 192000 };
      try { if ('AudioEncoder' in window && (await AudioEncoder.isConfigSupported(cfg)).supported) return cfg; } catch { /* try next */ }
    }
    return null;
  }

  function exportMp4(short) {
    return offlineJob(short, 'Preparing MP4…', async (job, w, h) => {
      const { Muxer, ArrayBufferTarget } = mp4mux;
      const total = totalDuration();
      const RATE = 48000;
      const vcfg = await pickAvc(w, h);
      const [mix, acfg] = await Promise.all([mixAudio(total, RATE), pickAudio(RATE)]);
      if (mix) shakalBuffer(mix);
      const withAudio = mix && acfg;
      const muxer = new Muxer({
        target: new ArrayBufferTarget(),
        video: { codec: 'avc', width: w, height: h, frameRate: FPS },
        ...(withAudio ? { audio: { codec: acfg.codec === 'opus' ? 'opus' : 'aac', numberOfChannels: 2, sampleRate: RATE } } : {}),
        fastStart: 'in-memory',
      });
      let failure = null;
      const venc = new VideoEncoder({ output: (c, m) => muxer.addVideoChunk(c, m), error: (e) => (failure = e) });
      venc.configure(vcfg);

      if (withAudio) {
        const aenc = new AudioEncoder({ output: (c, m) => muxer.addAudioChunk(c, m), error: (e) => (failure = e) });
        aenc.configure(acfg);
        const L = mix.getChannelData(0), R = mix.getChannelData(1), STEP = 4800;
        for (let o = 0; o < L.length; o += STEP) {
          const len = Math.min(STEP, L.length - o), data = new Float32Array(len * 2);
          data.set(L.subarray(o, o + len), 0); data.set(R.subarray(o, o + len), len);
          const ad = new AudioData({ format: 'f32-planar', sampleRate: RATE, numberOfFrames: len, numberOfChannels: 2, timestamp: Math.round((o / RATE) * 1e6), data });
          aenc.encode(ad); ad.close();
        }
        await aenc.flush();
      }

      const n = Math.max(1, Math.round(total * FPS));
      const label = `MP4 ${w}×${h}`;
      for (let i = 0; i < n && !job.cancelled; i++) {
        if (failure) throw failure;
        await renderAt(i / FPS);
        const frame = new VideoFrame(ui.view, { timestamp: Math.round((i / FPS) * 1e6), duration: Math.round(1e6 / FPS) });
        venc.encode(frame, { keyFrame: i % (FPS * 2) === 0 });
        frame.close();
        while (venc.encodeQueueSize > 6) await new Promise((r) => venc.addEventListener('dequeue', r, { once: true }));
        progress(label, i, n);
        if (i % 4 === 0) await yieldUI();
      }
      await venc.flush();
      if (failure) throw failure;
      if (job.cancelled) return;
      muxer.finalize();
      download(new Blob([muxer.target.buffer], { type: 'video/mp4' }), `${fileBase()}.mp4`);
    });
  }

  // ---------- GIF ----------
  const GIF_FPS = 15;
  let gifenc = null;
  function exportGif(short) {
    return offlineJob(short, 'Preparing GIF…', async (job, w, h) => {
      gifenc ||= await import('https://cdn.jsdelivr.net/npm/gifenc@1.0.3/+esm');
      const { GIFEncoder, quantize, applyPalette } = gifenc;
      const grab = document.createElement('canvas');
      grab.width = w; grab.height = h;
      const gx = grab.getContext('2d', { willReadFrequently: true });
      const enc = GIFEncoder();
      const n = Math.max(1, Math.floor(totalDuration() * GIF_FPS));
      for (let i = 0; i < n && !job.cancelled; i++) {
        await renderAt(i / GIF_FPS);
        gx.drawImage(ui.view, 0, 0);
        const rgba = gx.getImageData(0, 0, w, h).data;
        const palette = quantize(rgba, 256);
        enc.writeFrame(applyPalette(rgba, palette), w, h, { palette, delay: 1000 / GIF_FPS });
        progress(`GIF ${w}×${h}`, i, n);
        await yieldUI();
      }
      enc.finish();
      if (!job.cancelled) download(new Blob([enc.bytes()], { type: 'image/gif' }), `${fileBase()}.gif`);
    });
  }

  // ---------- real-time recording (fallback for browsers without WebCodecs) ----------
  async function recordRealtime(short) {
    const s = state.src;
    const mime = pickMime();
    if (!mime) { alert('Your browser cannot record video. Try Chrome, Edge or Firefox.'); return; }
    audioCtx();
    setCanvasSize(short);
    const [w, h] = [ui.view.width, ui.view.height];
    const stream = new MediaStream([
      ...ui.view.captureStream(FPS).getVideoTracks(),
      ...recDest.stream.getAudioTracks(),
    ]);
    const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: bitrateFor(w, h), audioBitsPerSecond: 192000 });
    const chunks = [];
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    const ext = mime.includes('mp4') ? 'mp4' : 'webm';
    const label = `${w}×${h}`;
    state.exporting = { rec, chunks, ext, cancelled: false, label };
    rec.onstop = () => {
      const job = state.exporting;
      state.exporting = null;
      stream.getTracks().forEach((t) => t.kind === 'video' && t.stop());
      ui.busy.hidden = true;
      setCanvasSize(previewShort());
      if (!job.cancelled) download(new Blob(job.chunks, { type: mime.split(';')[0] }), `${fileBase()}.${ext}`);
      setTime(0);
    };

    ui.busy.hidden = false;
    ui.busyBar.style.width = '0%';
    ui.busyText.textContent = `Rendering ${label}…`;
    ui.exportBtn.disabled = true;

    // wait until everything has rewound to the start
    state.playing = false; updatePlayIcon();
    setTime(0);
    const vids = [s.kind === 'video' ? s.el : null, ...state.layers.map((l) => l.video)].filter(Boolean);
    await Promise.all(vids.map((v) => (v.seeking ? new Promise((ok) => v.addEventListener('seeked', ok, { once: true })) : 0)));
    rec.start(500);
    state.playing = true; updatePlayIcon();
    setTime(0);
    if (s.kind === 'video') s.el.play().catch(() => {});
    // a timer (not requestAnimationFrame) keeps recording even if the tab is hidden
    state.exporting.timer = setInterval(step, 1000 / FPS);
    // stop exactly when the video ends, even if timers are slowed down in a background tab
    if (s.kind === 'video') s.el.addEventListener('ended', finishExport, { once: true });
  }
  function finishExport() {
    const job = state.exporting;
    if (!job || job.stopping) return;
    job.stopping = true;
    clearInterval(job.timer);
    render(totalDuration() - 0.001);
    const stop = () => job.rec.state !== 'inactive' && job.rec.stop();
    if (document.hidden) stop(); else setTimeout(stop, 120);   // hidden tabs delay timers
    if (state.src.kind === 'video') state.src.el.pause();
    ui.exportBtn.disabled = false;
  }
  ui.cancelBtn.onclick = () => {
    if (!state.exporting) return;
    state.exporting.cancelled = true;
    if (!state.exporting.offline) finishExport();
  };

  // ---------- controls ----------
  function updatePlayIcon() {
    ui.icPlay.toggleAttribute('hidden', state.playing);
    ui.icPause.toggleAttribute('hidden', !state.playing);
    ui.playBtn.setAttribute('aria-label', state.playing ? 'Pause' : 'Play');
  }
  function togglePlay() {
    if (!state.src || state.exporting) return;
    audioCtx();
    const t = currentTime();
    state.playing = !state.playing;
    updatePlayIcon();
    if (state.playing) {
      setTime(t);
      if (state.src.kind === 'video') state.src.el.play().catch(() => {});
    } else {
      state.pausedAt = t;
      if (state.src.kind === 'video') state.src.el.pause();
      state.layers.forEach((l) => l.video?.pause());
    }
  }

  ui.playBtn.onclick = togglePlay;
  ui.view.onclick = togglePlay;

  const pick = () => { audioCtx(); ui.fileInput.click(); };
  ui.attachBtn.onclick = pick;
  ui.emptyBtn.onclick = pick;
  ui.fileInput.onchange = () => { loadSource(ui.fileInput.files[0]); ui.fileInput.value = ''; };
  ui.tplInput.onchange = () => { if (ui.tplInput.files[0]) addCustomTemplate(ui.tplInput.files[0]); ui.tplInput.value = ''; };
  ui.quality.onchange = () => { if (state.src && !state.exporting) { setCanvasSize(previewShort()); updateMeta(); } };
  ui.exportBtn.onclick = startExport;
  ui.clearBtn.onclick = () => [...state.layers].forEach(removeLayer);

  // drag & drop
  let dragDepth = 0;
  window.addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; ui.dropHint.hidden = false; ui.stage.classList.add('drag'); });
  window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; ui.dropHint.hidden = true; ui.stage.classList.remove('drag'); } });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => {
    e.preventDefault(); dragDepth = 0; ui.dropHint.hidden = true; ui.stage.classList.remove('drag');
    const f = e.dataTransfer.files[0];
    if (f) { audioCtx(); loadSource(f); }
  });
  // Ctrl+V: paste a copied file or a screenshot straight from the clipboard
  window.addEventListener('paste', (e) => {
    const item = [...(e.clipboardData?.items || [])].find((it) => it.kind === 'file' && /^(image|video)\//.test(it.type));
    const file = item?.getAsFile();
    if (!file) return;
    e.preventDefault();
    const ext = file.type.split('/')[1].replace('jpeg', 'jpg').replace('quicktime', 'mov');
    const named = file.name && file.name !== 'image.png' ? file : new File([file], `pasted.${ext}`, { type: file.type });
    audioCtx();
    loadSource(named);
  });
  window.addEventListener('keydown', (e) => {
    if (/INPUT|SELECT|TEXTAREA/.test(e.target.tagName)) return;
    if (e.code === 'Space' && e.target.tagName !== 'BUTTON') { e.preventDefault(); togglePlay(); }
    if ((e.key === 'Delete' || e.key === 'Backspace') && TL.sel) {
      e.preventDefault();
      const { l, c } = TL.sel;
      l.clips = l.clips.filter((x) => x !== c); l.auto = false; TL.sel = null;
      syncLayer(l, currentTime(), true);
      renderAll();
    }
  });

  // ---------- stars ----------
  (function stars() {
    const c = $('stars'), x = c.getContext('2d');
    let pts = [];
    const resize = () => {
      const dpr = Math.min(2, devicePixelRatio || 1);
      c.width = innerWidth * dpr; c.height = innerHeight * dpr;
      x.setTransform(dpr, 0, 0, dpr, 0, 0);
      const n = Math.round((innerWidth * innerHeight) / 5500);
      pts = Array.from({ length: n }, () => ({
        x: Math.random() * innerWidth, y: Math.random() * innerHeight,
        r: Math.random() * 1.1 + 0.2, p: Math.random() * 6.28, s: 0.4 + Math.random() * 1.4,
      }));
    };
    resize(); addEventListener('resize', resize);
    let last = 0;
    const loop = (ts) => {
      requestAnimationFrame(loop);
      if (ts - last < 50) return;          // ~20 fps is plenty for stars
      last = ts;
      x.clearRect(0, 0, innerWidth, innerHeight);
      for (const p of pts) {
        x.globalAlpha = 0.25 + 0.6 * (0.5 + 0.5 * Math.sin(p.p + ts / 1000 * p.s));
        x.fillStyle = '#fff';
        x.beginPath(); x.arc(p.x, p.y, p.r, 0, 6.283); x.fill();
      }
    };
    requestAnimationFrame(loop);
  })();

  renderTemplates();
  renderLayers();
  requestAnimationFrame(tick);
})();
