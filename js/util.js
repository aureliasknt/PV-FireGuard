'use strict';
/* 通用工具：随机数、调色板、风险分级、Canvas 图表 */
const U = (() => {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
  const rand = (a, b) => a + Math.random() * (b - a);
  const randi = (a, b) => Math.floor(rand(a, b + 1));
  const pick = arr => arr[Math.floor(Math.random() * arr.length)];
  const fmt = (x, d = 1) => (x == null || !isFinite(x)) ? '—' : Number(x).toFixed(d);
  let spare = null;
  function randn() {
    if (spare !== null) { const s = spare; spare = null; return s; }
    let u, v, s;
    do { u = Math.random() * 2 - 1; v = Math.random() * 2 - 1; s = u * u + v * v; } while (s >= 1 || s === 0);
    const m = Math.sqrt(-2 * Math.log(s) / s);
    spare = v * m;
    return u * m;
  }
  function median(arr) {
    const a = Array.from(arr).sort((x, y) => x - y);
    const n = a.length;
    if (!n) return 0;
    return n % 2 ? a[(n - 1) / 2] : (a[n / 2 - 1] + a[n / 2]) / 2;
  }

  /* ---------- 调色板 ---------- */
  const IRON = [[0, [0, 0, 14]], [0.12, [32, 0, 92]], [0.3, [122, 0, 150]], [0.48, [200, 30, 92]],
    [0.62, [236, 82, 22]], [0.78, [250, 162, 0]], [0.9, [255, 226, 64]], [1, [255, 255, 236]]];
  const OCEAN = [[0, [8, 12, 30]], [0.3, [28, 58, 140]], [0.55, [18, 160, 182]], [0.8, [160, 222, 84]], [1, [255, 250, 200]]];
  const GRAY = [[0, [0, 0, 0]], [1, [255, 255, 255]]];
  const DIVERGE = [[0, [40, 90, 200]], [0.5, [20, 24, 40]], [1, [240, 80, 60]]];
  function palette(stops, t) {
    t = clamp(t, 0, 1);
    for (let i = 1; i < stops.length; i++) {
      if (t <= stops[i][0]) {
        const [t0, c0] = stops[i - 1], [t1, c1] = stops[i];
        const k = (t - t0) / ((t1 - t0) || 1);
        return [c0[0] + (c1[0] - c0[0]) * k, c0[1] + (c1[1] - c0[1]) * k, c0[2] + (c1[2] - c0[2]) * k];
      }
    }
    return stops[stops.length - 1][1];
  }
  const PAL = {
    iron: t => palette(IRON, t), ocean: t => palette(OCEAN, t),
    gray: t => palette(GRAY, t), diverge: t => palette(DIVERGE, t)
  };
  const rgb = (c, a = 1) => a >= 1 ? `rgb(${c[0] | 0},${c[1] | 0},${c[2] | 0})` : `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`;

  /* ---------- 风险分级（四色预警） ---------- */
  const LEVELS = [
    { key: 'blue', idx: 0, name: '低风险', grade: '蓝色', color: '#3b82f6' },
    { key: 'yellow', idx: 1, name: '一般风险', grade: '黄色', color: '#eab308' },
    { key: 'orange', idx: 2, name: '较高风险', grade: '橙色', color: '#f97316' },
    { key: 'red', idx: 3, name: '高风险', grade: '红色', color: '#ef4444' }
  ];
  const level = r => LEVELS[r < 25 ? 0 : r < 50 ? 1 : r < 75 ? 2 : 3];
  const tag = (text, cls) => `<span class="tag lv-${cls}">${text}</span>`;

  /* ---------- Canvas 基础 ---------- */
  function setup(canvas) {
    if (!canvas) return null;
    const r = canvas.getBoundingClientRect();
    const w = Math.round(r.width), h = Math.round(r.height);
    if (w < 4 || h < 4) return null;
    const dpr = window.devicePixelRatio || 1;
    const cw = Math.round(w * dpr), ch = Math.round(h * dpr);
    if (canvas.width !== cw || canvas.height !== ch) { canvas.width = cw; canvas.height = ch; }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    return { ctx, w, h };
  }
  const C = { grid: 'rgba(148,163,184,0.13)', axis: '#64748b', text: '#94a3b8', font: '11px "Microsoft YaHei",system-ui,sans-serif' };

  function niceStep(range, n) {
    const raw = range / Math.max(1, n);
    const p = Math.pow(10, Math.floor(Math.log10(raw || 1)));
    const f = raw / p;
    return (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) * p;
  }
  function tickFmt(v, step) {
    const d = step >= 1 ? 0 : Math.min(4, Math.ceil(-Math.log10(step)));
    return Number(v).toFixed(d);
  }

  /* 折线图 opt: {series:[{y,x?,color,label,width,dash}], xMin,xMax,yMin,yMax,xLabel,yLabel,hlines,vlines,legend,fill} */
  function lineChart(canvas, opt) {
    const s = setup(canvas); if (!s) return;
    const { ctx, w, h } = s;
    const m = { l: 50, r: 14, t: opt.legend === false ? 12 : 24, b: opt.xLabel ? 34 : 22 };
    const series = opt.series.filter(se => se.y && se.y.length);
    let xMin = opt.xMin, xMax = opt.xMax, yMin = opt.yMin, yMax = opt.yMax;
    if (xMin == null || xMax == null) {
      let a = Infinity, b = -Infinity;
      series.forEach(se => { if (se.x) { se.x.forEach(v => { a = Math.min(a, v); b = Math.max(b, v); }); } else { a = Math.min(a, 0); b = Math.max(b, se.y.length - 1); } });
      if (xMin == null) xMin = isFinite(a) ? a : 0;
      if (xMax == null) xMax = isFinite(b) ? b : 1;
    }
    if (yMin == null || yMax == null) {
      let a = Infinity, b = -Infinity;
      series.forEach(se => se.y.forEach(v => { if (isFinite(v)) { a = Math.min(a, v); b = Math.max(b, v); } }));
      (opt.hlines || []).forEach(hl => { a = Math.min(a, hl.y); b = Math.max(b, hl.y); });
      if (!isFinite(a)) { a = 0; b = 1; }
      const pad = (b - a) * 0.08 || 1;
      if (yMin == null) yMin = a - pad;
      if (yMax == null) yMax = b + pad;
    }
    if (xMax === xMin) xMax = xMin + 1;
    if (yMax === yMin) yMax = yMin + 1;
    const pw = w - m.l - m.r, ph = h - m.t - m.b;
    const X = v => m.l + (v - xMin) / (xMax - xMin) * pw;
    const Y = v => m.t + (1 - (v - yMin) / (yMax - yMin)) * ph;
    ctx.font = C.font; ctx.lineWidth = 1;
    const ys = niceStep(yMax - yMin, opt.yTicks || 5);
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    for (let v = Math.ceil(yMin / ys) * ys; v <= yMax + 1e-9; v += ys) {
      ctx.strokeStyle = C.grid; ctx.beginPath(); ctx.moveTo(m.l, Y(v)); ctx.lineTo(w - m.r, Y(v)); ctx.stroke();
      ctx.fillStyle = C.text; ctx.fillText(opt.yFmt ? opt.yFmt(v) : tickFmt(v, ys), m.l - 6, Y(v));
    }
    const xs = niceStep(xMax - xMin, Math.max(3, Math.floor(pw / 80)));
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    for (let v = Math.ceil(xMin / xs) * xs; v <= xMax + 1e-9; v += xs) {
      ctx.strokeStyle = C.grid; ctx.beginPath(); ctx.moveTo(X(v), m.t); ctx.lineTo(X(v), m.t + ph); ctx.stroke();
      ctx.fillStyle = C.text; ctx.fillText(opt.xFmt ? opt.xFmt(v) : tickFmt(v, xs), X(v), m.t + ph + 5);
    }
    ctx.strokeStyle = C.axis; ctx.strokeRect(m.l, m.t, pw, ph);
    if (opt.xLabel) { ctx.fillStyle = C.text; ctx.textAlign = 'center'; ctx.fillText(opt.xLabel, m.l + pw / 2, h - 14); }
    if (opt.yLabel) { ctx.save(); ctx.translate(11, m.t + ph / 2); ctx.rotate(-Math.PI / 2); ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillStyle = C.text; ctx.fillText(opt.yLabel, 0, 0); ctx.restore(); }
    ctx.save(); ctx.beginPath(); ctx.rect(m.l, m.t, pw, ph); ctx.clip();
    (opt.hlines || []).forEach(hl => {
      ctx.strokeStyle = hl.color || '#f97316'; ctx.setLineDash([5, 4]); ctx.beginPath(); ctx.moveTo(m.l, Y(hl.y)); ctx.lineTo(w - m.r, Y(hl.y)); ctx.stroke(); ctx.setLineDash([]);
      if (hl.label) { ctx.fillStyle = hl.color || '#f97316'; ctx.textAlign = hl.left ? 'left' : 'right'; ctx.textBaseline = hl.below ? 'top' : 'bottom'; ctx.fillText(hl.label, hl.left ? m.l + 4 : w - m.r - 4, Y(hl.y) + (hl.below ? 2 : -2)); }
    });
    (opt.vlines || []).forEach(vl => {
      ctx.strokeStyle = vl.color || '#22d3ee'; ctx.setLineDash([4, 3]); ctx.beginPath(); ctx.moveTo(X(vl.x), m.t); ctx.lineTo(X(vl.x), m.t + ph); ctx.stroke(); ctx.setLineDash([]);
      if (vl.label) { ctx.fillStyle = vl.color || '#22d3ee'; ctx.textAlign = 'left'; ctx.textBaseline = 'top'; ctx.fillText(vl.label, X(vl.x) + 4, m.t + 4 + (vl.dy || 0)); }
    });
    series.forEach(se => {
      const n = se.y.length;
      const xv = i => se.x ? se.x[i] : i;
      if (se.fill) {
        ctx.beginPath(); ctx.moveTo(X(xv(0)), Y(Math.max(yMin, 0)));
        for (let i = 0; i < n; i++) ctx.lineTo(X(xv(i)), Y(se.y[i]));
        ctx.lineTo(X(xv(n - 1)), Y(Math.max(yMin, 0))); ctx.closePath();
        ctx.fillStyle = se.fill; ctx.fill();
      }
      ctx.strokeStyle = se.color || '#22d3ee'; ctx.lineWidth = se.width || 1.5;
      if (se.dash) ctx.setLineDash(se.dash);
      ctx.beginPath();
      let started = false;
      for (let i = 0; i < n; i++) {
        const v = se.y[i];
        if (!isFinite(v)) { started = false; continue; }
        if (!started) { ctx.moveTo(X(xv(i)), Y(v)); started = true; } else ctx.lineTo(X(xv(i)), Y(v));
      }
      ctx.stroke(); ctx.setLineDash([]); ctx.lineWidth = 1;
    });
    ctx.restore();
    if (opt.legend !== false) {
      let lx = m.l + 4;
      ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      series.forEach(se => {
        if (!se.label) return;
        ctx.fillStyle = se.color || '#22d3ee'; ctx.fillRect(lx, 8, 14, 3);
        ctx.fillStyle = C.text; ctx.fillText(se.label, lx + 18, 10);
        lx += 26 + ctx.measureText(se.label).width;
      });
    }
  }

  /* 横向条形图（支持正负值）opt: {labels, values, colors|color, fmt, max} */
  function barChart(canvas, opt) {
    const s = setup(canvas); if (!s) return;
    const { ctx, w, h } = s;
    const n = opt.labels.length; if (!n) return;
    ctx.font = C.font;
    let lw = 0; opt.labels.forEach(l => lw = Math.max(lw, ctx.measureText(l).width));
    const m = { l: lw + 14, r: 46, t: 6, b: 6 };
    const vals = opt.values;
    let lo = Math.min(0, ...vals), hi = Math.max(0, ...vals);
    if (opt.max != null) hi = Math.max(hi, opt.max);
    if (hi === lo) hi = lo + 1;
    const pw = w - m.l - m.r, rowH = (h - m.t - m.b) / n;
    const X = v => m.l + (v - lo) / (hi - lo) * pw;
    for (let i = 0; i < n; i++) {
      const y = m.t + i * rowH, v = vals[i];
      ctx.fillStyle = C.text; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
      ctx.fillText(opt.labels[i], m.l - 8, y + rowH / 2);
      const col = Array.isArray(opt.colors) ? opt.colors[i] : (opt.color || (v >= 0 ? '#22d3ee' : '#22c55e'));
      ctx.fillStyle = col;
      const x0 = X(0), x1 = X(v), bh = Math.min(16, rowH * 0.66);
      ctx.fillRect(Math.min(x0, x1), y + (rowH - bh) / 2, Math.max(1, Math.abs(x1 - x0)), bh);
      ctx.fillStyle = '#cbd5e1'; ctx.textAlign = 'left';
      ctx.fillText(opt.fmt ? opt.fmt(v) : fmt(v, 2), Math.max(x0, x1) + 4, y + rowH / 2);
    }
    if (lo < 0) { ctx.strokeStyle = C.axis; ctx.beginPath(); ctx.moveTo(X(0), m.t); ctx.lineTo(X(0), h - m.b); ctx.stroke(); }
  }

  /* 矩阵热力图（行=y） */
  function heatmap(canvas, M, opt = {}) {
    const s = setup(canvas); if (!s) return;
    const { ctx, w, h } = s;
    const rows = M.length, cols = M[0].length;
    let vmin = opt.vmin, vmax = opt.vmax;
    if (vmin == null || vmax == null) {
      let a = Infinity, b = -Infinity;
      M.forEach(r => r.forEach(v => { a = Math.min(a, v); b = Math.max(b, v); }));
      if (vmin == null) vmin = a; if (vmax == null) vmax = b;
    }
    const m = opt.margin || { l: 50, r: 8, t: 8, b: 26 };
    const off = document.createElement('canvas'); off.width = cols; off.height = rows;
    const octx = off.getContext('2d'), img = octx.createImageData(cols, rows);
    const pal = PAL[opt.pal || 'ocean'];
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      const col = pal((M[r][c] - vmin) / ((vmax - vmin) || 1));
      const rr = opt.flipY ? rows - 1 - r : r;
      const k = (rr * cols + c) * 4;
      img.data[k] = col[0]; img.data[k + 1] = col[1]; img.data[k + 2] = col[2]; img.data[k + 3] = 255;
    }
    octx.putImageData(img, 0, 0);
    ctx.imageSmoothingEnabled = !!opt.smooth;
    ctx.drawImage(off, m.l, m.t, w - m.l - m.r, h - m.t - m.b);
    ctx.strokeStyle = C.axis; ctx.strokeRect(m.l, m.t, w - m.l - m.r, h - m.t - m.b);
    ctx.font = C.font; ctx.fillStyle = C.text;
    if (opt.xLabel) { ctx.textAlign = 'center'; ctx.textBaseline = 'bottom'; ctx.fillText(opt.xLabel, m.l + (w - m.l - m.r) / 2, h - 2); }
    if (opt.yLabel) { ctx.save(); ctx.translate(12, m.t + (h - m.t - m.b) / 2); ctx.rotate(-Math.PI / 2); ctx.textAlign = 'center'; ctx.fillText(opt.yLabel, 0, 0); ctx.restore(); }
    if (opt.after) opt.after(ctx, { x: m.l, y: m.t, w: w - m.l - m.r, h: h - m.t - m.b });
  }

  /* 把温度矩阵画到 canvas（按像素尺寸） */
  function drawField(canvas, data, W, H, pal, vmin, vmax, scale = 1) {
    canvas.width = W * scale; canvas.height = H * scale;
    const ctx = canvas.getContext('2d');
    const off = document.createElement('canvas'); off.width = W; off.height = H;
    const octx = off.getContext('2d'), img = octx.createImageData(W, H);
    const p = PAL[pal] || PAL.iron, span = (vmax - vmin) || 1;
    for (let i = 0; i < W * H; i++) {
      const c = p((data[i] - vmin) / span), k = i * 4;
      img.data[k] = c[0]; img.data[k + 1] = c[1]; img.data[k + 2] = c[2]; img.data[k + 3] = 255;
    }
    octx.putImageData(img, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(off, 0, 0, W * scale, H * scale);
    return ctx;
  }

  /* 半圆仪表 */
  function gauge(canvas, value, sub) {
    const s = setup(canvas); if (!s) return;
    const { ctx, w, h } = s;
    const cx = w / 2, cy = h * 0.8, r = Math.min(w / 2 - 12, h * 0.7);
    const segs = [[0, 25, '#3b82f6'], [25, 50, '#eab308'], [50, 75, '#f97316'], [75, 100, '#ef4444']];
    ctx.lineWidth = Math.max(8, r * 0.16);
    segs.forEach(([a, b, c]) => {
      ctx.strokeStyle = c; ctx.globalAlpha = 0.85; ctx.beginPath();
      ctx.arc(cx, cy, r, Math.PI + a / 100 * Math.PI + 0.01, Math.PI + b / 100 * Math.PI - 0.01); ctx.stroke();
    });
    ctx.globalAlpha = 1;
    const ang = Math.PI + clamp(value, 0, 100) / 100 * Math.PI;
    ctx.strokeStyle = '#e2e8f0'; ctx.lineWidth = 3; ctx.beginPath();
    ctx.moveTo(cx, cy); ctx.lineTo(cx + Math.cos(ang) * (r - 6), cy + Math.sin(ang) * (r - 6)); ctx.stroke();
    ctx.fillStyle = '#e2e8f0'; ctx.beginPath(); ctx.arc(cx, cy, 5, 0, Math.PI * 2); ctx.fill();
    ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
    ctx.font = `bold ${Math.round(r * 0.36)}px system-ui,sans-serif`; ctx.fillStyle = level(value).color;
    ctx.fillText(fmt(value, 0), cx, cy - r * 0.28);
    if (sub) { ctx.font = C.font; ctx.fillStyle = C.text; ctx.fillText(sub, cx, cy + 16); }
  }

  /* 雷达图 */
  function radar(canvas, labels, values, color = '#22d3ee') {
    const s = setup(canvas); if (!s) return;
    const { ctx, w, h } = s;
    const cx = w / 2, cy = h / 2 + 4, r = Math.min(w, h) / 2 - 34, n = labels.length;
    ctx.font = C.font;
    for (let k = 1; k <= 4; k++) {
      ctx.strokeStyle = C.grid; ctx.beginPath();
      for (let i = 0; i <= n; i++) { const a = -Math.PI / 2 + i / n * Math.PI * 2; const x = cx + Math.cos(a) * r * k / 4, y = cy + Math.sin(a) * r * k / 4; i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }
      ctx.stroke();
    }
    for (let i = 0; i < n; i++) {
      const a = -Math.PI / 2 + i / n * Math.PI * 2;
      ctx.strokeStyle = C.grid; ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r); ctx.stroke();
      ctx.fillStyle = C.text; ctx.textAlign = Math.cos(a) > 0.2 ? 'left' : Math.cos(a) < -0.2 ? 'right' : 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(labels[i], cx + Math.cos(a) * (r + 10), cy + Math.sin(a) * (r + 10));
    }
    ctx.beginPath();
    values.forEach((v, i) => { const a = -Math.PI / 2 + i / n * Math.PI * 2; const x = cx + Math.cos(a) * r * clamp(v, 0, 1), y = cy + Math.sin(a) * r * clamp(v, 0, 1); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
    ctx.closePath(); ctx.fillStyle = color + '40'; ctx.fill(); ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.stroke(); ctx.lineWidth = 1;
  }

  /* 提示 */
  function toast(msg, type = 'info', ms = 3200) {
    let box = $('#toasts');
    if (!box) { box = document.createElement('div'); box.id = 'toasts'; document.body.appendChild(box); }
    const el = document.createElement('div');
    el.className = 'toast toast-' + type; el.textContent = msg;
    box.appendChild(el);
    setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 400); }, ms);
  }

  function download(name, content, mime = 'text/plain;charset=utf-8') {
    const blob = new Blob([content], { type: mime });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }

  const hms = sec => {
    sec = Math.floor(sec) % 86400;
    const p = v => String(v).padStart(2, '0');
    return `${p(Math.floor(sec / 3600))}:${p(Math.floor(sec % 3600 / 60))}:${p(sec % 60)}`;
  };

  /* 绑定滑块与其数值显示 #id-v */
  function range(id, f, onChange) {
    const el = $('#' + id), out = $('#' + id + '-v');
    const upd = () => { if (out) out.textContent = f(+el.value); };
    el.addEventListener('input', () => { upd(); if (onChange) onChange(+el.value); });
    upd();
    return el;
  }
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  return { range, sleep, $, $$, clamp, rand, randi, randn, pick, fmt, median, PAL, rgb, LEVELS, level, tag, setup, lineChart, barChart, heatmap, drawField, gauge, radar, toast, download, hms };
})();
if (typeof module !== 'undefined') module.exports = U;
