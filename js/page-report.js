'use strict';
/* 模块⑤ 事件管理与诊断报告：同步回放电—热证据，记录确认、排查、处理和复核 → 事件档案、处理状态与可导出报告 */
const Events = (() => {
  const STEPS = ['待确认', '排查中', '处理中', '待复核', '已关闭'];
  const ST_TAG = { '待确认': 'yellow', '排查中': 'orange', '处理中': 'orange', '待复核': 'blue', '已关闭': 'ok', '误报关闭': 'info' };
  const ACTIONS = {
    '待确认': [['confirm', '确认事件', 'primary'], ['falsepos', '判定误报', '']],
    '排查中': [['handle', '开始处理', 'primary'], ['falsepos', '判定误报', '']],
    '处理中': [['repair', '执行检修（清除故障/恢复送电）', ''], ['review', '提交复核', 'primary']],
    '待复核': [['pass', '复核通过并关闭', 'primary'], ['reject', '复核不通过', 'danger']]
  };
  const st = { sel: null, filter: 'open', sig: '', cur: 0, playing: null, tab: 'events' };
  const hms = t => U.hms(11 * 3600 + t);

  function init() {
    U.$$('#ev-tab button').forEach(b => b.onclick = () => tab(b.dataset.t));
    U.$('#ev-filter').onchange = e => { st.filter = e.target.value; st.sig = ''; live(); };
    U.$('#ev-list').addEventListener('click', e => { const tr = e.target.closest('[data-ev]'); if (tr) select(tr.dataset.ev); });
    U.$('#ev-detail').addEventListener('click', e => {
      const b = e.target.closest('[data-act]'); if (!b) return;
      const note = (U.$('#ev-note') || {}).value || '';
      if (Station.evAction(st.sel, b.dataset.act, note.trim())) { renderDetail(); st.sig = ''; live(); }
    });
    U.$('#ev-csv').onclick = exportCsv;
    U.$('#ev-json').onclick = () => {
      if (!DATA.guard('export')) return;
      const evs = Station.state().events.map(({ series, image, ...e }) => ({ ...e, tStart: hms(e.tStart), tLast: hms(e.tLast), evidenceSeries: series }));
      U.download(`PV-FireGuard_事件档案_${Date.now()}.json`, JSON.stringify(evs, null, 2), 'application/json');
      DATA.audit('导出事件档案', `${evs.length} 起（JSON，含证据时序）`);
    };
  }

  function tab(t) {
    st.tab = t;
    U.$$('#ev-tab button').forEach(b => b.classList.toggle('on', b.dataset.t === t));
    U.$('#ev-panel-events').style.display = t === 'events' ? '' : 'none';
    U.$('#ev-panel-report').style.display = t === 'report' ? '' : 'none';
    if (t === 'report') Report.generate(); else { st.sig = ''; live(); renderDetail(); }
  }

  const list = () => {
    const E = Station.state().events;
    return st.filter === 'all' ? E : st.filter === 'open' ? E.filter(Station.isOpen) : E.filter(e => e.status === st.filter);
  };

  function live() {
    if (st.tab !== 'events') return;
    const S = Station.state(), E = S.events;
    const cnt = s => E.filter(e => e.status === s).length;
    U.$('#ev-kpi').innerHTML = [['事件总数', E.length], ['待确认', cnt('待确认')], ['排查/处理中', cnt('排查中') + cnt('处理中')], ['待复核', cnt('待复核')], ['已关闭', cnt('已关闭') + cnt('误报关闭')]]
      .map(([k, v]) => `<div class="card kpi"><div class="l">${k}</div><div class="v">${v}</div></div>`).join('');
    const L = list();
    const sig = st.filter + '|' + L.map(e => e.id + e.status + e.lvMax + (e.tLast > S.t - 3 ? 1 : 0)).join(',');
    if (sig !== st.sig) {
      st.sig = sig;
      U.$('#ev-list').innerHTML = L.map(e => `<tr data-ev="${e.id}" class="${e.id === st.sel ? 'sel' : ''}"><td><b>${e.id}</b></td><td>${hms(e.tStart)}</td><td>${e.loc}</td><td>${e.type}</td>
        <td>${U.tag(U.LEVELS[Math.max(0, e.lvMax)].grade, U.LEVELS[Math.max(0, e.lvMax)].key)}</td><td>${e.prio}</td><td>${U.tag(e.status, ST_TAG[e.status])}</td></tr>`).join('')
        || '<tr><td colspan="7" class="muted">暂无事件。在模块①加载复杂故障场景，或在模块②复核确认热异常后自动建档。</td></tr>';
    }
    if (!st.sel && L.length) select(L[0].id);
    else if (st.sel) { const ev = E.find(e => e.id === st.sel); if (ev && ev.series && Station.isOpen(ev) && !st.playing) { if (st.cur >= ev.series.t.length - 2) st.cur = ev.series.t.length - 1; drawReplay(); } }
  }

  function select(id) {
    st.sel = id; st.sig = '';
    const ev = Station.state().events.find(e => e.id === id);
    st.cur = ev && ev.series ? ev.series.t.length - 1 : 0;
    stop(); renderDetail(); live();
  }

  function renderDetail() {
    const el = U.$('#ev-detail');
    const ev = Station.state().events.find(e => e.id === st.sel);
    if (!ev) { el.innerHTML = '<div class="hint">选择左侧事件查看详情、电—热证据回放与处理记录。</div>'; return; }
    const L = U.LEVELS[Math.max(0, ev.lvMax)];
    const si = ev.status === '误报关闭' ? -1 : STEPS.indexOf(ev.status);
    const acts = ACTIONS[ev.status] || [];
    el.innerHTML = `
      <div class="row sp"><h3 style="margin:0">${ev.id} · ${ev.type}</h3><span>${U.tag(L.grade + '预警', L.key)} ${U.tag(ev.status, ST_TAG[ev.status])}</span></div>
      <div class="kv" style="margin:10px 0;grid-template-columns:110px 1fr">
        <div class="k">位置 / 关联回路</div><div>${ev.loc} · ${ev.loop}</div>
        <div class="k">事件来源</div><div>${ev.source}</div>
        <div class="k">首次 / 最近触发</div><div>${hms(ev.tStart)} / ${hms(ev.tLast)}</div>
        <div class="k">处置优先级</div><div><b>${ev.prio}</b> ${FUSE.PRIO[Math.max(0, ev.lvMax)].name}（${FUSE.PRIO[Math.max(0, ev.lvMax)].due}）</div>
        <div class="k">触发原因</div><div>${ev.reasons.length ? ev.reasons.join('<br>') : '—'}</div>
      </div>
      <div class="stepper">${STEPS.map((s, i) => `<div class="${ev.status === '误报关闭' ? '' : i < si ? 'done' : i === si ? 'cur' : ''}"><b>${i + 1}</b>${s}</div>`).join('')}${ev.status === '误报关闭' ? '<div class="cur"><b>×</b>误报关闭</div>' : ''}</div>
      ${acts.length ? `<div class="row" style="margin:10px 0"><input type="text" id="ev-note" placeholder="处理说明（排查结论、处理措施、复核意见…）" style="flex:1;min-width:200px">${acts.map(([a, n, c]) => `<button class="btn sm ${c}" data-act="${a}">${n}</button>`).join('')}</div>` : '<div class="hint" style="margin:10px 0">事件已归档。</div>'}
      <h3 style="margin-top:14px">电—热证据同步回放 <span class="sub">${ev.series ? '热通道与电通道共享时间轴' : '人工提交的红外证据'}</span></h3>
      ${ev.series ? `
        <canvas id="ev-rp-T" style="height:130px"></canvas><canvas id="ev-rp-E" style="height:130px;margin-top:4px"></canvas>
        <div class="row" style="margin-top:6px"><button class="btn sm" id="ev-play">▶ 回放</button><input type="range" id="ev-cur" min="0" max="${ev.series.t.length - 1}" value="${st.cur}" style="flex:1"><span id="ev-cur-v" class="muted" style="font-size:12px;min-width:330px"></span></div>`
        : ev.image ? `<img src="${ev.image}" style="width:100%;border-radius:8px">` : '<div class="hint">无证据数据</div>'}
      <h3 style="margin-top:14px">处理记录</h3>
      <div class="tablewrap" style="max-height:220px"><table class="t"><thead><tr><th style="width:76px">时间</th><th style="width:90px">操作人</th><th style="width:120px">动作</th><th>说明</th></tr></thead>
        <tbody>${ev.trail.slice().reverse().map(x => `<tr><td>${x.time}</td><td>${x.who}</td><td>${x.act}</td><td class="muted">${x.note || ''}</td></tr>`).join('')}</tbody></table></div>`;
    if (ev.series) {
      U.$('#ev-cur').oninput = e => { stop(); st.cur = +e.target.value; drawReplay(); };
      U.$('#ev-play').onclick = () => st.playing ? stop() : play();
      drawReplay();
    }
  }

  function play() {
    const ev = Station.state().events.find(e => e.id === st.sel); if (!ev || !ev.series) return;
    if (st.cur >= ev.series.t.length - 1) st.cur = 0;
    const stepN = Math.max(1, Math.round(ev.series.t.length / 150));
    U.$('#ev-play').textContent = '⏸ 暂停';
    st.playing = setInterval(() => {
      st.cur = Math.min(ev.series.t.length - 1, st.cur + stepN);
      const r = U.$('#ev-cur'); if (r) { r.max = ev.series.t.length - 1; r.value = st.cur; }
      drawReplay();
      if (st.cur >= ev.series.t.length - 1) stop();
    }, 60);
  }
  function stop() { if (st.playing) clearInterval(st.playing); st.playing = null; const b = U.$('#ev-play'); if (b) b.textContent = '▶ 回放'; }

  function drawReplay() {
    const ev = Station.state().events.find(e => e.id === st.sel); if (!ev || !ev.series || !U.$('#ev-rp-T')) return;
    const s = ev.series, n = s.t.length; if (!n) return;
    const r = U.$('#ev-cur'); if (r) r.max = n - 1;
    const i = U.clamp(st.cur, 0, n - 1), x = s.t.map(t => (t - ev.tStart) / 60), xc = x[i];
    const vl = [{ x: 0, label: '事件触发', color: '#f97316' }, { x: xc, color: '#e2e8f0' }];
    U.lineChart(U.$('#ev-rp-T'), { series: [{ x, y: s.T, color: '#f97316', label: `${ev.loc} 故障点温度 ℃` }, { x, y: s.dT, color: '#fbbf24', label: 'ΔT (K)', dash: [4, 3] }], vlines: vl, xFmt: v => v.toFixed(1) + ' min' });
    U.lineChart(U.$('#ev-rp-E'), { series: [{ x, y: s.I, color: '#22d3ee', label: `S${ev.r + 1} 组串电流 A` }, { x, y: s.pa.map(v => v * 10), color: '#ef4444', label: 'P(电弧)×10' }], vlines: vl, yMin: 0, xFmt: v => v.toFixed(1) + ' min' });
    const tNow = hms(s.t[i]);
    const near = Station.state().log.filter(e => Math.abs(e.t - s.t[i]) <= 2 && (e.loc === ev.loc || e.loc === 'S' + (ev.r + 1))).map(e => e.type);
    U.$('#ev-cur-v').innerHTML = `${tNow} · T ${s.T[i].toFixed(1)} ℃ · ΔT ${s.dT[i].toFixed(1)} K · I ${s.I[i].toFixed(2)} A · P弧 ${(s.pa[i] * 100).toFixed(0)}%${near.length ? ` · <span style="color:#fbbf24">${near.join('、')}</span>` : ''}`;
  }

  function exportCsv() {
    if (!DATA.guard('export')) return;
    const E = Station.state().events;
    const rows = [['事件编号', '首次触发', '最近触发', '位置', '关联回路', '类型', '最高等级', '优先级', '状态', '触发原因', '处理记录']].concat(E.map(e => [
      e.id, hms(e.tStart), hms(e.tLast), e.loc, e.loop, e.type, U.LEVELS[Math.max(0, e.lvMax)].grade, e.prio, e.status, e.reasons.join('；'),
      e.trail.map(x => `${x.time} ${x.who} ${x.act}${x.note ? '：' + x.note : ''}`).join(' | ')]));
    U.download(`PV-FireGuard_事件档案_${Date.now()}.csv`, '﻿' + rows.map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\r\n'), 'text/csv;charset=utf-8');
    DATA.audit('导出事件档案', `${E.length} 起（CSV）`);
  }

  function onShow() { tab(st.tab); }

  return { init, live, onShow, select, ST_TAG };
})();

const Report = (() => {
  function init() {
    U.$('#rp-gen').onclick = generate;
    U.$('#rp-print').onclick = () => { if (!DATA.guard('export')) return; generate(); DATA.audit('导出诊断报告', 'PDF/打印'); setTimeout(() => window.print(), 100); };
    U.$('#rp-json').onclick = () => { if (!DATA.guard('export')) return; DATA.audit('导出诊断数据', 'JSON'); U.download(`PV-FireGuard_数据_${Date.now()}.json`, JSON.stringify(collect(), null, 2), 'application/json'); };
  }

  function collect() {
    const S = Station.state();
    return {
      generated: new Date().toISOString(), simClock: U.hms(11 * 3600 + S.t), env: S.env, stationLevel: S.lvMax, stationRisk: S.risk, stats: S.stats, criteria: { ...FUSE.CFG },
      modules: S.modules.filter(m => m.lvIdx >= 1 || m.diag || m.fire > 0 || m.burnt).map(m => ({ id: m.id, T: +m.Tm.toFixed(1), dT: +m.dTraw.toFixed(1), rate: +m.rate.toFixed(2), level: m.lvIdx, risk: +m.risk.toFixed(1), diag: m.diag && { cls: m.diag.name, part: m.diag.part, conf: +m.diag.conf.toFixed(3), grade: m.diag.grade.name }, fire: m.fire > 0, burnt: m.burnt })),
      strings: S.strings.map(s => ({ id: s.id, loop: DATA.loopPath(s.idx), V: +s.V.toFixed(1), I: +s.I.toFixed(2), pArc: +s.pArc.toFixed(3), arc: s.arc, shutdown: s.shutdown })),
      arcSegments: S.arcSegs.map(g => ({ string: g.id, start: g.start, end: g.end, peak: +g.peak.toFixed(3), confirmed: g.confirmed, locate: g.locate, evidence: g.evidence.map(e => `${e.name} ${e.z.toFixed(1)}σ`) })),
      events: S.events.map(({ series, image, ...e }) => e),
      sources: DATA.SOURCES.map(s => ({ id: s.id, online: DATA.online(s.id), offsetMs: +s.offset.toFixed(2), issues: DATA.quality(s, S.t).issues })),
      arcModel: Arc.meta, log: S.log
    };
  }

  function generate() {
    const S = Station.state(), env = S.env, now = new Date();
    const Lv = S.lvMax >= 0 ? U.LEVELS[S.lvMax] : null;
    const cnt = { red: 0, orange: 0, yellow: 0, blue: 0, action: 0, info: 0 };
    const byType = {};
    S.log.forEach(e => { cnt[e.lv] = (cnt[e.lv] || 0) + 1; if (['red', 'orange', 'yellow'].includes(e.lv)) byType[e.type] = (byType[e.type] || 0) + 1; });
    const abn = S.modules.filter(m => m.lvIdx >= 1 || m.fire > 0 || m.burnt || (m.diag && m.diag.cls !== 'reflect')).sort((a, b) => b.lvIdx - a.lvIdx || b.risk - a.risk);
    const L = S.stats.leads, meta = Arc.meta, rk = Risk.last;
    const hs = Hotspot.state.history[0];
    const row = (k, v) => `<tr><th style="width:34%">${k}</th><td>${v}</td></tr>`;
    const bad = DATA.SOURCES.map(s => [s, DATA.quality(s, S.t)]).filter(([, q]) => !q.ok);
    let n = 0; const H = t => `<h2>${'一二三四五六七八九十'[n++]}、${t}</h2>`;
    U.$('#report-body').innerHTML = `
      <h1>光伏电站故障诊断与火灾预警 · 运行诊断报告</h1>
      <div class="meta">PV-FireGuard 软件模型机 ｜ 中国科学技术大学 火灾安全全国重点实验室 ｜ 生成时间 ${now.toLocaleString('zh-CN')} ｜ 仿真时钟 ${U.hms(11 * 3600 + S.t)} ｜ 生成人 ${DATA.ROLES[DATA.role].name}</div>

      ${H('电站总览与状态监测')}
      <table>${row('电站最高预警等级', Lv ? `${U.tag(Lv.grade + '预警 · ' + Lv.name, Lv.key)} 处置优先级 ${FUSE.PRIO[S.lvMax].p}` : '正常')}
        ${row('参考风险指数', `${S.risk.toFixed(0)} / 100`)}
        ${row('环境工况', `辐照 ${env.G} W/m²，气温 ${env.Ta} ℃，风速 ${env.v} m/s，相对湿度 ${env.RH}%，可燃物堆积 ${(env.debris * 100).toFixed(0)}%`)}
        ${row('在网组件 / 关断组串', `${S.modules.filter(m => !m.burnt && m.fire <= 0 && S.strings[m.r].I > 0).length} / 72 ；${S.strings.filter(s => s.shutdown).map(s => s.id).join('、') || '无'}`)}
        ${row('测点在线 / 质量异常', `${DATA.SOURCES.filter(s => DATA.online(s.id)).length} / ${DATA.SOURCES.length} ；${bad.length ? bad.map(([s, q]) => `${s.id}（${q.issues.join('、')}）`).join('；') : '无'}`)}
        ${row('联动阻断 / 起火事件', `${S.stats.blocked} / ${S.stats.ignitions}`)}
        ${row('平均预警提前量', L.length ? (L.reduce((a, b) => a + b, 0) / L.length).toFixed(0) + ' s（' + L.length + ' 起）' : '无起火事件')}
        ${row('伪热斑抑制次数', S.stats.suppressed)}</table>
      <table style="margin-top:8px"><tr><th>组串 / 回路</th><th>电压</th><th>电流</th><th>P(电弧)</th><th>状态</th></tr>
        ${S.strings.map(s => `<tr><td>${DATA.loopPath(s.idx)}</td><td>${s.V.toFixed(0)} V</td><td>${s.I.toFixed(2)} A</td><td>${(s.pArc * 100).toFixed(1)}%</td><td>${s.shutdown ? '已快速关断' : s.arc ? '电弧确认' : s.noData ? '电流测点离线' : '正常'}</td></tr>`).join('')}</table>

      ${H('热异常诊断结果')}
      ${abn.length ? `<table><tr><th>组件</th><th>诊断结论 / 部位</th><th>置信度</th><th>温度</th><th>ΔT</th><th>温升速率</th><th>判据分级</th></tr>
        ${abn.map(m => `<tr><td>${m.id}</td><td>${m.burnt ? '已燃毁' : m.fire > 0 ? '燃烧中' : m.diag ? m.diag.name + ' · ' + m.diag.part + '（' + m.diag.grade.name + '）' : '温度异常'}</td><td>${m.diag ? (m.diag.conf * 100).toFixed(0) + '%' : '—'}</td><td>${m.Tm.toFixed(1)} ℃</td><td>${m.dTraw.toFixed(1)} K</td><td>${m.rate.toFixed(1)} K/min</td><td>${m.lvIdx >= 0 ? U.tag(U.LEVELS[m.lvIdx].grade, U.LEVELS[m.lvIdx].key) : '—'}</td></tr>`).join('')}</table>` : '<p>未发现热异常组件。</p>'}
      ${hs ? `<p>最近一次热异常诊断（${hs.label}）：${hs.regions.length ? hs.regions.map(r => `${r.cls}·${r.part} ${(r.conf * 100).toFixed(0)}%（ΔT ${r.dT.toFixed(1)} K，${r.grade}）`).join('；') : '未见异常'}</p>` : ''}

      ${H('疑似电弧事件')}
      ${S.arcSegs.length ? `<table><tr><th>回路</th><th>异常时段</th><th>峰值 P</th><th>结论</th><th>定位</th><th>诊断证据</th></tr>
        ${S.arcSegs.slice(0, 20).map(g => `<tr><td>${g.loop}</td><td>${U.hms(11 * 3600 + g.start)} – ${g.end != null ? U.hms(11 * 3600 + g.end) : '持续中'}</td><td>${(g.peak * 100).toFixed(0)}%</td><td>${g.confirmed ? '连续窗确认' : '疑似'}</td><td>${g.locate || '—'}</td><td>${g.evidence.map(e => `${e.name} ${e.z.toFixed(1)}σ`).join('、')}</td></tr>`).join('')}</table>` : '<p>统计周期内无疑似电弧事件。</p>'}

      ${H('事件档案与处理状态')}
      ${S.events.length ? `<table><tr><th>编号</th><th>首次触发</th><th>位置</th><th>类型</th><th>最高等级</th><th>优先级</th><th>状态</th><th>处理记录</th></tr>
        ${S.events.map(e => `<tr><td>${e.id}</td><td>${U.hms(11 * 3600 + e.tStart)}</td><td>${e.loc}</td><td>${e.type}</td><td>${U.tag(U.LEVELS[Math.max(0, e.lvMax)].grade, U.LEVELS[Math.max(0, e.lvMax)].key)}</td><td>${e.prio}</td><td>${e.status}</td><td>${e.trail.length} 条</td></tr>`).join('')}</table>` : '<p>暂无事件档案。</p>'}
      <p>告警统计：红色 ${cnt.red}，橙色 ${cnt.orange}，黄色 ${cnt.yellow}，联动处置 ${cnt.action}。${Object.keys(byType).length ? '主要告警类型：' + Object.entries(byType).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, v]) => `${k} ×${v}`).join('；') : ''}</p>

      ${H('算法模型与预警判据')}
      <table>${row('电弧判别模型', meta ? `多域特征 17 维 → MLP 17-${meta.nHid}-5，训练 ${meta.nTrain} / 测试 ${meta.nTest} 样本，${meta.epochs} 轮` : '未训练')}
        ${meta ? row('测试准确率 / 电弧检出率 / 误报率', `${(meta.acc * 100).toFixed(1)}% / ${(meta.recall * 100).toFixed(1)}% / ${(meta.far * 100).toFixed(1)}%`) : ''}
        ${row('热斑视觉流水线', '灰度化 → 高斯/Sobel/LoG 卷积特征 → 滞后阈值连通域候选 + NMS → 6 类可解释分类 + 四级分级 + 部位定位')}
        ${row('电—热融合判据 ' + FUSE.VERSION, `ΔT ${FUSE.CFG.dT1}/${FUSE.CFG.dT2}/${FUSE.CFG.dT3} K；温升 ≥${FUSE.CFG.rate} K/min；温度 ${FUSE.CFG.T1}/${FUSE.CFG.T2} ℃；电弧疑似 ${FUSE.CFG.pSus} / 确认 ${FUSE.CFG.pArc}×${FUSE.CFG.nWin} 窗`)}</table>

      ${rk ? `${H('专项电—热融合风险评估')}
      <table>${row('评估对象', `${rk.p.type === 'none' ? '无故障基线' : TH.FAULTS[rk.p.type].name}（严重度 ${rk.p.sev.toFixed(2)}），${TH.SCENES[rk.p.scene][0]}，${TH.MATS[rk.p.mat][0]}`)}
        ${row('判据分级 / 处置优先级', `${FUSE.tagOf(rk.g)} ${FUSE.prioTag(rk.g)}`)}
        ${row('触发原因', rk.g.reasons.map(x => `${x.by} ${x.txt}`).join('；') || '无')}
        ${row('参考风险指数', `${rk.r.R.toFixed(0)}，起火概率 ${(rk.r.P * 100).toFixed(1)}%，风险矩阵 L${rk.r.L}×C${rk.r.Cl}`)}
        ${row('热失控推演', `无防护峰值 ${rk.simNo.Tpeak.toFixed(0)} ℃${rk.simNo.tIgn != null ? '，约 ' + rk.simNo.tIgn + ' s 达到引燃温度' : '，推演时段内未引燃'}${rk.simYes ? `；有联动处置峰值 ${Math.max(...rk.simYes.T).toFixed(0)} ℃` : ''}`)}</table>
      <ol>${U.$('#rk-recos').innerHTML}</ol>` : ''}

      ${H('最近告警记录')}
      <table><tr><th>时间</th><th>位置</th><th>事件</th><th>等级</th><th>说明</th></tr>
        ${S.log.slice(0, 15).map(e => `<tr><td>${e.time}</td><td>${e.loc}</td><td>${e.type}</td><td>${U.tag(Station.LVNAME[e.lv] || e.lv, e.lv)}</td><td>${e.msg || ''}</td></tr>`).join('')}</table>
      <p class="meta" style="margin-top:20px">注：本报告由 PV-FireGuard 软件模型机自动生成。当前演示数据来自基于物理规律的仿真，模型参数与判据阈值为示意值，需经实验平台数据验证后使用。</p>`;
  }

  return { init, generate };
})();
