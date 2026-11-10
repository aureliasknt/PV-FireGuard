'use strict';
/* 物理驱动：故障点集总参数热平衡模型（含材料劣化正反馈）+ 数据驱动：可解释火灾风险融合评估 */
const TH = (() => {
  const SIG = 5.67e-8, EPS = 0.85, ALPHA = 0.9, CAREA = 10000; // 组件面热容 J/(m²·K)
  const T_IGN = 400;
  /* 故障热源：P(sev, I) 为故障点耗散功率 W；A 为热点面积 m²；glat 为横向导热 W/K；encl 为对流遮蔽系数 */
  const FAULTS = {
    shading: { name: '遮挡热斑', A: 0.05, glat: 1.2, encl: 1, P: (s, I) => s * 11.4 * I, desc: '被遮挡电池片反偏，承受子串电压耗散' },
    soiling: { name: '积灰污损', A: 0.12, glat: 1.0, encl: 1, P: (s, I) => s * 4 * I, desc: '下边框积灰造成局部遮挡' },
    crack: { name: '电池隐裂', A: 0.03, glat: 0.8, encl: 1, P: (s, I) => s * 2.5 * I, desc: '隐裂区域电流集中、局部失配' },
    junction: { name: '接线盒/连接器过热', A: 0.012, glat: 0.4, encl: 0.35, P: (s, I) => I * I * (0.05 + 0.9 * s), desc: '焊点虚接/接触电阻增大，I²R 发热' },
    bypass: { name: '旁路二极管失效', A: 0.04, glat: 1.0, encl: 1, P: (s, I) => s * 25 * I, desc: '二极管开路，遮挡电池承受高反偏功率' },
    arc: { name: '连接器串联电弧', A: 0.003, glat: 0.25, encl: 0.5, C: 15, P: (s, I) => I * (15 + 15 * s), desc: '连接器松动拉弧，弧压约 15–30 V' },
    reflect: { name: '反光干扰(非故障)', A: 0.05, glat: 1, encl: 1, P: () => 0, desc: '太阳/天空反射导致的伪热斑' }
  };
  const THRESHOLDS = [
    { T: 85, label: '85℃ 组件额定上限', color: '#eab308' },
    { T: 150, label: '150℃ EVA/背板加速劣化', color: '#f97316' },
    { T: 300, label: '300℃ 封装材料热分解', color: '#fb7185' },
    { T: T_IGN, label: '400℃ 背板/接线盒引燃', color: '#ef4444' }
  ];
  const hConv = v => 2 * (5.7 + 3.8 * v);                 // McAdams 双面对流
  const baseTemp = env => env.Ta + ALPHA * env.G / (hConv(env.v) + 6);
  const stringCurrent = G => 9.0 * Math.max(0, G) / 1000;

  function newSpot(env) { return { T: baseTemp(env), D: 0, ignited: false }; }

  /* 单步显式积分 */
  function step(s, f, env, I, dt, Tbg) {
    const F = FAULTS[f.type]; if (!F) return s;
    const A = F.A, C = F.C || CAREA * A;
    if (Tbg == null) Tbg = baseTemp(env);
    const P = F.P(f.sev, I) * (1 + 1.5 * s.D);
    const sub = Math.max(1, Math.ceil(dt / 0.5)), h = dt / sub;
    for (let k = 0; k < sub; k++) {
      const Tk = s.T + 273.15, Tak = env.Ta + 273.15;
      const q = P + ALPHA * env.G * A - hConv(env.v) * F.encl * A * (s.T - env.Ta)
        - EPS * SIG * A * (Tk ** 4 - Tak ** 4) - F.glat * (s.T - Tbg);
      s.T = Math.min(950, s.T + q / C * h);
      if (s.T > 130) s.D = Math.min(4, s.D + h * 0.003 * ((s.T - 130) / 50) ** 2);
      if (s.T >= T_IGN) s.ignited = true;
    }
    s.P = P;
    return s;
  }

  /* 推演：intervene(t, s) 返回 true 时切断电流（快速关断） */
  function simulate(f, env, dur, intervene) {
    const s = newSpot(env), out = { t: [], T: [], D: [], cross: {}, tCut: null, tIgn: null };
    let I = stringCurrent(env.G), cut = false;
    const Tbg = baseTemp(env);
    for (let t = 0; t <= dur; t += 1) {
      out.t.push(t); out.T.push(s.T); out.D.push(s.D);
      THRESHOLDS.forEach(th => { if (out.cross[th.T] == null && s.T >= th.T) out.cross[th.T] = t; });
      if (s.ignited && out.tIgn == null) out.tIgn = t;
      if (!cut && !s.ignited && intervene && intervene(t, s)) { cut = true; I = 0; out.tCut = t; }
      if (s.ignited) { s.T = Math.min(950, s.T + 25); continue; }
      step(s, f, env, I, 1, Tbg);
    }
    out.Tpeak = Math.max(...out.T);
    out.Tbg = Tbg;
    return out;
  }

  /* ---------- 可解释火灾风险融合 ---------- */
  const SCENES = { ground: ['地面集中式电站', 2.0], ci: ['工商业厂房屋顶', 3.6], home: ['户用屋顶', 3.0], bipv: ['BIPV 光伏幕墙', 4.5], storage: ['光储充一体站', 4.8] };
  const MATS = { A: ['A 级 不燃', -0.6], B1: ['B1 级 难燃', 0], B2: ['B2 级 可燃', 0.6], B3: ['B3 级 易燃', 1.0] };

  function risk(inp) {
    const c = U.clamp;
    const dT = Math.max(0, inp.Tpeak - inp.Tbg);
    const F = [
      ['热斑温差', c(dT / 60, 0, 1.5), 1.6],
      ['热失控程度', c((inp.Tpeak - 85) / 315, 0, 1), 3.2],
      ['电弧故障', inp.arcProb, 3.0],
      ['电弧持续', c(inp.arcDur / 2.5, 0, 1) * inp.arcProb, 1.2],
      ['环境高温', c((inp.Ta - 15) / 30, 0, 1), 0.5],
      ['强辐照', c(inp.G / 1100, 0, 1), 0.4],
      ['低湿度', c((70 - inp.RH) / 60, 0, 1), 0.5],
      ['可燃物堆积', inp.debris, 1.3],
      ['组件老化', c(inp.age / 25, 0, 1), 0.7],
      ['AFCI 电弧保护', inp.afci ? 1 : 0, -1.5 * inp.arcProb],
      ['快速关断 RSD', inp.rsd ? 1 : 0, -0.6],
      ['在线监测预警', inp.mon ? 1 : 0, -0.8]
    ];
    const b0 = -4.2;
    const contrib = F.map(([name, f, w]) => ({ name, f, w, v: f * w }));
    const z = b0 + contrib.reduce((a, k) => a + k.v, 0);
    const P = 1 / (1 + Math.exp(-z));
    let Cq = (SCENES[inp.scene] || SCENES.ci)[1] + (MATS[inp.mat] || MATS.B1)[1] + c(inp.v / 10, 0, 1) * 0.6 - (inp.spr ? 0.8 : 0);
    Cq = c(Cq, 1, 5);
    const L = P < 0.03 ? 1 : P < 0.1 ? 2 : P < 0.25 ? 3 : P < 0.5 ? 4 : 5;
    const R = 100 * c(Math.pow(P, 0.6) * (0.45 + 0.55 * (Cq - 1) / 4) * 1.25, 0, 1);
    return { P, z, contrib, C: Cq, L, Cl: Math.round(Cq), R, lv: U.level(R) };
  }

  return { FAULTS, THRESHOLDS, T_IGN, hConv, baseTemp, stringCurrent, newSpot, step, simulate, risk, SCENES, MATS };
})();
if (typeof module !== 'undefined') module.exports = TH;
