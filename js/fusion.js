'use strict';
/* 电—热融合风险分级：关联电气异常与热状态演化，依据验证判据分级，输出风险等级、触发原因与处置优先级 */
const FUSE = (() => {
  const DEF = { dT1: 10, dT2: 20, dT3: 40, rate: 3, T1: 85, T2: 150, pSus: 0.3, pArc: 0.6, nWin: 2, debris: 0.4, RH: 30 };
  const CFG = { ...DEF };
  const CFG_NAMES = {
    dT1: ['温差Ⅱ级阈值', 'K'], dT2: ['温差Ⅲ级阈值', 'K'], dT3: ['温差Ⅳ级阈值', 'K'], rate: ['持续温升速率阈值', 'K/min'],
    T1: ['故障点温度一级阈值', '℃'], T2: ['故障点温度二级阈值', '℃'], pSus: ['电弧疑似概率阈值', ''], pArc: ['电弧确认概率阈值', ''],
    nWin: ['电弧确认连续窗数', '窗'], debris: ['可燃物堆积加剧阈值', ''], RH: ['低湿度加剧阈值', '%']
  };
  const PRIO = [
    { p: 'P4', name: '纳入巡检', due: '下一巡检周期' },
    { p: 'P3', name: '计划检修', due: '24 h 内' },
    { p: 'P2', name: '尽快复核', due: '2 h 内' },
    { p: 'P1', name: '立即处置', due: '15 min 内' }
  ];

  /* x: { dT 热斑温差 K, T 故障点温度 ℃, rate 温升速率 K/min, pArc 电弧概率, arcConf 连续窗确认,
          sameLoop 电/热异常位于同一回路, synced 电/热测点时间同步, debris, RH } */
  function grade(x) {
    const c = CFG, f1 = v => U.fmt(v, 1);
    const C1 = { id: 'C1', name: '热斑温差 ΔT', val: `${f1(x.dT)} K`, th: `≥${c.dT1} / ${c.dT2} / ${c.dT3} K`, lv: x.dT >= c.dT3 ? 3 : x.dT >= c.dT2 ? 2 : x.dT >= c.dT1 ? 1 : 0 };
    C1.res = ['未触发', 'Ⅱ级', 'Ⅲ级', 'Ⅳ级'][C1.lv];
    const C2 = { id: 'C2', name: '温升速率 dT/dt', val: `${f1(x.rate)} K/min`, th: `≥${c.rate} K/min`, lv: x.rate >= c.rate ? 1 : 0 };
    C2.res = C2.lv ? '持续温升' : '未触发';
    const C3 = { id: 'C3', name: '故障点温度', val: `${U.fmt(x.T, 0)} ℃`, th: `≥${c.T1} / ${c.T2} ℃`, lv: x.T >= c.T2 ? 2 : x.T >= c.T1 ? 1 : 0 };
    C3.res = ['未触发', '超组件额定上限', '材料加速劣化'][C3.lv];
    const C4 = { id: 'C4', name: '电弧特征', val: `P=${(x.pArc * 100).toFixed(0)}%`, th: `疑似≥${(c.pSus * 100).toFixed(0)}%；确认≥${(c.pArc * 100).toFixed(0)}%×${c.nWin}窗`, lv: x.arcConf ? 2 : x.pArc >= c.pSus ? 1 : 0 };
    C4.res = ['未触发', '疑似', '确认'][C4.lv];
    const thermal = C1.lv >= 1 || C2.lv >= 1;
    const C5 = { id: 'C5', name: '电—热关联', val: !x.synced ? '时间未同步' : C4.lv && thermal ? (x.sameLoop ? '同一回路' : '不同回路') : '—', th: '电弧特征与热异常同回路、同时间窗', lv: x.synced && x.sameLoop && C4.lv >= 1 && thermal ? 1 : 0 };
    C5.res = C5.lv ? '关联成立' : !x.synced && C4.lv && thermal ? '暂不可用' : '未触发';
    const C6 = { id: 'C6', name: '环境加剧', val: `可燃物 ${(x.debris * 100).toFixed(0)}% / RH ${U.fmt(x.RH, 0)}%`, th: `可燃物≥${(c.debris * 100).toFixed(0)}% 或 RH<${c.RH}%`, lv: x.debris >= c.debris || x.RH < c.RH ? 1 : 0 };
    C6.res = C6.lv ? '加剧' : '未触发';
    const rules = [
      [3, C5.lv && C4.lv === 2, 'C4+C5', '电弧确认且同一回路热异常（电—热关联成立）'],
      [3, C3.lv === 2, 'C3', `故障点温度 ≥${c.T2} ℃，封装材料加速劣化`],
      [3, C1.lv === 3 && C2.lv, 'C1+C2', `ΔT ≥${c.dT3} K 且持续温升`],
      [2, C5.lv && C4.lv === 1, 'C4+C5', '疑似电弧与同一回路热异常关联'],
      [2, C4.lv === 2, 'C4', '电弧特征连续窗确认'],
      [2, C1.lv === 3, 'C1', `ΔT ≥${c.dT3} K（Ⅳ级热异常）`],
      [2, C1.lv === 2 && C2.lv, 'C1+C2', `ΔT ≥${c.dT2} K 且持续温升`],
      [2, C3.lv === 1, 'C3', `故障点温度 ≥${c.T1} ℃，超出组件额定上限`],
      [1, C1.lv === 2, 'C1', `ΔT ≥${c.dT2} K（Ⅲ级热异常）`],
      [1, C1.lv === 1 && C2.lv, 'C1+C2', `ΔT ≥${c.dT1} K 且持续温升`],
      [1, C4.lv === 1, 'C4', '电弧特征疑似'],
      [0, C1.lv === 1, 'C1', `ΔT ≥${c.dT1} K（Ⅱ级，观察）`]
    ];
    let lv = -1;
    const reasons = [];
    rules.forEach(([l, ok, by, txt]) => { if (ok) { reasons.push({ lv: l, by, txt }); if (l > lv) lv = l; } });
    if (lv === 1 && C6.lv) { lv = 2; reasons.unshift({ lv: 2, by: 'C6', txt: '环境加剧（可燃物堆积/低湿度），黄色升为橙色' }); }
    reasons.sort((a, b) => b.lv - a.lv);
    return { lv, level: lv >= 0 ? U.LEVELS[lv] : null, prio: lv >= 0 ? PRIO[lv] : null, reasons, C: [C1, C2, C3, C4, C5, C6] };
  }

  const tagOf = g => g.lv < 0 ? U.tag('正常', 'ok') : U.tag(`${g.level.grade}预警`, g.level.key);
  const prioTag = g => g.lv < 0 ? '—' : `<b>${g.prio.p}</b> ${g.prio.name}（${g.prio.due}）`;

  function set(k, v) { if (k in CFG && isFinite(v)) CFG[k] = v; }
  function reset() { Object.assign(CFG, DEF); }

  return { CFG, DEF, CFG_NAMES, PRIO, grade, tagOf, prioTag, set, reset, VERSION: 'v1.1' };
})();
