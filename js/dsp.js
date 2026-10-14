'use strict';
/* 直流侧电流信号仿真 + 时域/频域/时频域/小波多域特征提取 */
const DSP = (() => {
  const FS = 200000;   // 采样率 200 kHz
  const N = 2048;      // 窗长 10.24 ms
  const CLASSES = ['normal', 'series', 'parallel', 'inverter', 'irradiance'];
  const CLASS_NAMES = ['正常运行', '串联电弧', '并联电弧', '逆变器噪声干扰', '辐照/MPPT扰动'];
  const CLASS_COLORS = ['#22c55e', '#ef4444', '#f97316', '#a78bfa', '#38bdf8'];

  function fft(re, im) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang), half = len >> 1;
      for (let i = 0; i < n; i += len) {
        let cr = 1, ci = 0;
        for (let k = 0; k < half; k++) {
          const a = i + k, b = a + half;
          const xr = re[b] * cr - im[b] * ci, xi = re[b] * ci + im[b] * cr;
          re[b] = re[a] - xr; im[b] = im[a] - xi; re[a] += xr; im[a] += xi;
          const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
        }
      }
    }
  }
  const hannCache = {};
  function hann(n) {
    if (!hannCache[n]) { const w = new Float64Array(n); for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (n - 1)); hannCache[n] = w; }
    return hannCache[n];
  }
  /* 单边幅值谱（去均值 + 汉宁窗） */
  function spectrum(x, start = 0, n = x.length) {
    const w = hann(n), re = new Float64Array(n), im = new Float64Array(n);
    let mean = 0; for (let i = 0; i < n; i++) mean += x[start + i]; mean /= n;
    let ws = 0; for (let i = 0; i < n; i++) { re[i] = (x[start + i] - mean) * w[i]; ws += w[i]; }
    fft(re, im);
    const mag = new Float64Array(n / 2);
    for (let k = 0; k < n / 2; k++) mag[k] = Math.hypot(re[k], im[k]) * 2 / ws;
    return mag;
  }

  /* ---------- 信号仿真 ---------- */
  function generate(type, o = {}) {
    const n = o.n || N, I0 = o.I0 != null ? o.I0 : 8, noise = o.noise != null ? o.noise : 1;
    const sev = o.sev != null ? o.sev : U.rand(0.4, 1);
    const x = new Float64Array(n);
    const fsw = U.rand(15000, 20000), ph = U.rand(0, 6.28), ph2 = U.rand(0, 6.28);
    const aRip = 0.02 * I0 * U.rand(0.5, 1), aSw = 0.004 * I0 * U.rand(0.6, 1.4), sig = 0.003 * I0 * noise;
    const isArc = type === 'series' || type === 'parallel';
    const onset = isArc ? (o.onset != null ? o.onset : Math.floor(n * U.rand(0, 0.5))) : n;
    for (let i = 0; i < n; i++) {
      const t = i / FS;
      x[i] = I0 + aRip * Math.sin(2 * Math.PI * 100 * t + ph)
        + aSw * Math.sin(2 * Math.PI * fsw * t + ph2) + 0.4 * aSw * Math.sin(4 * Math.PI * fsw * t)
        + sig * U.randn();
    }
    if (type === 'inverter') {
      // 强开关谐波 + 周期性开关尖峰振铃（窄带、周期性）
      const k = U.rand(4, 9), period = FS / fsw, fr = U.rand(60000, 90000), amp = 0.05 * I0 * U.rand(0.5, 1.2);
      for (let i = 0; i < n; i++) {
        const t = i / FS;
        for (let hN = 1; hN <= 5; hN++) x[i] += k * aSw / hN * Math.sin(2 * Math.PI * fsw * hN * t + ph2 * hN);
        const tau = (i % period);
        x[i] += amp * Math.exp(-tau / 2.5) * Math.sin(2 * Math.PI * fr * tau / FS);
      }
    } else if (type === 'irradiance') {
      // 阶跃/斜坡（MPPT 扰动或云影边缘）
      const dI = I0 * U.rand(0.06, 0.25) * (Math.random() < 0.5 ? -1 : 1);
      const c = n * U.rand(0.2, 0.8), tau = U.rand(20, 200);
      for (let i = 0; i < n; i++) x[i] += dI / (1 + Math.exp(-(i - c) / tau));
    } else if (isArc) {
      const drop = type === 'series' ? I0 * U.rand(0.02, 0.08) * sev : I0 * U.rand(0.3, 0.65);
      const sa = I0 * (type === 'series' ? U.rand(0.008, 0.028) * (0.4 + 0.6 * sev) : U.rand(0.02, 0.05));
      let lp = 0, env = 1, next = onset;
      for (let i = onset; i < n; i++) {
        if (i >= next) { env = U.rand(0.3, 1.6); next = i + U.randi(40, 300); }
        const wn = U.randn();
        lp = 0.92 * lp + 0.4 * U.randn();
        let v = sa * env * (0.65 * wn + 0.5 * lp);
        if (Math.random() < 0.0025) v += (Math.random() < 0.5 ? -1 : 1) * sa * U.rand(4, 10);
        const tr = Math.min(1, (i - onset) / 6);
        x[i] += -drop * tr + v;
      }
    }
    return { x, onset: isArc ? onset : null, type };
  }

  /* ---------- 特征提取 ---------- */
  const FEATURE_NAMES = ['相对标准差', '差分标准差', '差分峭度', '峰峰值比', '均值阶跃',
    '频带0.5-5k', '频带5-15k', '频带15-30k', '频带30-60k', '频带60-100k',
    '谱熵', '谱平坦度', '谱峰均比', '小波D1', '小波D2', '小波D3', '小波D4'];
  const BANDS = [[500, 5000], [5000, 15000], [15000, 30000], [30000, 60000], [60000, 100000]];
  const L10 = v => Math.log10(v + 1e-12);

  function features(x, keep) {
    const n = x.length;
    let mean = 0; for (let i = 0; i < n; i++) mean += x[i]; mean /= n;
    const m = Math.max(Math.abs(mean), 0.3);
    let v = 0, mx = -Infinity, mn = Infinity;
    for (let i = 0; i < n; i++) { const d = x[i] - mean; v += d * d; if (x[i] > mx) mx = x[i]; if (x[i] < mn) mn = x[i]; }
    const sd = Math.sqrt(v / n);
    let dm = 0; for (let i = 1; i < n; i++) dm += x[i] - x[i - 1]; dm /= (n - 1);
    let d2 = 0, d4 = 0;
    for (let i = 1; i < n; i++) { const d = x[i] - x[i - 1] - dm; d2 += d * d; d4 += d * d * d * d; }
    d2 /= (n - 1); d4 /= (n - 1);
    const kurt = d4 / (d2 * d2 + 1e-18);
    const q = Math.floor(n / 4);
    let a = 0, b = 0; for (let i = 0; i < q; i++) { a += x[i]; b += x[n - q + i]; }
    const step = Math.abs(b - a) / q / m;
    const sp = spectrum(x), df = FS / n;
    const band = BANDS.map(([f0, f1]) => { let e = 0; for (let k = Math.ceil(f0 / df); k < Math.min(sp.length, Math.floor(f1 / df)); k++) e += sp[k] * sp[k]; return L10(e / (m * m)); });
    const k0 = Math.ceil(5000 / df), k1 = sp.length;
    let tot = 0, pk = 0; for (let k = k0; k < k1; k++) { const p = sp[k] * sp[k]; tot += p; if (p > pk) pk = p; }
    let H = 0; for (let k = k0; k < k1; k++) { const p = sp[k] * sp[k] / (tot + 1e-30); if (p > 0) H -= p * Math.log(p); }
    H /= Math.log(k1 - k0);
    const kf = Math.ceil(20000 / df);
    let lg = 0, ar = 0; for (let k = kf; k < k1; k++) { const p = sp[k] * sp[k] + 1e-24; lg += Math.log(p); ar += p; }
    const flat = Math.exp(lg / (k1 - kf)) / (ar / (k1 - kf));
    const pav = L10(pk / (tot / (k1 - k0) + 1e-30));
    // Haar 小波细节能量
    let cur = Array.from(x);
    const wav = [];
    for (let l = 0; l < 4; l++) {
      const half = cur.length >> 1, ap = new Array(half); let e = 0;
      for (let i = 0; i < half; i++) { const s0 = cur[2 * i], s1 = cur[2 * i + 1]; ap[i] = (s0 + s1) / Math.SQRT2; const d = (s0 - s1) / Math.SQRT2; e += d * d; }
      wav.push(L10(e / half / (m * m)));
      cur = ap;
    }
    const values = [sd / m, Math.sqrt(d2) / m, L10(kurt), (mx - mn) / m, step, ...band, H, flat, pav, ...wav];
    if (keep) keep.spectrum = sp;
    return values;
  }

  /* 短时傅里叶变换：返回 [bin][frame] 的 dB 矩阵（低频在下） */
  function stft(x, win = 256, hop = 64) {
    const frames = Math.floor((x.length - win) / hop) + 1, bins = win / 2;
    const M = []; for (let b = 0; b < bins; b++) M.push(new Array(frames));
    for (let f = 0; f < frames; f++) {
      const sp = spectrum(x, f * hop, win);
      for (let b = 0; b < bins; b++) M[bins - 1 - b][f] = 20 * Math.log10(sp[b] + 1e-7);
    }
    return M;
  }

  return { FS, N, CLASSES, CLASS_NAMES, CLASS_COLORS, FEATURE_NAMES, fft, spectrum, generate, features, stft };
})();
if (typeof module !== 'undefined') module.exports = DSP;
