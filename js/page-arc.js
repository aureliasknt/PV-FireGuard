'use strict';
/* 模块③ 电弧故障诊断（实测数据）：数据集与预处理 → 采样要求核验 → 双通道多域特征 → 神经网络判别 → 连续窗确认
   信号来源：电弧实验平台 5-30.rar（100 kHz，直流侧 + 交流侧电流），经 tools/preprocess_arc.py 预处理后内嵌于 data/arc-real.js */
const Arc = (() => {
  const st = { model: null, scaler: null, ready: false, training: false, hist: { loss: [], acc: [] }, eval: null, imp: null, cur: null, stream: null, meta: null, norm: null, feats: null };
  const DOMAIN = DSP.DOMAIN;
  const NOISE_UNIT = 0.001;   // 叠加噪声滑块单位：mV

  /* ---------- 数据集与预处理说明 ---------- */
  function renderDataset() {
    const P = REAL.P, S = P.stats, R = P.records;
    const nTr = R.filter(r => r.split === 'train').length;
    const totSamples = R.reduce((a, r) => a + r.samples, 0);
    const steps = [
      ['① 原始数据', `${S.files} 个 CSV · DAQ ${P.fs / 1000} kHz × 2 通道（通道0 交流侧，通道1 直流侧）`, `${(S.rawBytes / 1e9).toFixed(2)} GB · ${(totSamples / 1e6).toFixed(1)} M 点/通道`],
      ['② 表头与标签', 'GBK 表头校验采样率/通道数；文件名 → 负载类型、电弧位置、序号', `${REAL.LOADS.length} 类负载 × 3 种工况`],
      ['③ 量化还原', `按 ADC 步长 ${(P.lsb * 1000).toFixed(2)} mV 转为 int16 码值`, `最大误差 ${S.maxQuantErrLsb} LSB（近似无损）`],
      ['④ 分窗', `${P.N} 点 = ${(P.N / P.fs * 1000).toFixed(2)} ms，与在线诊断窗长一致`, `${S.rawWindows.toLocaleString()} 窗`],
      ['⑤ 清洗', '剔除无电流窗口（交流侧 σ < 20 mV，负载断开/停机段）', `剔除 ${S.invalidWindows} 窗`],
      ['⑥ 抽样', `每记录在 12.5/37.5/62.5/87.5% 处各取 ${P.wpb} 个连续窗`, `${S.keptWindows.toLocaleString()} 窗（${P.blocks}×${P.wpb}/记录）`],
      ['⑦ 打包', '一阶差分 + gzip + base64，浏览器端解压', `${(S.packBytes / 1e6).toFixed(2)} MB（gzip 后；内嵌文件 ≈${(S.packBytes * 4 / 3 / 1e6).toFixed(1)} MB）`],
      ['⑧ 划分', '按记录：序号 1 → 训练集，序号 ≥2 → 测试集', `训练 ${nTr} / 测试 ${R.length - nTr} 条记录`]
    ];
    U.$('#arc-ds-steps').innerHTML = steps.map(r => `<tr><td style="white-space:nowrap"><b>${r[0]}</b></td><td style="font-size:12px">${r[1]}</td><td class="muted" style="font-size:12px">${r[2]}</td></tr>`).join('');
    const cur = st.cur ? st.cur.ri : +U.$('#arc-rec').value;
    U.$('#arc-ds-mat').innerHTML = REAL.LOADS.map(L => `<tr><td><b>${L}</b></td>${['none', 'dc', 'ac'].map(sd => `<td>${R.map((r, i) => [r, i]).filter(([r]) => r.load === L && r.side === sd)
      .map(([r, i]) => `<span class="rchip ${r.split === 'train' ? 'train' : ''} ${i === cur ? 'on' : ''}" data-ri="${i}" title="${r.file}">${r.id} · ${Math.round(r.dur)} s</span>`).join('') || '<span class="muted">—</span>'}</td>`).join('')}</tr>`).join('');
    U.$$('#arc-ds-mat .rchip').forEach(el => el.onclick = () => { U.$('#arc-rec').value = el.dataset.ri; onRecChange(); });
  }

  /* 记录全时段概览：每 0.1 s 的直流均值、直流高频分量、交流有效值 */
  function drawOverview() {
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
    renderDataset(); drawOverview(); updWinLabel();
    if (REAL.ready) diagnose();
  }
  function updWinLabel() {
    const r = REAL.rec(+U.$('#arc-rec').value), w = +U.$('#arc-w').value, P = REAL.P, b = Math.floor(w / P.wpb);
    U.$('#arc-w-v').textContent = `#${w + 1} · 段${b + 1} · t=${((r.blocks[b] + w % P.wpb) * P.N / P.fs).toFixed(3)} s`;
  }

  function init() {
    const sel = U.$('#arc-rec');
    REAL.LOADS.forEach(L => {
      const g = document.createElement('optgroup'); g.label = L + '负载';
      REAL.records.forEach((r, i) => { if (r.load === L) g.insertAdjacentHTML('beforeend', `<option value="${i}">${r.id} ${REAL.SIDE_NAMES[r.side]} #${r.seq}（${r.split === 'train' ? '训练' : '测试'}）</option>`); });
      sel.appendChild(g);
    });
    sel.value = REAL.records.findIndex(r => r.side === 'dc' && r.split === 'test');
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
  async function extractAll(info) {
    if (st.feats) return st.feats;
    await REAL.load();
    const X = [], Y = [], R = [];
    for (let ri = 0; ri < REAL.records.length; ri++) {
      for (let w = 0; w < REAL.WPR; w++) { const g = REAL.win(ri, w); X.push(DSP.features(g.dc, g.ac)); Y.push(g.cls); R.push(ri); }
      info.textContent = `解码实测数据并提取特征：记录 ${ri + 1}/${REAL.records.length}（${X.length} 窗）…`;
      await U.sleep(0);
    }
    return (st.feats = { X, Y, R });
  }

  async function train() {
    if (st.training) return;
    st.training = true;
    const btn = U.$('#arc-train'); btn.disabled = true;
    const info = U.$('#arc-train-info');
    const nHid = +U.$('#arc-h').value, epochs = +U.$('#arc-ep').value, split = U.$('#arc-split').value;
    const { X, Y, R } = await extractAll(info);
    let tr, te;
    if (split === 'record') {
      tr = X.map((_, i) => i).filter(i => REAL.rec(R[i]).split === 'train');
      te = X.map((_, i) => i).filter(i => REAL.rec(R[i]).split === 'test');
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
      te.forEach((i, k) => { (by[R[i]] = by[R[i]] || []).push(model.predict(Xte[k])); });
      const rows = Object.entries(by).map(([ri, P]) => {
        const votes = [0, 0, 0]; P.forEach(p => votes[p.indexOf(Math.max(...p))]++);
        let h = 0, conf = false; P.forEach(p => { h = arcProb(p) >= C.pArc ? h + 1 : 0; if (h >= C.nWin) conf = true; });
        const r = REAL.rec(+ri), y = REAL.cls(r);
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
    st.deploy = { model: mA, scaler: scAll }; st.ready = true;
    st.meta = { nTrain: Xtr.length, nTest: Xte.length, nIn, nHid, nOut, epochs, split, acc: st.eval.acc, recall, far, rec, time: new Date() };
    info.innerHTML = `训练完成：实测窗口 ${X.length}（训练 ${Xtr.length} / 测试 ${Xte.length}，${split === 'record' ? '按记录划分' : '随机划分'}），网络 ${nIn}-${nHid}-${nOut}。单窗测试准确率 <b>${(st.eval.acc * 100).toFixed(1)}%</b>，电弧检出率 <b>${(recall * 100).toFixed(1)}%</b>，误报率 <b>${(far * 100).toFixed(1)}%</b>。<br>本页诊断与回放使用评估模型；在线监测使用全部记录训练的部署模型。`;
    st.training = false; btn.disabled = false;
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
    const p = currentParams();
    const g = degrade(REAL.win(p.ri, p.w), p);
    const chk = sampleCheck(g, p.fsDev);
    const r = classify(g, 'eval');
    st.cur = { ...p, g, probs: r.probs, f: r.f, chk };
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
    if (!st.ready) { U.$('#arc-verdict').innerHTML = '<span class="muted">模型训练中…</span>'; U.$('#arc-probs').innerHTML = ''; U.$('#arc-evid').innerHTML = ''; return; }
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
      `<div class="hint" style="margin-top:6px">实测标签：${DSP.CLASS_NAMES[y]}（${rec.split === 'train' ? '训练集' : '测试集'}记录）${best === y ? ' ' + U.tag('判别正确', 'ok') : ' ' + U.tag('判别错误', 'red')}</div>`;
  }

  /* ---------- 实时检测回放：同一负载的无弧记录 2 段 → 电弧记录 3 段 ---------- */
  async function stream() {
    if (!st.ready) { U.toast('模型尚未训练完成，请稍候', 'warn'); return; }
    await REAL.load();
    const R = REAL.records, ri = +U.$('#arc-rec').value, r = R[ri];
    const prefer = list => list.find(i => R[i].split === 'test') ?? list[0];
    const idxOf = f => R.map((x, i) => i).filter(i => f(R[i]));
    const arcI = r.side !== 'none' ? ri : prefer(idxOf(x => x.load === r.load && x.side === 'dc'));
    let normI = prefer(idxOf(x => x.load === R[arcI].load && x.side === 'none')), note = '';
    if (normI == null) { normI = prefer(idxOf(x => x.load === '阻感' && x.side === 'none')); note = `（${R[arcI].load}负载无无弧记录，前段借用阻感负载）`; }
    const P = REAL.P, C = FUSE.CFG, winMs = P.N / P.fs * 1000;
    const seq = [];
    for (let w = 0; w < 2 * P.wpb; w++) seq.push(REAL.win(normI, w));
    for (let w = P.wpb; w < 4 * P.wpb; w++) seq.push(REAL.win(arcI, w));
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
      <div class="k">前段（无电弧）</div><div class="v">${R[normI].id} ${R[normI].load} #${R[normI].seq} · 段1–2${note}</div>
      <div class="k">后段（电弧）</div><div class="v">${R[arcI].id} ${R[arcI].load} · ${REAL.SIDE_NAMES[R[arcI].side]} #${R[arcI].seq} · 段2–4</div>
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
  function onShow() { if (!st.cur && st.ready) diagnose(); if (!st.stream && st.ready) stream(); drawAll(); renderDataset(); Station.stringsPanel(); live(); }

  return { init, train, classify, arcProb, evidence, live, onShow, get ready() { return st.ready; }, get meta() { return st.meta; }, get state() { return st; } };
})();
