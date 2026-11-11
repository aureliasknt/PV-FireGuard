'use strict';
/* 模块③ 电弧故障诊断（实测数据）：数据集与预处理 → 采样要求核验 → 双通道多域特征 → 神经网络判别 → 连续窗确认
   信号来源：电弧实验平台 5-30.rar（100 kHz，直流侧 + 交流侧电流），经 tools/preprocess_arc.py 预处理后内嵌于 data/arc-real.js */
const Arc = (() => {
  const st = { model: null, scaler: null, ready: false, training: false, hist: { loss: [], acc: [] }, eval: null, imp: null, cur: null, stream: null, meta: null, norm: null, feats: null };
  const DOMAIN = DSP.DOMAIN;
  const NOISE_UNIT = 0.001;   // 叠加噪声滑块单位：mV

  /* ---------- 数据集与预处理说明 ---------- */
  function renderDataset() {
    if (!REAL.hasData) return;
    const P = REAL.P, R = REAL.records, IM = REAL.imported, EX = R.filter(r => r.src === 'builtin');
    const nTr = R.filter(r => r.split === 'train').length, nTe = R.filter(r => r.split === 'test').length;
    const sum = k => R.reduce((a, r) => a + (r[k] || 0), 0);
    const dur = sum('dur');
    const src = [EX.length ? `示例 ${EX.length} 条（5-30.rar 内置）` : '', IM.length ? `手动导入 ${IM.length} 条` : ''].filter(Boolean).join(' + ');
    U.$('#arc-ds-sub').textContent = src;
    const steps = [
      ['① 数据来源', `DAQ ${P.fs / 1000} kHz × 2 通道（交流侧、直流侧电流）：${src}`, `${R.length} 条 · ${dur >= 60 ? (dur / 60).toFixed(1) + ' min' : dur.toFixed(1) + ' s'} · ${(sum('samples') / 1e6).toFixed(1)} M 点/通道`],
      ['② 表头与标签', '表头（GBK/UTF-8）校验采样率/通道；文件名 → 负载类型、电弧位置、序号；可手动修改', `${REAL.LOADS.length} 类负载 · ${R.filter(r => r.side === 'unknown').length} 条未标注`],
      ['③ 数值格式', EX.length ? `示例数据按 ADC 步长 ${(P.lsb * 1000).toFixed(2)} mV 存为 int16（误差 ${P.stats.maxQuantErrLsb} LSB）；导入数据保留 Float32 原值` : '导入数据保留 Float32 原值', '近似无损'],
      ['④ 分窗', `${P.N} 点 = ${(P.N / P.fs * 1000).toFixed(2)} ms，与在线诊断窗长一致`, `${sum('windows').toLocaleString()} 窗`],
      ['⑤ 清洗', '剔除无电流窗口（交流侧 σ < 20 mV，负载断开/停机段）', `剔除 ${sum('invalid').toLocaleString()} 窗`],
      ['⑥ 抽样', `每记录在 12.5/37.5/62.5/87.5% 处各取 ${P.wpb} 个连续窗`, `${(R.length * REAL.WPR).toLocaleString()} 窗（${P.blocks}×${P.wpb}/记录）`],
      ['⑦ 存储', '示例：差分+gzip 内嵌于 data/arc-real.js；导入：浏览器 IndexedDB（原始 CSV 不保存）', `${EX.length ? `示例 ${(P.stats.packBytes / 1e6).toFixed(2)} MB` : ''}${EX.length && IM.length ? ' · ' : ''}${IM.length ? `导入 ${(IM.length * REAL.WPR * 2 * P.N * 4 / 1e6).toFixed(1)} MB` : ''}`],
      ['⑧ 划分', '按记录：序号 1 → 训练集，序号 ≥2 → 测试集；未标注记录只诊断不训练', `训练 ${nTr} / 测试 ${nTe} / 共 ${R.length} 条记录`]
    ];
    U.$('#arc-ds-steps').innerHTML = steps.map(r => `<tr><td style="white-space:nowrap"><b>${r[0]}</b></td><td style="font-size:12px">${r[1]}</td><td class="muted" style="font-size:12px">${r[2]}</td></tr>`).join('');
    const cur = +U.$('#arc-rec').value;
    const sides = ['none', 'dc', 'ac'].concat(R.some(r => r.side === 'unknown') ? ['unknown'] : []);
    U.$('#arc-ds-mat-h').innerHTML = `<th>负载类型</th>${sides.map(sd => `<th>${REAL.SIDE_NAMES[sd]}</th>`).join('')}`;
    U.$('#arc-ds-mat').innerHTML = REAL.LOADS.map(L => `<tr><td><b>${L}</b></td>${sides.map(sd => `<td>${R.map((r, i) => [r, i]).filter(([r]) => r.load === L && r.side === sd)
      .map(([r, i]) => `<span class="rchip ${r.split === 'train' ? 'train' : ''} ${r.src === 'import' ? 'imp' : ''} ${i === cur ? 'on' : ''}" data-ri="${i}" title="${r.file}${r.src === 'import' ? '（导入）' : ''}">${r.id} · ${Math.round(r.dur)} s</span>`).join('') || '<span class="muted">—</span>'}</td>`).join('')}</tr>`).join('');
    U.$$('#arc-ds-mat .rchip').forEach(el => el.onclick = () => { U.$('#arc-rec').value = el.dataset.ri; onRecChange(); });
  }

  /* 记录下拉框：按负载分组；重建时按记录编号保持当前选择 */
  function buildSelect(keepId) {
    const sel = U.$('#arc-rec');
    sel.innerHTML = '';
    REAL.LOADS.forEach(L => {
      const g = document.createElement('optgroup'); g.label = L === '未知' ? '未知负载' : L + '负载';
      REAL.records.forEach((r, i) => { if (r.load === L) g.insertAdjacentHTML('beforeend', `<option value="${i}">${r.id} ${REAL.SIDE_NAMES[r.side]} #${r.seq}（${REAL.SPLIT_NAMES[r.split]}${r.src === 'import' ? '·导入' : ''}）</option>`); });
      sel.appendChild(g);
    });
    const k = keepId ? REAL.indexOf(keepId) : -1;
    sel.value = k >= 0 ? k : Math.max(0, REAL.records.findIndex(r => r.side === 'dc' && r.split === 'test'));
  }

  /* ---------- 手动导入 ---------- */
  async function handleFiles(list) {
    const files = [...list].filter(f => /\.(csv|txt|rar|zip|7z)$/i.test(f.name));
    if (!files.length) { U.toast('未找到 CSV 文件', 'warn'); return; }
    if (!DATA.guard('model')) return;
    const box = U.$('#arc-imp-prog');
    box.innerHTML = files.map((f, k) => `<div class="ip" id="ip-${k}"><span class="nm" title="${f.name}">${f.name}</span><div class="bar"><i style="width:0%"></i></div><span class="msg">等待中 · ${(f.size / 1e6).toFixed(1)} MB</span></div>`).join('');
    const opts = { fsDefault: +U.$('#arc-imp-fs').value, map: U.$('#arc-imp-map').value };
    const replace = U.$('#arc-imp-mode').value === 'replace' && (REAL.imported.length > 0 || REAL.includeExample);
    if (replace && !confirm(`导入方式为“替换现有数据”：导入成功后将清空当前全部 ${REAL.records.length} 条记录（${dataSummary()}），再写入新数据。是否继续？`)) { box.innerHTML = ''; return; }
    // 先全部解析（失败的文件不影响现有数据），再一次性写入
    const parsed = [];
    for (let k = 0; k < files.length; k++) {
      const f = files[k], row = U.$('#ip-' + k), bar = row.querySelector('i'), msg = row.querySelector('.msg');
      msg.textContent = '解析中…';
      try {
        const r = await ArcImport.importFile(f, opts, p => { bar.style.width = (p * 90).toFixed(0) + '%'; msg.textContent = `解析中 ${(p * 100).toFixed(0)}%`; });
        parsed.push({ r, f, row, bar, msg });
        bar.style.width = '95%'; msg.textContent = '解析完成，等待写入…';
      } catch (e) {
        row.classList.add('err'); bar.style.width = '100%'; bar.style.background = 'var(--red)';
        msg.textContent = '✗ ' + (e.message || e);
      }
    }
    if (replace && parsed.length) {
      const before = dataSummary();
      await REAL.resetAll();
      DATA.audit('替换数据', `清空原有数据（${before}），写入 ${parsed.length} 个新文件`);
    } else if (replace) U.toast('没有文件导入成功，现有数据保持不变', 'warn');
    for (const { r, f, bar, msg } of parsed) {
      const saved = await REAL.ingest(r);
      bar.style.width = '100%';
      msg.textContent = `✓ ${saved.id} · ${saved.load} · ${REAL.SIDE_NAMES[saved.side]} #${saved.seq} · ${saved.dur} s · ${saved.windows} 窗（剔除 ${saved.invalid}）· ${saved.chMap} · ${(saved.parseMs / 1000).toFixed(1)} s`;
      DATA.audit('导入实测数据', `${f.name} → ${saved.id}（${saved.load}，${REAL.SIDE_NAMES[saved.side]}，${saved.dur} s）`);
    }
    const ok = parsed.length;
    U.toast(`导入完成：成功 ${ok} / ${files.length} 个文件${replace && ok ? '（已替换原有数据）' : ''}`, ok === files.length ? 'ok' : 'warn');
    if (ok && U.$('#arc-imp-train').checked) train();
  }

  const dataSummary = () => {
    const nImp = REAL.imported.length, nEx = REAL.records.length - nImp;
    return [nImp ? `导入 ${nImp} 条` : '', nEx ? `示例 ${nEx} 条` : ''].filter(Boolean).join('、') || '无';
  };

  function renderImports() {
    const IM = REAL.imported;
    U.$('#arc-imp-sub').textContent = IM.length ? `${IM.length} 条 · 共 ${(IM.reduce((a, r) => a + r.rawBytes, 0) / 1e6).toFixed(0)} MB 原始数据` : '';
    const opt = (o, v) => Object.entries(o).map(([k, n]) => `<option value="${k}" ${k === v ? 'selected' : ''}>${n}</option>`).join('');
    const loads = [...new Set(['阻性', '感性', '阻感', '电子开关类', '混合', '未知'].concat(IM.map(r => r.load)))];
    U.$('#arc-imp-list').innerHTML = IM.map(r => `<tr>
      <td><b>${r.id}</b></td><td style="font-size:12px;max-width:190px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${r.file}">${r.file}</td>
      <td><select class="imp-sel" data-id="${r.id}" data-k="load">${loads.map(l => `<option ${l === r.load ? 'selected' : ''}>${l}</option>`).join('')}</select></td>
      <td><select class="imp-sel" data-id="${r.id}" data-k="side">${opt(REAL.SIDE_NAMES, r.side)}</select></td>
      <td><select class="imp-sel" data-id="${r.id}" data-k="split">${opt(REAL.SPLIT_NAMES, r.split)}</select></td>
      <td class="muted" style="font-size:12px;white-space:nowrap">${r.dur} s · ${r.windows}</td>
      <td><button class="btn sm" data-del="${r.id}">删除</button></td></tr>`).join('') || '<tr><td colspan="7" class="muted">暂无导入数据。可导入解压后的 5-30 文件夹中的 CSV。</td></tr>';
    U.$$('#arc-imp-list .imp-sel').forEach(el => el.onchange = () => {
      if (!DATA.guard('model')) { renderImports(); return; }
      const patch = { [el.dataset.k]: el.value };
      if (el.dataset.k === 'side' && el.value === 'unknown') patch.split = 'none';
      REAL.update(el.dataset.id, patch);
      DATA.audit('修改导入数据标注', `${el.dataset.id}：${el.dataset.k} → ${el.value}`);
      U.$('#arc-train-info').innerHTML = '<span style="color:#f97316">数据集标注已变更，请点击“重新训练”使模型生效。</span>';
    });
    U.$$('#arc-imp-list [data-del]').forEach(el => el.onclick = () => {
      if (!DATA.guard('model')) return;
      if (!confirm(`删除导入记录 ${el.dataset.del}？`)) return;
      REAL.remove(el.dataset.del).then(() => {
        DATA.audit('删除导入数据', el.dataset.del);
        if (REAL.hasData && U.$('#arc-imp-train').checked) train();
        else if (REAL.hasData) U.$('#arc-train-info').innerHTML = '<span style="color:#f97316">数据集已变更，请点击“重新训练”使模型生效。</span>';
      });
    });
  }

  /* 数据集变更（导入/修改/删除）后刷新页面各部分 */
  function onDataChange() {
    const keep = st.cur ? st.cur.id : null;
    st.feats = null;
    buildSelect(keep);
    const exb = U.$('#arc-example');
    exb.disabled = false;
    exb.textContent = REAL.includeExample ? '移除示例数据' : '加载示例数据';
    exb.title = '5-30.rar 内置 29 条实测记录，可单独演示，也可与导入数据一起作为训练集';
    renderDataset(); renderImports(); updWinLabel(); drawOverview();
    if (!REAL.hasData) {
      st.cur = null; st.stream = null; st.ready = false; st.evalM = st.deploy = null; st.meta = null; st.eval = null; st.imp = null; st.hist = { loss: [], acc: [] }; st.trainError = null;
      U.$('#arc-train-info').textContent = '等待数据接入：导入 CSV 或加载示例数据后自动训练。';
      return;
    }
    if (!st.ready) { train(); return; }   // 首次有数据：自动训练
    if (Main.current() === 'arc') diagnose();
  }

  function initImport() {
    const drop = U.$('#arc-drop');
    U.$('#arc-pick').onclick = () => U.$('#arc-file').click();
    U.$('#arc-pick-dir').onclick = () => U.$('#arc-dir').click();
    U.$('#arc-file').onchange = e => { handleFiles(e.target.files); e.target.value = ''; };
    U.$('#arc-dir').onchange = e => { handleFiles(e.target.files); e.target.value = ''; };
    drop.ondragover = e => { e.preventDefault(); drop.classList.add('over'); };
    drop.ondragleave = () => drop.classList.remove('over');
    drop.ondrop = async e => { e.preventDefault(); drop.classList.remove('over'); handleFiles(await ArcImport.filesFromDrop(e.dataTransfer)); };
    U.$('#arc-imp-clear').onclick = async () => {
      if (!REAL.imported.length || !DATA.guard('model')) return;
      if (!confirm(`确定清除全部 ${REAL.imported.length} 条导入记录？`)) return;
      await REAL.clear(); DATA.audit('清除导入数据', '全部'); U.$('#arc-imp-prog').innerHTML = '';
      if (REAL.hasData) train();
    };
    U.$('#arc-reset').onclick = async () => {
      if (!REAL.hasData && !REAL.imported.length && !Hotspot.state.src && !Risk.last) { U.toast('当前已是初始状态（无数据），无需重置', 'info'); return; }
      if (!DATA.guard('model')) return;
      if (!confirm(`重置数据将清空：
· 全部记录（${dataSummary()}），包括保存在本浏览器中的导入副本
· 已训练的判别模型
· 电站监测历史、告警日志与事件档案
· 热异常诊断与电—热融合评估结果

平台回到初始状态“等待数据接入”，之后可重新导入其他数据。审计日志保留。是否继续？`)) return;
      const before = dataSummary();
      await REAL.resetAll();
      Hotspot.clear(); Risk.clear();   // 其他模块中由用户输入产生的结果一并清除
      U.$('#arc-imp-prog').innerHTML = '';
      DATA.audit('重置数据', `清空全部数据（${before}），并清除热异常诊断与融合评估结果`);
      U.toast('已重置为初始状态（无数据），可重新导入', 'ok');
    };
    U.$('#arc-example').onclick = async () => {
      if (!DATA.guard('model')) return;
      const on = !REAL.includeExample;
      U.$('#arc-example').disabled = true;
      await REAL.setExample(on);
      U.$('#arc-example').disabled = false;
      DATA.audit(on ? '加载示例数据' : '移除示例数据', '5-30.rar 内置 29 条记录');
      if (REAL.hasData && st.ready) train();
      U.toast(on ? '已加载示例数据（5-30 内置 29 条记录）' : '已移除示例数据', 'ok');
    };
    REAL.onChange(onDataChange);
    renderImports();
  }

  /* 记录全时段概览：每 0.1 s 的直流均值、直流高频分量、交流有效值 */
  function drawOverview() {
    if (!REAL.hasData) return;
    const ri = +U.$('#arc-rec').value, r = REAL.rec(ri), P = REAL.P, ov = r.ov;
    const t = ov.dcMean.map((_, i) => +(i * P.overviewDt).toFixed(2));
    const nrm = a => { const mx = Math.max(...a.map(Math.abs)) || 1; return { y: a.map(v => v / mx), mx }; };
    const hf = nrm(ov.dcHf), ac = nrm(ov.acRms), dm = nrm(ov.dcMean);
    const w = +U.$('#arc-w').value, b = Math.floor(w / P.wpb);
    const winT = (r.blocks[b] + w % P.wpb) * P.N / P.fs;
    U.$('#arc-ov-sub').textContent = `${r.file} · ${r.dur} s · ${r.windows} 窗${r.invalid ? `（剔除 ${r.invalid}）` : ''}`;
    U.lineChart(U.$('#arc-ov'), {
      series: [
        { x: t, y: hf.y, color: '#ef4444', width: 1.2, label: `直流高频分量（峰 ${hf.mx.toFixed(0)} mV）` },
        { x: t, y: ac.y, color: '#a78bfa', width: 1.2, label: `交流有效值（峰 ${ac.mx.toFixed(2)} V）` },
        { x: t, y: dm.y, color: '#38bdf8', width: 1.2, label: `直流均值（峰 ${dm.mx.toFixed(2)} V）` }
      ],
      yMin: 0, yMax: 1.12, xLabel: '原始记录时间 / s', yLabel: '归一化',
      vlines: r.blocks.map((s, k) => ({ x: s * P.N / P.fs, label: `段${k + 1}`, color: '#94a3b8', dy: 14 })).concat([{ x: winT, label: '当前窗', color: '#f97316', dy: 30 }])
    });
  }

  function onRecChange() {
    if (!REAL.hasData) return;
    renderDataset(); drawOverview(); updWinLabel();
    if (REAL.ready) diagnose();
  }
  function updWinLabel() {
    if (!REAL.hasData) { U.$('#arc-w-v').textContent = ''; return; }
    const r = REAL.rec(+U.$('#arc-rec').value), w = +U.$('#arc-w').value, P = REAL.P, b = Math.floor(w / P.wpb);
    U.$('#arc-w-v').textContent = `#${w + 1} · 段${b + 1} · t=${((r.blocks[b] + w % P.wpb) * P.N / P.fs).toFixed(3)} s`;
  }

  function init() {
    const sel = U.$('#arc-rec');
    buildSelect();
    sel.onchange = onRecChange;
    U.$('#arc-w').addEventListener('input', () => { updWinLabel(); drawOverview(); });
    U.$('#arc-w').addEventListener('change', () => { if (REAL.ready) diagnose(); });
    U.range('arc-noise', v => v ? v + ' mV' : '无');
    U.range('arc-loss', v => v.toFixed(1) + '%');
    U.$('#arc-gen').onclick = diagnose;
    U.$('#arc-rand').onclick = () => {
      sel.value = U.randi(0, REAL.records.length - 1);
      U.$('#arc-w').value = U.randi(0, REAL.WPR - 1);
      onRecChange();
    };
    U.$('#arc-train').onclick = () => { if (DATA.guard('model')) { DATA.audit('电弧模型重新训练', `实测数据，${U.$('#arc-split').selectedOptions[0].text}划分，隐层 ${U.$('#arc-h').value}`); train(); } };
    U.$('#arc-stream').onclick = stream;
    initImport();
    renderDataset(); updWinLabel();
  }

  /* 判别：输入 {dc, ac} 双通道窗口，返回 3 类概率
     use = 'eval'：评估模型（仅训练集记录训练，本页诊断/回放用，测试记录对其未知）
     use = 'deploy'：部署模型（全部记录训练，在线监测用） */
  function classify(g, use = 'deploy') {
    const f = DSP.features(g.dc, g.ac);
    const M = use === 'eval' ? st.evalM : st.deploy;
    if (!st.ready || !M) return { probs: [1, 0, 0], f, ready: false };
    return { probs: M.model.predict(M.scaler.transform(f)), f, ready: true };
  }
  const arcProb = p => p[1] + p[2];

  /* 诊断证据：相对正常工况分布偏离最大的特征（z 分数） */
  function evidence(f, k = 3) {
    if (!st.norm) return [];
    return f.map((v, i) => ({ i, name: DSP.FEATURE_NAMES[i], dom: DOMAIN(i), v, z: (v - st.norm.mu[i]) / st.norm.sd[i] }))
      .sort((a, b) => Math.abs(b.z) - Math.abs(a.z)).slice(0, k);
  }
  const evTxt = ev => ev.map(e => `${e.name} ${e.z >= 0 ? '+' : ''}${e.z.toFixed(1)}σ`).join('、');

  /* 采样要求核验：采样率、窗长、数据完整率（帧序号校验）、量程饱和（双通道取最差值）
     注：实测电流本身存在恒值段（交流电弧过零“零休”、整流侧断续导通），故不以波形恒值判断丢包 */
  const REQ = { fs: 100000, winMs: 10, comp: 0.99, clip: 0.005 };
  const RANGE = 10;   // 采集卡量程 ±10 V
  function sampleCheck(g, fsDev) {
    const lim = (g.range || RANGE) - REAL.P.lsb / 2;
    let nClip = 0; for (const x of [g.dc, g.ac]) for (const v of x) if (Math.abs(v) >= lim) nClip++;
    const comp = 1 - (g.missing || 0) / g.dc.length, clip = nClip / (2 * g.dc.length), winMs = g.dc.length / DSP.FS * 1000;
    const items = [
      ['采样率', `${fsDev / 1000} kHz`, `≥ ${REQ.fs / 1000} kHz`, fsDev >= REQ.fs],
      ['窗长', `${winMs.toFixed(2)} ms`, `≥ ${REQ.winMs} ms`, winMs >= REQ.winMs],
      ['数据完整率', `${(comp * 100).toFixed(2)}%`, `≥ ${REQ.comp * 100}%`, comp >= REQ.comp],
      ['量程饱和/削波', `${(clip * 100).toFixed(2)}%`, `≤ ${REQ.clip * 100}%`, clip <= REQ.clip]
    ];
    return { items, ok: items.every(i => i[3]) };
  }
  /* 采集条件劣化：叠加白噪声（按 ADC 步长量化）、丢包（保持上一值并计入缺失）、传感器量程不足导致削波 */
  function degrade(g, p) {
    const lsb = REAL.P.lsb;
    if (p.noise > 0) [g.dc, g.ac].forEach(x => { for (let i = 0; i < x.length; i++) x[i] = Math.round((x[i] + U.randn() * p.noise * NOISE_UNIT) / lsb) * lsb; });
    if (p.sat) {   // 模拟选用量程过小的传感器：量程 = 窗口峰值的 60%
      let pk = 0; for (const x of [g.dc, g.ac]) for (const v of x) pk = Math.max(pk, Math.abs(v));
      g.range = 0.6 * pk;
      [g.dc, g.ac].forEach(x => { for (let i = 0; i < x.length; i++) x[i] = Math.max(-g.range, Math.min(g.range, x[i])); });
    }
    if (p.loss > 0) {
      const lost = new Uint8Array(g.dc.length), nGap = Math.max(1, Math.round(g.dc.length * p.loss / 100 / 24));
      for (let k = 0; k < nGap; k++) { const a = U.randi(1, g.dc.length - 30); for (let i = a; i < a + 24; i++) { g.dc[i] = g.dc[a - 1]; g.ac[i] = g.ac[a - 1]; lost[i] = 1; } }
      g.missing = lost.reduce((s, v) => s + v, 0);
    }
    return g;
  }

  /* ---------- 训练：全部实测窗口提取特征 → MLP ---------- */
  /* 只使用已标注记录；R 保存记录快照，避免训练过程中数据集变更导致错位 */
  /* supp：导入数据缺少某类样本时，追加 5-30 示例记录（实测）作为训练/评估补充 */
  async function extractAll(info, supp = false) {
    if (st.feats && st.feats.supp === supp) return st.feats;
    await REAL.load();
    const X = [], Y = [], R = [];
    const recs = REAL.records.filter(r => REAL.cls(r) != null).concat(supp ? REAL.supplement() : []);
    for (let k = 0; k < recs.length; k++) {
      const r = recs[k];
      for (let w = 0; w < REAL.WPR; w++) { const g = REAL.winOf(r, w); X.push(DSP.features(g.dc, g.ac)); Y.push(g.cls); R.push(r); }
      info.textContent = `读取实测数据并提取特征：记录 ${k + 1}/${recs.length}（${X.length} 窗）…`;
      await U.sleep(0);
    }
    return (st.feats = { X, Y, R, supp, nSupp: supp ? recs.length - REAL.records.filter(r => REAL.cls(r) != null).length : 0 });
  }

  async function train() {
    if (st.training) { st.retrain = true; return; }
    st.training = true; st.retrain = false;
    await REAL.load();
    const split = U.$('#arc-split').value;
    // 导入数据是否足以训练：训练集需含 3 类样本，按记录划分时还需测试集；不足时自动用示例数据补充
    const act = REAL.records.filter(r => REAL.cls(r) != null);
    const trCls = new Set(act.filter(r => split !== 'record' || r.split === 'train').map(r => REAL.cls(r)));
    const lack = [0, 1, 2].filter(c => !trCls.has(c));
    const supp = REAL.hasData && (lack.length > 0 || (split === 'record' && !act.some(r => r.split === 'test'))) && REAL.supplement().length > 0;
    if (!REAL.hasData || (!act.length && !supp)) {
      st.ready = false; st.evalM = st.deploy = null; st.cur = null; st.stream = null; st.training = false;
      st.trainError = REAL.hasData ? '记录均未标注' : null;
      U.$('#arc-train-info').textContent = REAL.hasData ? '当前记录均未标注，无法训练判别模型：请在“已导入记录”中标注（无电弧/直流侧/交流侧）。' : '等待数据接入：导入 CSV 或加载示例数据后自动训练。';
      if (REAL.hasData) U.$('#arc-verdict').innerHTML = '<span class="muted">无可用模型：需要至少一组已标注的记录</span>';
      return null;
    }
    const btn = U.$('#arc-train'); btn.disabled = true;
    const info = U.$('#arc-train-info');
    const nHid = +U.$('#arc-h').value, epochs = +U.$('#arc-ep').value;
    const { X, Y, R, nSupp } = await extractAll(info, supp);
    const suppNote = supp ? `导入数据${lack.length ? `缺少「${lack.map(c => DSP.CLASS_NAMES[c]).join('、')}」样本` : '没有测试集记录'}，已自动补充 5-30 示例数据 ${nSupp} 条（实测）参与训练与评估。` : '';
    let tr, te;
    if (split === 'record') {
      tr = X.map((_, i) => i).filter(i => R[i].split === 'train');
      te = X.map((_, i) => i).filter(i => R[i].split === 'test');
      const miss = [0, 1, 2].filter(c => !tr.some(i => Y[i] === c));
      if (miss.length || !te.length) {
        st.ready = false; st.evalM = st.deploy = null; st.cur = null; st.stream = null;
        st.trainError = miss.length ? `训练集缺少「${miss.map(c => DSP.CLASS_NAMES[c]).join('、')}」样本` : '测试集为空';
        info.innerHTML = `<span style="color:#ef4444">无法训练：${st.trainError}，请在“已导入记录”中调整标签或用途，或加载示例数据补充训练集。</span>`;
        st.training = false; btn.disabled = false; return st.meta;
      }
    } else {
      const idx = X.map((_, i) => i);
      for (let i = idx.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [idx[i], idx[j]] = [idx[j], idx[i]]; }
      const k = Math.round(idx.length * 0.7); tr = idx.slice(0, k); te = idx.slice(k);
    }
    for (let i = tr.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [tr[i], tr[j]] = [tr[j], tr[i]]; }
    const scaler = new ML.Scaler().fit(tr.map(i => X[i]));
    const Xtr = tr.map(i => scaler.transform(X[i])), Ytr = tr.map(i => Y[i]);
    const Xte = te.map(i => scaler.transform(X[i])), Yte = te.map(i => Y[i]);
    const nIn = DSP.FEATURE_NAMES.length, nOut = DSP.CLASSES.length;
    const model = new ML.MLP(nIn, nHid, nOut);
    const hist = { loss: [], acc: [], vloss: [] };
    st.hist = hist;
    for (let e = 0; e < epochs; e++) {
      const loss = model.trainEpoch(Xtr, Ytr, { lr: 0.01, batch: 32 });
      const ev = model.evaluate(Xte, Yte);
      hist.loss.push(loss); hist.vloss.push(ev.loss); hist.acc.push(ev.acc);
      if (e % 4 === 3 || e === epochs - 1) { info.textContent = `训练中：第 ${e + 1}/${epochs} 轮，损失 ${loss.toFixed(4)}，测试准确率 ${(ev.acc * 100).toFixed(1)}%`; drawCurve(); await U.sleep(0); }
    }
    st.evalM = { model, scaler };
    const Xn = tr.filter(i => Y[i] === 0).map(i => X[i]), d = nIn;
    const mu = new Array(d).fill(0), sd = new Array(d).fill(0);
    Xn.forEach(x => x.forEach((v, j) => mu[j] += v / Xn.length));
    Xn.forEach(x => x.forEach((v, j) => sd[j] += (v - mu[j]) ** 2 / Xn.length));
    st.norm = { mu, sd: sd.map(v => Math.sqrt(v) + 1e-6) };
    st.eval = model.evaluate(Xte, Yte);
    info.textContent = '计算置换特征重要性 …'; await U.sleep(0);
    st.imp = ML.permutationImportance(model, Xte, Yte, 2);
    const cm = st.eval.cm, rs = r => cm[r].reduce((a, b) => a + b, 0);
    const recall = (cm[1][1] + cm[1][2] + cm[2][1] + cm[2][2]) / (rs(1) + rs(2) || 1);
    const far = (cm[0][1] + cm[0][2]) / (rs(0) || 1);
    // 记录级评估（按记录划分时）：测试记录内全部窗口多数表决 + 连续窗确认
    let rec = null;
    if (split === 'record') {
      const C = FUSE.CFG, by = {};
      const recOf = {};
      te.forEach((i, k) => { recOf[R[i].id] = R[i]; (by[R[i].id] = by[R[i].id] || []).push(model.predict(Xte[k])); });
      const rows = Object.entries(by).map(([id, P]) => {
        const votes = [0, 0, 0]; P.forEach(p => votes[p.indexOf(Math.max(...p))]++);
        let h = 0, conf = false; P.forEach(p => { h = arcProb(p) >= C.pArc ? h + 1 : 0; if (h >= C.nWin) conf = true; });
        const r = recOf[id], y = REAL.cls(r);
        return { r, y, vote: votes.indexOf(Math.max(...votes)), conf, arcFrac: (votes[1] + votes[2]) / P.length };
      });
      rec = { rows, ok: rows.filter(o => o.vote === o.y).length, n: rows.length,
        det: rows.filter(o => o.y > 0 && o.conf).length, nArc: rows.filter(o => o.y > 0).length,
        fa: rows.filter(o => o.y === 0 && o.conf).length, nNorm: rows.filter(o => o.y === 0).length };
    }
    // 评估完成后，用全部记录重新训练部署模型，供在线监测使用
    const scAll = new ML.Scaler().fit(X), XA = X.map(x => scAll.transform(x)), mA = new ML.MLP(nIn, nHid, nOut);
    for (let e = 0; e < epochs; e++) {
      mA.trainEpoch(XA, Y, { lr: 0.01, batch: 32 });
      if (e % 8 === 7) { info.textContent = `使用全部 ${REAL.records.length} 条记录训练在线部署模型：第 ${e + 1}/${epochs} 轮 …`; await U.sleep(0); }
    }
    st.deploy = { model: mA, scaler: scAll }; st.ready = true; st.trainError = null;
    st.meta = { nTrain: Xtr.length, nTest: Xte.length, nIn, nHid, nOut, epochs, split, acc: st.eval.acc, recall, far, rec, time: new Date() };
    const nImp = new Set(R.filter(r => r.src === 'import').map(r => r.id)).size;
    st.meta.nRec = new Set(R.map(r => r.id)).size; st.meta.nImp = nImp;
    st.meta.nSupp = nSupp;
    info.innerHTML = (suppNote ? `<span style="color:#f97316">${suppNote}</span><br>` : '') + `训练完成：${st.meta.nRec} 条已标注记录${nImp ? `（含导入 ${nImp} 条）` : ''}，实测窗口 ${X.length}（训练 ${Xtr.length} / 测试 ${Xte.length}，${split === 'record' ? '按记录划分' : '随机划分'}），网络 ${nIn}-${nHid}-${nOut}。单窗测试准确率 <b>${(st.eval.acc * 100).toFixed(1)}%</b>，电弧检出率 <b>${(recall * 100).toFixed(1)}%</b>，误报率 <b>${(far * 100).toFixed(1)}%</b>。<br>本页诊断与回放使用评估模型；在线监测使用全部已标注记录训练的部署模型。`;
    st.training = false; btn.disabled = false;
    if (st.retrain) { setTimeout(train, 0); return st.meta; }
    drawAll();
    diagnose();
    if (typeof Main !== 'undefined' && Main.current() === 'arc') stream();
    return st.meta;
  }

  function drawCurve() {
    const h = st.hist; if (!h.loss.length) return;
    const lmax = Math.max(...h.loss.slice(0, 3), 0.5);
    U.lineChart(U.$('#arc-curve'), {
      series: [{ y: h.loss.map(v => v / lmax), color: '#f97316', label: '训练损失(归一)' }, { y: h.vloss.map(v => v / lmax), color: '#fbbf24', label: '测试损失', dash: [4, 3] }, { y: h.acc, color: '#00bcd4', label: '测试准确率' }],
      yMin: 0, yMax: 1.05, xLabel: '训练轮次'
    });
  }

  function drawCM() {
    const c = U.$('#arc-cm'), s = U.setup(c); if (!s || !st.eval) return;
    const { ctx, w, h } = s, cm = st.eval.cm, n = cm.length;
    const names = DSP.CLASS_NAMES;
    const m = { l: 76, t: 8, r: 6, b: 34 }, cw = (w - m.l - m.r) / n, ch = (h - m.t - m.b) / n;
    ctx.font = '12px "Microsoft YaHei",sans-serif';
    for (let r = 0; r < n; r++) {
      const rs = cm[r].reduce((a, b) => a + b, 0) || 1;
      for (let k = 0; k < n; k++) {
        const v = cm[r][k] / rs;
        ctx.fillStyle = r === k ? `rgba(0,188,212,${0.12 + 0.75 * v})` : `rgba(239,68,68,${v > 0 ? 0.15 + 0.7 * v : 0.04})`;
        ctx.fillRect(m.l + k * cw + 1, m.t + r * ch + 1, cw - 2, ch - 2);
        ctx.fillStyle = U.theme().strong; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(`${cm[r][k]}（${(v * 100).toFixed(0)}%）`, m.l + k * cw + cw / 2, m.t + r * ch + ch / 2);
      }
      ctx.fillStyle = U.theme().text; ctx.textAlign = 'right'; ctx.fillText(names[r], m.l - 6, m.t + r * ch + ch / 2);
      ctx.textAlign = 'center'; ctx.fillText(names[r], m.l + r * cw + cw / 2, h - m.b + 12);
    }
    ctx.fillText('预测类别 →', m.l + (w - m.l - m.r) / 2, h - 6);
    const M = st.meta;
    U.$('#arc-cm-sub').textContent = M.split === 'record' ? `测试集 · ${M.rec.n} 条未参与训练的记录 · ${M.nTest} 窗` : `测试集 · 随机 30% · ${M.nTest} 窗`;
    U.$('#arc-rec-acc').innerHTML = M.rec
      ? `记录级（每条 ${REAL.WPR} 窗多数表决）：<b>${M.rec.ok}/${M.rec.n}</b> 判对；连续 ${FUSE.CFG.nWin} 窗确认：电弧记录检出 <b>${M.rec.det}/${M.rec.nArc}</b>，无弧记录误报 <b>${M.rec.fa}/${M.rec.nNorm}</b>`
      : '随机划分时同一记录的窗口可能同时出现在训练集与测试集，准确率偏乐观；“按记录”划分更接近实际部署。';
  }

  function drawImp() {
    if (!st.imp) return;
    const order = st.imp.map((v, i) => i).sort((a, b) => st.imp[b] - st.imp[a]).slice(0, 15);
    U.barChart(U.$('#arc-imp'), {
      labels: order.map(i => DSP.FEATURE_NAMES[i]), values: order.map(i => st.imp[i] * 100),
      colors: order.map(i => i < DSP.NB ? '#38bdf8' : '#a78bfa'),
      fmt: v => v.toFixed(1) + '%'
    });
  }

  function currentParams() {
    return { ri: +U.$('#arc-rec').value, w: +U.$('#arc-w').value, noise: +U.$('#arc-noise').value,
      fsDev: +U.$('#arc-fs').value, loss: +U.$('#arc-loss').value, sat: U.$('#arc-sat').checked };
  }

  async function diagnose() {
    await REAL.load();
    if (!REAL.hasData) return;
    const p = currentParams();
    const g = degrade(REAL.win(p.ri, p.w), p);
    const chk = sampleCheck(g, p.fsDev);
    const r = classify(g, 'eval');
    st.cur = { ...p, id: REAL.rec(p.ri).id, g, probs: r.probs, f: r.f, chk };
    renderResult();
    renderDataset();
  }

  function renderResult() {
    const c = st.cur; if (!c) return;
    if (st.ready) { const r = classify(c.g, 'eval'); c.probs = r.probs; c.f = r.f; }
    const rec = REAL.rec(c.ri);
    U.$('#arc-chk').innerHTML = c.chk.items.map(([k, v, th, ok]) => `<tr><td>${k}</td><td>${v}</td><td class="muted">${th}</td><td>${ok ? U.tag('满足', 'ok') : U.tag('不满足', 'red')}</td></tr>`).join('');
    U.$('#arc-wave-sub').textContent = `${rec.id} ${rec.load}负载 · ${REAL.SIDE_NAMES[rec.side]} · 原始 t = ${c.g.t.toFixed(3)} s · 窗长 10.24 ms · fs = 100 kHz`;
    const t = Array.from(c.g.dc, (_, i) => i / DSP.FS * 1000);
    U.lineChart(U.$('#arc-wave'), {
      series: [{ y: Array.from(c.g.dc), x: t, color: '#38bdf8', width: 1, label: '直流侧电流' }, { y: Array.from(c.g.ac), x: t, color: '#a78bfa', width: 1, label: '交流侧电流' }],
      xLabel: '时间 / ms', yLabel: '采集卡读数 / V'
    });
    const df = DSP.FS / c.g.dc.length, toDb = sp => { const y = []; for (let k = 1; k < sp.length; k++) y.push(20 * Math.log10(sp[k] + 1e-7)); return y; };
    const fx = []; for (let k = 1; k < c.g.dc.length / 2; k++) fx.push(k * df / 1000);
    U.lineChart(U.$('#arc-spec'), { series: [{ y: toDb(DSP.spectrum(c.g.dc)), x: fx, color: '#38bdf8', width: 1, label: '直流侧' }, { y: toDb(DSP.spectrum(c.g.ac)), x: fx, color: '#a78bfa', width: 1, label: '交流侧' }], xLabel: '频率 / kHz', yLabel: '幅值 / dB', yMin: -110 });
    const M = DSP.stft(c.g.dc);
    let vmax = -Infinity; M.forEach(row => row.forEach(v => { if (v > vmax) vmax = v; }));
    U.heatmap(U.$('#arc-stft'), M, { pal: 'ocean', vmin: vmax - 70, vmax, xLabel: '时间 0 → 10.24 ms', yLabel: '频率 0 → 50 kHz', smooth: true });
    U.$('#arc-feat').innerHTML = c.f.map((v, i) => `<tr><td>${DSP.FEATURE_NAMES[i]}</td><td class="muted">${DOMAIN(i)}</td><td style="text-align:right">${v.toFixed(4)}</td></tr>`).join('');
    renderProbs();
    drawOverview();
  }

  function renderProbs() {
    const c = st.cur;
    if (!st.ready) { U.$('#arc-verdict').innerHTML = st.trainError ? `<span style="color:#fbbf24">模型不可用：${st.trainError}</span>` : '<span class="muted">模型训练中…</span>'; U.$('#arc-probs').innerHTML = ''; U.$('#arc-evid').innerHTML = ''; return; }
    if (!c.chk.ok) {
      U.$('#arc-verdict').innerHTML = `<span style="color:#fbbf24">信号不满足采样要求</span> ${U.tag('不予判别', 'orange')}`;
      U.$('#arc-probs').innerHTML = `<div class="hint">未通过项：${c.chk.items.filter(i => !i[3]).map(i => i[0]).join('、')}。为避免误判，仅对满足采样要求的电气信号进行电弧诊断，请检查采集设备。</div>`;
      U.$('#arc-evid').innerHTML = '';
      return;
    }
    const best = c.probs.indexOf(Math.max(...c.probs));
    const pa = arcProb(c.probs), C = FUSE.CFG, rec = REAL.rec(c.ri), y = REAL.cls(rec);
    const lv = pa >= C.pArc ? 'red' : pa >= C.pSus ? 'orange' : 'ok';
    U.$('#arc-verdict').innerHTML = `<span style="color:${DSP.CLASS_COLORS[best]}">${DSP.CLASS_NAMES[best]}</span> ${U.tag(pa >= C.pArc ? '疑似电弧（待连续窗确认）' : pa >= C.pSus ? '疑似电弧（低）' : '无电弧特征', lv)}`;
    U.$('#arc-evid').innerHTML = `<div class="muted" style="font-size:12px;margin:8px 0 4px">诊断证据（相对正常工况分布偏离最大的特征）</div>` +
      evidence(c.f, 4).map(e => `<div class="pr"><span>${e.name}<span class="muted">·${e.dom}</span></span><div class="bar"><i style="width:${Math.min(100, Math.abs(e.z) * 8).toFixed(0)}%;background:${e.z > 0 ? '#f97316' : '#38bdf8'}"></i></div><span style="text-align:right">${e.z >= 0 ? '+' : ''}${e.z.toFixed(1)}σ</span></div>`).join('');
    U.$('#arc-probs').innerHTML = c.probs.map((p, i) => `<div class="pr"><span>${DSP.CLASS_NAMES[i]}</span><div class="bar"><i style="width:${(p * 100).toFixed(1)}%;background:${DSP.CLASS_COLORS[i]}"></i></div><span style="text-align:right">${(p * 100).toFixed(1)}%</span></div>`).join('') +
      (y == null
        ? `<div class="hint" style="margin-top:6px">记录未标注（${rec.src === 'import' ? '导入数据' : ''}），仅给出诊断结论；在“已导入记录”中标注后可参与训练与评估。</div>`
        : `<div class="hint" style="margin-top:6px">实测标签：${DSP.CLASS_NAMES[y]}（${REAL.SPLIT_NAMES[rec.split]}记录${rec.src === 'import' ? '·导入' : ''}）${best === y ? ' ' + U.tag('判别正确', 'ok') : ' ' + U.tag('判别错误', 'red')}</div>`);
  }

  /* ---------- 实时检测回放：同一负载的无弧记录 2 段 → 电弧记录 3 段 ---------- */
  async function stream() {
    if (!REAL.hasData) return;
    if (!st.ready) { U.toast('模型尚未训练完成，请稍候', 'warn'); return; }
    await REAL.load();
    const r = REAL.rec(+U.$('#arc-rec').value); if (!r) return;
    // 优先使用当前数据；当前数据中没有所需类型的记录时，由 5-30 示例数据（实测）补充
    const act = REAL.records, sup = REAL.supplement();
    const pick = f => { const a = act.filter(f), list = a.length ? a : sup.filter(f); return list.find(x => x.split === 'test') || list[0] || null; };
    const arcR = r.side !== 'none' ? r : (pick(x => x.load === r.load && x.side === 'dc') || pick(x => x.side === 'dc'));
    let normR = arcR && pick(x => x.load === arcR.load && x.side === 'none'), note = '';
    if (arcR && !normR) { normR = pick(x => x.side === 'none'); if (normR) note = `（${arcR.load}负载无无弧记录，前段借用${normR.load}负载）`; }
    if (!arcR || !normR) {
      st.stream = null; U.setup(U.$('#arc-timeline'));
      U.$('#arc-stream-res').innerHTML = `<div class="k">回放</div><div class="v muted">缺少${!arcR ? '电弧' : '无电弧'}记录，无法拼接回放</div>`;
      return;
    }
    const tagSup = x => x.src === 'builtin' && !REAL.example ? ' <span class="sim-tag">示例补充</span>' : '';
    const P = REAL.P, C = FUSE.CFG, winMs = P.N / P.fs * 1000;
    const seq = [];
    for (let w = 0; w < 2 * P.wpb; w++) seq.push(REAL.winOf(normR, w));
    for (let w = P.wpb; w < 4 * P.wpb; w++) seq.push(REAL.winOf(arcR, w));
    const k0 = 2 * P.wpb, out = [];
    let hits = 0, det = null, falseAlarm = 0;
    seq.forEach((g, i) => {
      const pr = classify(g, 'eval').probs, pa = arcProb(pr);
      out.push({ pa, cls: pr.indexOf(Math.max(...pr)), arc: i >= k0 });
      if (pa >= C.pArc) hits++; else hits = 0;
      if (hits >= C.nWin && det == null) { if (i >= k0) det = i; else { falseAlarm++; hits = 0; } }
    });
    const nW = seq.length, tOn = k0 * winMs, tDet = det != null ? (det + 1) * winMs : null, delay = tDet != null ? tDet - tOn : null;
    const arcFrac = out.slice(k0).filter(o => o.pa >= C.pArc).length / (nW - k0);
    st.stream = { out, k0, det, tOn, tDet, delay, falseAlarm, winMs };
    drawStream();
    U.$('#arc-stream-res').innerHTML = `
      <div class="k">前段（无电弧）</div><div class="v">${normR.id} ${normR.load} #${normR.seq} · 段1–2${note}${tagSup(normR)}</div>
      <div class="k">后段（${arcR.side === 'unknown' ? '待诊断记录' : '电弧'}）</div><div class="v">${arcR.id} ${arcR.load} · ${REAL.SIDE_NAMES[arcR.side]} #${arcR.seq} · 段2–4${tagSup(arcR)}</div>
      <div class="k">拼接点（电弧出现）</div><div class="v">${tOn.toFixed(1)} ms</div>
      <div class="k">确认检出时刻（P≥${C.pArc}×${C.nWin} 窗）</div><div class="v">${tDet != null ? tDet.toFixed(1) + ' ms' : '未检出'}</div>
      <div class="k">检测延时</div><div class="v"><b>${delay != null ? delay.toFixed(1) + ' ms' : '—'}</b></div>
      <div class="k">电弧段窗口判为电弧</div><div class="v">${(arcFrac * 100).toFixed(0)}%</div>
      <div class="k">拼接前误报次数</div><div class="v">${falseAlarm}</div>
      <div class="k">UL 1699B 时限（≤2.5 s）</div><div class="v">${delay != null && delay <= 2500 ? U.tag('满足', 'ok') : U.tag('未满足', 'red')}</div>`;
  }

  function drawStream() {
    const s = st.stream; if (!s) return;
    const c = U.$('#arc-timeline'), S = U.setup(c); if (!S) return;
    const { ctx, w, h } = S, n = s.out.length, m = { l: 36, r: 8, t: 10, b: 26 };
    const bw = (w - m.l - m.r) / n, ph = h - m.t - m.b, thr = FUSE.CFG.pArc;
    ctx.font = '12px "Microsoft YaHei",sans-serif';
    ctx.strokeStyle = 'rgba(239,68,68,.6)'; ctx.setLineDash([4, 3]);
    ctx.beginPath(); ctx.moveTo(m.l, m.t + ph * (1 - thr)); ctx.lineTo(w - m.r, m.t + ph * (1 - thr)); ctx.stroke(); ctx.setLineDash([]);
    s.out.forEach((o, i) => {
      if (o.arc) { ctx.fillStyle = 'rgba(239,68,68,.12)'; ctx.fillRect(m.l + i * bw, m.t, bw, ph); }
      ctx.fillStyle = DSP.CLASS_COLORS[o.cls];
      const bh = Math.max(2, o.pa * ph);
      ctx.fillRect(m.l + i * bw + 1, m.t + ph - bh, bw - 2, bh);
    });
    const X = ms => m.l + ms / s.winMs * bw;
    ctx.strokeStyle = '#ef4444'; ctx.beginPath(); ctx.moveTo(X(s.tOn), m.t); ctx.lineTo(X(s.tOn), m.t + ph); ctx.stroke();
    ctx.fillStyle = '#ef4444'; ctx.textAlign = 'left'; ctx.fillText('电弧记录', X(s.tOn) + 3, m.t + 10);
    if (s.tDet != null) { ctx.strokeStyle = '#00bcd4'; ctx.beginPath(); ctx.moveTo(X(s.tDet), m.t); ctx.lineTo(X(s.tDet), m.t + ph); ctx.stroke(); ctx.fillStyle = '#00bcd4'; ctx.fillText('确认检出', X(s.tDet) + 3, m.t + 24); }
    ctx.fillStyle = U.theme().text; ctx.textAlign = 'right'; ctx.fillText('P弧', m.l - 6, m.t + 8); ctx.fillText(String(thr), m.l - 6, m.t + ph * (1 - thr) + 4);
    ctx.textAlign = 'center';
    for (let t = 0; t <= n * s.winMs; t += 100) ctx.fillText(t + ' ms', Math.min(w - 24, X(t)), h - 8);
  }

  /* 疑似电弧事件：异常时段、关联回路与诊断证据（来自在线监测） */
  function live() {
    const S = Station.state(), segs = S.arcSegs;
    const ft = s => s >= 60 ? `${Math.floor(s / 60)} min ${s % 60} s` : `${s} s`;
    U.$('#arc-segs').innerHTML = segs.slice(0, 40).map(g => {
      const end = g.end != null ? g.end : S.t, ev = S.events.find(e => e.key === g.locate && e.tStart <= end && e.tLast >= g.start - 2);
      return `<tr><td><b>${g.id}</b><div class="muted" style="font-size:12px">${g.loop}</div></td><td>${U.hms(11 * 3600 + g.start)} – ${g.end != null ? U.hms(11 * 3600 + g.end) : '<span style="color:#f97316">持续中</span>'}<div class="muted" style="font-size:12px">${ft(end - g.start)}</div></td>
        <td>${(g.peak * 100).toFixed(0)}%</td><td>${g.confirmed ? U.tag('连续窗确认', 'red') : U.tag('疑似', 'orange')}</td><td>${g.locate || '—'}</td><td class="muted" style="font-size:12px">${g.cls}；${evTxt(g.evidence)}${g.src ? `<div>信号：${g.src}</div>` : ''}</td><td>${ev ? ev.id : '—'}</td></tr>`;
    }).join('') || '<tr><td colspan="7" class="muted">暂无疑似电弧事件</td></tr>';
  }

  function drawAll() { drawCurve(); drawCM(); drawImp(); drawStream(); if (st.cur) renderResult(); else drawOverview(); }
  function onShow() { if (!REAL.hasData) { renderImports(); return; } if (!st.cur && st.ready) diagnose(); if (!st.stream && st.ready) stream(); drawAll(); renderDataset(); Station.stringsPanel(); live(); }

  return { init, train, classify, arcProb, evidence, live, onShow, get ready() { return st.ready; }, get meta() { return st.meta; }, get state() { return st; } };
})();
