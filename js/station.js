'use strict';
/* 电站数字孪生：热-电仿真、红外+电弧双通道诊断、分级预警、RSD 联动、火势蔓延 */
const Station = (() => {
  const ROWS = 6, COLS = 12, PMOD = 400, CLOCK0 = 11 * 3600;
  const S = {
    t: 0, running: true, speed: 1, view: 'thermal', modules: [], strings: [], log: [], trend: [],
    env: { G: 900, Ta: 30, v: 2, dir: 0, RH: 45, debris: 0.2, inv: false }, Gprev: 900,
    auto: true, sel: null, stats: { blocked: 0, ignitions: 0, leads: [], suppressed: 0 }, layout: null, risk: 0, frame: 0
  };

  function mkModule(r, c) {
    return { r, c, id: `S${r + 1}-M${String(c + 1).padStart(2, '0')}`, off: U.randn() * 0.5, fault: null, spot: null,
      Tm: 0, Tapp: 0, Tbg: 0, dTraw: 0, dT: 0, fire: 0, burnt: false, diag: null, diagT: -99, diagDT: 0, risk: 0, lvIdx: -1, firstAlarm: null, reflectAmp: 0 };
  }
  function build() {
    S.modules = []; S.strings = [];
    for (let r = 0; r < ROWS; r++) {
      S.strings.push({ idx: r, id: `S${r + 1}`, shutdown: false, I: 0, pArc: 0, hits: 0, arc: false, cls: 0, probs: null, arcSince: null });
      for (let c = 0; c < COLS; c++) S.modules.push(mkModule(r, c));
    }
    S.t = 0; S.log = []; S.trend = []; S.sel = null; S.stats = { blocked: 0, ignitions: 0, leads: [], suppressed: 0 };
  }
  const mod = (r, c) => (r >= 0 && r < ROWS && c >= 0 && c < COLS) ? S.modules[r * COLS + c] : null;

  /* ---------- 日志 ---------- */
  function log(loc, type, lv, conf, msg) {
    S.log.unshift({ t: S.t, time: U.hms(CLOCK0 + S.t), loc, type, lv, conf, msg });
    if (S.log.length > 300) S.log.length = 300;
    S.logDirty = true;
    if (lv === 'red') U.toast(`【${loc}】${type}`, 'danger');
  }
  const LVNAME = { blue: '蓝色预警', yellow: '黄色预警', orange: '橙色预警', red: '红色预警', info: '信息', action: '联动处置', ok: '恢复' };

  /* ---------- 故障注入 ---------- */
  function inject(m, type, sev) {
    if (m.burnt || m.fire > 0) { U.toast('该组件已过火，请先复位', 'warn'); return; }
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
    if (!st.shutdown) { st.shutdown = true; log(st.id, '组串紧急关断', 'action', null, '起火组串直流侧已快速关断'); }
  }

  /* ---------- 仿真一步（1 s） ---------- */
  function step() {
    S.t += 1;
    const env = S.env, Tbg0 = TH.baseTemp(env);
    const dG = Math.abs(env.G - S.Gprev); S.Gprev = env.G;
    // 组串电流
    S.strings.forEach(st => {
      const open = S.modules.some(m => m.r === st.idx && (m.fire > 0 || m.burnt));
      st.I = (st.shutdown || open) ? 0 : TH.stringCurrent(env.G) * (1 - 0.0004 * (Tbg0 - 25));
    });
    // 组件热状态
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
    // 每组串温差（以组串中位温度为基准）
    for (let r = 0; r < ROWS; r++) {
      const row = S.modules.filter(m => m.r === r && !m.burnt && m.fire <= 0);
      const med = U.median(row.map(m => m.Tapp));
      row.forEach(m => { m.dTraw = m.Tapp - med; });
    }
    arcDetect(dG);
    irDiagnose();
    assess();
    S.trend.push({ t: S.t, Tmax: Math.max(...S.modules.filter(m => !m.burnt).map(m => m.Tm), env.Ta), risk: S.risk });
    if (S.trend.length > 300) S.trend.shift();
  }

  function spread(m) {
    const env = S.env, rad = env.dir * Math.PI / 180, wx = Math.cos(rad), wy = Math.sin(rad);
    for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
      if (!dr && !dc) continue;
      const n = mod(m.r + dr, m.c + dc);
      if (!n || n.burnt || n.fire > 0) continue;
      const d = Math.hypot(dc, dr), along = (dc * wx + dr * wy) / d;
      // 同排相邻组件间距小、易蔓延；风向与可燃物显著加速蔓延
      const p = (dr === 0 ? 0.004 : 0.0015) / d * (1 + 1.5 * env.debris) * (1 + Math.max(0, along) * env.v / 3) * (env.RH < 30 ? 1.3 : 1);
      if (Math.random() < p) { n.firstAlarm = null; ignite(n); }
    }
  }

  /* ---------- 电信号通道：组串电弧检测 ---------- */
  function arcDetect(dG) {
    S.strings.forEach(st => {
      if (st.I < 0.3) { st.pArc = 0; st.hits = 0; st.probs = null; return; }
      const arcM = S.modules.find(m => m.r === st.idx && m.fault && m.fault.type === 'arc' && !m.burnt && m.fire <= 0);
      const type = arcM ? 'series' : S.env.inv ? 'inverter' : dG > 30 ? 'irradiance' : 'normal';
      const g = DSP.generate(type, { I0: st.I, sev: arcM ? arcM.fault.sev : 0.5, noise: 1, onset: 0 });
      const r = Arc.classify(g.x);
      if (!r.ready) { st.probs = null; return; }
      st.probs = r.probs; st.cls = r.probs.indexOf(Math.max(...r.probs));
      const pa = Arc.arcProb(r.probs);
      st.pArc = pa;
      st.hits = pa > 0.6 ? st.hits + 1 : 0;
      if (st.hits >= 2 && !st.arc) {
        st.arc = true; st.arcSince = S.t;
        // 电-热融合定位：组串内温度最高的组件
        const row = S.modules.filter(m => m.r === st.idx && !m.burnt);
        const hot = row.reduce((a, m) => m.Tm > a.Tm ? m : a, row[0]);
        st.locate = hot ? hot.id : null;
        log(st.id, '直流电弧故障', 'red', pa, `电信号确认电弧；红外融合定位于 ${st.locate}（${U.fmt(hot && hot.Tm, 0)} ℃）`);
        if (hot && hot.firstAlarm == null) hot.firstAlarm = S.t;
        if (S.auto) {
          st.shutdown = true; S.stats.blocked++;
          log(st.id, '自动快速关断(RSD)', 'action', null, `检出后 ${S.t - st.arcSince} s 内切断组串电流，电弧熄灭`);
        }
      }
      if (st.arc && st.hits === 0 && pa < 0.3) { st.arc = false; }
    });
  }

  /* ---------- 红外通道：组件热斑诊断（调用视觉流水线） ---------- */
  function irDiagnose() {
    let budget = 3;
    S.modules.forEach(m => {
      if (m.burnt || m.fire > 0) return;
      if (m.dTraw < 4) { if (m.diag && m.dTraw < 2.5) m.diag = null; return; }
      const stale = S.t - m.diagT > 30 || Math.abs(m.dTraw - m.diagDT) > 6 || !m.diag;
      if (!stale || budget <= 0) return;
      budget--;
      const scene = m.fault ? ({ arc: 'junction' }[m.fault.type] || m.fault.type) : 'normal';
      const s = VIS.synth(scene, { amp: m.dTraw, Tb: m.Tbg, noise: 0.3, sev: m.fault ? m.fault.sev : 0.5 });
      const res = VIS.analyze(s.T, s.W, s.H, { thK: 4 });
      m.diagT = S.t; m.diagDT = m.dTraw;
      if (!res.regions.length) { m.diag = null; return; }
      const top = res.regions[0];
      const prev = m.diag && m.diag.cls;
      m.diag = { cls: VIS.CLS[top.cls], name: VIS.CLS_NAMES[top.cls], conf: top.conf, dT: top.dTmax, grade: top.grade };
      if (m.diag.cls === 'reflect' && prev !== 'reflect') {
        S.stats.suppressed++;
        log(m.id, '伪热斑已抑制', 'info', top.conf, `识别为反光干扰（表观 ΔT ${top.dTmax.toFixed(1)} K），不触发告警`);
      } else if (m.diag.cls !== 'reflect' && prev !== m.diag.cls && m.lvIdx < 1) {
        log(m.id, `红外巡检发现：${m.diag.name}`, 'blue', top.conf, `${top.grade.name}，ΔT ${top.dTmax.toFixed(1)} K，纳入跟踪`);
      }
    });
  }

  /* ---------- 风险评估与分级告警 ---------- */
  function assess() {
    let maxR = 0;
    const env = S.env;
    const ef = 1 + 0.3 * env.debris + 0.1 * U.clamp((env.Ta - 30) / 10, 0, 1);
    S.modules.forEach(m => {
      if (m.burnt) { m.risk = 0; return; }
      if (m.fire > 0) { m.risk = 100; maxR = 100; return; }
      const st = S.strings[m.r];
      const suppressed = m.diag && m.diag.cls === 'reflect';
      const dT = suppressed ? 0 : (m.diag ? Math.max(0, m.dTraw) : 0);
      m.dT = dT;
      const arcHere = st.arc && st.locate === m.id && !st.shutdown;
      const D = m.spot ? m.spot.D : 0;
      const x = (0.022 * Math.max(0, dT - 5) + 2.8 * U.clamp((m.Tm - 90) / 310, 0, 1) + 0.3 * D + (arcHere ? 3 : 0)) * ef;
      m.risk = 100 * (1 - Math.exp(-x));
      maxR = Math.max(maxR, m.risk);
      const lv = m.risk >= 25 ? U.level(m.risk).idx : -1;
      if (lv > m.lvIdx && lv >= 1) {
        const L = U.LEVELS[lv];
        if (m.firstAlarm == null) m.firstAlarm = S.t;
        const what = m.diag ? `${m.diag.name}（${m.diag.grade.name}）` : '组件温度异常';
        log(m.id, what, L.key, m.diag ? m.diag.conf : null, `ΔT ${U.fmt(dT, 1)} K，故障点 ${U.fmt(m.Tm, 0)} ℃，风险指数 ${m.risk.toFixed(0)}`);
        if (lv === 3 && S.auto && !st.shutdown) {
          st.shutdown = true; S.stats.blocked++;
          log(st.id, '自动快速关断(RSD)', 'action', null, `${m.id} 达到红色预警，切断组串电流以阻断热失控`);
        }
      }
      if (lv > m.lvIdx) m.lvIdx = lv;
      else if (m.lvIdx >= 1 && m.risk < [0, 25, 50, 75][m.lvIdx] - 8) m.lvIdx = lv;   // 降级滞回，避免阈值附近反复告警
    });
    S.risk = maxR;
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
    if (announce) log('电站', '系统复位', 'info', null, '全部组件恢复正常运行');
    render();
  }

  /* ---------- 绘制 ---------- */
  function render() {
    const cv = U.$('#st-canvas'), s = U.setup(cv);
    if (s) drawArray(s);
    U.$('#hd-clock').textContent = U.hms(CLOCK0 + S.t);
    const lv = U.level(S.risk);
    U.$('#hd-risk').innerHTML = `<span style="color:${lv.color}">${S.risk.toFixed(0)} · ${lv.grade}</span>`;
    kpis(); stringsPanel(); detail();
    if (S.logDirty) { logTable(); S.logDirty = false; }
    if (S.frame++ % 2 === 0) trend();
  }

  function drawArray({ ctx, w, h }) {
    const m = { l: 44, r: 16, t: 30, b: 34 }, gap = 6;
    const mw = (w - m.l - m.r - gap * (COLS - 1)) / COLS, mh = Math.min(70, (h - m.t - m.b - gap * (ROWS - 1)) / ROWS);
    const top = m.t + ((h - m.t - m.b) - (mh * ROWS + gap * (ROWS - 1))) / 2;
    S.layout = { m, gap, mw, mh, top };
    // 屋面
    const grd = ctx.createLinearGradient(0, 0, 0, h); grd.addColorStop(0, '#1a2338'); grd.addColorStop(1, '#121a2c');
    ctx.fillStyle = grd; ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = 'rgba(148,163,184,.08)';
    for (let x = 0; x < w; x += 18) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke(); }
    ctx.font = '11px "Microsoft YaHei",sans-serif'; ctx.textBaseline = 'middle';
    const blink = (Date.now() / 500 | 0) % 2 === 0;
    for (let c = 0; c < COLS; c++) { ctx.fillStyle = '#64748b'; ctx.textAlign = 'center'; ctx.fillText('M' + (c + 1), m.l + c * (mw + gap) + mw / 2, top - 10); }
    S.modules.forEach(md => {
      const x = m.l + md.c * (mw + gap), y = top + md.r * (mh + gap);
      let col;
      if (md.burnt) col = [24, 20, 20];
      else if (S.view === 'thermal') col = U.PAL.iron((md.Tapp - 15) / (120 - 15));
      else { const L = U.level(md.risk); const c0 = L.color.match(/\w\w/g).map(h2 => parseInt(h2, 16)); const a = 0.25 + 0.75 * md.risk / 100; col = [c0[0] * a + 20 * (1 - a), c0[1] * a + 30 * (1 - a), c0[2] * a + 50 * (1 - a)]; }
      ctx.fillStyle = U.rgb(col); ctx.fillRect(x, y, mw, mh);
      // 电池片网格
      ctx.strokeStyle = 'rgba(255,255,255,.07)'; ctx.lineWidth = 1;
      for (let k = 1; k < 6; k++) { ctx.beginPath(); ctx.moveTo(x + mw * k / 6, y); ctx.lineTo(x + mw * k / 6, y + mh); ctx.stroke(); }
      for (let k = 1; k < 3; k++) { ctx.beginPath(); ctx.moveTo(x, y + mh * k / 3); ctx.lineTo(x + mw, y + mh * k / 3); ctx.stroke(); }
      if (md.burnt) { ctx.strokeStyle = '#3f3f46'; ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + mw, y + mh); ctx.moveTo(x + mw, y); ctx.lineTo(x, y + mh); ctx.stroke(); }
      if (md.fire > 0) flame(ctx, x + mw / 2, y + mh / 2, Math.min(mw, mh));
      // 告警边框
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
      if (st.shutdown) { ctx.fillStyle = 'rgba(15,23,42,.35)'; ctx.fillRect(m.l - 2, y - mh / 2 - 2, w - m.l - m.r + 4, mh + 4); }
    });
    // 风向
    const ax = w - 110, ay = h - 14, rad = S.env.dir * Math.PI / 180, L = 9 + S.env.v * 1.2;
    ctx.strokeStyle = '#7dd3fc'; ctx.fillStyle = '#7dd3fc'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(ax - Math.cos(rad) * L, ay - Math.sin(rad) * L); ctx.lineTo(ax + Math.cos(rad) * L, ay + Math.sin(rad) * L); ctx.stroke();
    ctx.beginPath(); ctx.arc(ax + Math.cos(rad) * L, ay + Math.sin(rad) * L, 3, 0, 7); ctx.fill(); ctx.lineWidth = 1;
    ctx.font = '11px "Microsoft YaHei",sans-serif'; ctx.textAlign = 'left'; ctx.fillText(`风 ${S.env.v} m/s`, ax + 22, ay);
    // 色标
    const lx = m.l, ly = h - 18, lw = Math.min(260, w * 0.35);
    if (S.view === 'thermal') {
      for (let i = 0; i < lw; i++) { ctx.fillStyle = U.rgb(U.PAL.iron(i / lw)); ctx.fillRect(lx + i, ly, 1, 8); }
      ctx.fillStyle = '#94a3b8'; ctx.textAlign = 'left';
      ctx.fillText('红外表观温度  15℃ → ≥120℃', lx + lw + 8, ly + 4);
    } else {
      U.LEVELS.forEach((L, i) => { ctx.fillStyle = L.color; ctx.fillRect(lx + i * 80, ly, 12, 8); ctx.fillStyle = '#94a3b8'; ctx.textAlign = 'left'; ctx.fillText(L.name, lx + i * 80 + 16, ly + 4); });
    }
  }

  function flame(ctx, x, y, s) {
    const f = 0.85 + 0.25 * Math.sin(Date.now() / 90 + x);
    const g = ctx.createRadialGradient(x, y + s * 0.15, 1, x, y, s * 0.75 * f);
    g.addColorStop(0, 'rgba(255,255,200,.95)'); g.addColorStop(0.35, 'rgba(255,170,0,.9)'); g.addColorStop(0.7, 'rgba(239,68,68,.6)'); g.addColorStop(1, 'rgba(239,68,68,0)');
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, s * 0.8 * f, 0, 7); ctx.fill();
  }

  function kpis() {
    const env = S.env;
    let P = 0;
    S.modules.forEach(m => {
      const st = S.strings[m.r];
      if (m.burnt || m.fire > 0 || st.I === 0) return;
      let k = 1 - 0.004 * (m.Tbg - 25);
      if (m.fault) k *= { shading: 0.67, bypass: 0.67, soiling: 0.92, crack: 0.95, junction: 0.97, arc: 0.9, reflect: 1 }[m.fault.type];
      P += PMOD * env.G / 1000 * k;
    });
    const nAct = S.modules.filter(m => !m.burnt && m.fire <= 0 && S.strings[m.r].I > 0).length;
    U.$('#k-power').innerHTML = `${(P / 1000).toFixed(2)}<small>kW</small>`;
    U.$('#k-power-s').textContent = `${nAct}/72 组件在网 · G ${env.G} W/m² · Ta ${env.Ta} ℃`;
    const live = S.modules.filter(m => !m.burnt);
    const hot = live.reduce((a, m) => (!a || m.Tm > a.Tm) ? m : a, null);
    U.$('#k-tmax').innerHTML = hot ? `${hot.Tm.toFixed(1)}<small>℃</small>` : '—';
    U.$('#k-tmax-s').textContent = hot ? `位于 ${hot.id} · 背景 ${TH.baseTemp(env).toFixed(1)} ℃` : '';
    const al = S.modules.filter(m => m.lvIdx >= 1 && !m.burnt).length + S.strings.filter(s => s.arc && !s.shutdown).length;
    const fires = S.modules.filter(m => m.fire > 0).length;
    U.$('#k-alarms').innerHTML = `${al}${fires ? `<small style="color:#ef4444">🔥${fires}</small>` : ''}`;
    U.$('#k-alarms-s').textContent = `已抑制伪热斑 ${S.stats.suppressed} 次`;
    const lv = U.level(S.risk);
    U.$('#k-risk').innerHTML = `<span style="color:${lv.color}">${S.risk.toFixed(0)}</span><small>/100</small>`;
    U.$('#k-risk-s').innerHTML = U.tag(lv.grade + '预警 · ' + lv.name, lv.key);
    U.$('#k-block').textContent = `${S.stats.blocked} / ${S.stats.ignitions}`;
    U.$('#k-block-s').textContent = S.auto ? '自动联动处置已启用' : '自动联动处置已关闭';
    const L = S.stats.leads;
    U.$('#k-lead').innerHTML = L.length ? `${(L.reduce((a, b) => a + b, 0) / L.length).toFixed(0)}<small>s</small>` : '—';
  }

  function stringsPanel() {
    U.$('#st-strings').innerHTML = S.strings.map(st => {
      const pa = st.pArc || 0;
      const status = st.shutdown ? U.tag('已关断', 'action') : st.arc ? U.tag('电弧告警', 'red') : st.I === 0 ? U.tag('停运', 'info') : U.tag('正常', 'ok');
      const cls = st.probs ? `<span style="color:${DSP.CLASS_COLORS[st.cls]}">${DSP.CLASS_NAMES[st.cls]}</span>` : (Arc.ready ? '—' : '<span class="muted">模型训练中</span>');
      const btn = st.shutdown ? `<button class="btn sm" data-restore="${st.idx}">恢复送电</button>` : '';
      return `<div class="srow"><b>${st.id}</b><span>${st.I.toFixed(2)} A</span><div><div class="mini-bar"><i style="width:${(pa * 100).toFixed(0)}%;background:${pa > 0.6 ? '#ef4444' : pa > 0.3 ? '#f97316' : '#22c55e'}"></i></div><div class="muted" style="font-size:11px;margin-top:2px">P(电弧) ${(pa * 100).toFixed(1)}% · ${cls}</div></div><span>${status}</span><span>${btn}</span></div>`;
    }).join('');
  }

  function detail() {
    const m = S.sel, el = U.$('#st-detail');
    if (!m) return;
    const st = S.strings[m.r];
    const status = m.burnt ? U.tag('已燃毁', 'info') : m.fire > 0 ? U.tag('燃烧中', 'red') : m.lvIdx >= 1 ? U.tag(U.LEVELS[m.lvIdx].grade + '预警', U.LEVELS[m.lvIdx].key) : U.tag('正常', 'ok');
    el.innerHTML = `<div class="row sp"><h3 style="margin:0">组件 ${m.id}</h3>${status}</div>
      <div class="kv" style="margin:10px 0">
        <div class="k">红外诊断</div><div class="v">${m.diag ? `${m.diag.name} ${(m.diag.conf * 100).toFixed(0)}%` : '无异常'}</div>
        <div class="k">异常分级</div><div class="v">${m.diag ? m.diag.grade.name : '—'}</div>
        <div class="k">故障点温度</div><div class="v">${U.fmt(m.Tm, 1)} ℃</div>
        <div class="k">相对组串温差 ΔT</div><div class="v">${U.fmt(m.dTraw, 1)} K</div>
        <div class="k">材料劣化指数 D</div><div class="v">${m.spot ? m.spot.D.toFixed(3) : '0'}</div>
        <div class="k">组串电流 / P(电弧)</div><div class="v">${st.I.toFixed(2)} A / ${(st.pArc * 100).toFixed(0)}%</div>
        <div class="k">风险指数</div><div class="v" style="color:${U.level(m.risk).color}"><b>${m.risk.toFixed(0)}</b></div>
        <div class="k">注入故障(真值)</div><div class="v muted">${m.fault ? TH.FAULTS[m.fault.type].name + ' · ' + m.fault.sev.toFixed(2) : '无'}</div>
      </div>
      <div class="row"><button class="btn sm" id="dt-ir">红外诊断详情</button><button class="btn sm" id="dt-risk">热失控推演</button><button class="btn sm" id="dt-clear">清除故障</button></div>`;
    U.$('#dt-ir').onclick = () => { Main.go('hotspot'); Hotspot.loadModule(m); };
    U.$('#dt-risk').onclick = () => { Main.go('risk'); Risk.loadModule(m, S.env, S.auto); };
    U.$('#dt-clear').onclick = () => { inject(m, 'clear'); render(); };
  }

  function logTable() {
    U.$('#st-log').innerHTML = S.log.slice(0, 120).map(e => `<tr><td>${e.time}</td><td>${e.loc}</td><td>${e.type}</td><td>${U.tag(LVNAME[e.lv] || e.lv, e.lv)}</td><td>${e.conf != null ? (e.conf * 100).toFixed(0) + '%' : '—'}</td><td class="muted">${e.msg || ''}</td></tr>`).join('') || '<tr><td colspan="6" class="muted">暂无事件</td></tr>';
  }

  function trend() {
    const T = S.trend; if (!T.length) return;
    const x = T.map(p => (p.t - S.t) / 60);
    U.lineChart(U.$('#st-trend-T'), { series: [{ x, y: T.map(p => p.Tmax), color: '#f97316', label: '组件最高温度 ℃', fill: 'rgba(249,115,22,.08)' }], xMin: -5, xMax: 0, xFmt: v => v.toFixed(0) + ' min' });
    U.lineChart(U.$('#st-trend-R'), { series: [{ x, y: T.map(p => p.risk), color: '#ef4444', label: '电站火灾风险指数', fill: 'rgba(239,68,68,.08)' }], xMin: -5, xMax: 0, yMin: 0, yMax: 100, xFmt: v => v.toFixed(0) + ' min',
      hlines: [{ y: 25, color: '#eab308' }, { y: 50, color: '#f97316' }, { y: 75, color: '#ef4444' }] });
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

  function init() {
    build();
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
    U.$('#st-play').onclick = () => { S.running = !S.running; U.$('#st-play').textContent = S.running ? '⏸ 暂停' : '▶ 继续'; U.$('#hd-pulse').style.background = S.running ? '' : '#64748b'; };
    U.$('#st-load').onclick = () => { const k = U.$('#st-scenario').value; if (!k) { U.toast('请先选择一个场景', 'warn'); return; } loadScenario(k); };
    U.$('#st-auto').onchange = e => { S.auto = e.target.checked; log('电站', S.auto ? '启用自动联动处置' : '关闭自动联动处置', 'info', null, S.auto ? '红色预警/电弧确认时自动快速关断组串' : '仅告警，不自动关断'); };
    U.$('#st-reset').onclick = () => reset();
    U.$('#st-strings').addEventListener('click', e => {
      const b = e.target.closest('[data-restore]'); if (!b) return;
      const st = S.strings[+b.dataset.restore];
      st.shutdown = false; st.arc = false; st.hits = 0;
      S.modules.filter(m => m.r === st.idx).forEach(m => { if (m.lvIdx === 3) m.lvIdx = 2; });
      log(st.id, '组串恢复送电', 'ok', null, '人工确认后恢复；若故障未排除将再次触发预警');
    });
    U.$('#st-csv').onclick = () => {
      const rows = [['时间', '位置', '事件', '等级', '置信度', '说明']].concat(S.log.slice().reverse().map(e => [e.time, e.loc, e.type, LVNAME[e.lv] || e.lv, e.conf != null ? (e.conf * 100).toFixed(0) + '%' : '', e.msg || '']));
      U.download(`PV-FireGuard_事件日志_${Date.now()}.csv`, '﻿' + rows.map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\r\n'), 'text/csv;charset=utf-8');
    };
    U.$('#st-clearlog').onclick = () => { S.log = []; S.logDirty = true; render(); };
    log('电站', '系统启动', 'info', null, '红外通道与电弧通道自检通过');
    for (let i = 0; i < 30; i++) step();
    setInterval(tick, 1000);
    setInterval(() => { if (Main.current() === 'station') { const s = U.setup(U.$('#st-canvas')); if (s) drawArray(s); } }, 250);
  }

  function tick() {
    if (S.running) for (let k = 0; k < S.speed; k++) step();
    if (Main.current() === 'station') render();
    else { U.$('#hd-clock').textContent = U.hms(CLOCK0 + S.t); const lv = U.level(S.risk); U.$('#hd-risk').innerHTML = `<span style="color:${lv.color}">${S.risk.toFixed(0)} · ${lv.grade}</span>`; }
  }

  return {
    init, render, step, onShow: () => { S.logDirty = true; render(); },
    selected: () => S.sel, env: () => ({ ...S.env }), isAuto: () => S.auto, state: () => S,
    LVNAME
  };
})();
