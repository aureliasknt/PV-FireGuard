'use strict';
/* 模块① 电站可视化与状态监测：设备与测点关联、热-电仿真、红外+电弧双通道诊断、电—热判据分级、事件生成与证据留存 */
const Station = (() => {
  const ROWS = 6, COLS = 12, PMOD = 400, CLOCK0 = 11 * 3600, FR_CAP = 1800, SER_CAP = 3600;
  const CLOSED = ['已关闭', '误报关闭'];
  const S = {
    t: 0, running: true, speed: 1, view: 'thermal', trendWin: 5, modules: [], strings: [], log: [], frames: [], events: [], evSeq: 0, arcSegs: [],
    env: { G: 900, Ta: 30, v: 2, dir: 0, RH: 45, debris: 0.2, inv: false }, Gprev: 900,
    auto: true, sel: null, stats: { blocked: 0, ignitions: 0, leads: [], suppressed: 0 }, layout: null, risk: 0, lvMax: -1, frame: 0, stepMs: 0
  };
  const clock = () => U.hms(CLOCK0 + S.t);

  function mkModule(r, c) {
    return { r, c, id: `S${r + 1}-M${String(c + 1).padStart(2, '0')}`, off: U.randn() * 0.5, fault: null, spot: null,
      Tm: 0, Tapp: 0, Tbg: 0, dTraw: 0, dT: 0, rate: 0, fire: 0, burnt: false, diag: null, diagT: -99, diagDT: 0, risk: 0, grade: null,
      lvIdx: -1, lowCnt: 0, firstAlarm: null, reflectAmp: 0 };
  }
  function build() {
    S.modules = []; S.strings = [];
    for (let r = 0; r < ROWS; r++) {
      S.strings.push({ idx: r, id: `S${r + 1}`, shutdown: false, I: 0, V: 0, pArc: 0, hits: 0, arc: false, cls: 0, probs: null, arcSince: null, locate: null, seg: null, noData: false, rsdAt: null });
      for (let c = 0; c < COLS; c++) S.modules.push(mkModule(r, c));
    }
    S.t = 0; S.log = []; S.frames = []; S.events = []; S.evSeq = 0; S.arcSegs = []; S.sel = null;
    S.stats = { blocked: 0, ignitions: 0, leads: [], suppressed: 0 };
  }
  const mod = (r, c) => (r >= 0 && r < ROWS && c >= 0 && c < COLS) ? S.modules[r * COLS + c] : null;

  /* ---------- 日志 ---------- */
  function log(loc, type, lv, conf, msg) {
    S.log.unshift({ t: S.t, time: clock(), loc, type, lv, conf, msg });
    if (S.log.length > 300) S.log.length = 300;
    S.logDirty = true;
    if (lv === 'red') U.toast(`【${loc}】${type}`, 'danger');
  }
  const LVNAME = { blue: '蓝色预警', yellow: '黄色预警', orange: '橙色预警', red: '红色预警', info: '信息', action: '联动处置', ok: '恢复' };

  /* ---------- 事件档案 ---------- */
  const isOpen = e => !CLOSED.includes(e.status);
  function pushSeries(ev, f) {
    const s = ev.series;
    if (s.t.length && s.t[s.t.length - 1] >= f.t) return;
    s.t.push(f.t); s.T.push(f.T[ev.mi]); s.dT.push(f.T[ev.mi] - f.med[ev.r]); s.I.push(f.I[ev.r]); s.pa.push(f.pa[ev.r]);
    if (s.t.length > SER_CAP) Object.values(s).forEach(a => a.shift());
  }
  function trail(ev, act, note, who = '系统') { ev.trail.push({ time: clock(), who, act, note }); }
  function raise(m, lv, reasons, what) {
    const st = S.strings[m.r];
    let ev = S.events.find(e => e.key === m.id && isOpen(e));
    if (!ev) {
      ev = { id: 'EV-' + String(++S.evSeq).padStart(4, '0'), key: m.id, loc: m.id, r: m.r, mi: m.r * COLS + m.c, loop: DATA.loopPath(m.r),
        type: what, lv, lvMax: lv, tStart: S.t, tLast: S.t, status: '待确认', reasons, source: '在线监测（红外 + 电信号）', trail: [],
        series: { t: [], T: [], dT: [], I: [], pa: [] } };
      S.frames.slice(-60).forEach(f => pushSeries(ev, f));
      trail(ev, '自动生成事件', `${U.LEVELS[lv].grade}预警：${reasons[0] || what}`);
      S.events.unshift(ev);
      if (S.events.length > 200) S.events.length = 200;
    } else {
      ev.tLast = S.t;
      if (lv > ev.lvMax) { ev.lvMax = lv; ev.type = what; trail(ev, '预警升级', `升级为${U.LEVELS[lv].grade}预警：${reasons[0] || what}`); }
      ev.lv = lv; ev.reasons = reasons;
    }
    if (st.rsdAt === S.t && !ev.trail.some(x => x.act === '联动处置' && x.time === clock())) trail(ev, '联动处置', `${st.id} 快速关断(RSD)，切断回路电流`);
    ev.prio = FUSE.PRIO[ev.lvMax].p;
    S.evDirty = true;
    return ev;
  }
  function addExternal(o) {
    const ev = { id: 'EV-' + String(++S.evSeq).padStart(4, '0'), key: 'ext-' + S.evSeq, loc: o.loc, r: null, mi: null, loop: o.loop || '—',
      type: o.type, lv: o.lv, lvMax: o.lv, prio: FUSE.PRIO[Math.max(0, o.lv)].p, tStart: S.t, tLast: S.t, status: '待确认', reasons: o.reasons || [],
      source: o.source, image: o.image || null, trail: [], series: null };
    trail(ev, '人工提交事件', o.note || '', DATA.ROLES[DATA.role].name);
    S.events.unshift(ev); S.evDirty = true;
    log(o.loc, `事件 ${ev.id} 已建档`, 'info', null, `${o.source}：${o.type}`);
    return ev;
  }
  const FLOW = {
    confirm: { from: ['待确认'], to: '排查中', name: '确认事件' },
    falsepos: { from: ['待确认', '排查中'], to: '误报关闭', name: '判定误报' },
    handle: { from: ['排查中'], to: '处理中', name: '开始处理' },
    repair: { from: ['处理中'], to: null, name: '执行检修' },
    review: { from: ['处理中'], to: '待复核', name: '提交复核' },
    pass: { from: ['待复核'], to: '已关闭', name: '复核通过' },
    reject: { from: ['待复核'], to: '处理中', name: '复核不通过' }
  };
  function evAction(id, act, note) {
    if (!DATA.guard('event')) return false;
    const ev = S.events.find(e => e.id === id), F = FLOW[act];
    if (!ev || !F || !F.from.includes(ev.status)) return false;
    if (act === 'repair') {
      if (ev.mi == null) { note = (note ? note + '；' : '') + '现场检修完成'; }
      else {
        let m = S.modules[ev.mi];
        if (m.burnt || m.fire > 0) { m = S.modules[ev.mi] = mkModule(m.r, m.c); if (S.sel && S.sel.id === m.id) S.sel = m; note = (note ? note + '；' : '') + '更换过火组件'; }
        else { inject(m, 'clear'); m.lvIdx = -1; m.lowCnt = 0; }
        const st = S.strings[m.r];
        if (st.shutdown) { st.shutdown = false; st.arc = false; st.hits = 0; log(st.id, '组串恢复送电', 'ok', null, `事件 ${ev.id} 检修完成后恢复`); }
      }
      ev.repaired = true;
    }
    if (act === 'pass' && ev.mi != null) {
      const m = S.modules[ev.mi];
      if (m.lvIdx >= 1 || m.fire > 0 || m.burnt) { U.toast('复核未通过：该位置当前仍满足预警判据，请继续处理', 'warn'); return false; }
    }
    if (F.to) ev.status = F.to;
    trail(ev, F.name, note || '', DATA.ROLES[DATA.role].name);
    DATA.audit('事件' + F.name, `${ev.id}（${ev.loc}）${note ? '：' + note : ''}`);
    log(ev.loc, `事件 ${ev.id} ${F.name}`, act === 'pass' ? 'ok' : 'info', null, note || `状态 → ${ev.status}`);
    S.evDirty = true;
    return true;
  }

  /* ---------- 故障注入 ---------- */
  function inject(m, type, sev) {
    if (m.burnt || m.fire > 0) { U.toast('该组件已过火，请先复位或通过事件检修更换', 'warn'); return; }
    if (type === 'clear') {
      m.fault = null; m.spot = null; m.diag = null; m.lvIdx = -1; m.firstAlarm = null; m.reflectAmp = 0;
      log(m.id, '故障已清除', 'ok', null, '人工检修完成');
      return;
    }
    m.fault = { type, sev, t0: S.t };
    m.spot = TH.newSpot(S.env);
    m.reflectAmp = type === 'reflect' ? 12 + 20 * sev : 0;
    m.diagT = -99;
  }

  function ignite(m) {
    if (m.fire > 0 || m.burnt) return;
    m.fire = 120; S.stats.ignitions++;
    const lead = m.firstAlarm != null ? S.t - m.firstAlarm : null;
    if (lead != null) S.stats.leads.push(lead);
    log(m.id, '火灾确认：组件起火', 'red', 1, (lead != null ? `首次预警至起火 ${lead} s。` : '起火前未产生预警（蔓延引燃）。') + '已联动报警至消防控制室');
    const st = S.strings[m.r];
    if (!st.shutdown) { st.shutdown = true; st.rsdAt = S.t; log(st.id, '组串紧急关断', 'action', null, '起火组串直流侧已快速关断'); }
    const ev = raise(m, 3, ['火灾确认：组件起火'], '组件起火');
    trail(ev, '消防联动', '已报警至消防控制室');
    m.lvIdx = 3;
  }

  /* ---------- 电气量 ---------- */
  function stringV(st) {
    const env = S.env;
    if (st.shutdown || env.G < 20) return 0;
    const row = S.modules.filter(m => m.r === st.idx);
    if (row.some(m => m.fire > 0 || m.burnt)) return 0;
    let V = 0;
    row.forEach(m => {
      let v = 37.5 * (1 - 0.0035 * (m.Tbg - 25)) * (1 + 0.03 * Math.log(env.G / 1000));
      if (m.fault) {
        if (m.fault.type === 'shading' && m.fault.sev > 0.5) v *= 2 / 3;     // 旁路二极管导通，子串电压旁路
        if (m.fault.type === 'soiling') v *= 0.98;
        if (m.fault.type === 'arc' && st.I > 0) v -= 15 + 15 * m.fault.sev;   // 弧压
      }
      V += v;
    });
    return Math.max(0, st.I > 0 ? V : V * 1.2);
  }
  function power() {
    let P = 0;
    S.modules.forEach(m => {
      const st = S.strings[m.r];
      if (m.burnt || m.fire > 0 || st.I === 0) return;
      let k = 1 - 0.004 * (m.Tbg - 25);
      if (m.fault) k *= { shading: 0.67, bypass: 0.67, soiling: 0.92, crack: 0.95, junction: 0.97, arc: 0.9, reflect: 1 }[m.fault.type];
      P += PMOD * S.env.G / 1000 * k;
    });
    return P / 1000;
  }

  /* ---------- 仿真一步（1 s） ---------- */
  function step() {
    const t0 = performance.now();
    S.t += 1;
    DATA.tick(S.t);
    const env = S.env, Tbg0 = TH.baseTemp(env);
    const dG = Math.abs(env.G - S.Gprev); S.Gprev = env.G;
    S.strings.forEach(st => {
      const open = S.modules.some(m => m.r === st.idx && (m.fire > 0 || m.burnt));
      st.I = (st.shutdown || open) ? 0 : TH.stringCurrent(env.G) * (1 - 0.0004 * (Tbg0 - 25));
    });
    S.modules.forEach(m => {
      const st = S.strings[m.r];
      m.Tbg = Tbg0 + m.off + (st.I === 0 && env.G > 50 ? 1.5 : 0);
      if (m.burnt) { m.Tm = env.Ta + 3; m.Tapp = m.Tm; return; }
      if (m.fire > 0) {
        m.fire -= 1; m.Tm = 620 + U.randn() * 40; m.Tapp = m.Tm;
        if (m.fire <= 0) { m.burnt = true; m.fire = 0; log(m.id, '组件燃尽', 'info', null, '火焰熄灭'); }
        spread(m);
        return;
      }
      let T = m.Tbg;
      if (m.fault && m.fault.type !== 'reflect') {
        TH.step(m.spot, m.fault, env, st.I, 1, m.Tbg);
        T = Math.max(T, m.spot.T);
        if (m.spot.ignited) { ignite(m); return; }
      }
      m.Tm = T + U.randn() * 0.25;
      m.Tapp = m.Tm + m.reflectAmp * (env.G / 1000);
    });
    const med = [];
    for (let r = 0; r < ROWS; r++) {
      const row = S.modules.filter(m => m.r === r && !m.burnt && m.fire <= 0);
      med[r] = U.median(row.map(m => m.Tapp));
      row.forEach(m => { m.dTraw = m.Tapp - med[r]; });
    }
    S.strings.forEach(st => { st.V = stringV(st); });
    arcDetect(dG);
    irDiagnose();
    assess();
    const f = {
      t: S.t, Tmax: Math.max(...S.modules.filter(m => !m.burnt).map(m => m.Tm), env.Ta), risk: S.risk, P: power(),
      nAb: S.modules.filter(m => m.lvIdx >= 1 && !m.burnt).length,
      I: S.strings.map(s => s.I), V: S.strings.map(s => s.V), pa: S.strings.map(s => s.pArc), med, T: Float32Array.from(S.modules, m => m.Tm)
    };
    S.frames.push(f);
    if (S.frames.length > FR_CAP) S.frames.shift();
    S.events.forEach(ev => { if (ev.series && isOpen(ev)) pushSeries(ev, f); });
    S.stepMs = 0.9 * S.stepMs + 0.1 * (performance.now() - t0);
  }

  function spread(m) {
    const env = S.env, rad = env.dir * Math.PI / 180, wx = Math.cos(rad), wy = Math.sin(rad);
    for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
      if (!dr && !dc) continue;
      const n = mod(m.r + dr, m.c + dc);
      if (!n || n.burnt || n.fire > 0) continue;
      const d = Math.hypot(dc, dr), along = (dc * wx + dr * wy) / d;
      const p = (dr === 0 ? 0.004 : 0.0015) / d * (1 + 1.5 * env.debris) * (1 + Math.max(0, along) * env.v / 3) * (env.RH < 30 ? 1.3 : 1);
      if (Math.random() < p) { n.firstAlarm = null; ignite(n); }
    }
  }

  /* ---------- 电信号通道：组串电弧检测 + 异常时段记录 ---------- */
  function closeSeg(st) {
    if (!st.seg) return;
    st.seg.end = S.t;
    if (!st.seg.confirmed && st.seg.end - st.seg.start < 2) { const i = S.arcSegs.indexOf(st.seg); if (i >= 0) S.arcSegs.splice(i, 1); }
    st.seg = null;
    if (S.arcSegs.length > 100) S.arcSegs.length = 100;
  }
  function arcDetect(dG) {
    const C = FUSE.CFG;
    S.strings.forEach(st => {
      st.noData = !DATA.online('CT-S' + (st.idx + 1));
      if (st.I < 0.3 || st.noData) { st.pArc = 0; st.hits = 0; st.probs = null; closeSeg(st); return; }
      const arcM = S.modules.find(m => m.r === st.idx && m.fault && m.fault.type === 'arc' && !m.burnt && m.fire <= 0);
      const type = arcM ? 'series' : S.env.inv ? 'inverter' : dG > 30 ? 'irradiance' : 'normal';
      const g = DSP.generate(type, { I0: st.I, sev: arcM ? arcM.fault.sev : 0.5, noise: 1, onset: 0 });
      const r = Arc.classify(g.x);
      if (!r.ready) { st.probs = null; return; }
      st.probs = r.probs; st.cls = r.probs.indexOf(Math.max(...r.probs));
      const pa = Arc.arcProb(r.probs);
      st.pArc = pa;
      const row = S.modules.filter(m => m.r === st.idx && !m.burnt);
      const hot = row.reduce((a, m) => m.Tm > a.Tm ? m : a, row[0]);
      if (pa >= C.pSus) st.locate = hot ? hot.id : null;                    // 电—热融合定位：回路内温度最高的组件
      else if (!st.arc) st.locate = null;
      if (pa >= C.pSus) {
        if (!st.seg) { st.seg = { id: st.id, r: st.idx, loop: DATA.loopPath(st.idx), start: S.t, end: null, peak: pa, confirmed: false, locate: st.locate, cls: DSP.CLASS_NAMES[st.cls], evidence: Arc.evidence(r.f) }; S.arcSegs.unshift(st.seg); }
        else if (pa >= st.seg.peak) { st.seg.peak = pa; st.seg.evidence = Arc.evidence(r.f); st.seg.cls = DSP.CLASS_NAMES[st.cls]; st.seg.locate = st.locate; }
      } else closeSeg(st);
      st.hits = pa > C.pArc ? st.hits + 1 : 0;
      if (st.hits >= C.nWin && !st.arc) {
        st.arc = true; st.arcSince = S.t;
        if (st.seg) st.seg.confirmed = true;
        log(st.id, '电弧特征连续窗确认', 'orange', pa, `关联回路 ${DATA.loopPath(st.idx)}；红外融合定位于 ${st.locate}（${U.fmt(hot && hot.Tm, 0)} ℃）`);
        if (hot && hot.firstAlarm == null) hot.firstAlarm = S.t;
        if (S.auto) {
          st.shutdown = true; st.rsdAt = S.t; S.stats.blocked++;
          log(st.id, '自动快速关断(RSD)', 'action', null, `确认后 ${S.t - st.arcSince} s 内切断组串电流，电弧熄灭`);
        }
      }
      if (st.arc && st.hits === 0 && pa < 0.3) st.arc = false;
    });
  }

  /* ---------- 红外通道：组件热斑诊断（调用视觉流水线） ---------- */
  function irDiagnose() {
    let budget = 3;
    S.modules.forEach(m => {
      if (m.burnt || m.fire > 0) return;
      if (!DATA.online(DATA.irFor(m.r))) return;
      if (m.dTraw < 4) { if (m.diag && m.dTraw < 2.5) m.diag = null; return; }
      const stale = S.t - m.diagT > 30 || Math.abs(m.dTraw - m.diagDT) > 6 || !m.diag;
      if (!stale || budget <= 0) return;
      budget--;
      const scene = m.fault ? ({ arc: 'connector' }[m.fault.type] || m.fault.type) : 'normal';
      const s = VIS.synth(scene, { amp: m.dTraw, Tb: m.Tbg, noise: 0.3, sev: m.fault ? m.fault.sev : 0.5 });
      const res = VIS.analyze(s.T, s.W, s.H, { thK: 4 });
      m.diagT = S.t; m.diagDT = m.dTraw;
      if (!res.regions.length) { m.diag = null; return; }
      const top = res.regions[0];
      const prev = m.diag && m.diag.cls;
      m.diag = { cls: VIS.CLS[top.cls], name: VIS.CLS_NAMES[top.cls], part: VIS.partOf(top, s.W, s.H, true).part, conf: top.conf, dT: top.dTmax, grade: top.grade };
      if (m.diag.cls === 'reflect' && prev !== 'reflect') {
        S.stats.suppressed++;
        log(m.id, '伪热斑已抑制', 'info', top.conf, `识别为反光干扰（表观 ΔT ${top.dTmax.toFixed(1)} K），不触发告警，列入待复核`);
      } else if (m.diag.cls !== 'reflect' && prev !== m.diag.cls && m.lvIdx < 1) {
        log(m.id, `红外巡检发现：${m.diag.name}`, 'blue', top.conf, `部位：${m.diag.part}；${top.grade.name}，ΔT ${top.dTmax.toFixed(1)} K，纳入跟踪`);
      }
    });
  }

  /* ---------- 电—热融合判据分级 ---------- */
  function assess() {
    let maxR = 0, lvMax = -1;
    const env = S.env;
    const ef = 1 + 0.3 * env.debris + 0.1 * U.clamp((env.Ta - 30) / 10, 0, 1);
    const n = S.frames.length, past = n ? S.frames[Math.max(0, n - 60)] : null, span = past ? Math.max(1, S.t - past.t) : 1;
    S.modules.forEach((m, i) => {
      if (m.burnt) { m.risk = 0; m.grade = null; return; }
      if (m.fire > 0) { m.risk = 100; maxR = 100; lvMax = 3; return; }
      const st = S.strings[m.r];
      const irOk = DATA.online(DATA.irFor(m.r));
      const suppressed = m.diag && m.diag.cls === 'reflect';
      const dT = suppressed || !irOk ? 0 : (m.diag ? Math.max(0, m.dTraw) : 0);
      const T = irOk ? m.Tm : m.Tbg;
      m.dT = dT;
      m.rate = irOk && past ? (m.Tm - past.T[i]) * 60 / span : 0;
      const arcHere = st.locate === m.id && st.I > 0;
      const g = FUSE.grade({
        dT, T, rate: m.rate, pArc: arcHere ? st.pArc : 0, arcConf: arcHere && st.arc, sameLoop: true,
        synced: DATA.synced('CT-S' + (m.r + 1)) && DATA.synced(DATA.irFor(m.r)), debris: env.debris, RH: env.RH
      });
      m.grade = g;
      const D = m.spot ? m.spot.D : 0;
      const x = (0.022 * Math.max(0, dT - 5) + 2.8 * U.clamp((T - 90) / 310, 0, 1) + 0.3 * D + (arcHere && st.arc ? 3 : 0)) * ef;
      m.risk = 100 * (1 - Math.exp(-x));                                        // 参考风险指数（量化排序用）
      maxR = Math.max(maxR, m.risk);
      const lv = g.lv;
      if (lv > m.lvIdx) {
        m.lowCnt = 0;
        if (lv >= 1) {
          if (m.firstAlarm == null) m.firstAlarm = S.t;
          const L = U.LEVELS[lv];
          const what = arcHere && g.C[3].lv ? '回路电弧关联热异常' : m.diag ? `${m.diag.name}（${m.diag.part}）` : '组件温度异常';
          const why = g.reasons.filter(r => r.lv === lv).map(r => `${r.by} ${r.txt}`).join('；');
          log(m.id, what, L.key, m.diag ? m.diag.conf : null, `${why}｜${g.prio.p} ${g.prio.name}`);
          const ev = raise(m, lv, g.reasons.map(r => `${r.by}：${r.txt}`), what);
          if (lv === 3 && S.auto && !st.shutdown) {
            st.shutdown = true; st.rsdAt = S.t; S.stats.blocked++;
            log(st.id, '自动快速关断(RSD)', 'action', null, `${m.id} 达到红色预警，切断组串电流以阻断热失控`);
            trail(ev, '联动处置', `${st.id} 快速关断(RSD)，阻断热失控`);
          }
        }
        m.lvIdx = lv;
      } else if (lv < m.lvIdx) {
        if (++m.lowCnt >= 30) { m.lvIdx = lv; m.lowCnt = 0; }                    // 降级需持续 30 s，避免阈值附近反复告警
      } else m.lowCnt = 0;
      if (m.lvIdx >= 1 && m.lvIdx === lv) { const ev = S.events.find(e => e.key === m.id && isOpen(e)); if (ev) ev.tLast = S.t; }
      lvMax = Math.max(lvMax, m.lvIdx);
    });
    S.risk = maxR; S.lvMax = lvMax;
  }

  /* ---------- 场景库 ---------- */
  function setEnv(o) {
    Object.entries(o).forEach(([k, v]) => {
      S.env[k] = v;
      const el = U.$('#ev-' + k);
      if (el) { if (el.type === 'checkbox') el.checked = v; else { el.value = v; el.dispatchEvent(new Event('input')); } }
    });
  }
  function loadScenario(k) {
    reset(false);
    const put = (r, c, type, sev) => inject(mod(r, c), type, sev);
    if (k === 'A') setEnv({ G: 950, Ta: 28, v: 2, RH: 50, debris: 0.1, inv: false });
    if (k === 'B') { setEnv({ G: 1000, Ta: 33, v: 1.5, RH: 40, debris: 0.3, inv: false }); put(1, 3, 'shading', 0.9); put(4, 8, 'shading', 0.6); [0, 1, 2, 3].forEach(c => put(5, c + 4, 'soiling', 0.7)); put(2, 10, 'crack', 0.7); }
    if (k === 'C') { setEnv({ G: 900, Ta: 30, v: 2, RH: 45, debris: 0.3, inv: false }); put(2, 6, 'arc', 0.85); put(4, 2, 'junction', 0.55); }
    if (k === 'D') { setEnv({ G: 1100, Ta: 40, v: 8, dir: 0, RH: 25, debris: 0.6, inv: false }); put(1, 4, 'bypass', 1); put(3, 7, 'junction', 1); put(4, 2, 'arc', 0.9); put(0, 9, 'shading', 0.9); }
    if (k === 'E') { setEnv({ G: 950, Ta: 30, v: 2, RH: 50, debris: 0.2, inv: true }); put(0, 2, 'reflect', 0.8); put(3, 9, 'reflect', 0.7); put(5, 5, 'reflect', 0.9); }
    log('电站', '加载复杂故障场景 ' + k, 'info', null, U.$('#st-scenario').selectedOptions[0].textContent);
    U.toast('已加载' + U.$('#st-scenario').selectedOptions[0].textContent, 'ok');
  }

  function reset(announce = true) {
    build();
    if (announce) log('电站', '系统复位', 'info', null, '全部组件恢复正常运行，历史与事件档案已清空');
    S.evDirty = true;
    render();
  }

  /* ---------- 绘制 ---------- */
  function header() {
    U.$('#hd-clock').textContent = clock();
    const L = S.lvMax >= 0 ? U.LEVELS[S.lvMax] : null;
    U.$('#hd-risk').innerHTML = L ? `<span style="color:${L.color}">${L.grade}预警 · ${S.risk.toFixed(0)}</span>` : '<span style="color:#22c55e">正常</span>';
  }
  function render() {
    const cv = U.$('#st-canvas'), s = U.setup(cv);
    if (s) drawArray(s);
    header();
    kpis(); devTable(); detail();
    if (S.logDirty) { logTable(); S.logDirty = false; }
    if (S.frame++ % 2 === 0) trend();
  }

  function drawArray({ ctx, w, h }) {
    const m = { l: 44, r: 16, t: 30, b: 34 }, gap = 6;
    const mw = (w - m.l - m.r - gap * (COLS - 1)) / COLS, mh = Math.min(70, (h - m.t - m.b - gap * (ROWS - 1)) / ROWS);
    const top = m.t + ((h - m.t - m.b) - (mh * ROWS + gap * (ROWS - 1))) / 2;
    S.layout = { m, gap, mw, mh, top };
    const grd = ctx.createLinearGradient(0, 0, 0, h); grd.addColorStop(0, '#1a2338'); grd.addColorStop(1, '#121a2c');
    ctx.fillStyle = grd; ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = 'rgba(148,163,184,.08)';
    for (let x = 0; x < w; x += 18) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke(); }
    ctx.font = '11px "Microsoft YaHei",sans-serif'; ctx.textBaseline = 'middle';
    const blink = (Date.now() / 500 | 0) % 2 === 0;
    for (let c = 0; c < COLS; c++) { ctx.fillStyle = '#64748b'; ctx.textAlign = 'center'; ctx.fillText('M' + (c + 1), m.l + c * (mw + gap) + mw / 2, top - 10); }
    S.modules.forEach(md => {
      const x = m.l + md.c * (mw + gap), y = top + md.r * (mh + gap);
      const irOk = DATA.online(DATA.irFor(md.r));
      let col;
      if (md.burnt) col = [24, 20, 20];
      else if (S.view === 'thermal') col = irOk ? U.PAL.iron((md.Tapp - 15) / (120 - 15)) : [51, 65, 85];
      else if (md.lvIdx < 0 && md.fire <= 0) col = [30, 52, 48];
      else { const L = md.fire > 0 ? U.LEVELS[3] : U.LEVELS[Math.max(0, md.lvIdx)]; const c0 = L.color.match(/\w\w/g).map(h2 => parseInt(h2, 16)); const a = 0.45 + 0.55 * md.risk / 100; col = [c0[0] * a + 20 * (1 - a), c0[1] * a + 30 * (1 - a), c0[2] * a + 50 * (1 - a)]; }
      ctx.fillStyle = U.rgb(col); ctx.fillRect(x, y, mw, mh);
      ctx.strokeStyle = 'rgba(255,255,255,.07)'; ctx.lineWidth = 1;
      for (let k = 1; k < 6; k++) { ctx.beginPath(); ctx.moveTo(x + mw * k / 6, y); ctx.lineTo(x + mw * k / 6, y + mh); ctx.stroke(); }
      for (let k = 1; k < 3; k++) { ctx.beginPath(); ctx.moveTo(x, y + mh * k / 3); ctx.lineTo(x + mw, y + mh * k / 3); ctx.stroke(); }
      if (md.burnt) { ctx.strokeStyle = '#3f3f46'; ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + mw, y + mh); ctx.moveTo(x + mw, y); ctx.lineTo(x, y + mh); ctx.stroke(); }
      if (md.fire > 0) flame(ctx, x + mw / 2, y + mh / 2, Math.min(mw, mh));
      if (!md.burnt && md.lvIdx >= 1 && md.fire <= 0) {
        const L = U.LEVELS[md.lvIdx];
        if (!(md.lvIdx === 3 && !blink)) { ctx.strokeStyle = L.color; ctx.lineWidth = 2.5; ctx.strokeRect(x - 1, y - 1, mw + 2, mh + 2); }
      }
      if (md.diag && md.diag.cls === 'reflect') { ctx.fillStyle = '#cbd5e1'; ctx.textAlign = 'right'; ctx.fillText('伪', x + mw - 3, y + 9); }
      if (md.fault && md.fault.type === 'arc' && !md.burnt) { ctx.fillStyle = S.strings[md.r].shutdown ? '#94a3b8' : '#fde047'; ctx.textAlign = 'left'; ctx.font = 'bold 13px sans-serif'; ctx.fillText('ϟ', x + 3, y + 10); ctx.font = '11px "Microsoft YaHei",sans-serif'; }
      if (S.sel === md) { ctx.setLineDash([4, 3]); ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.strokeRect(x - 4, y - 4, mw + 8, mh + 8); ctx.setLineDash([]); }
    });
    S.strings.forEach(st => {
      const y = top + st.idx * (mh + gap) + mh / 2;
      ctx.textAlign = 'center'; ctx.fillStyle = st.arc && !st.shutdown ? (blink ? '#ef4444' : '#fca5a5') : '#94a3b8';
      ctx.font = 'bold 12px sans-serif'; ctx.fillText(st.id, 20, y - 6);
      ctx.font = '10px "Microsoft YaHei",sans-serif';
      if (st.shutdown) { ctx.fillStyle = '#a5b4fc'; ctx.fillText('RSD', 20, y + 8); }
      else if (st.arc) { ctx.fillStyle = '#ef4444'; ctx.fillText('电弧', 20, y + 8); }
      else if (st.noData) { ctx.fillStyle = '#fbbf24'; ctx.fillText('CT离线', 20, y + 8); }
      if (st.shutdown) { ctx.fillStyle = 'rgba(15,23,42,.35)'; ctx.fillRect(m.l - 2, y - mh / 2 - 2, w - m.l - m.r + 4, mh + 4); }
    });
    if (S.view === 'thermal') ['IR-01', 'IR-02'].forEach((id, k) => {
      if (DATA.online(id)) return;
      const y = top + k * 3 * (mh + gap) + (3 * mh + 2 * gap) / 2;
      ctx.fillStyle = '#fbbf24'; ctx.font = 'bold 13px "Microsoft YaHei",sans-serif'; ctx.textAlign = 'center';
      ctx.fillText(`${id} 红外通道离线 · 热异常诊断暂停`, m.l + (w - m.l - m.r) / 2, y);
      ctx.font = '11px "Microsoft YaHei",sans-serif';
    });
    const ax = w - 110, ay = h - 14, rad = S.env.dir * Math.PI / 180, L = 9 + S.env.v * 1.2;
    ctx.strokeStyle = '#7dd3fc'; ctx.fillStyle = '#7dd3fc'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(ax - Math.cos(rad) * L, ay - Math.sin(rad) * L); ctx.lineTo(ax + Math.cos(rad) * L, ay + Math.sin(rad) * L); ctx.stroke();
    ctx.beginPath(); ctx.arc(ax + Math.cos(rad) * L, ay + Math.sin(rad) * L, 3, 0, 7); ctx.fill(); ctx.lineWidth = 1;
    ctx.font = '11px "Microsoft YaHei",sans-serif'; ctx.textAlign = 'left'; ctx.fillText(`风 ${S.env.v} m/s`, ax + 22, ay);
    const lx = m.l, ly = h - 18, lw = Math.min(260, w * 0.35);
    if (S.view === 'thermal') {
      for (let i = 0; i < lw; i++) { ctx.fillStyle = U.rgb(U.PAL.iron(i / lw)); ctx.fillRect(lx + i, ly, 1, 8); }
      ctx.fillStyle = '#94a3b8'; ctx.textAlign = 'left';
      ctx.fillText('红外表观温度  15℃ → ≥120℃', lx + lw + 8, ly + 4);
    } else {
      [['正常', 'rgb(30,52,48)'], ...U.LEVELS.map(L => [L.grade + '预警', L.color])].forEach(([n, c], i) => { ctx.fillStyle = c; ctx.fillRect(lx + i * 78, ly, 12, 8); ctx.fillStyle = '#94a3b8'; ctx.textAlign = 'left'; ctx.fillText(n, lx + i * 78 + 16, ly + 4); });
    }
  }

  function flame(ctx, x, y, s) {
    const f = 0.85 + 0.25 * Math.sin(Date.now() / 90 + x);
    const g = ctx.createRadialGradient(x, y + s * 0.15, 1, x, y, s * 0.75 * f);
    g.addColorStop(0, 'rgba(255,255,200,.95)'); g.addColorStop(0.35, 'rgba(255,170,0,.9)'); g.addColorStop(0.7, 'rgba(239,68,68,.6)'); g.addColorStop(1, 'rgba(239,68,68,0)');
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, s * 0.8 * f, 0, 7); ctx.fill();
  }

  function kpis() {
    const env = S.env, P = power();
    const nAct = S.modules.filter(m => !m.burnt && m.fire <= 0 && S.strings[m.r].I > 0).length;
    U.$('#k-power').innerHTML = `${P.toFixed(2)}<small>kW</small>`;
    U.$('#k-power-s').textContent = `${nAct}/72 组件在网 · G ${env.G} W/m² · Ta ${env.Ta} ℃`;
    const live = S.modules.filter(m => !m.burnt);
    const hot = live.reduce((a, m) => (!a || m.Tm > a.Tm) ? m : a, null);
    U.$('#k-tmax').innerHTML = hot ? `${hot.Tm.toFixed(1)}<small>℃</small>` : '—';
    U.$('#k-tmax-s').textContent = hot ? `位于 ${hot.id} · 背景 ${TH.baseTemp(env).toFixed(1)} ℃` : '';
    const al = S.modules.filter(m => m.lvIdx >= 1 && !m.burnt).length;
    const fires = S.modules.filter(m => m.fire > 0).length;
    const open = S.events.filter(isOpen).length;
    U.$('#k-alarms').innerHTML = `${al}${fires ? `<small style="color:#ef4444">🔥${fires}</small>` : ''}`;
    U.$('#k-alarms-s').textContent = `未关闭事件 ${open} 起 · 已抑制伪热斑 ${S.stats.suppressed} 次`;
    const L = S.lvMax >= 0 ? U.LEVELS[S.lvMax] : null;
    U.$('#k-risk').innerHTML = L ? `<span style="color:${L.color}">${L.grade}</span><small>${FUSE.PRIO[S.lvMax].p}</small>` : '<span style="color:#22c55e">正常</span>';
    U.$('#k-risk-s').textContent = `参考风险指数 ${S.risk.toFixed(0)} / 100`;
    U.$('#k-block').textContent = `${S.stats.blocked} / ${S.stats.ignitions}`;
    U.$('#k-block-s').textContent = S.auto ? '自动联动处置已启用' : '自动联动处置已关闭';
    const on = DATA.SOURCES.filter(s => DATA.online(s.id)).length, bad = DATA.SOURCES.filter(s => !DATA.quality(s, S.t).ok).length;
    U.$('#k-online').innerHTML = `${on}<small>/ ${DATA.SOURCES.length}</small>`;
    U.$('#k-online-s').innerHTML = bad ? `<span style="color:#fbbf24">${bad} 个测点质量异常</span>` : '时间同步与数据质量正常';
  }

  /* 设备与测点状态：电压、电流、温度和在线状态 */
  const dot = id => { const s = DATA.src(id), q = DATA.quality(s, S.t); return `<span class="dot ${!DATA.online(id) ? 'off' : q.ok ? 'on' : 'warn'}" title="${id}：${!DATA.online(id) ? '离线' : q.ok ? '在线' : q.issues.join('、')}"></span>`; };
  function devTable() {
    U.$('#st-dev').innerHTML = S.strings.map(st => {
      const k = st.idx + 1, row = S.modules.filter(m => m.r === st.idx && !m.burnt);
      const Tm = Math.max(...row.map(m => m.Tm), S.env.Ta);
      const nab = S.modules.filter(m => m.r === st.idx && m.lvIdx >= 1).length;
      const vOk = DATA.online('VT-S' + k), iOk = DATA.online('CT-S' + k), tOk = DATA.online('TC-S' + k) || DATA.online(DATA.irFor(st.idx));
      const status = st.shutdown ? U.tag('已关断', 'action') : st.arc ? U.tag('电弧确认', 'red') : st.I === 0 ? U.tag('停运', 'info') : nab ? U.tag(`${nab} 处异常`, 'orange') : U.tag('正常', 'ok');
      const btn = st.shutdown ? ` <button class="btn sm" data-restore="${st.idx}">恢复送电</button>` : '';
      return `<tr><td><b>${st.id}</b></td><td class="muted">${DATA.loopOf(st.idx).cb} / ${DATA.loopOf(st.idx).mppt.split('/')[1]}</td>
        <td>${vOk ? st.V.toFixed(0) + ' V' : '<span class="muted">—</span>'}</td><td>${iOk ? st.I.toFixed(2) + ' A' : '<span class="muted">—</span>'}</td>
        <td>${vOk && iOk ? (st.V * st.I / 1000).toFixed(2) + ' kW' : '—'}</td><td>${tOk ? Tm.toFixed(1) + ' ℃' : '—'}</td>
        <td>${dot('CT-S' + k)}${dot('VT-S' + k)}${dot('TC-S' + k)}${dot(DATA.irFor(st.idx))}</td><td>${status}${btn}</td></tr>`;
    }).join('');
  }

  /* 组串回路电弧监测（显示于模块③） */
  function stringsPanel() {
    const el = U.$('#arc-strings'); if (!el) return;
    el.innerHTML = S.strings.map(st => {
      const pa = st.pArc || 0;
      const status = st.noData ? U.tag('采样不满足', 'orange') : st.shutdown ? U.tag('已关断', 'action') : st.arc ? U.tag('电弧确认', 'red') : pa >= FUSE.CFG.pSus ? U.tag('疑似电弧', 'orange') : st.I === 0 ? U.tag('停运', 'info') : U.tag('正常', 'ok');
      const cls = st.noData ? `<span style="color:#fbbf24">CT-S${st.idx + 1} 离线，暂停判别</span>` : st.probs ? `<span style="color:${DSP.CLASS_COLORS[st.cls]}">${DSP.CLASS_NAMES[st.cls]}</span>` : (Arc.ready ? '—' : '<span class="muted">模型训练中</span>');
      const btn = st.shutdown ? `<button class="btn sm" data-restore="${st.idx}">恢复送电</button>` : '';
      return `<div class="srow"><b>${st.id}</b><span>${st.I.toFixed(2)} A</span><div><div class="mini-bar"><i style="width:${(pa * 100).toFixed(0)}%;background:${pa > 0.6 ? '#ef4444' : pa > 0.3 ? '#f97316' : '#22c55e'}"></i></div><div class="muted" style="font-size:11px;margin-top:2px">${DATA.loopPath(st.idx)} · P(电弧) ${(pa * 100).toFixed(1)}% · ${cls}</div></div><span>${status}</span><span>${btn}</span></div>`;
    }).join('');
  }

  function distribution() {
    const rows = S.strings.map(st => {
      const ms = S.modules.filter(m => m.r === st.idx);
      const c = [0, 1, 2, 3].map(l => ms.filter(m => m.lvIdx === l && !m.burnt && m.fire <= 0).length);
      const fire = ms.filter(m => m.fire > 0 || m.burnt).length;
      const dmax = Math.max(0, ...ms.filter(m => !m.burnt).map(m => m.dT));
      const cell = (v, k) => v ? `<td style="color:${U.LEVELS[k].color};font-weight:700">${v}</td>` : '<td class="muted">0</td>';
      return `<tr><td><b>${st.id}</b></td>${c.map(cell).join('')}<td>${fire ? `<b style="color:#ef4444">${fire}</b>` : '<span class="muted">0</span>'}</td><td>${st.arc ? U.tag('确认', 'red') : st.pArc >= FUSE.CFG.pSus ? U.tag('疑似', 'orange') : '—'}</td><td>${dmax.toFixed(1)}</td></tr>`;
    }).join('');
    const types = {};
    S.modules.forEach(m => { if (m.lvIdx >= 1 && m.diag) types[m.diag.name] = (types[m.diag.name] || 0) + 1; });
    return `<h3>异常分布 <span class="sub">按组串 / 预警等级统计</span></h3>
      <table class="t"><thead><tr><th>组串</th><th>蓝</th><th>黄</th><th>橙</th><th>红</th><th>过火</th><th>电弧</th><th>ΔTmax</th></tr></thead><tbody>${rows}</tbody></table>
      <div class="hint" style="margin-top:8px">${Object.keys(types).length ? '异常类型：' + Object.entries(types).map(([k, v]) => `${k} ×${v}`).join('；') : '当前无黄色及以上异常。'}<br>点击阵列中任一组件查看测点详情与判据核验。</div>`;
  }

  function detail() {
    const m = S.sel, el = U.$('#st-detail');
    if (!m) { el.innerHTML = distribution(); return; }
    const st = S.strings[m.r], g = m.grade;
    const status = m.burnt ? U.tag('已燃毁', 'info') : m.fire > 0 ? U.tag('燃烧中', 'red') : m.lvIdx >= 1 ? U.tag(U.LEVELS[m.lvIdx].grade + '预警', U.LEVELS[m.lvIdx].key) : U.tag('正常', 'ok');
    el.innerHTML = `<div class="row sp"><h3 style="margin:0">组件 ${m.id}</h3><span>${status} <button class="btn sm" id="dt-back">返回总览</button></span></div>
      <div class="kv" style="margin:10px 0">
        <div class="k">关联回路</div><div class="v">${DATA.loopPath(m.r)}</div>
        <div class="k">关联测点</div><div class="v">${dot('CT-S' + (m.r + 1))}CT ${dot('VT-S' + (m.r + 1))}VT ${dot('TC-S' + (m.r + 1))}TC ${dot(DATA.irFor(m.r))}${DATA.irFor(m.r)}</div>
        <div class="k">红外诊断 / 部位</div><div class="v">${m.diag ? `${m.diag.name} ${(m.diag.conf * 100).toFixed(0)}% · ${m.diag.part}` : '无异常'}</div>
        <div class="k">故障点温度</div><div class="v">${U.fmt(m.Tm, 1)} ℃</div>
        <div class="k">ΔT / 温升速率</div><div class="v">${U.fmt(m.dTraw, 1)} K / ${U.fmt(m.rate, 1)} K/min</div>
        <div class="k">组串 V / I / P(电弧)</div><div class="v">${st.V.toFixed(0)} V / ${st.I.toFixed(2)} A / ${(st.pArc * 100).toFixed(0)}%</div>
        <div class="k">判据分级 / 优先级</div><div class="v">${g ? FUSE.tagOf(g) + ' ' + (g.prio ? g.prio.p : '') : '—'}</div>
        <div class="k">参考风险指数</div><div class="v"><b>${m.risk.toFixed(0)}</b></div>
        <div class="k">注入故障(真值)</div><div class="v muted">${m.fault ? TH.FAULTS[m.fault.type].name + ' · ' + m.fault.sev.toFixed(2) : '无'}</div>
      </div>
      ${g && g.reasons.length ? `<div class="hint" style="margin-bottom:8px">触发原因：${g.reasons.slice(0, 3).map(r => `${r.by} ${r.txt}`).join('；')}</div>` : ''}
      <div class="row"><button class="btn sm" id="dt-ir">热异常诊断</button><button class="btn sm" id="dt-risk">融合评估</button><button class="btn sm" id="dt-clear">清除故障</button></div>`;
    U.$('#dt-back').onclick = () => { S.sel = null; render(); };
    U.$('#dt-ir').onclick = () => { Main.go('hotspot'); Hotspot.loadModule(m); };
    U.$('#dt-risk').onclick = () => { Main.go('risk'); Risk.loadModule(m, S.env, S.auto); };
    U.$('#dt-clear').onclick = () => { inject(m, 'clear'); render(); };
  }

  function logTable() {
    U.$('#st-log').innerHTML = S.log.slice(0, 120).map(e => `<tr><td>${e.time}</td><td>${e.loc}</td><td>${e.type}</td><td>${U.tag(LVNAME[e.lv] || e.lv, e.lv)}</td><td>${e.conf != null ? (e.conf * 100).toFixed(0) + '%' : '—'}</td><td class="muted">${e.msg || ''}</td></tr>`).join('') || '<tr><td colspan="6" class="muted">暂无事件</td></tr>';
  }

  function trend() {
    const W = S.trendWin * 60, F = S.frames.filter(f => f.t > S.t - W);
    if (!F.length) return;
    const x = F.map(f => (f.t - S.t) / 60), o = { xMin: -S.trendWin, xMax: 0, xFmt: v => v.toFixed(0) + ' min' };
    U.lineChart(U.$('#st-trend-T'), { ...o, series: [{ x, y: F.map(f => f.Tmax), color: '#f97316', label: '组件最高温度 ℃', fill: 'rgba(249,115,22,.08)' }] });
    U.lineChart(U.$('#st-trend-P'), { ...o, yMin: 0, series: [{ x, y: F.map(f => f.P), color: '#22d3ee', label: '发电功率 kW', fill: 'rgba(34,211,238,.08)' }] });
    U.lineChart(U.$('#st-trend-R'), { ...o, yMin: 0, series: [{ x, y: F.map(f => f.nAb), color: '#ef4444', label: '黄色及以上异常组件数' }, { x, y: F.map(f => f.risk / 10), color: '#a78bfa', label: '参考风险指数 /10', dash: [4, 3] }] });
  }

  /* ---------- 交互 ---------- */
  function hit(ev) {
    const L = S.layout; if (!L) return null;
    const r = ev.target.getBoundingClientRect(), x = ev.clientX - r.left, y = ev.clientY - r.top;
    const c = Math.floor((x - L.m.l) / (L.mw + L.gap)), rr = Math.floor((y - L.top) / (L.mh + L.gap));
    const md = mod(rr, c);
    if (!md) return null;
    const lx = x - L.m.l - c * (L.mw + L.gap), ly = y - L.top - rr * (L.mh + L.gap);
    return lx <= L.mw && ly <= L.mh ? md : null;
  }

  function restore(idx) {
    const st = S.strings[idx];
    st.shutdown = false; st.arc = false; st.hits = 0;
    S.modules.filter(m => m.r === st.idx).forEach(m => { if (m.lvIdx === 3) m.lvIdx = 2; });
    log(st.id, '组串恢复送电', 'ok', null, '人工确认后恢复；若故障未排除将再次触发预警');
    DATA.audit('组串恢复送电', st.id);
  }

  function init() {
    build();
    DATA.setClock(clock);
    const env = S.env;
    U.range('ev-G', v => v + ' W/m²', v => env.G = v);
    U.range('ev-Ta', v => v + ' ℃', v => env.Ta = v);
    U.range('ev-v', v => v.toFixed(1) + ' m/s', v => env.v = v);
    const dirName = d => ['东', '东南', '南', '西南', '西', '西北', '北', '东北'][Math.round(d / 45) % 8];
    U.range('ev-dir', v => `${dirName(v)} ${v}°`, v => env.dir = v);
    U.range('ev-RH', v => v + ' %', v => env.RH = v);
    U.range('ev-debris', v => (v * 100).toFixed(0) + '%', v => env.debris = v);
    U.$('#ev-inv').onchange = e => env.inv = e.target.checked;
    U.range('st-sev', v => v.toFixed(2));
    U.$('#st-canvas').addEventListener('click', ev => {
      const m = hit(ev); if (!m) return;
      const tool = U.$('#st-tool').value;
      if (tool !== 'select') {
        inject(m, tool, +U.$('#st-sev').value);
        if (tool !== 'clear') log(m.id, '注入故障：' + TH.FAULTS[tool].name, 'info', null, `严重度 ${(+U.$('#st-sev').value).toFixed(2)}（模拟真实故障发生，诊断系统未获知真值）`);
      }
      S.sel = m; render();
    });
    U.$$('#st-view button').forEach(b => b.onclick = () => { U.$$('#st-view button').forEach(x => x.classList.toggle('on', x === b)); S.view = b.dataset.v; render(); });
    U.$$('#st-speed button').forEach(b => b.onclick = () => { U.$$('#st-speed button').forEach(x => x.classList.toggle('on', x === b)); S.speed = +b.dataset.s; });
    U.$$('#st-win button').forEach(b => b.onclick = () => { U.$$('#st-win button').forEach(x => x.classList.toggle('on', x === b)); S.trendWin = +b.dataset.w; trend(); });
    U.$('#st-play').onclick = () => { S.running = !S.running; U.$('#st-play').textContent = S.running ? '⏸ 暂停' : '▶ 继续'; U.$('#hd-pulse').style.background = S.running ? '' : '#64748b'; };
    U.$('#st-load').onclick = () => { const k = U.$('#st-scenario').value; if (!k) { U.toast('请先选择一个场景', 'warn'); return; } loadScenario(k); };
    U.$('#st-auto').onchange = e => { S.auto = e.target.checked; log('电站', S.auto ? '启用自动联动处置' : '关闭自动联动处置', 'info', null, S.auto ? '红色预警/电弧确认时自动快速关断组串' : '仅告警，不自动关断'); DATA.audit('联动处置开关', S.auto ? '启用' : '关闭'); };
    U.$('#st-reset').onclick = () => reset();
    // 表格每秒刷新，用 pointerdown 保证按钮点击不因重绘丢失
    document.addEventListener('pointerdown', e => {
      const b = e.target.closest('[data-restore]'); if (!b) return;
      if (!DATA.guard('event')) return;
      restore(+b.dataset.restore); render(); stringsPanel();
    });
    U.$('#st-csv').onclick = () => {
      if (!DATA.guard('export')) return;
      const rows = [['时间', '位置', '事件', '等级', '置信度', '说明']].concat(S.log.slice().reverse().map(e => [e.time, e.loc, e.type, LVNAME[e.lv] || e.lv, e.conf != null ? (e.conf * 100).toFixed(0) + '%' : '', e.msg || '']));
      U.download(`PV-FireGuard_告警日志_${Date.now()}.csv`, '﻿' + rows.map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\r\n'), 'text/csv;charset=utf-8');
      DATA.audit('导出告警日志', `${S.log.length} 条`);
    };
    U.$('#st-clearlog').onclick = () => { S.log = []; S.logDirty = true; render(); };
    log('电站', '系统启动', 'info', null, `${DATA.SOURCES.length} 个测点接入，红外通道与电弧通道自检通过`);
    DATA.audit('系统启动', '加载设备映射与预警判据 ' + FUSE.VERSION);
    for (let i = 0; i < 30; i++) step();
    setInterval(tick, 1000);
    setInterval(() => { if (Main.current() === 'station') { const s = U.setup(U.$('#st-canvas')); if (s) drawArray(s); } }, 250);
  }

  function tick() {
    if (S.running) for (let k = 0; k < S.speed; k++) step();
    const p = Main.current();
    if (p === 'station') render(); else header();
    if (p === 'arc') { stringsPanel(); Arc.live(); }
    if (p === 'report') Events.live();
    if (p === 'data') DataPage.live();
  }

  return {
    init, render, step, stringsPanel, onShow: () => { S.logDirty = true; render(); },
    selected: () => S.sel, env: () => ({ ...S.env }), isAuto: () => S.auto, state: () => S,
    evAction, addExternal, isOpen, FLOW, clock, LVNAME, mkFramesCsv: () => S.frames
  };
})();
