'use strict';
/* 红外热像：组件热像仿真 + 灰度化 → 卷积特征 → 候选区域生成(RPN思路, 滞后阈值+连通域+NMS) → 分类回归 */
const VIS = (() => {
  const W = 200, H = 120, CW = 20, CH = 20;          // 60 片电池组件（10×6，横置）
  const JB = { x: 100, y: 8 };                       // 接线盒投影位置
  const CLS = ['shading', 'junction', 'bypass', 'crack', 'soiling', 'reflect'];
  const CLS_NAMES = ['遮挡热斑', '接线盒/接点过热', '旁路二极管/子串异常', '电池隐裂热点', '积灰污损', '反光干扰(伪热斑)'];
  const CLS_COLORS = ['#f97316', '#ef4444', '#eab308', '#a78bfa', '#38bdf8', '#94a3b8'];
  const SCENES = {
    normal: '正常组件', shading: '局部遮挡热斑', junction: '接线盒/接点过热', bypass: '旁路二极管失效(子串发热)',
    crack: '电池隐裂', soiling: '积灰污损', multi: '复合故障(遮挡+接点+积灰)', reflect: '反光干扰(误报测试)'
  };

  const sig = (v) => 1 / (1 + Math.exp(-v));

  function synth(scene, o = {}) {
    const sev = o.sev != null ? o.sev : 0.7, noise = o.noise != null ? o.noise : 0.3, Tb = o.Tb != null ? o.Tb : 45;
    const amp = o.amp;
    const T = new Float32Array(W * H), truth = [];
    const gx = U.rand(-1, 1), gy = U.rand(-1, 1);
    const cellOff = Array.from({ length: 60 }, () => U.randn() * 0.25);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      let t = Tb + gx * (x / W - 0.5) * 2 + gy * (y / H - 0.5) * 2 + cellOff[Math.floor(y / CH) * 10 + Math.floor(x / CW)];
      if (x % CW === 0 || y % CH === 0) t -= 0.7;
      const edge = Math.min(x, y, W - 1 - x, H - 1 - y);
      if (edge < 3) t -= (3 - edge) * 1.1;
      if (x >= 90 && x < 110 && y >= 3 && y < 13) t += 1.2;
      T[y * W + x] = t;
    }
    const add = (fn) => { for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) T[y * W + x] += fn(x, y); };
    const rectSoft = (x0, y0, x1, y1, a, s = 0.9) => (x, y) => a * sig((x - x0) / s) * sig((x1 - x) / s) * sig((y - y0) / s) * sig((y1 - y) / s);

    const doShading = (k) => {
      const used = new Set();
      for (let n = 0; n < k; n++) {
        let ci, ri;
        do { ci = U.randi(0, 9); ri = U.randi(0, 5); } while (used.has(ci + ',' + ri) || (ri === 0 && ci >= 4 && ci <= 5));
        used.add(ci + ',' + ri);
        const a = (amp != null ? amp : (12 + 45 * sev)) * U.rand(0.85, 1.1);
        const x0 = ci * CW + 1.5, y0 = ri * CH + 1.5;
        add(rectSoft(x0, y0, x0 + CW - 3, y0 + CH - 3, a));
        truth.push({ type: 'shading', box: [ci * CW, ri * CH, ci * CW + CW, ri * CH + CH] });
      }
    };
    const doJunction = (s = sev) => {
      const a = amp != null ? amp : (15 + 50 * s);
      add((x, y) => a * Math.exp(-((x - JB.x) ** 2) / (2 * 8 * 8) - ((y - JB.y) ** 2) / (2 * 5 * 5)));
      truth.push({ type: 'junction', box: [JB.x - 16, 0, JB.x + 16, JB.y + 12] });
    };
    const doBypass = () => {
      const k = U.randi(0, 2), a = amp != null ? amp : (5 + 10 * sev);
      add(rectSoft(1, k * 40 + 1, W - 2, k * 40 + 39, a, 0.8));
      truth.push({ type: 'bypass', box: [0, k * 40, W, k * 40 + 40] });
    };
    const doCrack = () => {
      const ci = U.randi(0, 9), ri = U.randi(1, 4), a = amp != null ? amp : (8 + 22 * sev);
      const th = U.rand(0.25, Math.PI / 2 - 0.25) + (Math.random() < 0.5 ? 0 : Math.PI / 2), nx = Math.cos(th), ny = Math.sin(th), off = U.rand(-1, 4);
      const cx = ci * CW + CW / 2, cy = ri * CH + CH / 2;
      add((x, y) => {
        if (x < ci * CW + 1 || x > ci * CW + CW - 1 || y < ri * CH + 1 || y > ri * CH + CH - 1) return 0;
        const d = (x - cx) * nx + (y - cy) * ny - off;
        return d > 0 ? a * sig(d / 0.8) * (0.85 + 0.15 * Math.sin(x * 0.7 + y)) : 0;
      });
      truth.push({ type: 'crack', box: [ci * CW, ri * CH, ci * CW + CW, ri * CH + CH] });
    };
    const doSoiling = (s = sev) => {
      const a = amp != null ? amp : (4 + 10 * s), p1 = U.rand(0, 6), p2 = U.rand(0, 6);
      add((x, y) => {
        if (y < H - 16) return 0;
        const d = (y - (H - 16)) / 13;
        const pat = 0.55 + 0.3 * Math.sin(x * 0.09 + p1) + 0.15 * Math.sin(x * 0.31 + p2);
        return a * Math.min(1, d) * pat;
      });
      truth.push({ type: 'soiling', box: [0, H - 16, W, H] });
    };
    const doReflect = () => {
      const cx = U.rand(30, 170), cy = U.rand(35, 95), s = U.rand(13, 19), a = amp != null ? amp : U.rand(15, 32);
      add((x, y) => a * Math.exp(-((x - cx) ** 2 + (y - cy) ** 2) / (2 * s * s)));
      truth.push({ type: 'reflect', box: [cx - 2 * s, cy - 2 * s, cx + 2 * s, cy + 2 * s] });
    };

    if (scene === 'shading') doShading(sev > 0.75 ? 2 : 1);
    else if (scene === 'junction') doJunction();
    else if (scene === 'bypass') doBypass();
    else if (scene === 'crack') doCrack();
    else if (scene === 'soiling') doSoiling();
    else if (scene === 'multi') { doShading(1); doJunction(sev * 0.8); doSoiling(sev * 0.6); }
    else if (scene === 'reflect') doReflect();
    if (o.reflect && scene !== 'reflect') doReflect();
    if (o.wind) { const wa = U.rand(2, 5); add((x) => -wa * x / W); }
    for (let i = 0; i < T.length; i++) T[i] += noise * U.randn();
    return { T, W, H, truth, Tb, scene };
  }

  /* ---------- 卷积 ---------- */
  function conv(src, w, h, kArr, ks) {
    const k = Float64Array.from(kArr), out = new Float32Array(w * h), r = ks >> 1;
    const cx = new Int32Array(w + 2 * r);
    for (let x = 0; x < w + 2 * r; x++) cx[x] = Math.min(w - 1, Math.max(0, x - r));
    for (let y = 0; y < h; y++) {
      const o = y * w;
      for (let j = 0; j < ks; j++) {
        const row = Math.min(h - 1, Math.max(0, y + j - r)) * w;
        for (let i = 0; i < ks; i++) {
          const kv = k[j * ks + i];
          if (kv === 0) continue;
          for (let x = 0; x < w; x++) out[o + x] += kv * src[row + cx[x + i]];
        }
      }
    }
    return out;
  }
  const GAUSS = (() => { const k = [], s = 1.1; let t = 0; for (let j = -2; j <= 2; j++) for (let i = -2; i <= 2; i++) { const v = Math.exp(-(i * i + j * j) / (2 * s * s)); k.push(v); t += v; } return k.map(v => v / t); })();
  const SOBX = [-1, 0, 1, -2, 0, 2, -1, 0, 1], SOBY = [-1, -2, -1, 0, 0, 0, 1, 2, 1];
  const LOG = [0, 0, -1, 0, 0, 0, -1, -2, -1, 0, -1, -2, 16, -2, -1, 0, -1, -2, -1, 0, 0, 0, -1, 0, 0];

  function analyze(T, w, h, o = {}) {
    const grid = o.grid !== false;
    let mn = Infinity, mx = -Infinity;
    for (const v of T) { if (v < mn) mn = v; if (v > mx) mx = v; }
    const gray = new Float32Array(T.length);
    for (let i = 0; i < T.length; i++) gray[i] = (T[i] - mn) / ((mx - mn) || 1);
    const g = conv(T, w, h, GAUSS, 5);
    const sx = conv(g, w, h, SOBX, 3), sy = conv(g, w, h, SOBY, 3);
    const sob = new Float32Array(T.length); for (let i = 0; i < T.length; i++) sob[i] = Math.hypot(sx[i], sy[i]);
    const lg = conv(g, w, h, LOG, 5);
    const samp = [], m = Math.max(4, Math.round(Math.min(w, h) * 0.04));
    for (let y = m; y < h - m; y += 2) for (let x = m; x < w - m; x += 2) samp.push(g[y * w + x]);
    const med = U.median(samp);
    const mad = U.median(samp.map(v => Math.abs(v - med))) * 1.4826;
    const dT = new Float32Array(T.length); for (let i = 0; i < T.length; i++) dT[i] = g[i] - med;
    const th = Math.max(o.thK != null ? o.thK : 5, 4 * mad);
    // 候选区域：滞后阈值 + 8 连通域
    const lab = new Int32Array(T.length).fill(-1), props = [];
    const weak = th * 0.5;
    for (let s0 = 0; s0 < T.length; s0++) {
      if (lab[s0] !== -1 || dT[s0] <= weak) continue;
      const id = props.length, stack = [s0], pix = [];
      lab[s0] = id;
      let strong = false;
      while (stack.length) {
        const p = stack.pop(); pix.push(p);
        if (dT[p] > th) strong = true;
        const px = p % w, py = (p / w) | 0;
        for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) {
          const xx = px + i, yy = py + j;
          if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
          const q = yy * w + xx;
          if (lab[q] === -1 && dT[q] > weak) { lab[q] = id; stack.push(q); }
        }
      }
      props.push({ id, pix, strong });
    }
    let regions = props.filter(p => p.strong && p.pix.length >= 6).map(p => regionFeatures(p, w, h, dT, sob, lab, grid));
    // NMS：按 ΔT 排序，抑制与高分框 IoU>0.5 的候选
    regions.sort((a, b) => b.dTmax - a.dTmax);
    const keep = [];
    regions.forEach(r => { if (!keep.some(k => iou(k.box, r.box) > 0.5)) keep.push(r); });
    regions = keep.slice(0, 8);
    regions.forEach(r => classify(r, w, h, grid));
    return { gray, g, sob, lg, dT, med, mad, th, regions, mn, mx, w, h, nProposals: props.length };
  }

  function iou(a, b) {
    const ix = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])), iy = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
    const I = ix * iy, Ua = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - I;
    return Ua > 0 ? I / Ua : 0;
  }

  function regionFeatures(p, w, h, dT, sob, lab, grid) {
    let x0 = w, y0 = h, x1 = 0, y1 = 0, sum = 0, mxv = -Infinity, cx = 0, cy = 0, bs = 0, bn = 0;
    p.pix.forEach(q => {
      const x = q % w, y = (q / w) | 0, v = dT[q];
      x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
      sum += v; if (v > mxv) mxv = v; cx += x; cy += y;
      const edge = (x === 0 || y === 0 || x === w - 1 || y === h - 1) ||
        lab[q - 1] !== p.id || lab[q + 1] !== p.id || lab[q - w] !== p.id || lab[q + w] !== p.id;
      if (edge) { bs += sob[q]; bn++; }
    });
    const n = p.pix.length, bw = x1 - x0 + 1, bh = y1 - y0 + 1;
    const cellA = grid ? CW * CH : (w * h / 60);
    return {
      box: [x0, y0, x1 + 1, y1 + 1], area: n, bw, bh, cx: cx / n, cy: cy / n,
      dTmax: mxv, dTmean: sum / n, aspect: bw / bh, fill: n / (bw * bh),
      cellFrac: n / cellA, widthFrac: bw / w, heightFrac: bh / h,
      sharp: (bs / Math.max(1, bn)) / Math.max(1, mxv)
    };
  }

  /* 分类：几何/热学可解释特征 → 线性打分 → softmax 概率 */
  function classify(r, w, h, grid) {
    const s = (x, a, b) => U.clamp((x - a) / (b - a), 0, 1);
    const band = (x, a, b, c, d) => Math.min(s(x, a, b), 1 - s(x, c, d));
    const nearJB = grid ? 1 - s(Math.hypot(r.cx - JB.x * w / W, r.cy - JB.y * h / H), 10, 22) : 0;
    const bottom = s(r.cy / h, 0.82, 0.9) * s(r.box[3] / h, 0.92, 0.98);
    const wide = s(r.widthFrac, 0.45, 0.75);
    const soft = 1 - s(r.sharp, 0.35, 0.9);
    const sharp = s(r.sharp, 0.5, 1.2);
    const cellLike = band(r.cellFrac, 0.7, 0.88, 2.2, 3.2);
    const square = band(r.aspect, 0.5, 0.7, 1.5, 2.2);
    const partial = band(r.cellFrac, 0.06, 0.12, 0.66, 0.84);
    const tall = band(r.heightFrac, 0.22, 0.28, 0.4, 0.5);
    const z = [
      /* 遮挡热斑 */ 2.6 * cellLike + 1.2 * square + 1.2 * sharp + 0.8 * s(r.fill, 0.6, 0.85) - 3 * nearJB - 3 * wide - 3 * bottom * s(r.aspect, 1.8, 3.5),
      /* 接线盒   */ 5 * nearJB + 0.6 * soft - 1.5 * wide - 1.5 * bottom,
      /* 旁路子串 */ 3 * wide + 2.4 * tall - 0.5 * s(r.dTmax, 25, 40) - 2.5 * bottom - 2 * nearJB,
      /* 隐裂     */ 2.6 * partial + 1.0 * sharp + 0.8 * (1 - s(r.fill, 0.55, 0.85)) - 1.5 * cellLike - 3 * nearJB - 2 * wide - 2 * bottom,
      /* 积灰     */ 2.5 * bottom + 3 * bottom * s(r.aspect, 1.8, 3.5) + 1.2 * s(r.aspect, 2, 5) + 0.6 * (1 - s(r.dTmax, 12, 20)) - 2 * nearJB,
      /* 反光     */ 3.0 * soft + 1.2 * s(r.cellFrac, 1.2, 2.5) * soft - 3.5 * nearJB - 2 * bottom - 2.5 * wide - 1.5 * sharp
    ];
    const g = 2.2, mx = Math.max(...z);
    const e = z.map(v => Math.exp(g * (v - mx))), tot = e.reduce((a, b) => a + b, 0);
    r.probs = e.map(v => v / tot);
    r.cls = r.probs.indexOf(Math.max(...r.probs));
    r.conf = r.probs[r.cls];
    r.grade = gradeOf(r.dTmax, CLS[r.cls]);
    return r;
  }

  function gradeOf(dT, cls) {
    if (cls === 'reflect') return { g: 0, name: '伪热斑·已抑制', lv: 'info' };
    if (dT < 10) return { g: 1, name: 'Ⅰ级 观察', lv: 'blue' };
    if (dT < 20) return { g: 2, name: 'Ⅱ级 计划检修', lv: 'yellow' };
    if (dT < 40) return { g: 3, name: 'Ⅲ级 尽快处理', lv: 'orange' };
    return { g: 4, name: 'Ⅳ级 紧急处置', lv: 'red' };
  }

  /* 上传图片 → 伪温度场 */
  function fromImage(img, Tmin, Tmax, maxW = 240) {
    const sc = Math.min(1, maxW / img.width);
    const w = Math.max(16, Math.round(img.width * sc)), h = Math.max(16, Math.round(img.height * sc));
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const ctx = c.getContext('2d'); ctx.drawImage(img, 0, 0, w, h);
    const d = ctx.getImageData(0, 0, w, h).data, T = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) {
      const l = (0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2]) / 255;
      T[i] = Tmin + l * (Tmax - Tmin);
    }
    return { T, W: w, H: h };
  }

  return { W, H, CW, CH, CLS, CLS_NAMES, CLS_COLORS, SCENES, synth, analyze, gradeOf, fromImage };
})();
if (typeof module !== 'undefined') module.exports = VIS;
