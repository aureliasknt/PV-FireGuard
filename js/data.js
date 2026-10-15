'use strict';
/* 后台数据支撑层：多源数据接入与设备映射、时间同步与数据质量检查、权限与审计日志 */
const DATA = (() => {
  /* ---------- 设备与回路映射 ---------- */
  const loopOf = r => ({ cb: r < 3 ? 'CB-01' : 'CB-02', mppt: r < 3 ? 'INV-01/MPPT-1' : 'INV-01/MPPT-2' });
  const loopPath = r => `S${r + 1} → ${loopOf(r).cb} → ${loopOf(r).mppt}`;
  const irFor = r => r < 3 ? 'IR-01' : 'IR-02';

  /* ---------- 多源测点 ---------- */
  const KIND = { current: '直流电流', voltage: '直流电压', tc: '背板热电偶', ir: '红外热像', weather: '气象' };
  const SOURCES = [];
  const add = (id, kind, maps, proto, rate, fast) => SOURCES.push({ id, kind, maps, proto, rate, fast, fault: null, offset: U.rand(-0.2, 0.2), recv: 0, miss: 0, lastT: 0 });
  for (let r = 0; r < 6; r++) add(`CT-S${r + 1}`, 'current', `组串 S${r + 1}（${loopOf(r).cb}）`, '高速采集卡 PCIe', '200 kHz', true);
  for (let r = 0; r < 6; r++) add(`VT-S${r + 1}`, 'voltage', `组串 S${r + 1}（${loopOf(r).cb}）`, '高速采集卡 PCIe', '10 kHz', true);
  for (let r = 0; r < 6; r++) add(`TC-S${r + 1}`, 'tc', `S${r + 1} 组件背板 ×3`, 'Modbus RTU', '1 Hz', false);
  add('IR-01', 'ir', 'S1–S3 全部组件、连接器', 'GigE Vision', '1 fps', true);
  add('IR-02', 'ir', 'S4–S6 全部组件、连接器', 'GigE Vision', '1 fps', true);
  add('WS-01', 'weather', '辐照 / 温湿度 / 风速风向', 'RS485 Modbus', '1 Hz', false);
  const src = id => SOURCES.find(s => s.id === id);
  const SYNC_TH = s => s.fast ? 1 : 50;   // 时钟偏差阈值 ms：高速通道 PTP ≤1 ms，低速通道 NTP ≤50 ms

  /* 每仿真秒推进一次：接收计数、时钟偏差漂移 */
  function tick(t) {
    SOURCES.forEach(s => {
      if (s.fault === 'offline') { s.miss++; return; }
      s.recv++; s.lastT = t;
      if (s.fault === 'drift') s.offset += s.fast ? 0.35 : 6;
      else s.offset = U.clamp(s.offset * 0.9 + U.randn() * (s.fast ? 0.05 : 2), -SYNC_TH(s) * 0.6, SYNC_TH(s) * 0.6);
    });
  }
  const online = id => { const s = src(id); return !s || s.fault !== 'offline'; };
  const synced = id => { const s = src(id); return !s || Math.abs(s.offset) <= SYNC_TH(s); };
  function quality(s, t) {
    const comp = s.recv + s.miss ? s.recv / (s.recv + s.miss) : 1;
    const stale = t - s.lastT;
    const issues = [];
    if (s.fault === 'offline' || stale > 3) issues.push('通信中断');
    if (Math.abs(s.offset) > SYNC_TH(s)) issues.push('时钟偏差超限');
    if (comp < 0.99) issues.push('完整率 < 99%');
    return { comp, stale, issues, ok: !issues.length };
  }
  function setFault(id, f) {
    const s = src(id); if (!s) return;
    if (f === s.fault) return;
    s.fault = f;
    if (!f) { s.offset = U.rand(-0.2, 0.2); }
    audit('测点状态变更', `${id}：${f === 'offline' ? '模拟通信中断' : f === 'drift' ? '模拟时钟漂移' : '恢复正常'}`);
  }

  /* ---------- 权限与审计 ---------- */
  const ROLES = {
    admin: { name: '系统管理员', perms: ['event', 'criteria', 'sensor', 'model', 'export'] },
    ops: { name: '运维工程师', perms: ['event', 'sensor', 'export'] },
    viewer: { name: '只读访客', perms: [] }
  };
  const PERM_NAMES = { event: '事件确认/处理/复核', criteria: '预警判据修改', sensor: '测点运维操作', model: '模型重新训练', export: '数据与报告导出' };
  let role = 'admin';
  const AUD = [];
  let simClock = () => '—';
  function audit(action, detail) {
    AUD.unshift({ real: new Date().toLocaleTimeString('zh-CN', { hour12: false }), sim: simClock(), user: ROLES[role].name, action, detail });
    if (AUD.length > 300) AUD.length = 300;
  }
  const can = p => ROLES[role].perms.includes(p);
  function guard(p) {
    if (can(p)) return true;
    U.toast(`当前角色「${ROLES[role].name}」无「${PERM_NAMES[p]}」权限`, 'warn');
    return false;
  }
  function setRole(r) {
    if (!ROLES[r] || r === role) return;
    const old = ROLES[role].name;
    role = r;
    audit('切换用户角色', `${old} → ${ROLES[r].name}`);
    const el = U.$('#hd-user'); if (el) el.textContent = ROLES[r].name;
  }

  return {
    SOURCES, KIND, src, tick, online, synced, quality, setFault, SYNC_TH, loopOf, loopPath, irFor,
    ROLES, PERM_NAMES, can, guard, setRole, audit, AUD, get role() { return role; }, setClock: f => { simClock = f; }
  };
})();
