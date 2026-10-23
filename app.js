/* STUPPID EFECTS — всё рендерится в браузере (WebGL + MediaRecorder). */
(() => {
  'use strict';

  // ---------- шаблоны ----------
  // mode: 'key' — зелёный хромакей, 'screen' — светлое на чёрном, 'normal' — просто поверх
  const TEMPLATES = [
    { id: 'explosion', name: 'Взрыв', url: 'templates/explosion.mp4', mode: 'key' },
    { id: 'lightning', name: 'Молнии', url: 'templates/lightning.mp4', mode: 'screen' },
  ];
  const MODES = { normal: 'Обычный', key: 'Хромакей', screen: 'Экран' };
  const PREVIEW_MAX = 720;      // короткая сторона превью
  const IMAGE_SECONDS = 3;      // длина ролика из фото без эффектов
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
    t0: 0,              // performance.now() в момент t=0
    pausedAt: 0,
    exporting: null,
  };
  let layerSeq = 0;

  // ---------- WebGL рендерер ----------
  const gl = ui.view.getContext('webgl', { alpha: false, premultipliedAlpha: true, preserveDrawingBuffer: true, antialias: false });
  if (!gl) alert('Браузер не поддерживает WebGL — эффекты работать не будут.');

  const VS = `attribute vec2 p; uniform vec2 s; varying vec2 uv;
    void main(){ uv = p*0.5+0.5; gl_Position = vec4(p*s, 0.0, 1.0); }`;
  const FS = `precision mediump float; varying vec2 uv; uniform sampler2D t; uniform int m; uniform float o;
    void main(){
      vec4 c = texture2D(t, uv);
      if (m == 1) {                                   // хромакей
        float mx = max(c.r, c.b);
        float k = c.g - mx;
        float a = 1.0 - smoothstep(0.04, 0.16, k);
        c.g = min(c.g, mx + 0.03);                    // убираем зелёный ореол
        a *= o;
        gl_FragColor = vec4(c.rgb * a, a);
      } else if (m == 2) {                            // экран
        gl_FragColor = vec4(c.rgb * o, 1.0);
      } else {
        gl_FragColor = vec4(c.rgb * o, o);
      }
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
  const uS = gl.getUniformLocation(prog, 's'), uM = gl.getUniformLocation(prog, 'm'), uO = gl.getUniformLocation(prog, 'o');
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

  function drawQuad(tex, source, mode, opacity, sx, sy) {
    gl.bindTexture(gl.TEXTURE_2D, tex);
    try { gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source); } catch { return; }
    const m = mode === 'key' ? 1 : mode === 'screen' ? 2 : 0;
    if (m === 2) gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_COLOR);
    else gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.uniform1i(uM, m); gl.uniform1f(uO, opacity); gl.uniform2f(uS, sx, sy);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  // ---------- время ----------
  const fxEnd = () => state.layers.reduce((e, l) => Math.max(e, l.loop ? 0 : l.start + l.duration), 0);
  function totalDuration() {
    const s = state.src;
    if (!s) return 0;
    if (s.kind === 'video') return s.duration;
    if (s.kind === 'gif') return Math.max(s.duration, fxEnd());
    return Math.max(fxEnd(), state.layers.length ? 0 : IMAGE_SECONDS) || IMAGE_SECONDS;
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

  // держим <video> синхронно с общим временем
  function syncVideo(v, local, active, playing, force) {
    if (!active) {
      if (!v.paused) v.pause();
      if (local < 0 && v.currentTime > 0.01) v.currentTime = 0;
      return;
    }
    if (force || Math.abs(v.currentTime - local) > 0.25) v.currentTime = local;
    if (playing && v.paused) v.play().catch(() => {});
    if (!playing && !v.paused) v.pause();
  }
  function layerLocal(l, t) {
    let local = t - l.start;
    if (l.loop && local >= 0) local %= l.duration;
    return local;
  }
  function syncLayer(l, t, force) {
    const local = layerLocal(l, t);
    syncVideo(l.video, local, local >= 0 && local < l.duration, state.playing, force);
  }

  // ---------- кадр ----------
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
    if (s.kind !== 'video' || s.el.readyState >= 2) drawQuad(baseTex, frame, 'normal', 1, 1, 1);

    const outA = W / H;
    for (const l of state.layers) {
      const local = layerLocal(l, t);
      if (local < 0 || local >= l.duration || l.video.readyState < 2) continue;
      const fa = l.video.videoWidth / l.video.videoHeight;
      let sx = 1, sy = 1;                       // cover
      if (fa > outA) sx = fa / outA; else sy = outA / fa;
      drawQuad(l.tex, l.video, l.mode, l.opacity, sx * l.scale, sy * l.scale);
    }
  }

  function tick() {
    requestAnimationFrame(tick);
    const s = state.src;
    if (!s) return;
    const total = totalDuration();
    let t = currentTime();

    if (s.kind === 'video' && state.playing) {
      // видео — главный источник времени (так звук не прыгает)
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
      ui.busyText.textContent = `Рендер ${state.exporting.label}… ${Math.round(p * 100)}%`;
    }
  }
  const fmt = (x) => { x = Math.max(0, x); const m = Math.floor(x / 60), s = Math.floor(x % 60); return `${m}:${String(s).padStart(2, '0')}`; };

  // ---------- размеры ----------
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
    // холст сам становится горизонтальным / вертикальным / квадратным под файл
    ui.stage.style.aspectRatio = `${w} / ${h}`;
    ui.stage.style.width = `min(100%, 960px, calc(72vh * ${(w / h).toFixed(4)}))`;
  }
  function orientation() {
    const { w, h } = state.src;
    return w > h ? 'горизонталь' : w < h ? 'вертикаль' : 'квадрат';
  }
  function previewShort() {
    const q = +ui.quality.value || Math.min(state.src.w, state.src.h);
    return Math.min(q, PREVIEW_MAX);
  }
  function updateMeta() {
    if (!state.src) return;
    const [w, h] = outSize(+ui.quality.value);
    const kind = { video: 'видео', image: 'фото', gif: 'GIF' }[state.src.kind];
    ui.meta.textContent = `${kind} · ${orientation()} · ${state.src.w}×${state.src.h} → ${w}×${h}`;
  }

  // ---------- загрузка медиа ----------
  async function loadSource(file) {
    if (!file || state.exporting) return;
    const url = URL.createObjectURL(file);
    let src;
    try {
      if (file.type.startsWith('video/') || /\.(mp4|webm|mov|mkv|m4v|ogv)$/i.test(file.name)) {
        const v = document.createElement('video');
        v.src = url; v.playsInline = true; v.preload = 'auto'; v.crossOrigin = 'anonymous';
        await new Promise((ok, fail) => { v.onloadeddata = ok; v.onerror = () => fail(new Error('видео не читается')); });
        if (!isFinite(v.duration)) {
          // у WebM из записей экрана длина неизвестна — перематываем в конец, чтобы браузер её посчитал
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
      alert('Не получилось открыть файл: ' + e.message);
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

  // ---------- звук ----------
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
    } catch { /* без звука */ }
  }

  // ---------- шаблоны / слои ----------
  function tplTile(tpl) {
    const b = document.createElement('button');
    b.className = 'tpl';
    b.title = `Добавить «${tpl.name}»`;
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
      if (tpl.mode === 'key') {
        const d = x.getImageData(0, 0, cw, ch), p = d.data;
        for (let i = 0; i < p.length; i += 4) {
          const mx = Math.max(p[i], p[i + 2]), k = p[i + 1] - mx;
          if (k > 10) { const a = Math.max(0, 1 - (k - 10) / 30); p[i] *= a; p[i + 1] = Math.min(p[i + 1], mx) * a; p[i + 2] *= a; p[i] += 11 * (1 - a); p[i + 1] += 11 * (1 - a); p[i + 2] += 11 * (1 - a); }
        }
        x.putImageData(d, 0, 0);
      }
      // кадр из середины ролика — превью для слоя
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
    add.innerHTML = `<div><svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>Свой шаблон</div>`;
    add.title = 'Загрузить свой видео-шаблон (хромакей или на чёрном фоне)';
    add.onclick = () => ui.tplInput.click();
    ui.templates.append(add);
  }

  async function addCustomTemplate(file) {
    const url = URL.createObjectURL(file);
    const mode = await guessMode(url);
    const tpl = { id: 'custom' + Date.now(), name: file.name.replace(/\.[^.]+$/, '').slice(0, 24), url, mode };
    TEMPLATES.push(tpl);
    renderTemplates();
  }
  // угадываем режим по углам кадра: зелёный → хромакей, тёмный → экран
  async function guessMode(url) {
    const v = document.createElement('video');
    v.src = url; v.muted = true;
    try {
      await new Promise((ok, fail) => { v.onloadeddata = ok; v.onerror = fail; });
      v.currentTime = Math.min(0.1, v.duration / 2);
      await new Promise((ok) => (v.onseeked = ok));
      const c = document.createElement('canvas'); c.width = 32; c.height = 32;
      const x = c.getContext('2d'); x.drawImage(v, 0, 0, 32, 32);
      const px = [[0, 0], [31, 0], [0, 31], [31, 31]].map(([a, b]) => x.getImageData(a, b, 1, 1).data);
      if (px.filter((p) => p[1] > 90 && p[1] - Math.max(p[0], p[2]) > 50).length >= 2) return 'key';
      if (px.filter((p) => p[0] + p[1] + p[2] < 60).length >= 2) return 'screen';
    } catch { /* ignore */ }
    return 'normal';
  }

  function addLayer(tpl, thumbCanvas) {
    const v = document.createElement('video');
    v.src = tpl.url; v.playsInline = true; v.preload = 'auto'; v.crossOrigin = 'anonymous';
    const l = {
      id: ++layerSeq, tpl, video: v, tex: makeTex(), mode: tpl.mode,
      start: 0, opacity: 1, scale: 1, loop: false, duration: 1, thumb: null,
    };
    // новый слой стартует с текущей позиции — удобно складывать эффекты друг за другом
    if (state.src) l.start = Math.round(Math.min(currentTime(), Math.max(0, totalDuration() - 0.5)) * 10) / 10;
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
    loop: '<svg viewBox="0 0 24 24"><path d="M17 2l4 4-4 4"/><path d="M3 11V9a3 3 0 0 1 3-3h15M7 22l-4-4 4-4"/><path d="M21 13v2a3 3 0 0 1-3 3H3"/></svg>',
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
        <label class="field"><span>Старт <b data-o="start"></b></span><input type="range" data-k="start" min="0" max="${maxStart}" step="0.1"></label>
        <label class="field"><span>Прозрачность <b data-o="opacity"></b></span><input type="range" data-k="opacity" min="0" max="1" step="0.01"></label>
        <label class="field"><span>Размер <b data-o="scale"></b></span><input type="range" data-k="scale" min="0.3" max="2.5" step="0.05"></label>
        <label class="field"><span>Режим</span><select data-k="mode">${Object.entries(MODES).map(([k, n]) => `<option value="${k}">${n}</option>`).join('')}</select></label>
        <span class="actions">
          <button class="mini${l.loop ? ' on' : ''}" data-a="loop" title="Повторять весь ролик">${ICON.loop}</button>
          <button class="mini" data-a="up" title="Выше" ${i === 0 ? 'disabled' : ''}>${ICON.up}</button>
          <button class="mini" data-a="down" title="Ниже" ${i === state.layers.length - 1 ? 'disabled' : ''}>${ICON.down}</button>
          <button class="mini" data-a="del" title="Удалить">${ICON.del}</button>
        </span>`;
      li.querySelector('.lname').textContent = l.tpl.name;
      if (l.thumb) li.querySelector('.thumb').append(l.thumb);
      const out = () => {
        li.querySelector('[data-o=start]').textContent = l.start.toFixed(1) + 'с';
        li.querySelector('[data-o=opacity]').textContent = Math.round(l.opacity * 100) + '%';
        li.querySelector('[data-o=scale]').textContent = Math.round(l.scale * 100) + '%';
      };
      li.querySelectorAll('[data-k]').forEach((inp) => {
        inp.value = l[inp.dataset.k];
        inp.addEventListener('input', () => {
          const k = inp.dataset.k;
          l[k] = k === 'mode' ? inp.value : +inp.value;
          out();
          if (k === 'start') syncLayer(l, currentTime(), true);
        });
      });
      li.querySelector('[data-k=start]').addEventListener('change', () => updateTimeline());
      li.querySelector('.actions').addEventListener('click', (e) => {
        const a = e.target.closest('[data-a]')?.dataset.a;
        if (!a) return;
        if (a === 'del') return removeLayer(l);
        if (a === 'loop') { l.loop = !l.loop; return renderLayers(); }
        const j = a === 'up' ? i - 1 : i + 1;
        [state.layers[i], state.layers[j]] = [state.layers[j], state.layers[i]];
        renderLayers();
      });
      out();
      ui.layers.append(li);
    });
  }
  function updateTimeline() {
    // длина ролика могла измениться — подтягиваем шкалу «Старт»
    const max = Math.max(10, Math.ceil(totalDuration()));
    ui.layers.querySelectorAll('[data-k=start]').forEach((r) => (r.max = max));
  }

  // ---------- экспорт ----------
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

    const format = ui.format.value;
    if (format === 'mp3') return exportMp3();
    // PNG — текущий кадр в выбранном качестве
    if (format === 'png') {
      setCanvasSize(short);
      render(currentTime());
      ui.view.toBlob((b) => { download(b, fileBase() + '.png'); setCanvasSize(previewShort()); }, 'image/png');
      return;
    }

    const mime = pickMime();
    if (!mime) { alert('Браузер не умеет записывать видео. Попробуй Chrome, Edge или Firefox.'); return; }
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
    ui.busyText.textContent = `Рендер ${label}…`;
    ui.exportBtn.disabled = true;

    // ждём, пока всё перемотается в начало
    state.playing = false; updatePlayIcon();
    setTime(0);
    const vids = [s.kind === 'video' ? s.el : null, ...state.layers.map((l) => l.video)].filter(Boolean);
    await Promise.all(vids.map((v) => (v.seeking ? new Promise((ok) => v.addEventListener('seeked', ok, { once: true })) : 0)));
    rec.start(500);
    state.playing = true; updatePlayIcon();
    setTime(0);
    if (s.kind === 'video') s.el.play().catch(() => {});
  }
  function finishExport() {
    const job = state.exporting;
    if (!job || job.stopping) return;
    job.stopping = true;
    render(totalDuration() - 0.001);
    setTimeout(() => job.rec.state !== 'inactive' && job.rec.stop(), 120);
    if (state.src.kind === 'video') state.src.el.pause();
    ui.exportBtn.disabled = false;
  }

  // ---------- MP3: звук файла + звук эффектов, без записи в реальном времени ----------
  let lamePromise = null;
  function loadLame() {
    lamePromise ||= new Promise((ok, fail) => {
      const sc = document.createElement('script');
      sc.src = 'https://cdnjs.cloudflare.com/ajax/libs/lamejs/1.2.1/lame.min.js';
      sc.onload = ok;
      sc.onerror = () => { lamePromise = null; fail(new Error('не загрузился MP3-кодировщик')); };
      document.head.append(sc);
    });
    return lamePromise;
  }
  async function decodeAudio(blobOrUrl) {
    try {
      const buf = blobOrUrl instanceof Blob ? await blobOrUrl.arrayBuffer() : await fetch(blobOrUrl).then((r) => r.arrayBuffer());
      return await audioCtx().decodeAudioData(buf);
    } catch { return null; }
  }
  const hasSound = (b) => {
    if (!b) return false;
    const d = b.getChannelData(0);
    for (let i = 0; i < d.length; i += 64) if (Math.abs(d[i]) > 1e-4) return true;
    return false;
  };
  async function exportMp3() {
    const s = state.src;
    const RATE = 44100;
    const dur = totalDuration();
    ui.busy.hidden = false;
    ui.busyBar.style.width = '10%';
    ui.busyText.textContent = 'Собираю звук…';
    try {
      const [, base, ...fx] = await Promise.all([
        loadLame(),
        s.kind === 'video' ? decodeAudio(s.file) : null,
        ...state.layers.map((l) => decodeAudio(l.tpl.url)),
      ]);
      const parts = [];
      if (hasSound(base)) parts.push({ buf: base, at: 0, gain: 1, loop: false });
      state.layers.forEach((l, i) => hasSound(fx[i]) && parts.push({ buf: fx[i], at: l.start, gain: l.opacity, loop: l.loop }));
      if (!parts.length) throw new Error('в файле и эффектах нет звука');

      const off = new OfflineAudioContext(2, Math.ceil(dur * RATE), RATE);
      for (const p of parts) {
        for (let at = p.at; at < dur; at += p.buf.duration) {
          const n = off.createBufferSource();
          const g = off.createGain();
          n.buffer = p.buf; g.gain.value = p.gain;
          n.connect(g).connect(off.destination);
          n.start(at);
          if (!p.loop) break;
        }
      }
      ui.busyBar.style.width = '40%';
      const mix = await off.startRendering();

      ui.busyText.textContent = 'Кодирую MP3…';
      const enc = new lamejs.Mp3Encoder(2, RATE, 192);
      const toI16 = (f) => { const o = new Int16Array(f.length); for (let i = 0; i < f.length; i++) o[i] = Math.max(-1, Math.min(1, f[i])) * 0x7fff; return o; };
      const L = toI16(mix.getChannelData(0)), R = toI16(mix.getChannelData(1));
      const out = [];
      const STEP = 1152 * 40;
      for (let i = 0; i < L.length; i += STEP) {
        const chunk = enc.encodeBuffer(L.subarray(i, i + STEP), R.subarray(i, i + STEP));
        if (chunk.length) out.push(new Uint8Array(chunk));
        if ((i / STEP) % 20 === 0) {
          ui.busyBar.style.width = (40 + (i / L.length) * 60).toFixed(1) + '%';
          await new Promise((r) => setTimeout(r));
        }
      }
      out.push(new Uint8Array(enc.flush()));
      download(new Blob(out, { type: 'audio/mpeg' }), `${s.name}_stuppid.mp3`);
    } catch (e) {
      alert('Не получилось сохранить MP3: ' + e.message);
    } finally {
      ui.busy.hidden = true;
    }
  }

  ui.cancelBtn.onclick = () => {
    if (!state.exporting) return;
    state.exporting.cancelled = true;
    finishExport();
  };

  // ---------- управление ----------
  function updatePlayIcon() {
    ui.icPlay.toggleAttribute('hidden', state.playing);
    ui.icPause.toggleAttribute('hidden', !state.playing);
    ui.playBtn.setAttribute('aria-label', state.playing ? 'Пауза' : 'Играть');
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
  ui.format.onchange = () => (ui.quality.disabled = ui.format.value === 'mp3');
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
  window.addEventListener('keydown', (e) => {
    if (e.code === 'Space' && !/INPUT|SELECT|BUTTON/.test(e.target.tagName)) { e.preventDefault(); togglePlay(); }
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && state.exporting) ui.busyText.textContent = 'Не сворачивай вкладку — запись идёт в реальном времени';
  });

  // ---------- звёзды ----------
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
      if (ts - last < 50) return;          // ~20 к/с — звёздам хватит
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
