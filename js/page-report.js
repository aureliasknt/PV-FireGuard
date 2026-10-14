'use strict';
/* 诊断报告页 */
const Report = (() => {
  function init() {
    U.$('#rp-gen').onclick = generate;
    U.$('#rp-print').onclick = () => { generate(); setTimeout(() => window.print(), 100); };
    U.$('#rp-json').onclick = () => U.download(`PV-FireGuard_数据_${Date.now()}.json`, JSON.stringify(collect(), null, 2), 'application/json');
  }

  function collect() {
    const S = Station.state();
    return {
      generated: new Date().toISOString(), simClock: U.hms(11 * 3600 + S.t), env: S.env, stationRisk: S.risk, stats: S.stats,
      modules: S.modules.filter(m => m.lvIdx >= 1 || m.diag || m.fire > 0 || m.burnt).map(m => ({ id: m.id, T: +m.Tm.toFixed(1), dT: +m.dTraw.toFixed(1), risk: +m.risk.toFixed(1), diag: m.diag && { cls: m.diag.name, conf: +m.diag.conf.toFixed(3), grade: m.diag.grade.name }, fire: m.fire > 0, burnt: m.burnt })),
      strings: S.strings.map(s => ({ id: s.id, I: +s.I.toFixed(2), pArc: +s.pArc.toFixed(3), arc: s.arc, shutdown: s.shutdown })),
      arcModel: Arc.meta, log: S.log
    };
  }

  function generate() {
    const S = Station.state(), env = S.env, lv = U.level(S.risk), now = new Date();
    const cnt = { red: 0, orange: 0, yellow: 0, blue: 0, action: 0, info: 0 };
    const byType = {};
    S.log.forEach(e => { cnt[e.lv] = (cnt[e.lv] || 0) + 1; if (['red', 'orange', 'yellow'].includes(e.lv)) byType[e.type] = (byType[e.type] || 0) + 1; });
    const abn = S.modules.filter(m => m.lvIdx >= 1 || m.fire > 0 || m.burnt || (m.diag && m.diag.cls !== 'reflect')).sort((a, b) => b.risk - a.risk);
    const L = S.stats.leads, meta = Arc.meta, rk = Risk.last;
    const hs = Hotspot.state.history[0];
    const row = (k, v) => `<tr><th style="width:34%">${k}</th><td>${v}</td></tr>`;
    U.$('#report-body').innerHTML = `
      <h1>光伏电站故障诊断与火灾预警 · 运行诊断报告</h1>
      <div class="meta">PV-FireGuard v1.0 ｜ 中国科学技术大学 火灾安全全国重点实验室 ｜ 生成时间 ${now.toLocaleString('zh-CN')} ｜ 仿真时钟 ${U.hms(11 * 3600 + S.t)}</div>

      <h2>一、电站运行概况</h2>
      <table>${row('综合火灾风险', `<b>${S.risk.toFixed(0)}</b> / 100 ${U.tag(lv.grade + '预警 · ' + lv.name, lv.key)}`)}
        ${row('环境工况', `辐照 ${env.G} W/m²，气温 ${env.Ta} ℃，风速 ${env.v} m/s，相对湿度 ${env.RH}%，可燃物堆积 ${(env.debris * 100).toFixed(0)}%`)}
        ${row('在网组件 / 关断组串', `${S.modules.filter(m => !m.burnt && m.fire <= 0 && S.strings[m.r].I > 0).length} / 72 ；${S.strings.filter(s => s.shutdown).map(s => s.id).join('、') || '无'}`)}
        ${row('联动阻断次数', S.stats.blocked)}${row('起火事件', S.stats.ignitions)}
        ${row('平均预警提前量', L.length ? (L.reduce((a, b) => a + b, 0) / L.length).toFixed(0) + ' s（' + L.length + ' 起）' : '无起火事件')}
        ${row('伪热斑抑制次数', S.stats.suppressed)}</table>

      <h2>二、告警统计</h2>
      <table><tr><th>红色</th><th>橙色</th><th>黄色</th><th>联动处置</th><th>信息</th></tr>
        <tr><td>${cnt.red}</td><td>${cnt.orange}</td><td>${cnt.yellow}</td><td>${cnt.action}</td><td>${cnt.info}</td></tr></table>
      <p>${Object.keys(byType).length ? '主要告警类型：' + Object.entries(byType).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ×${v}`).join('；') : '统计周期内无黄色及以上告警。'}</p>

      <h2>三、异常组件清单</h2>
      ${abn.length ? `<table><tr><th>组件</th><th>诊断结论</th><th>置信度</th><th>温度</th><th>ΔT</th><th>风险</th><th>状态</th></tr>
        ${abn.map(m => `<tr><td>${m.id}</td><td>${m.burnt ? '已燃毁' : m.fire > 0 ? '燃烧中' : m.diag ? m.diag.name + '（' + m.diag.grade.name + '）' : '温度异常'}</td><td>${m.diag ? (m.diag.conf * 100).toFixed(0) + '%' : '—'}</td><td>${m.Tm.toFixed(1)} ℃</td><td>${m.dTraw.toFixed(1)} K</td><td>${m.risk.toFixed(0)}</td><td>${S.strings[m.r].shutdown ? '组串已关断' : '运行中'}</td></tr>`).join('')}</table>` : '<p>未发现异常组件。</p>'}

      <h2>四、组串电弧监测</h2>
      <table><tr><th>组串</th><th>电流</th><th>P(电弧)</th><th>AI 判别</th><th>状态</th></tr>
        ${S.strings.map(s => `<tr><td>${s.id}</td><td>${s.I.toFixed(2)} A</td><td>${(s.pArc * 100).toFixed(1)}%</td><td>${s.probs ? DSP.CLASS_NAMES[s.cls] : '—'}</td><td>${s.shutdown ? '已快速关断' : s.arc ? '电弧告警' : '正常'}</td></tr>`).join('')}</table>

      <h2>五、智能模型性能</h2>
      <table>${row('电弧判别模型', meta ? `多域特征 17 维 → MLP 17-${meta.nHid}-5，训练 ${meta.nTrain} / 测试 ${meta.nTest} 样本，${meta.epochs} 轮` : '未训练')}
        ${meta ? row('测试准确率 / 电弧检出率 / 误报率', `${(meta.acc * 100).toFixed(1)}% / ${(meta.recall * 100).toFixed(1)}% / ${(meta.far * 100).toFixed(1)}%`) : ''}
        ${row('热斑视觉流水线', '灰度化 → 高斯/Sobel/LoG 卷积特征 → 滞后阈值连通域候选 + NMS → 6 类可解释分类 + 四级分级')}
        ${hs ? row('最近一次红外诊断', `${hs.label}：${hs.regions.length ? hs.regions.map(r => `${r.cls} ${(r.conf * 100).toFixed(0)}%（ΔT ${r.dT.toFixed(1)} K，${r.grade}）`).join('；') : '未见异常'}`) : ''}</table>

      ${rk ? `<h2>六、专项火灾风险评估</h2>
      <table>${row('评估对象', `${rk.p.type === 'none' ? '无故障基线' : TH.FAULTS[rk.p.type].name}（严重度 ${rk.p.sev.toFixed(2)}），${TH.SCENES[rk.p.scene][0]}，${TH.MATS[rk.p.mat][0]}`)}
        ${row('风险指数 / 等级', `${rk.r.R.toFixed(0)} ${U.tag(rk.r.lv.grade + '预警 · ' + rk.r.lv.name, rk.r.lv.key)}，起火概率 ${(rk.r.P * 100).toFixed(1)}%，风险矩阵 L${rk.r.L}×C${rk.r.Cl}`)}
        ${row('热失控推演', `无防护峰值 ${rk.simNo.Tpeak.toFixed(0)} ℃${rk.simNo.tIgn != null ? '，约 ' + rk.simNo.tIgn + ' s 达到引燃温度' : '，推演时段内未引燃'}${rk.simYes ? `；有联动处置峰值 ${Math.max(...rk.simYes.T).toFixed(0)} ℃` : ''}`)}
        ${row('主要增险因子', rk.r.contrib.filter(k => k.v > 0.05).sort((a, b) => b.v - a.v).slice(0, 4).map(k => `${k.name}(+${k.v.toFixed(2)})`).join('、') || '无')}</table>
      <ol>${U.$('#rk-recos').innerHTML}</ol>` : ''}

      <h2>${rk ? '七' : '六'}、最近事件记录</h2>
      <table><tr><th>时间</th><th>位置</th><th>事件</th><th>等级</th><th>说明</th></tr>
        ${S.log.slice(0, 15).map(e => `<tr><td>${e.time}</td><td>${e.loc}</td><td>${e.type}</td><td>${U.tag(Station.LVNAME[e.lv] || e.lv, e.lv)}</td><td>${e.msg || ''}</td></tr>`).join('')}</table>
      <p class="meta" style="margin-top:20px">注：本报告由 PV-FireGuard 平台自动生成。当前演示数据来自基于物理规律的仿真，模型参数为示意值。</p>`;
  }

  return { init, generate, onShow: generate };
})();
