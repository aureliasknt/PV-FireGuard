'use strict';
/* 实测数据源：解码 data/arc-real.js（tools/preprocess_arc.py 生成）
   记录 → 4 段连续采样 × 10 窗 × 1024 点 × 2 通道（直流侧、交流侧），int16 码值 × LSB = 采集卡读数 / V */
const REAL = (() => {
  const P = ARC_REAL;
  const SIDE_CLS = { none: 0, dc: 1, ac: 2 };
  const SIDE_NAMES = { none: '无电弧', dc: '直流侧电弧', ac: '交流侧电弧' };
  const LOADS = [...new Set(P.records.map(r => r.load))];
  const WPR = P.blocks * P.wpb;       // 每记录窗口数
  let q = null, loading = null;

  function decode() {
    const s = atob(P.blob), bin = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) bin[i] = s.charCodeAt(i);
    const ds = new Blob([bin]).stream().pipeThrough(new DecompressionStream('gzip'));
    return new Response(ds).arrayBuffer().then(buf => {
      const d = new Int16Array(buf), out = new Int16Array(d.length);
      let acc = 0;
      for (let i = 0; i < d.length; i++) { acc += d[i]; out[i] = acc; }   // 一阶差分还原
      q = out; P.blob = null;
    });
  }
  const load = () => loading || (loading = decode());

  const rec = i => P.records[i];
  const cls = r => SIDE_CLS[(typeof r === 'number' ? rec(r) : r).side];
  const label = r => `${r.id} ${r.load}负载 · ${SIDE_NAMES[r.side]} · #${r.seq}`;

  /* 取第 ri 个记录的第 w 个窗口（0…39），返回双通道信号与在原文件中的时刻 */
  function win(ri, w) {
    const r = rec(ri), N = P.N, b = Math.floor(w / P.wpb), j = w % P.wpb;
    const base = r.offset + b * 2 * P.wpb * N;
    const dc = new Float64Array(N), ac = new Float64Array(N);
    for (let i = 0; i < N; i++) { dc[i] = q[base + j * N + i] * P.lsb; ac[i] = q[base + (P.wpb + j) * N + i] * P.lsb; }
    return { dc, ac, ri, w, block: b, t: (r.blocks[b] + j) * N / P.fs, cls: cls(r) };
  }
  /* 按条件随机抽取一个窗口 */
  function sample(filter = () => true) {
    const idx = P.records.map((r, i) => i).filter(i => filter(rec(i)));
    const ri = idx[Math.floor(Math.random() * idx.length)];
    return win(ri, Math.floor(Math.random() * WPR));
  }

  /* 按条件随机抽取 k 个连续窗口（同一连续段内，k ≤ 每段窗数） */
  function run(filter, k) {
    const g = sample(filter), start = g.block * P.wpb + Math.floor(Math.random() * (P.wpb - k + 1));
    return Array.from({ length: k }, (_, j) => win(g.ri, start + j));
  }

  return { P, LOADS, SIDE_NAMES, WPR, load, rec, cls, label, win, sample, run, get ready() { return !!q; }, get records() { return P.records; } };
})();
