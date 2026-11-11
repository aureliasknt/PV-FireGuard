'use strict';
/* 实测数据源
   1) 示例数据：data/arc-real.js（5-30.rar 经 tools/preprocess_arc.py 预处理），int16 码值 × LSB = 采集卡读数 / V。
      平台初始状态为空（等待数据接入）；示例数据仅在用户点击“加载示例数据”后启用，可随时移除，该选择保存在 localStorage
   2) 导入记录：用户手动导入的 DAQ CSV（js/arc-import.js 在浏览器端完成同样的预处理），Float32 存储，保存于 IndexedDB
   每条记录：4 段连续采样 × 10 窗 × 1024 点 × 2 通道（直流侧、交流侧）
   ingest() 为统一的数据接入口：手动导入现在走这里，后续实时采集接入也可调用同一接口 */
const REAL = (() => {
  const P = ARC_REAL;
  const SIDE_CLS = { none: 0, dc: 1, ac: 2, unknown: null };
  const SIDE_NAMES = { none: '无电弧', dc: '直流侧电弧', ac: '交流侧电弧', unknown: '未标注' };
  const SPLIT_NAMES = { train: '训练集', test: '测试集', none: '不参与训练' };
  const WPR = P.blocks * P.wpb;       // 每记录窗口数
  const builtin = P.records.map(r => ({ ...r, src: 'builtin' }));
  const EX_KEY = 'pvfg-include-example';
  let includeExample = false;   // 是否启用示例数据（默认不启用）
  try { includeExample = localStorage.getItem(EX_KEY) === '1'; } catch (e) { /* 存储不可用时默认不包含 */ }
  let imported = [], records = [], q = null, loading = null, loaded = false;
  const listeners = [];

  function decode() {
    const s = atob(P.blob), bin = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) bin[i] = s.charCodeAt(i);
    const ds = new Blob([bin]).stream().pipeThrough(new DecompressionStream('gzip'));
    return new Response(ds).arrayBuffer().then(buf => {
      const d = new Int16Array(buf), out = new Int16Array(d.length);
      let acc = 0;
      for (let i = 0; i < d.length; i++) { acc += d[i]; out[i] = acc; }   // 一阶差分还原
      q = out;
    });
  }
  let decoding = null;
  const ensureDecoded = () => decoding || (decoding = decode());
  // 示例数据始终解码（仅约 100 ms），但只有用户启用时才进入当前数据集；未启用时仅作为缺失类别的补充来源
  const load = () => loading || (loading = Promise.all([ensureDecoded(), restore()]).then(() => { loaded = true; rebuild(); }));

  /* 示例数据是否参与：没有导入数据时自动参与（初始状态）；有导入数据时由用户选择 */
  const exampleActive = () => !!q && includeExample;   // 示例数据仅在用户启用时参与
  async function setExample(on) {
    await ensureDecoded();
    includeExample = !!on;
    try { localStorage.setItem(EX_KEY, on ? '1' : '0'); } catch (e) { /* 忽略 */ }
    rebuild();
  }

  /* 导入记录与同名内置记录合并：同名文件以导入版本为准 */
  function rebuild() {
    const names = new Set(imported.map(r => r.file));
    records = (exampleActive() ? builtin.filter(r => !names.has(r.file)) : []).concat(imported);
    listeners.forEach(f => { try { f(); } catch (e) { console.error(e); } });
  }
  const onChange = f => listeners.push(f);

  /* ---------- IndexedDB 持久化（失败时仅保留在内存中） ---------- */
  const DB = 'pvfg-data', STORE = 'arcImports';
  function db() {
    return new Promise((res, rej) => {
      const r = indexedDB.open(DB, 1);
      r.onupgradeneeded = () => r.result.createObjectStore(STORE, { keyPath: 'id' });
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    });
  }
  async function tx(mode, fn) {
    const d = await db();
    return new Promise((res, rej) => { const t = d.transaction(STORE, mode), s = t.objectStore(STORE), out = fn(s); t.oncomplete = () => res(out && out.result); t.onerror = () => rej(t.error); });
  }
  async function restore() {
    try {
      const all = await tx('readonly', s => s.getAll());
      if (all && all.length) imported = all.sort((a, b) => a.id.localeCompare(b.id));
    } catch (e) { console.warn('无法读取已导入数据', e); }
  }
  const persist = r => tx('readwrite', s => s.put(r)).catch(e => console.warn('导入数据未能持久化', e));

  /* ---------- 数据接入 ---------- */
  function nextId() {
    const n = imported.reduce((m, r) => Math.max(m, +r.id.slice(1) || 0), 0);
    return 'U' + String(n + 1).padStart(2, '0');
  }
  async function ingest(r) {
    const old = imported.find(x => x.file === r.file);
    r.id = old ? old.id : nextId();
    r.src = 'import';
    imported = imported.filter(x => x.file !== r.file).concat([r]).sort((a, b) => a.id.localeCompare(b.id));
    await persist(r);
    rebuild();
    return r;
  }
  async function update(id, patch) {
    const r = imported.find(x => x.id === id); if (!r) return;
    Object.assign(r, patch); await persist(r); rebuild();
  }
  async function remove(id) {
    imported = imported.filter(x => x.id !== id);
    await tx('readwrite', s => s.delete(id)).catch(() => {});
    rebuild();
  }
  /* 重置：清空全部导入记录（含 IndexedDB 副本）并移除示例数据，平台回到初始状态（等待数据接入） */
  async function resetAll() {
    imported = []; includeExample = false;
    try { localStorage.setItem(EX_KEY, '0'); } catch (e) { /* 忽略 */ }
    await tx('readwrite', s => s.clear()).catch(() => {});
    rebuild();
  }
  async function clear() {
    imported = [];
    await tx('readwrite', s => s.clear()).catch(() => {});
    rebuild();
  }

  const rec = i => records[i];
  const indexOf = id => records.findIndex(r => r.id === id);
  const cls = r => SIDE_CLS[(typeof r === 'number' ? rec(r) : r).side];
  const label = r => `${r.id} ${r.load}负载 · ${SIDE_NAMES[r.side]} · #${r.seq}`;

  /* 取第 ri 个记录的第 w 个窗口（0…39），返回双通道信号与在原文件中的时刻 */
  /* 读取任意记录（含未启用的示例记录）的第 w 个窗口（0…39） */
  function winOf(r, w, ri = -1) {
    const N = P.N, b = Math.floor(w / P.wpb), j = w % P.wpb;
    const dc = new Float64Array(N), ac = new Float64Array(N);
    if (r.buf) {
      const base = b * 2 * P.wpb * N;
      for (let i = 0; i < N; i++) { dc[i] = r.buf[base + j * N + i]; ac[i] = r.buf[base + (P.wpb + j) * N + i]; }
    } else {
      const base = r.offset + b * 2 * P.wpb * N;
      for (let i = 0; i < N; i++) { dc[i] = q[base + j * N + i] * P.lsb; ac[i] = q[base + (P.wpb + j) * N + i] * P.lsb; }
    }
    return { dc, ac, ri, rec: r, w, block: b, t: (r.blocks[b] + j) * N / P.fs, cls: cls(r) };
  }
  /* 取当前数据集中第 ri 个记录的第 w 个窗口 */
  const win = (ri, w) => winOf(rec(ri), w, ri);

  /* 示例补充：当前未启用、且未被同名导入文件替换的示例记录（导入数据缺少某类样本时用于补充） */
  const supplement = () => {
    if (!q || exampleActive()) return [];
    const names = new Set(imported.map(r => r.file));
    return builtin.filter(r => !names.has(r.file));
  };

  /* 按条件随机抽取一个窗口；当前数据中没有符合条件的记录时，可退回到示例补充记录；都没有时返回 null */
  function sample(filter = () => true, fallback = false) {
    const idx = records.map((r, i) => i).filter(i => filter(rec(i)));
    if (idx.length) { const ri = idx[Math.floor(Math.random() * idx.length)]; return win(ri, Math.floor(Math.random() * WPR)); }
    if (!fallback) return null;
    const sup = supplement().filter(filter);
    if (!sup.length) return null;
    const g = winOf(sup[Math.floor(Math.random() * sup.length)], Math.floor(Math.random() * WPR));
    g.supplement = true;
    return g;
  }
  /* 按条件随机抽取 k 个连续窗口（同一连续段内，k ≤ 每段窗数） */
  function run(filter, k, fallback = false) {
    const g = sample(filter, fallback); if (!g) return null;
    const start = g.block * P.wpb + Math.floor(Math.random() * (P.wpb - k + 1));
    return Array.from({ length: k }, (_, j) => { const x = winOf(g.rec, start + j, g.ri); x.supplement = g.supplement; return x; });
  }

  return {
    P, SIDE_NAMES, SPLIT_NAMES, WPR, load, rec, indexOf, cls, label, win, winOf, sample, run, supplement,
    ingest, update, remove, clear, resetAll, onChange, setExample,
    get ready() { return loaded; }, get example() { return exampleActive(); }, get includeExample() { return includeExample; },
    get exampleOnly() { return exampleActive() && imported.length === 0; }, get hasData() { return records.length > 0; },
    get records() { return records; }, get imported() { return imported; },
    get LOADS() { return [...new Set(records.map(r => r.load))]; }
  };
})();
