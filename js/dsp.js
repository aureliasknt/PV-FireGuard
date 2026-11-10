'use strict';
/* 电流信号处理：FFT、STFT 与时域/频域/谱统计/小波多域特征提取
   信号源为电弧实验平台实测数据（data/arc-real.js，100 kHz，直流侧 + 交流侧双通道），见 real.js */
const DSP = (() => {
  const FS = 100000;   // 采集卡采样率 100 kHz
  const N = 1024;      // 窗长 10.24 ms
  const CLASSES = ['normal', 'dc', 'ac'];
  const CLASS_NAMES = ['正常运行', '直流侧电弧', '交流侧电弧'];
  const CLASS_COLORS = ['#22c55e', '#ef4444', '#f97316'];
  const CH = ['DC', 'AC'];
  const CH_NAMES = ['直流侧', '交流侧'];

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

  /* ---------- 单通道 17 维特征 ---------- */
  const BASE_NAMES = ['相对标准差', '差分标准差', '差分峭度', '峰峰值比', '均值阶跃',
    '频带0.5-5k', '频带5-10k', '频带10-20k', '频带20-35k', '频带35-50k',
    '谱熵', '谱平坦度', '谱峰均比', '小波D1', '小波D2', '小波D3', '小波D4'];
  const NB = BASE_NAMES.length;
  const FEATURE_NAMES = CH.flatMap(c => BASE_NAMES.map(n => `${c}·${n}`));
  const BANDS = [[500, 5000], [5000, 10000], [10000, 20000], [20000, 35000], [35000, 50000]];
  const L10 = v => Math.log10(v + 1e-12);
  const DOMAIN = i => { const j = i % NB; return j < 5 ? '时域' : j < 10 ? '频域' : j < 13 ? '谱统计' : '小波'; };

  function features1(x) {
    const n = x.length;
    let mean = 0; for (let i = 0; i < n; i++) mean += x[i]; mean /= n;
    let v = 0, mx = -Infinity, mn = Infinity;
    for (let i = 0; i < n; i++) { const d = x[i] - mean; v += d * d; if (x[i] > mx) mx = x[i]; if (x[i] < mn) mn = x[i]; }
    const sd = Math.sqrt(v / n);
    const m = Math.max(Math.sqrt(mean * mean + sd * sd), 0.02);   // 以窗口有效值归一，消除负载电流大小的影响
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
    return [sd / m, Math.sqrt(d2) / m, L10(kurt), (mx - mn) / m, step, ...band, H, flat, pav, ...wav];
  }
  /* 双通道 34 维特征：直流侧 17 维 + 交流侧 17 维 */
  const features = (dc, ac) => features1(dc).concat(features1(ac));

  /* 短时傅里叶变换：返回 [bin][frame] 的 dB 矩阵（低频在下） */
  function stft(x, win = 128, hop = 32) {
    const frames = Math.floor((x.length - win) / hop) + 1, bins = win / 2;
    const M = []; for (let b = 0; b < bins; b++) M.push(new Array(frames));
    for (let f = 0; f < frames; f++) {
      const sp = spectrum(x, f * hop, win);
      for (let b = 0; b < bins; b++) M[bins - 1 - b][f] = 20 * Math.log10(sp[b] + 1e-7);
    }
    return M;
  }

  return { FS, N, CLASSES, CLASS_NAMES, CLASS_COLORS, CH, CH_NAMES, NB, BASE_NAMES, FEATURE_NAMES, DOMAIN, fft, spectrum, features, features1, stft };
})();
if (typeof module !== 'undefined') module.exports = DSP;
