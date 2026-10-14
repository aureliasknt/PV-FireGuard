'use strict';
/* 页面路由与启动 */
const Main = (() => {
  const PAGES = { station: Station, hotspot: Hotspot, arc: Arc, risk: Risk, report: Report, about: null };
  let cur = 'station';

  function go(p) {
    if (!(p in PAGES)) return;
    cur = p;
    U.$$('#nav button').forEach(b => b.classList.toggle('active', b.dataset.page === p));
    U.$$('.page').forEach(s => s.classList.toggle('active', s.id === 'page-' + p));
    document.querySelector('main').scrollTop = 0;
    try { history.replaceState(null, '', '#' + p); } catch (e) { /* file:// 下可能不可用 */ }
    requestAnimationFrame(() => { const m = PAGES[p]; if (m && m.onShow) m.onShow(); });
  }

  function start() {
    window.addEventListener('error', e => U.toast('运行错误：' + (e.message || e), 'danger', 6000));
    U.$$('#nav button').forEach(b => b.onclick = () => go(b.dataset.page));
    Arc.init(); Hotspot.init(); Risk.init(); Report.init(); Station.init();
    let rt = null;
    window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(() => { const m = PAGES[cur]; if (m && m.onShow) m.onShow(); }, 150); });
    const h = location.hash.slice(1);
    go(h in PAGES ? h : 'station');
    Arc.train().then(meta => U.toast(`电弧判别模型训练完成，测试准确率 ${(meta.acc * 100).toFixed(1)}%`, 'ok'));
  }

  return { go, start, current: () => cur };
})();
document.addEventListener('DOMContentLoaded', Main.start);
