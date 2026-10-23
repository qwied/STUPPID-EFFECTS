/* STUPPID EFECTS — everything renders in the browser (WebGL + WebCodecs). */
(() => {
  'use strict';

  // ---------- templates ----------
  // bg: the template background that is always removed — 'green' (green screen), 'black' or 'none'
  // mode: how the effect is blended over the media — 'normal', 'screen' or 'add'
  const TEMPLATES = [
    { id: 'explosion', name: 'Explosion', url: 'explosion.mp4', bg: 'green', mode: 'normal' },
    { id: 'lightning', name: 'Lightning', url: 'lightning.mp4', bg: 'black', mode: 'screen' },
  ];
  const REPEATS = [0, 1, 2, 3, 5, 10];   // 0 = endless loop
  const MODES = { normal: 'Normal', screen: 'Screen', add: 'Add (glow)' };
  const PREVIEW_MAX = 720;      // preview short side
  const IMAGE_SECONDS = 3;      // clip length for a photo without effects
  const FPS = 30;

  const $ = (id) => document.getElementById(id);
  const ui = {
    stage: $('stage'), view: $('view'), emptyBtn: $('emptyBtn'), dropHint: $('dropHint'),
    busy: $('busy'), busyText: $('busyText'), busyBar: $('busyBar'), cancelBtn: $('cancelBtn'),
    transport: $('transport'), playBtn: $('playBtn'), icPlay: $('icPlay'), icPause: $('icPause'),
    seek: $('seek'), seekFill: $('seekFill'), time: $('time'), meta: $('meta'),
    attachBtn: $('attachBtn'), quality: $('quality'), format: $('format'), exportBtn: $('exportBtn'),
    templates: $('templates'), layers: $('layers'), layerCount: $('layerCount'),
    noLayers: $('noLayers'), clearBtn: $('clearBtn'), fileInput: $('fileInput'), tplInput: $('tplInput'),
  };

  const state = {
    src: null,          // { kind: 'video'|'image'|'gif', el, w, h, duration, frames, name }
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
  function shader(type, src) {
    const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  }
  const prog = gl.createProgram();
  gl.attachShader(prog, shader(gl.VERTEX_SHADER, VS));
  gl.attachShader(prog, shader(gl.FRAGMENT_SHADER, FS));
  gl.linkProgram(prog); gl.useProgram(prog);
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
    gl.bindTexture(gl.TEXTURE_2D, tex);
    try { gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source); } catch { return; }
    if (mode === 'screen') gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_COLOR);
    else if (mode === 'add') gl.blendFunc(gl.ONE, gl.ONE);
    else gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.uniform1i(uK, BG[bg] || 0); gl.uniform1f(uO, opacity); gl.uniform2f(uS, sx, sy);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  // ---------- time ----------
  // one pass of an effect lasts duration / speed; repeat 0 means endless
  const cycle = (l) => l.duration / l.speed;
  // endless effects get whole passes (at least IMAGE_SECONDS long) so a photo clip loops seamlessly
  const passes = (l) => l.repeat || Math.max(1, Math.ceil((IMAGE_SECONDS - l.start) / cycle(l) - 1e-6));
  const fxEnd = () => state.layers.reduce((e, l) => Math.max(e, l.start + cycle(l) * passes(l)), 0);
  function totalDuration() {
    const s = state.src;
    if (!s) return 0;
    if (s.kind === 'video') return s.duration;
    if (s.kind === 'gif') return Math.max(s.duration, fxEnd());
    return state.layers.length ? fxEnd() : IMAGE_SECONDS;
  }
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
    for (const l of state.layers) syncLayer(l, t, true);
  }

  // keep <video> in sync with the shared clock
  function syncVideo(v, local, active, playing, force, rate = 1) {
    if (!active) {
      if (!v.paused) v.pause();
      if (local < 0 && v.currentTime > 0.01) v.currentTime = 0;
      return;
    }
    // re-seek only when clearly off and not already seeking — avoids endless seeking at high speed
    if (force || (!v.seeking && Math.abs(v.currentTime - local) > 0.25 * Math.max(1, rate))) v.currentTime = local;
    if (playing && v.paused) v.play().catch(() => {});
    if (!playing && !v.paused) v.pause();
  }
  // position inside the effect video (its own seconds): negative before start, Infinity after the last repeat
  function layerLocal(l, t) {
    const rel = t - l.start;
    if (rel < 0) return rel;
    if (l.repeat && rel >= cycle(l) * l.repeat) return Infinity;
    return (rel % cycle(l)) * l.speed;
  }
  function syncLayer(l, t, force) {
    const local = layerLocal(l, t);
    if (l.video.playbackRate !== l.speed) l.video.playbackRate = l.speed;
    syncVideo(l.video, local, local >= 0 && local < l.duration, state.playing, force, l.speed);
  }

  // ---------- frame ----------
  function render(t) {
    const s = state.src;
    const W = ui.view.width, H = ui.view.height;
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
      const local = layerLocal(l, t);
      if (local < 0 || local >= l.duration || l.video.readyState < 2) continue;
      // auto fit: the effect keeps its proportions and is stretched to cover the whole frame
      const fa = l.video.videoWidth / l.video.videoHeight;
      let sx = 1, sy = 1;
      if (fa > outA) sx = fa / outA; else sy = outA / fa;
      drawQuad(l.tex, l.video, l.tpl.bg, l.mode, l.opacity, sx * l.scale, sy * l.scale);
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
    render(t);

    ui.seekFill.style.width = (total ? Math.min(100, (t / total) * 100) : 0) + '%';
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
        src = { kind: 'image', el: img, w: img.naturalWidth, h: img.naturalHeight, duration: IMAGE_SECONDS };
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

    ui.emptyBtn.hidden = true;
    ui.view.hidden = false;
    ui.transport.hidden = false;
    ui.exportBtn.disabled = false;
    setCanvasSize(previewShort());
    updateMeta();
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
  let ac = null, recDest = null;
  function audioCtx() {
    if (!ac) {
      ac = new (window.AudioContext || window.webkitAudioContext)();
      recDest = ac.createMediaStreamDestination();
    }
    if (ac.state === 'suspended') ac.resume();
    return ac;
  }
  function routeAudio(el) {
    if (el._routed) return;
    try {
      const ctx = audioCtx();
      const node = ctx.createMediaElementSource(el);
      node.connect(ctx.destination);
      node.connect(recDest);
      el._routed = true;
    } catch { /* no audio */ }
  }

  // ---------- templates / layers ----------
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
      // mid-clip frame used as the layer thumbnail
      if (!tpl.poster && v.currentTime > v.duration * 0.35) {
        tpl.poster = document.createElement('canvas');
        tpl.poster.width = cw; tpl.poster.height = ch;
        tpl.poster.getContext('2d').drawImage(c, 0, 0);
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
  function renderTemplates() {
    ui.templates.innerHTML = '';
    TEMPLATES.forEach((t) => ui.templates.append(tplTile(t)));
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

  function addLayer(tpl, thumbCanvas) {
    const v = document.createElement('video');
    v.src = tpl.url; v.playsInline = true; v.preload = 'auto'; v.crossOrigin = 'anonymous';
    const l = {
      id: ++layerSeq, tpl, video: v, tex: makeTex(), mode: tpl.mode,
      start: 0, opacity: 1, scale: 1, speed: 1, repeat: 0, duration: 1, thumb: null,
    };
    if (thumbCanvas) {
      l.thumb = document.createElement('canvas');
      l.thumb.width = 108; l.thumb.height = 72;
      l.thumb.getContext('2d').drawImage(thumbCanvas, 0, 0, 108, 72);
    }
    v.addEventListener('loadedmetadata', () => { l.duration = v.duration || 1; renderLayers(); });
    v.addEventListener('loadeddata', () => routeAudio(v), { once: true });
    state.layers.push(l);
    renderLayers();
  }
  function removeLayer(l) {
    l.video.pause(); l.video.removeAttribute('src'); l.video.load();
    gl.deleteTexture(l.tex);
    state.layers = state.layers.filter((x) => x !== l);
    renderLayers();
  }

  const ICON = {
    up: '<svg viewBox="0 0 24 24"><path d="M18 15l-6-6-6 6"/></svg>',
    down: '<svg viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg>',
    del: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  };
  function renderLayers() {
    ui.layers.innerHTML = '';
    ui.layerCount.textContent = state.layers.length;
    ui.noLayers.hidden = state.layers.length > 0;
    ui.clearBtn.hidden = state.layers.length === 0;
    const maxStart = Math.max(10, Math.ceil(state.src ? totalDuration() : 10));

    state.layers.forEach((l, i) => {
      const li = document.createElement('li');
      li.className = 'layer';
      li.innerHTML = `
        <span class="idx">${i + 1}</span>
        <span class="thumb"></span>
        <span class="lname"></span>
        <label class="field"><span>Start <b data-o="start"></b></span><input type="range" data-k="start" min="0" max="${maxStart}" step="0.1"></label>
        <label class="field"><span>Opacity <b data-o="opacity"></b></span><input type="range" data-k="opacity" min="0" max="1" step="0.01"></label>
        <label class="field"><span>Size <b data-o="scale"></b></span><input type="range" data-k="scale" min="0.3" max="2.5" step="0.05"></label>
        <label class="field"><span>Speed <b data-o="speed"></b></span><input type="range" data-k="speed" min="0.25" max="3" step="0.05"></label>
        <label class="field"><span>Mode</span><select data-k="mode">${Object.entries(MODES).map(([k, n]) => `<option value="${k}">${n}</option>`).join('')}</select></label>
        <label class="field"><span>Repeat</span><select data-k="repeat">${REPEATS.map((n) => `<option value="${n}">${n ? n + '×' : '∞ Loop'}</option>`).join('')}</select></label>
        <span class="actions">
          <button class="mini" data-a="up" title="Move up" ${i === 0 ? 'disabled' : ''}>${ICON.up}</button>
          <button class="mini" data-a="down" title="Move down" ${i === state.layers.length - 1 ? 'disabled' : ''}>${ICON.down}</button>
          <button class="mini" data-a="del" title="Remove">${ICON.del}</button>
        </span>`;
      li.querySelector('.lname').textContent = l.tpl.name;
      if (l.thumb) li.querySelector('.thumb').append(l.thumb);
      const out = () => {
        li.querySelector('[data-o=start]').textContent = l.start.toFixed(1) + 's';
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
          if (k === 'start' || k === 'speed' || k === 'repeat') syncLayer(l, currentTime(), true);
        });
      });
      li.querySelectorAll('[data-k=start], [data-k=speed], [data-k=repeat]').forEach((el) => el.addEventListener('change', updateTimeline));
      li.querySelector('.actions').addEventListener('click', (e) => {
        const a = e.target.closest('[data-a]')?.dataset.a;
        if (!a) return;
        if (a === 'del') return removeLayer(l);
        const j = a === 'up' ? i - 1 : i + 1;
        [state.layers[i], state.layers[j]] = [state.layers[j], state.layers[i]];
        renderLayers();
      });
      out();
      ui.layers.append(li);
    });
  }
  function updateTimeline() {
    // clip length may have changed — update the Start slider range
    const max = Math.max(10, Math.ceil(totalDuration()));
    ui.layers.querySelectorAll('[data-k=start]').forEach((r) => (r.max = max));
  }

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
      const local = layerLocal(l, t);
      if (local >= 0 && local < l.duration - 0.05) waits.push(seekTo(l.video, local));
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
    state.layers.forEach((l) => l.video.pause());
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
  // original sound + effect sounds (with their start, speed, repeats, opacity) mixed into one track
  async function mixAudio(total, rate) {
    const s = state.src;
    const base = s.kind === 'video' ? await decodeAudio(s.file) : null;
    const fx = await Promise.all(state.layers.map((l) => decodeAudio(l.tpl.url)));
    if (!base && !fx.some(Boolean)) return null;
    const off = new OfflineAudioContext(2, Math.ceil(total * rate), rate);
    if (base) { const n = off.createBufferSource(); n.buffer = base; n.connect(off.destination); n.start(0); }
    state.layers.forEach((l, i) => {
      if (!fx[i]) return;
      for (let k = 0; !l.repeat || k < l.repeat; k++) {
        const at = l.start + k * cycle(l);
        if (at >= total) break;
        const n = off.createBufferSource(), g = off.createGain();
        n.buffer = fx[i]; n.playbackRate.value = l.speed; g.gain.value = l.opacity;
        n.connect(g).connect(off.destination);
        n.start(at);
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
      state.layers.forEach((l) => l.video.pause());
    }
  }

  ui.playBtn.onclick = togglePlay;
  ui.view.onclick = togglePlay;
  ui.seek.addEventListener('pointerdown', (e) => {
    if (!state.src || state.exporting) return;
    const go = (ev) => {
      const r = ui.seek.getBoundingClientRect();
      setTime(Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width)) * totalDuration() * 0.999);
    };
    go(e);
    ui.seek.setPointerCapture(e.pointerId);
    ui.seek.onpointermove = go;
    ui.seek.onpointerup = () => (ui.seek.onpointermove = null);
  });

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
    if (e.code === 'Space' && !/INPUT|SELECT|BUTTON/.test(e.target.tagName)) { e.preventDefault(); togglePlay(); }
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
