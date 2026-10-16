'use strict';
/* 设置页：界面主题（深色 / 浅色 / 跟随系统），保存在本地浏览器 */
const Settings = (() => {
  const KEY = 'pvfg-theme';
  const mq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: light)') : null;
  let pref = 'dark';

  const resolve = p => p === 'system' ? (mq && mq.matches ? 'light' : 'dark') : p;

  function apply(p) {
    pref = p;
    document.documentElement.dataset.theme = resolve(p);
    try { localStorage.setItem(KEY, p); } catch (e) { /* 隐私模式等情况下不保存 */ }
    U.$$('#set-theme button').forEach(b => b.classList.toggle('on', b.dataset.v === p));
  }

  function init() {
    try { pref = localStorage.getItem(KEY) || 'dark'; } catch (e) { pref = 'dark'; }
    apply(pref);
    U.$$('#set-theme button').forEach(b => b.onclick = () => apply(b.dataset.v));
    if (mq && mq.addEventListener) mq.addEventListener('change', () => { if (pref === 'system') apply('system'); });
  }

  return { init, onShow() {} };
})();
