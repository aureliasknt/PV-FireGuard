'use strict';
/* 实测数据手动导入：DAQ CSV → 浏览器端预处理 → REAL.ingest()
   处理流程与 tools/preprocess_arc.py 一致：
   表头解析（GBK/UTF-8）→ 流式解析数值 → 1024 点分窗 → 剔除无电流窗（交流侧 σ < 20 mV）
   → 在 12.5/37.5/62.5/87.5% 处各取 10 个连续有效窗 → 每 0.1 s 全时段概览 → 按文件名识别标签
   原始文件不保存，只保留抽样后的 40 窗（约 320 KB/记录） */
const ArcImport = (() => {
  const N = 1024, BLOCKS = 4, WPB = 10, OVDT = 0.1, MIN_AC_STD = 0.02, FS_REQ = 100000;
  const LOADS = [['电子开关类负载', '电子开关类'], ['电子开关类', '电子开关类'], ['混合负载', '混合'], ['混合', '混合'], ['阻性负载', '阻性'], ['阻性', '阻性'], ['阻感', '阻感'], ['感性', '感性']];

  /* 文件名 → 负载类型、电弧位置、序号（规则同 preprocess_arc.py；无法识别时标为“未标注”） */
  function parseName(file) {
    const name = file.replace(/\.[^.]+$/, '');
    const hit = LOADS.find(([k]) => name.includes(k));
    const side = /直流侧弧|直流侧电弧|dc_?arc/i.test(name) ? 'dc' : /交流侧弧|交流侧电弧|ac_?arc/i.test(name) ? 'ac' : /noarc|无弧|无电弧|正常/i.test(name) ? 'none' : 'unknown';
    const m = name.match(/_(\d+)_(?:no)?arc$/i) || name.match(/_(\d+)$/);
    const seq = m ? +m[1] : 1;
    return { load: hit ? hit[1] : '未知', side, seq };
  }

  /* 表头：读取前 8 KB，识别非数值行；返回采样率、通道名与数据起始字节 */
  async function readHeader(file) {
    const bytes = new Uint8Array(await file.slice(0, 8192).arrayBuffer());
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { text = new TextDecoder('gbk').decode(bytes); }
    const lines = text.split('\n');
    let k = 0;
    while (k < lines.length - 1 && !/^\s*[-+]?(\d|\.\d)/.test(lines[k])) k++;
    const head = lines.slice(0, k).map(s => s.trim());
    let fs = null, nch = null, names = null;
    head.forEach((ln, i) => {
      const kv = ln.split(/[:：]/);
      if (kv.length >= 2) {
        const key = kv[0], v = parseFloat(kv[1]);
        if (/采样|rate|fs/i.test(key) && isFinite(v)) fs = v;
        else if (/通道|channel/i.test(key) && isFinite(v)) nch = v;
      } else if (ln.includes(',')) names = ln.split(',').map(s => s.trim());
      if (i === 1 && fs == null && kv.length >= 2 && isFinite(parseFloat(kv[1]))) fs = parseFloat(kv[1]);
    });
    let off = 0, nl = 0;
    while (nl < k && off < bytes.length) { if (bytes[off] === 10) nl++; off++; }
    return { fs, nch, names, dataStart: off, headerLines: head };
  }

  /* 流式解析数值 CSV（逐字节状态机，只取前两列） */
  async function parseData(file, start, onProgress) {
    let cap = Math.max(1 << 16, Math.ceil((file.size - start) / 30)), n = 0;
    let c0 = new Float32Array(cap), c1 = new Float32Array(cap);
    let ip = 0, fp = 0, fd = 1, ex = 0, neg = false, eneg = false, inF = false, inE = false, has = false, col = 0, v0 = 0;
    const reader = file.slice(start).stream().getReader();
    let done = 0, last = 0;
    const finish = () => {
      if (!has) return NaN;
      let v = ip + fp / fd; if (inE) v *= Math.pow(10, eneg ? -ex : ex);
      return neg ? -v : v;
    };
    const reset = () => { ip = 0; fp = 0; fd = 1; ex = 0; neg = false; eneg = false; inF = false; inE = false; has = false; };
    for (;;) {
      const { value, done: end } = await reader.read();
      if (end) break;
      for (let i = 0; i < value.length; i++) {
        const c = value[i];
        if (c >= 48 && c <= 57) { has = true; if (inE) ex = ex * 10 + c - 48; else if (inF) { fp = fp * 10 + c - 48; fd *= 10; } else ip = ip * 10 + c - 48; }
        else if (c === 46) inF = true;
        else if (c === 45) { if (inE) eneg = true; else neg = true; }
        else if (c === 69 || c === 101) inE = true;
        else if (c === 44 || c === 9 || c === 59) { const v = finish(); if (col === 0) v0 = v; else if (col === 1) { if (n >= cap) { cap *= 2; const a = new Float32Array(cap), b = new Float32Array(cap); a.set(c0); b.set(c1); c0 = a; c1 = b; } c0[n] = v0; c1[n] = v; n++; } col++; reset(); }
        else if (c === 10) { if (col === 1) { const v = finish(); if (n >= cap) { cap *= 2; const a = new Float32Array(cap), b = new Float32Array(cap); a.set(c0); b.set(c1); c0 = a; c1 = b; } c0[n] = v0; c1[n] = v; n++; } col = 0; reset(); }
      }
      done += value.length;
      const now = Date.now();
      if (now - last > 120) { last = now; onProgress && onProgress(done / (file.size - start)); await new Promise(r => setTimeout(r, 0)); }
    }
    if (col === 1 && has) { const v = finish(); if (n < cap) { c0[n] = v0; c1[n] = v; n++; } }
    return [c0.subarray(0, n), c1.subarray(0, n)];
  }

  /* 分窗 → 清洗 → 抽样 → 概览 */
  function preprocess(dc, ac, fs) {
    const n = Math.min(dc.length, ac.length), nw = Math.floor(n / N);
    if (nw < BLOCKS * WPB + BLOCKS) throw new Error(`数据过短：${(n / fs).toFixed(2)} s，至少需要 ${((BLOCKS * WPB + BLOCKS) * N / fs).toFixed(2)} s`);
    const bad = new Int32Array(nw + 1);   // 无效窗前缀和
    let invalid = 0;
    for (let w = 0; w < nw; w++) {
      let m = 0, s = 0; for (let i = w * N; i < (w + 1) * N; i++) m += ac[i]; m /= N;
      for (let i = w * N; i < (w + 1) * N; i++) s += (ac[i] - m) ** 2;
      const ok = Math.sqrt(s / N) >= MIN_AC_STD && Number.isFinite(m);
      if (!ok) invalid++;
      bad[w + 1] = bad[w] + (ok ? 0 : 1);
    }
    const allValid = s => bad[s + WPB] - bad[s] === 0;
    const starts = [];
    for (let b = 0; b < BLOCKS; b++) {
      const c = Math.floor(nw * (b + 0.5) / BLOCKS) - WPB / 2;
      let found = null;
      for (let d = 0; d <= nw && found == null; d++) for (const s of d ? [c - d, c + d] : [c]) {
        if (s < 0 || s > nw - WPB) continue;
        if (allValid(s) && starts.every(t => Math.abs(s - t) >= WPB)) { found = s; break; }
      }
      if (found == null) throw new Error(`有效窗口不足（无电流窗 ${invalid}/${nw}），无法抽取 ${BLOCKS} 段连续采样`);
      starts.push(found);
    }
    starts.sort((a, b) => a - b);
    const buf = new Float32Array(BLOCKS * 2 * WPB * N);
    starts.forEach((s0, b) => { buf.set(dc.subarray(s0 * N, (s0 + WPB) * N), b * 2 * WPB * N); buf.set(ac.subarray(s0 * N, (s0 + WPB) * N), (b * 2 + 1) * WPB * N); });
    const step = Math.round(fs * OVDT), k = Math.floor(n / step), ov = { dcMean: [], dcHf: [], acRms: [] };
    for (let j = 0; j < k; j++) {
      let sm = 0, sa = 0, dm = 0, d2 = 0;
      for (let i = j * step; i < (j + 1) * step; i++) { sm += dc[i]; sa += ac[i] * ac[i]; if (i > j * step) { const d = dc[i] - dc[i - 1]; dm += d; d2 += d * d; } }
      const nd = step - 1; dm /= nd;
      ov.dcMean.push(+(sm / step).toFixed(3)); ov.acRms.push(+Math.sqrt(sa / step).toFixed(3));
      ov.dcHf.push(+(Math.sqrt(Math.max(0, d2 / nd - dm * dm)) * 1000).toFixed(1));
    }
    return { dur: +(n / fs).toFixed(2), samples: n, windows: nw, invalid, blocks: starts, ov, buf };
  }

  /* 单个文件完整导入流程；opts: { fsDefault, map: 'auto' | 'ac0' | 'dc0' } */
  async function importFile(file, opts, onProgress) {
    if (/\.(rar|zip|7z)$/i.test(file.name)) throw new Error('浏览器无法直接解压压缩包，请先解压（如 5-30.rar），再选择其中的 CSV 文件或整个文件夹');
    const t0 = performance.now();
    const h = await readHeader(file);
    const fs = h.fs || opts.fsDefault;
    if (fs !== FS_REQ) throw new Error(`采样率 ${fs / 1000} kHz 不符合要求：当前特征与模型按 ${FS_REQ / 1000} kHz 设计`);
    if (h.nch != null && h.nch < 2) throw new Error('需要 2 个通道（交流侧、直流侧）');
    let dcIdx = 1, how = '默认：通道0=交流，通道1=直流';
    if (opts.map === 'dc0') { dcIdx = 0; how = '手动：通道0=直流，通道1=交流'; }
    else if (opts.map === 'ac0') how = '手动：通道0=交流，通道1=直流';
    else if (h.names && h.names.length >= 2) {
      const di = h.names.findIndex(s => s.includes('直流') || /\bdc\b/i.test(s));
      if (di === 0 || di === 1) { dcIdx = di; how = `表头：${h.names.slice(0, 2).join(' / ')}`; }
    }
    const [c0, c1] = await parseData(file, h.dataStart, onProgress);
    if (c0.length < N) throw new Error('未解析到有效数值数据（需为两列数值 CSV）');
    const dc = dcIdx === 0 ? c0 : c1, ac = dcIdx === 0 ? c1 : c0;
    const pp = preprocess(dc, ac, fs);
    const lab = parseName(file.name);
    return {
      file: file.name, ...lab, split: lab.side === 'unknown' ? 'none' : lab.seq === 1 ? 'train' : 'test',
      ...pp, fs, chMap: how, rawBytes: file.size, importedAt: new Date().toISOString(), parseMs: Math.round(performance.now() - t0)
    };
  }

  /* 拖放：递归展开文件夹 */
  async function filesFromDrop(dt) {
    const out = [], items = [...(dt.items || [])].map(i => i.webkitGetAsEntry && i.webkitGetAsEntry()).filter(Boolean);
    if (!items.length) return [...dt.files];
    const walk = async e => {
      if (e.isFile) out.push(await new Promise((res, rej) => e.file(res, rej)));
      else if (e.isDirectory) {
        const rd = e.createReader();
        for (;;) { const ents = await new Promise((res, rej) => rd.readEntries(res, rej)); if (!ents.length) break; for (const x of ents) await walk(x); }
      }
    };
    for (const e of items) await walk(e);
    return out;
  }

  return { parseName, readHeader, parseData, preprocess, importFile, filesFromDrop, N, BLOCKS, WPB };
})();
if (typeof module !== 'undefined') module.exports = ArcImport;
