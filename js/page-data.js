'use strict';
/* 后台数据支撑层页：接入映射、时间同步与质量、预处理与特征、历史存储与归档、模型与判据、权限日志与运维 */
const DataPage = (() => {
  const t0 = Date.now();

  function init() {
    // 多源数据接入与设备映射（静态结构，仅状态单元格刷新）
    U.$('#ds-src').innerHTML = DATA.SOURCES.map(s => `<tr><td><b>${s.id}</b></td><td>${DATA.KIND[s.kind]}</td><td>${s.maps}</td><td class="muted">${s.proto}</td><td>${s.rate}</td>
      <td id="ds-st-${s.id}"></td><td style="white-space:nowrap"><button class="btn sm" data-f="offline" data-id="${s.id}">中断</button><button class="btn sm" data-f="drift" data-id="${s.id}">漂移</button><button class="btn sm" data-f="" data-id="${s.id}">恢复</button></td></tr>`).join('');
    U.$('#ds-src').addEventListener('click', e => {
      const b = e.target.closest('[data-f]'); if (!b) return;
      if (!DATA.guard('sensor')) return;
      DATA.setFault(b.dataset.id, b.dataset.f || null);
      U.toast(`${b.dataset.id}：${b.dataset.f === 'offline' ? '已模拟通信中断' : b.dataset.f === 'drift' ? '已模拟时钟漂移' : '已恢复'}`, b.dataset.f ? 'warn' : 'ok');
      live();
    });
    // 角色
    U.$('#ds-role').innerHTML = Object.entries(DATA.ROLES).map(([k, r]) => `<option value="${k}">${r.name}</option>`).join('');
    U.$('#ds-role').value = DATA.role;
    U.$('#ds-role').onchange = e => { DATA.setRole(e.target.value); renderPerms(); renderCfg(); live(); };
    U.$('#hd-user').textContent = DATA.ROLES[DATA.role].name;
    // 判据
    U.$('#ds-cfg-save').onclick = () => {
      if (!DATA.guard('criteria')) { renderCfg(); return; }
      const ch = [];
      Object.keys(FUSE.CFG).forEach(k => { const v = +U.$('#cfg-' + k).value; if (isFinite(v) && v !== FUSE.CFG[k]) { ch.push(`${FUSE.CFG_NAMES[k][0]} ${FUSE.CFG[k]}→${v}`); FUSE.set(k, v); } });
      if (ch.length) { DATA.audit('修改预警判据', ch.join('；')); U.toast('预警判据已更新并立即生效', 'ok'); } else U.toast('判据未变化', 'info');
      live();
    };
    U.$('#ds-cfg-reset').onclick = () => { if (!DATA.guard('criteria')) return; FUSE.reset(); DATA.audit('恢复默认预警判据', FUSE.VERSION); renderCfg(); U.toast('已恢复默认判据', 'ok'); };
    U.$('#ds-exp-hist').onclick = exportHistory;
    U.$('#ds-exp-audit').onclick = () => {
      if (!DATA.guard('export')) return;
      const rows = [['时间', '仿真时钟', '用户', '操作', '详情']].concat(DATA.AUD.slice().reverse().map(a => [a.real, a.sim, a.user, a.action, a.detail]));
      U.download(`PV-FireGuard_操作日志_${Date.now()}.csv`, '﻿' + rows.map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\r\n'), 'text/csv;charset=utf-8');
    };
    renderPerms(); renderCfg(); renderFeatures();
  }

  function renderPerms() {
    const P = Object.keys(DATA.PERM_NAMES);
    U.$('#ds-perm').innerHTML = `<thead><tr><th>权限</th>${Object.values(DATA.ROLES).map(r => `<th>${r.name}</th>`).join('')}</tr></thead><tbody>` +
      P.map(p => `<tr><td>${DATA.PERM_NAMES[p]}</td>${Object.entries(DATA.ROLES).map(([k, r]) => `<td style="${k === DATA.role ? 'background:rgba(34,211,238,.08)' : ''}">${r.perms.includes(p) ? '✓' : '<span class="muted">—</span>'}</td>`).join('')}</tr>`).join('') + '</tbody>';
  }

  function renderCfg() {
    const dis = DATA.can('criteria') ? '' : 'disabled';
    U.$('#ds-cfg').innerHTML = Object.entries(FUSE.CFG_NAMES).map(([k, [n, u]]) =>
      `<label class="cfg"><span>${n}</span><input type="number" id="cfg-${k}" value="${FUSE.CFG[k]}" step="${FUSE.CFG[k] < 1 ? 0.05 : 1}" ${dis}><small>${u}</small></label>`).join('');
  }

  function renderFeatures() {
    const n = DSP.FEATURE_NAMES;
    const rows = [
      ['电弧·时域', n.slice(0, 5).join('、'), 'CT-S1…S6 · 200 kHz', '模块③'],
      ['电弧·频域/谱统计', n.slice(5, 13).join('、'), 'CT-S1…S6 · FFT/STFT', '模块③'],
      ['电弧·小波', n.slice(13).join('、'), 'CT-S1…S6 · Haar 4 层', '模块③'],
      ['热·区域特征', 'ΔTmax、ΔTmean、面积、长宽比、填充率、边缘锐度、部位', 'IR-01/02 · 卷积特征图', '模块②'],
      ['热·时序特征', '温升速率 dT/dt、相对组串中位温差', 'IR + TC · 1 Hz 时序', '模块②④'],
      ['电气·运行量', '组串电压、电流、功率', 'VT/CT · 1 Hz 汇总', '模块①④'],
      ['环境', '辐照、气温、风速风向、湿度', 'WS-01', '模块①④']
    ];
    U.$('#ds-feat').innerHTML = rows.map(r => `<tr><td><b>${r[0]}</b></td><td style="font-size:12px">${r[1]}</td><td class="muted" style="font-size:12px">${r[2]}</td><td>${r[3]}</td></tr>`).join('');
  }

  function live() {
    const S = Station.state(), t = S.t;
    DATA.SOURCES.forEach(s => {
      const el = U.$('#ds-st-' + s.id); if (!el) return;
      el.innerHTML = s.fault === 'offline' ? U.tag('离线', 'red') : s.fault === 'drift' ? U.tag('在线·漂移', 'orange') : U.tag('在线', 'ok');
    });
    U.$('#ds-q').innerHTML = DATA.SOURCES.map(s => {
      const q = DATA.quality(s, t);
      return `<tr><td>${s.id}</td><td style="color:${Math.abs(s.offset) > DATA.SYNC_TH(s) ? '#f97316' : ''}">${s.offset >= 0 ? '+' : ''}${s.offset.toFixed(s.fast ? 2 : 1)} ms <span class="muted">/ ≤${DATA.SYNC_TH(s)}</span></td>
        <td>${(q.comp * 100).toFixed(2)}%</td><td>${q.stale <= 1 ? '实时' : q.stale + ' s 前'}</td><td>${q.ok ? U.tag('通过', 'ok') : U.tag(q.issues.join('、'), 'orange')}</td></tr>`;
    }).join('');
    const nPts = DATA.SOURCES.length, open = S.events.filter(Station.isOpen).length;
    U.$('#ds-store').innerHTML = `
      <div class="k">仿真运行时长</div><div class="v">${Math.floor(t / 60)} min ${t % 60} s</div>
      <div class="k">时序帧（1 Hz，内存窗口）</div><div class="v">${S.frames.length} / 1800 帧</div>
      <div class="k">累计采集记录</div><div class="v">${(t * (nPts + 72)).toLocaleString()} 点</div>
      <div class="k">告警日志</div><div class="v">${S.log.length} 条</div>
      <div class="k">事件档案（未关闭 / 已归档）</div><div class="v">${open} / ${S.events.length - open}</div>
      <div class="k">疑似电弧异常时段</div><div class="v">${S.arcSegs.length} 段</div>`;
    const meta = Arc.meta;
    U.$('#ds-models').innerHTML = [
      ['电弧判别 MLP', meta ? `17-${meta.nHid}-5` : '—', meta ? `准确率 ${(meta.acc * 100).toFixed(1)}%，检出率 ${(meta.recall * 100).toFixed(1)}%，误报率 ${(meta.far * 100).toFixed(1)}%` : '训练中', meta ? meta.time.toLocaleTimeString('zh-CN', { hour12: false }) : '—', Arc.ready ? U.tag('已部署', 'ok') : U.tag('训练中', 'yellow')],
      ['热斑视觉流水线', 'v1.1', '6 类分类 + 部位定位 + 四级分级', '内置', U.tag('已部署', 'ok')],
      ['故障点热平衡模型', 'v1.0', '集总热容 + 对流辐射 + 劣化正反馈', '内置', U.tag('已部署', 'ok')],
      ['电—热融合判据', FUSE.VERSION, '6 项判据 · 12 条分级规则', '—', U.tag('生效中', 'ok')]
    ].map(r => `<tr>${r.map(c => `<td>${c}</td>`).join('')}</tr>`).join('');
    U.$('#ds-audit').innerHTML = DATA.AUD.slice(0, 60).map(a => `<tr><td>${a.real}</td><td>${a.sim}</td><td>${a.user}</td><td>${a.action}</td><td class="muted">${a.detail}</td></tr>`).join('') || '<tr><td colspan="5" class="muted">暂无操作记录</td></tr>';
    const up = Math.floor((Date.now() - t0) / 1000);
    U.$('#ds-ops').innerHTML = `
      <div class="k">当前用户</div><div class="v">${DATA.ROLES[DATA.role].name}</div>
      <div class="k">页面运行时长</div><div class="v">${Math.floor(up / 60)} min ${up % 60} s</div>
      <div class="k">单步计算耗时</div><div class="v">${S.stepMs.toFixed(1)} ms</div>
      <div class="k">测点在线</div><div class="v">${DATA.SOURCES.filter(s => DATA.online(s.id)).length} / ${nPts}</div>
      <div class="k">质量检查未通过</div><div class="v">${DATA.SOURCES.filter(s => !DATA.quality(s, t).ok).length}</div>`;
  }

  function exportHistory() {
    if (!DATA.guard('export')) return;
    const F = Station.state().frames;
    const head = ['仿真时钟', '功率kW', '最高温度℃', '异常组件数', '参考风险指数'];
    for (let r = 1; r <= 6; r++) head.push(`S${r}电压V`, `S${r}电流A`, `S${r}P电弧`);
    const rows = [head].concat(F.map(f => { const o = [U.hms(11 * 3600 + f.t), f.P.toFixed(3), f.Tmax.toFixed(2), f.nAb, f.risk.toFixed(1)]; for (let r = 0; r < 6; r++) o.push(f.V[r].toFixed(1), f.I[r].toFixed(3), f.pa[r].toFixed(3)); return o; }));
    U.download(`PV-FireGuard_历史时序_${Date.now()}.csv`, '﻿' + rows.map(r => r.join(',')).join('\r\n'), 'text/csv;charset=utf-8');
    DATA.audit('导出历史时序', `${F.length} 帧`);
  }

  function onShow() { renderPerms(); renderCfg(); live(); }

  return { init, live, onShow };
})();
