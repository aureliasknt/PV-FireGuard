'use strict';
/* 模块④ 电—热融合风险评估与预警：关联电气异常与热状态演化，依据验证判据分级 → 风险等级、触发原因与处置优先级 */
const Risk = (() => {
  const st = { last: null };
  const ft = s => s == null ? '—' : s < 60 ? `${s} 秒` : `${Math.floor(s / 60)} 分 ${s % 60} 秒`;
  let timer = null;
  const schedule = () => { clearTimeout(timer); timer = setTimeout(evaluate, 60); };

  function init() {
    const ty = U.$('#rk-type');
    ty.insertAdjacentHTML('beforeend', '<option value="none">无故障（基线）</option>');
    Object.entries(TH.FAULTS).forEach(([k, f]) => { if (k !== 'reflect') ty.insertAdjacentHTML('beforeend', `<option value="${k}">${f.name}</option>`); });
    ty.value = 'junction';
    Object.entries(TH.SCENES).forEach(([k, v]) => U.$('#rk-scene').insertAdjacentHTML('beforeend', `<option value="${k}">${v[0]}</option>`));
    U.$('#rk-scene').value = 'ci';
    Object.entries(TH.MATS).forEach(([k, v]) => U.$('#rk-mat').insertAdjacentHTML('beforeend', `<option value="${k}">${v[0]}</option>`));
    U.$('#rk-mat').value = 'B1';
    U.range('rk-sev', v => v.toFixed(2), schedule);
    U.range('rk-arc', v => (v * 100).toFixed(0) + '%', schedule);
    U.range('rk-dur', v => (v / 60).toFixed(0) + ' min', schedule);
    U.range('rk-obs', v => v + ' min', schedule);
    U.range('rk-G', v => v + ' W/m²', schedule);
    U.range('rk-Ta', v => v + ' ℃', schedule);
    U.range('rk-v', v => v.toFixed(1) + ' m/s', schedule);
    U.range('rk-RH', v => v + ' %', schedule);
    U.range('rk-debris', v => (v * 100).toFixed(0) + '%', schedule);
    U.range('rk-age', v => v + ' 年', schedule);
    ty.onchange = () => { setVal('rk-arc', ty.value === 'arc' ? 0.95 : 0.05); schedule(); };
    ['rk-scene', 'rk-mat', 'rk-afci', 'rk-rsd', 'rk-mon', 'rk-spr'].forEach(id => U.$('#' + id).addEventListener('change', schedule));
    U.$('#rk-from').onclick = () => {
      const m = Station.selected();
      if (!m) { U.toast('请先在“电站状态监测”中选中组件', 'warn'); return; }
      loadModule(m, Station.env(), Station.isAuto());
    };
  }

  function setVal(id, v) { const el = U.$('#' + id); el.value = v; el.dispatchEvent(new Event('input')); }

  function loadModule(m, env, auto) {
    U.$('#rk-type').value = m.fault && m.fault.type !== 'reflect' ? m.fault.type : 'none';
    if (m.fault) setVal('rk-sev', m.fault.sev);
    setVal('rk-arc', m.fault && m.fault.type === 'arc' ? 0.95 : 0.05);
    setVal('rk-G', Math.max(100, env.G)); setVal('rk-Ta', env.Ta); setVal('rk-v', env.v); setVal('rk-RH', env.RH); setVal('rk-debris', env.debris);
    U.$('#rk-scene').value = 'ci'; U.$('#rk-rsd').checked = auto; U.$('#rk-afci').checked = auto; U.$('#rk-mon').checked = true;
    evaluate();
    U.toast(`已载入组件 ${m.id} 的工况`, 'ok');
  }

  function read() {
    const b = id => U.$('#' + id).checked, n = id => +U.$('#' + id).value;
    return {
      type: U.$('#rk-type').value, sev: n('rk-sev'), arcProb: n('rk-arc'), dur: n('rk-dur'), obs: n('rk-obs') * 60,
      G: n('rk-G'), Ta: n('rk-Ta'), v: n('rk-v'), RH: n('rk-RH'), scene: U.$('#rk-scene').value, mat: U.$('#rk-mat').value,
      debris: n('rk-debris'), age: n('rk-age'), afci: b('rk-afci'), rsd: b('rk-rsd'), mon: b('rk-mon'), spr: b('rk-spr')
    };
  }

  function evaluate() {
    const p = read();
    const env = { G: p.G, Ta: p.Ta, v: p.v };
    const f = p.type === 'none' ? null : { type: p.type, sev: p.sev };
    const flat = (Tb) => ({ t: [0, p.dur], T: [Tb, Tb], cross: {}, Tpeak: Tb, Tbg: Tb, tIgn: null, tCut: null });
    const simNo = f ? TH.simulate(f, env, p.dur) : flat(TH.baseTemp(env));
    let tAlarm = null, simYes = null;
    const hasProt = p.afci || p.rsd || p.mon;
    const Tal = simNo.Tbg + 40;                                             // Ⅳ级（ΔT≥40 K）红色预警温度
    if (f && hasProt) {
      simYes = TH.simulate(f, env, p.dur, (t, s) => {
        if (p.type === 'arc' && p.afci && t >= 1) return true;              // AFCI：约 1 s 内切断
        if (p.type === 'arc' && p.mon && p.rsd && t >= 2) return true;      // 本系统电弧确认 + RSD
        if (p.type === 'arc' && p.mon && !p.rsd && t >= 2 + 60) return true; // 本系统告警 + 人工远程分闸
        if (!p.mon) return false;
        if (s.T >= Tal && tAlarm == null) tAlarm = t;
        if (tAlarm == null) return false;
        return p.rsd ? true : t - tAlarm >= 300;                            // RSD 自动关断 / 人工 5 min 内处置
      });
    }
    const arcDur = p.type === 'arc' ? (p.afci ? 1 : p.mon && p.rsd ? 2 : 60) : 0;
    const r = TH.risk({ ...p, Tpeak: simNo.Tpeak, Tbg: simNo.Tbg, arcDur });
    // 电—热判据核验：取观测时刻的热状态（无防护演化）与电气监测结果
    const k = Math.min(simNo.T.length - 1, p.obs), k0 = Math.max(0, k - 60);
    const Tobs = simNo.T[k], rate = (simNo.T[k] - simNo.T[k0]) * 60 / Math.max(1, k - k0);
    const g = FUSE.grade({ dT: Math.max(0, Tobs - simNo.Tbg), T: Tobs, rate, pArc: p.arcProb, arcConf: p.arcProb >= FUSE.CFG.pArc,
      sameLoop: !!f, synced: true, debris: p.debris, RH: p.RH });
    st.last = { p, simNo, simYes, r, g, obs: { t: k, T: Tobs, rate }, time: new Date() };
    render();
  }

  function render() {
    const L = st.last; if (!L) return;
    const { p, simNo, simYes, r, g } = L;
    U.gauge(U.$('#rk-gauge'), r.R, `参考风险指数 · 起火概率 ${(r.P * 100).toFixed(1)}%`);
    U.$('#rk-level').innerHTML = `<div style="font-size:20px;font-weight:700;margin:2px 0 4px;color:${g.lv >= 0 ? g.level.color : '#22c55e'}">${g.lv >= 0 ? g.level.grade + '预警 · ' + g.level.name : '正常'}</div>
      <div class="hint">处置优先级：${FUSE.prioTag(g)}</div>`;
    U.$('#rk-crit').innerHTML = g.C.map(c => `<tr><td><b>${c.id}</b> ${c.name}</td><td>${c.val}</td><td class="muted">${c.th}</td><td>${c.lv ? U.tag(c.res, c.id === 'C6' ? 'yellow' : c.lv >= 2 ? 'red' : 'orange') : '<span class="muted">' + c.res + '</span>'}</td></tr>`).join('');
    U.$('#rk-why').innerHTML = g.reasons.length ? g.reasons.map(x => `<li>${U.tag(U.LEVELS[x.lv].grade, U.LEVELS[x.lv].key)} <b>${x.by}</b> ${x.txt}</li>`).join('') : '<li class="muted">未满足任何预警判据</li>';
    U.$('#rk-obs-info').textContent = `观测时刻 t = ${(L.obs.t / 60).toFixed(0)} min：故障点 ${L.obs.T.toFixed(0)} ℃，温升速率 ${L.obs.rate.toFixed(1)} K/min，电弧概率 ${(p.arcProb * 100).toFixed(0)}%`;
    // 风险矩阵
    let html = '';
    for (let l = 5; l >= 1; l--) {
      html += `<div class="ax">${l}</div>`;
      for (let c = 1; c <= 5; c++) {
        const v = l * c, col = v >= 15 ? '#ef4444' : v >= 9 ? '#f97316' : v >= 4 ? '#eab308' : '#3b82f6';
        const hit = l === r.L && c === r.Cl;
        html += `<div class="cell${hit ? ' hit' : ''}" style="background:${col}${hit ? '' : '55'}">${hit ? '●' : v}</div>`;
      }
    }
    html += '<div></div>' + [1, 2, 3, 4, 5].map(c => `<div class="ax">${c}</div>`).join('');
    U.$('#rk-matrix').innerHTML = html;
    U.$('#rk-pc').innerHTML = `纵轴：可能性等级 L=${r.L}（P=${(r.P * 100).toFixed(1)}%）<br>横轴：后果严重度 C=${r.C.toFixed(1)}（${TH.SCENES[p.scene][0]} / ${TH.MATS[p.mat][0]}）`;
    // 雷达
    const cf = name => r.contrib.find(k => k.name === name);
    const prot = 1 - ((p.afci ? 0.35 : 0) + (p.rsd ? 0.3 : 0) + (p.mon ? 0.35 : 0));
    U.radar(U.$('#rk-radar'), ['热危险', '电弧危险', '环境', '可燃物', '后果', '防护不足'], [
      Math.max(cf('热斑温差').f / 1.5, cf('热失控程度').f), p.arcProb,
      (cf('环境高温').f + cf('强辐照').f + cf('低湿度').f) / 3, p.debris, (r.C - 1) / 4, prot
    ], r.lv.color);
    // 热失控曲线
    const series = [];
    if (simYes) series.push({ x: simYes.t.map(t => t / 60), y: simYes.T, color: '#22c55e', label: '有联动处置', width: 2.5 });
    series.push({ x: simNo.t.map(t => t / 60), y: simNo.T, color: '#ef4444', label: '无防护', width: 2, dash: [6, 4] });
    const ymax = Math.max(120, Math.min(960, Math.max(...simNo.T) * 1.08));
    U.lineChart(U.$('#rk-curve'), {
      series, xLabel: '时间 / min', yLabel: '故障点温度 / ℃', yMin: Math.min(...simNo.T) - 5, yMax: ymax,
      hlines: TH.THRESHOLDS.filter(t => t.T < ymax).map(t => ({ y: t.T, label: t.label, color: t.color })),
      vlines: simYes && simYes.tCut != null ? [{ x: simYes.tCut / 60, label: '切断故障电流', color: '#22c55e', dy: 14 }] : []
    });
    U.$('#rk-thr').innerHTML = TH.THRESHOLDS.map(t => `<tr><td style="color:${t.color}">${t.label}</td><td>${ft(simNo.cross[t.T])}</td><td>${simYes ? ft(simYes.cross[t.T]) : '—'}</td></tr>`).join('') +
      `<tr><td>峰值温度</td><td>${simNo.Tpeak.toFixed(0)} ℃</td><td>${simYes ? Math.max(...simYes.T).toFixed(0) + ' ℃' : '—'}</td></tr>`;
    // 贡献
    const cs = r.contrib.filter(k => Math.abs(k.v) > 1e-3).sort((a, b) => b.v - a.v);
    U.barChart(U.$('#rk-contrib'), { labels: cs.map(k => k.name), values: cs.map(k => k.v), colors: cs.map(k => k.v >= 0 ? '#f97316' : '#22c55e'), fmt: v => (v >= 0 ? '+' : '') + v.toFixed(2) });
    U.$('#rk-recos').innerHTML = recos(p, r, simNo, simYes, g).map(t => `<li>${t}</li>`).join('');
  }

  function recos(p, r, simNo, simYes, g) {
    const out = [];
    if (g.lv === 3) out.push('<b style="color:#fca5a5">P1 立即处置（红色）：</b>15 min 内快速关断相关组串，派员携带灭火器材到场核查，并通知消防控制室做好联动准备。');
    else if (g.lv === 2) out.push('<b style="color:#fdba74">P2 尽快复核（橙色）：</b>2 小时内安排现场复核，必要时关断组串；加密红外巡检频次至每小时一次。');
    else if (g.lv === 1) out.push('<b style="color:#fde047">P3 计划检修（黄色）：</b>纳入 24 小时检修计划，持续跟踪温度与电弧指标变化趋势。');
    else if (g.lv === 0) out.push('<b style="color:#93c5fd">P4 纳入巡检（蓝色）：</b>保持常规巡检周期，跟踪温差变化。');
    else out.push('<b style="color:#86efac">未触发预警判据：</b>保持常规巡检周期，关注季节性环境变化。');
    if (p.type === 'arc') out.push(p.afci ? 'AFCI 可在约 1 s 内切断电弧，建议同步排查松动的 MC4 连接器并规范压接工艺。' : `未配置 AFCI 时电弧约 ${simNo.tIgn != null ? simNo.tIgn + ' 秒' : '短时间'} 内即可引燃周边材料，<b>强烈建议加装符合 UL 1699B / IEC 63027 的电弧故障断路器</b>。`);
    if (simNo.tIgn != null && p.type !== 'arc') out.push(`无防护情况下故障点约 ${ft(simNo.tIgn)} 后达到引燃温度，${simYes && simYes.tIgn == null ? '联动处置可有效阻断热失控过程。' : '需尽快处置。'}`);
    if (simNo.Tpeak >= 150 && simNo.tIgn == null) out.push(`故障点峰值温度约 ${simNo.Tpeak.toFixed(0)} ℃，已超过 EVA/背板加速劣化温度，长期运行存在热失控风险。`);
    if (p.debris > 0.4) out.push('组件下方可燃物堆积较多（落叶、杂草、包装物），应立即清理并设置定期清理制度。');
    if (p.mat === 'B2' || p.mat === 'B3') out.push('屋面基材燃烧性能偏低，建议在光伏阵列下方设置不燃隔离层，并按防火分区预留防火间距与消防通道。');
    if (p.scene === 'bipv') out.push('BIPV 幕墙需重点关注层间防火封堵与竖向火蔓延，可在窗槛墙部位设置火灾探测与联动装置。');
    if (p.scene === 'storage') out.push('光储充场景需联动储能 BMS 与充电桩，防止光伏故障引发储能热失控连锁事故。');
    if (!p.rsd) out.push('建议加装组件级快速关断装置（RSD），实现故障时直流侧电压快速降至安全范围。');
    if (!p.mon) out.push('建议部署本平台的红外 + 电弧双通道在线监测，将故障发现时间由“巡检周期”缩短至秒级。');
    if (p.v >= 6) out.push(`当前风速 ${p.v} m/s，一旦起火易沿下风向蔓延，应关注下风向组件与建筑开口。`);
    if (p.RH < 30) out.push('环境湿度低，可燃物易被引燃，建议提高预警灵敏度。');
    return out;
  }

  function onShow() { if (!st.last) evaluate(); else render(); }

  return { init, evaluate, loadModule, onShow, get last() { return st.last; } };
})();
