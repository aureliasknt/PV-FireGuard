'use strict';
/* 模块③ 直流电弧故障诊断：采样要求核验 → 多域特征 → 神经网络判别 → 疑似电弧事件（异常时段、关联回路、诊断证据） */
const Arc = (() => {
  const st = { model: null, scaler: null, ready: false, training: false, hist: { loss: [], acc: [] }, eval: null, imp: null, cur: null, stream: null, meta: null, norm: null };
  const DOMAIN = i => i < 5 ? '时域' : i < 10 ? '频域' : i < 13 ? '谱统计' : '小波';

  function init() {
    const sel = U.$('#arc-type');
    DSP.CLASSES.forEach((c, i) => sel.insertAdjacentHTML('beforeend', `<option value="${c}">${DSP.CLASS_NAMES[i]}</option>`));
    sel.value = 'series';
    U.range('arc-I', v => v.toFixed(1) + ' A');
    U.range('arc-sev', v => v.toFixed(2));
    U.range('arc-noise', v => v.toFixed(1) + '×');
    U.range('arc-loss', v => v.toFixed(1) + '%');
    U.$('#arc-gen').onclick = diagnose;
    U.$('#arc-rand').onclick = () => {
      sel.value = U.pick(DSP.CLASSES);
      U.$('#arc-I').value = U.rand(3, 11).toFixed(1); U.$('#arc-sev').value = U.rand(0.2, 1).toFixed(2);
      ['arc-I', 'arc-sev'].forEach(id => U.$('#' + id).dispatchEvent(new Event('input')));
      diagnose();
    };
    U.$('#arc-train').onclick = () => { if (DATA.guard('model')) { DATA.audit('电弧模型重新训练', `每类 ${U.$('#arc-n').value} 样本，隐层 ${U.$('#arc-h').value}`); train(); } };
    U.$('#arc-stream').onclick = stream;
  }

  /* 判别：返回 5 类概率 */
  function classify(x) {
    const f = DSP.features(x);
    if (!st.ready) return { probs: [1, 0, 0, 0, 0], f, ready: false };
    return { probs: st.model.predict(st.scaler.transform(f)), f, ready: true };
  }
  const arcProb = p => p[1] + p[2];

  /* 诊断证据：相对正常工况分布偏离最大的特征（z 分数） */
  function evidence(f, k = 3) {
    if (!st.norm) return [];
    return f.map((v, i) => ({ i, name: DSP.FEATURE_NAMES[i], dom: DOMAIN(i), v, z: (v - st.norm.mu[i]) / st.norm.sd[i] }))
      .sort((a, b) => Math.abs(b.z) - Math.abs(a.z)).slice(0, k);
  }
  const evTxt = ev => ev.map(e => `${e.name} ${e.z >= 0 ? '+' : ''}${e.z.toFixed(1)}σ`).join('、');

  /* 采样要求核验：采样率、窗长、数据完整率、量程饱和 */
  const REQ = { fs: 200000, winMs: 10, comp: 0.99, clip: 0.005 };
  function sampleCheck(x, fsDev) {
    let run = 0, missing = 0, mx = -Infinity, nClip = 0;
    for (let i = 1; i < x.length; i++) { if (x[i] === x[i - 1]) { run++; if (run === 4) missing += 4; else if (run > 4) missing++; } else run = 0; }
    for (const v of x) mx = Math.max(mx, v);
    for (const v of x) if (v >= mx - 1e-9) nClip++;
    const comp = 1 - missing / x.length, clip = nClip / x.length, winMs = x.length / DSP.FS * 1000;
    const items = [
      ['采样率', `${fsDev / 1000} kHz`, `≥ ${REQ.fs / 1000} kHz`, fsDev >= REQ.fs],
      ['窗长', `${winMs.toFixed(2)} ms`, `≥ ${REQ.winMs} ms`, winMs >= REQ.winMs],
      ['数据完整率', `${(comp * 100).toFixed(2)}%`, `≥ ${REQ.comp * 100}%`, comp >= REQ.comp],
      ['量程饱和/削波', `${(clip * 100).toFixed(2)}%`, `≤ ${REQ.clip * 100}%`, clip <= REQ.clip]
    ];
    return { items, ok: items.every(i => i[3]) };
  }
  function degrade(x, loss, sat, I0) {
    if (loss > 0) {
      const nGap = Math.max(1, Math.round(x.length * loss / 100 / 24));
      for (let g = 0; g < nGap; g++) { const a = U.randi(1, x.length - 30); for (let i = a; i < a + 24; i++) x[i] = x[a - 1]; }
    }
    if (sat) { const lim = I0 * 1.004; for (let i = 0; i < x.length; i++) x[i] = Math.min(x[i], lim); }
    return x;
  }

  async function train() {
    if (st.training) return;
    st.training = true;
    const btn = U.$('#arc-train'); btn.disabled = true;
    const info = U.$('#arc-train-info');
    const nPer = +U.$('#arc-n').value, nHid = +U.$('#arc-h').value, epochs = +U.$('#arc-ep').value;
    const X = [], Y = [];
    const total = nPer * DSP.CLASSES.length;
    for (let k = 0; k < total; k++) {
      const c = k % DSP.CLASSES.length;
      const g = DSP.generate(DSP.CLASSES[c], { I0: U.rand(2.5, 11), noise: U.rand(0.5, 2.5), sev: U.rand(0.15, 1) });
      X.push(DSP.features(g.x)); Y.push(c);
      if (k % 20 === 19) { info.textContent = `生成仿真训练样本 ${k + 1}/${total} …`; await U.sleep(0); }
    }
    const idx = X.map((_, i) => i);
    for (let i = idx.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [idx[i], idx[j]] = [idx[j], idx[i]]; }
    const nTr = Math.round(idx.length * 0.7);
    const scaler = new ML.Scaler().fit(idx.slice(0, nTr).map(i => X[i]));
    const Xtr = idx.slice(0, nTr).map(i => scaler.transform(X[i])), Ytr = idx.slice(0, nTr).map(i => Y[i]);
    const Xte = idx.slice(nTr).map(i => scaler.transform(X[i])), Yte = idx.slice(nTr).map(i => Y[i]);
    const model = new ML.MLP(DSP.FEATURE_NAMES.length, nHid, DSP.CLASSES.length);
    const hist = { loss: [], acc: [], vloss: [] };
    st.hist = hist;
    for (let e = 0; e < epochs; e++) {
      const loss = model.trainEpoch(Xtr, Ytr, { lr: 0.01, batch: 32 });
      const ev = model.evaluate(Xte, Yte);
      hist.loss.push(loss); hist.vloss.push(ev.loss); hist.acc.push(ev.acc);
      if (e % 4 === 3 || e === epochs - 1) { info.textContent = `训练中：第 ${e + 1}/${epochs} 轮，损失 ${loss.toFixed(4)}，测试准确率 ${(ev.acc * 100).toFixed(1)}%`; drawCurve(); await U.sleep(0); }
    }
    st.model = model; st.scaler = scaler; st.ready = true;
    const Xn = X.filter((_, i) => Y[i] === 0), d = X[0].length;
    const mu = new Array(d).fill(0), sd = new Array(d).fill(0);
    Xn.forEach(x => x.forEach((v, j) => mu[j] += v / Xn.length));
    Xn.forEach(x => x.forEach((v, j) => sd[j] += (v - mu[j]) ** 2 / Xn.length));
    st.norm = { mu, sd: sd.map(v => Math.sqrt(v) + 1e-6) };
    st.eval = model.evaluate(Xte, Yte);
    info.textContent = '计算置换特征重要性 …'; await U.sleep(0);
    st.imp = ML.permutationImportance(model, Xte, Yte, 2);
    const cm = st.eval.cm;
    const tp = cm[1][1] + cm[1][2] + cm[2][1] + cm[2][2];
    const arcAll = cm[1].reduce((a, b) => a + b, 0) + cm[2].reduce((a, b) => a + b, 0);
    let fa = 0, nonArc = 0;
    [0, 3, 4].forEach(r => { fa += cm[r][1] + cm[r][2]; nonArc += cm[r].reduce((a, b) => a + b, 0); });
    st.meta = { nTrain: Xtr.length, nTest: Xte.length, nHid, epochs, acc: st.eval.acc, recall: tp / arcAll, far: fa / nonArc, time: new Date() };
    info.innerHTML = `训练完成：样本 ${X.length}（训练 ${Xtr.length} / 测试 ${Xte.length}），网络 17-${nHid}-5。测试准确率 <b>${(st.eval.acc * 100).toFixed(1)}%</b>，电弧检出率 <b>${(st.meta.recall * 100).toFixed(1)}%</b>，误报率 <b>${(st.meta.far * 100).toFixed(1)}%</b>`;
    st.training = false; btn.disabled = false;
    drawAll();
    if (!st.cur) diagnose(); else renderResult();
    if (!st.stream && typeof Main !== 'undefined' && Main.current() === 'arc') stream();
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
    const names = ['正常', '串联弧', '并联弧', '逆变噪声', '辐照扰动'];
    const m = { l: 62, t: 8, r: 6, b: 34 }, cw = (w - m.l - m.r) / n, ch = (h - m.t - m.b) / n;
    ctx.font = '12px "Microsoft YaHei",sans-serif';
    for (let r = 0; r < n; r++) {
      const rs = cm[r].reduce((a, b) => a + b, 0) || 1;
      for (let k = 0; k < n; k++) {
        const v = cm[r][k] / rs;
        ctx.fillStyle = r === k ? `rgba(0,188,212,${0.12 + 0.75 * v})` : `rgba(239,68,68,${v > 0 ? 0.15 + 0.7 * v : 0.04})`;
        ctx.fillRect(m.l + k * cw + 1, m.t + r * ch + 1, cw - 2, ch - 2);
        ctx.fillStyle = U.theme().strong; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(cm[r][k], m.l + k * cw + cw / 2, m.t + r * ch + ch / 2);
      }
      ctx.fillStyle = U.theme().text; ctx.textAlign = 'right'; ctx.fillText(names[r], m.l - 6, m.t + r * ch + ch / 2);
      ctx.textAlign = 'center'; ctx.fillText(names[r], m.l + r * cw + cw / 2, h - m.b + 12);
    }
    ctx.fillText('预测类别 →', m.l + (w - m.l - m.r) / 2, h - 6);
  }

  function drawImp() {
    if (!st.imp) return;
    const order = st.imp.map((v, i) => i).sort((a, b) => st.imp[b] - st.imp[a]);
    U.barChart(U.$('#arc-imp'), {
      labels: order.map(i => DSP.FEATURE_NAMES[i]), values: order.map(i => st.imp[i] * 100),
      colors: order.map(i => ['#38bdf8', '#00bcd4', '#a78bfa', '#f472b6'][i < 5 ? 0 : i < 10 ? 1 : i < 13 ? 2 : 3]),
      fmt: v => v.toFixed(1) + '%'
    });
  }

  function currentParams() {
    return { type: U.$('#arc-type').value, I0: +U.$('#arc-I').value, sev: +U.$('#arc-sev').value, noise: +U.$('#arc-noise').value,
      fsDev: +U.$('#arc-fs').value, loss: +U.$('#arc-loss').value, sat: U.$('#arc-sat').checked };
  }

  function diagnose() {
    const p = currentParams();
    const g = DSP.generate(p.type, { I0: p.I0, sev: p.sev, noise: p.noise });
    degrade(g.x, p.loss, p.sat, p.I0);
    const chk = sampleCheck(g.x, p.fsDev);
    const r = classify(g.x);
    st.cur = { ...p, x: g.x, onset: g.onset, probs: r.probs, f: r.f, chk };
    renderResult();
  }

  function renderResult() {
    const c = st.cur; if (!c) return;
    if (st.ready) { const r = classify(c.x); c.probs = r.probs; c.f = r.f; }
    U.$('#arc-chk').innerHTML = c.chk.items.map(([k, v, th, ok]) => `<tr><td>${k}</td><td>${v}</td><td class="muted">${th}</td><td>${ok ? U.tag('满足', 'ok') : U.tag('不满足', 'red')}</td></tr>`).join('');
    const t = Array.from(c.x, (_, i) => i / DSP.FS * 1000);
    U.lineChart(U.$('#arc-wave'), {
      series: [{ y: Array.from(c.x), x: t, color: '#00bcd4', width: 1, label: '组串电流 I(t)' }],
      xLabel: '时间 / ms', yLabel: '电流 / A',
      vlines: c.onset != null ? [{ x: c.onset / DSP.FS * 1000, label: '电弧起始', color: '#ef4444' }] : []
    });
    const sp = DSP.spectrum(c.x), df = DSP.FS / c.x.length;
    const fx = [], fy = [];
    for (let k = 1; k < sp.length; k++) { fx.push(k * df / 1000); fy.push(20 * Math.log10(sp[k] + 1e-7)); }
    U.lineChart(U.$('#arc-spec'), { series: [{ y: fy, x: fx, color: '#a78bfa', width: 1 }], xLabel: '频率 / kHz', yLabel: '幅值 / dB', yMin: -110, legend: false });
    const M = DSP.stft(c.x);
    U.heatmap(U.$('#arc-stft'), M, { pal: 'ocean', vmin: -100, vmax: -20, xLabel: '时间 0 → 10.24 ms', yLabel: '频率 0 → 100 kHz', smooth: true });
    U.$('#arc-feat').innerHTML = c.f.map((v, i) => `<tr><td>${DSP.FEATURE_NAMES[i]}</td><td class="muted">${DOMAIN(i)}</td><td style="text-align:right">${v.toFixed(4)}</td></tr>`).join('');
    renderProbs();
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
    const pa = arcProb(c.probs), C = FUSE.CFG;
    const lv = pa >= C.pArc ? 'red' : pa >= C.pSus ? 'orange' : 'ok';
    U.$('#arc-verdict').innerHTML = `<span style="color:${DSP.CLASS_COLORS[best]}">${DSP.CLASS_NAMES[best]}</span> ${U.tag(pa >= C.pArc ? '疑似电弧（待连续窗确认）' : pa >= C.pSus ? '疑似电弧（低）' : '无电弧特征', lv)}`;
    U.$('#arc-evid').innerHTML = `<div class="muted" style="font-size:12px;margin:8px 0 4px">诊断证据（相对正常工况偏离最大的特征）</div>` +
      evidence(c.f, 4).map(e => `<div class="pr"><span>${e.name}<span class="muted">·${e.dom}</span></span><div class="bar"><i style="width:${Math.min(100, Math.abs(e.z) * 8).toFixed(0)}%;background:${e.z > 0 ? '#f97316' : '#38bdf8'}"></i></div><span style="text-align:right">${e.z >= 0 ? '+' : ''}${e.z.toFixed(1)}σ</span></div>`).join('');
    U.$('#arc-probs').innerHTML = c.probs.map((p, i) => `<div class="pr"><span>${DSP.CLASS_NAMES[i]}</span><div class="bar"><i style="width:${(p * 100).toFixed(1)}%;background:${DSP.CLASS_COLORS[i]}"></i></div><span style="text-align:right">${(p * 100).toFixed(1)}%</span></div>`).join('') +
      `<div class="hint" style="margin-top:6px">真实工况：${DSP.CLASS_NAMES[DSP.CLASSES.indexOf(c.type)]}</div>`;
  }

  async function stream() {
    if (!st.ready) { U.toast('模型尚未训练完成，请稍候', 'warn'); return; }
    const p = currentParams();
    const nW = 50, k0 = U.randi(10, 22), winMs = DSP.N / DSP.FS * 1000;
    const base = p.type === 'inverter' || p.type === 'irradiance' ? p.type : 'normal';
    const out = [];
    let hits = 0, det = null, falseAlarm = 0;
    for (let i = 0; i < nW; i++) {
      const type = i < k0 ? base : 'series';
      const g = DSP.generate(type, { I0: p.I0, sev: p.sev, noise: p.noise, onset: i === k0 ? Math.floor(DSP.N * 0.5) : 0 });
      const pr = classify(g.x).probs, pa = arcProb(pr);
      out.push({ pa, cls: pr.indexOf(Math.max(...pr)), arc: i >= k0 });
      if (pa > 0.6) hits++; else hits = 0;
      if (hits >= 2 && det == null) { if (i >= k0) det = i; else { falseAlarm++; hits = 0; } }
    }
    const tOn = (k0 + 0.5) * winMs, tDet = det != null ? (det + 1) * winMs : null;
    const Varc = 15 + 15 * p.sev;
    const delay = tDet != null ? tDet - tOn : null;
    const E = delay != null ? Varc * p.I0 * delay / 1000 : null;
    st.stream = { out, k0, det, tOn, tDet, delay, E, falseAlarm, winMs };
    drawStream();
    const pass = delay != null && delay <= 2500 && E <= 750;
    U.$('#arc-stream-res').innerHTML = `
      <div class="k">背景工况 / 电弧强度</div><div class="v">${DSP.CLASS_NAMES[DSP.CLASSES.indexOf(base)]} / ${p.sev.toFixed(2)}</div>
      <div class="k">电弧起始时刻</div><div class="v">${tOn.toFixed(1)} ms</div>
      <div class="k">确认检出时刻</div><div class="v">${tDet != null ? tDet.toFixed(1) + ' ms' : '未检出'}</div>
      <div class="k">异常时段</div><div class="v">${tDet != null ? `${tOn.toFixed(1)} – ${(nW * winMs).toFixed(1)} ms（至窗口末）` : '—'}</div>
      <div class="k">检测延时</div><div class="v"><b>${delay != null ? delay.toFixed(1) + ' ms' : '—'}</b></div>
      <div class="k">检出前电弧能量（弧压≈${Varc.toFixed(0)} V）</div><div class="v"><b>${E != null ? E.toFixed(2) + ' J' : '—'}</b></div>
      <div class="k">起弧前误报次数</div><div class="v">${falseAlarm}</div>
      <div class="k">UL 1699B（≤2.5 s 且 ≤750 J）</div><div class="v">${pass ? U.tag('满足', 'ok') : U.tag('未满足', 'red')}</div>`;
  }

  function drawStream() {
    const s = st.stream; if (!s) return;
    const c = U.$('#arc-timeline'), S = U.setup(c); if (!S) return;
    const { ctx, w, h } = S, n = s.out.length, m = { l: 36, r: 8, t: 10, b: 26 };
    const bw = (w - m.l - m.r) / n, ph = h - m.t - m.b;
    ctx.font = '12px "Microsoft YaHei",sans-serif';
    ctx.strokeStyle = 'rgba(239,68,68,.6)'; ctx.setLineDash([4, 3]);
    ctx.beginPath(); ctx.moveTo(m.l, m.t + ph * 0.4); ctx.lineTo(w - m.r, m.t + ph * 0.4); ctx.stroke(); ctx.setLineDash([]);
    s.out.forEach((o, i) => {
      ctx.fillStyle = DSP.CLASS_COLORS[o.cls];
      const bh = Math.max(2, o.pa * ph);
      ctx.fillRect(m.l + i * bw + 1, m.t + ph - bh, bw - 2, bh);
      if (o.arc) { ctx.fillStyle = 'rgba(239,68,68,.12)'; ctx.fillRect(m.l + i * bw, m.t, bw, ph); }
    });
    const X = ms => m.l + ms / s.winMs * bw;
    ctx.strokeStyle = '#ef4444'; ctx.beginPath(); ctx.moveTo(X(s.tOn), m.t); ctx.lineTo(X(s.tOn), m.t + ph); ctx.stroke();
    ctx.fillStyle = '#fca5a5'; ctx.textAlign = 'left'; ctx.fillText('起弧', X(s.tOn) + 3, m.t + 10);
    if (s.tDet != null) { ctx.strokeStyle = '#00bcd4'; ctx.beginPath(); ctx.moveTo(X(s.tDet), m.t); ctx.lineTo(X(s.tDet), m.t + ph); ctx.stroke(); ctx.fillStyle = '#00bcd4'; ctx.fillText('确认检出', X(s.tDet) + 3, m.t + 24); }
    ctx.fillStyle = U.theme().text; ctx.textAlign = 'right'; ctx.fillText('P弧', m.l - 6, m.t + 8); ctx.fillText('0.6', m.l - 6, m.t + ph * 0.4 + 4);
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
        <td>${(g.peak * 100).toFixed(0)}%</td><td>${g.confirmed ? U.tag('连续窗确认', 'red') : U.tag('疑似', 'orange')}</td><td>${g.locate || '—'}</td><td class="muted" style="font-size:12px">${g.cls}；${evTxt(g.evidence)}</td><td>${ev ? ev.id : '—'}</td></tr>`;
    }).join('') || '<tr><td colspan="7" class="muted">暂无疑似电弧事件</td></tr>';
  }

  function drawAll() { drawCurve(); drawCM(); drawImp(); drawStream(); if (st.cur) renderResult(); }
  function onShow() { if (!st.cur && st.ready) diagnose(); if (!st.stream && st.ready) stream(); drawAll(); Station.stringsPanel(); live(); }

  return { init, train, classify, arcProb, evidence, live, onShow, get ready() { return st.ready; }, get meta() { return st.meta; }, get state() { return st; } };
})();
