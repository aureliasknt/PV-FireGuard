'use strict';
/* 热斑智能诊断页 */
const Hotspot = (() => {
  const st = { src: null, res: null, history: [] };
  const MAP = { shading: 'shading', soiling: 'soiling', crack: 'crack', junction: 'junction', bypass: 'bypass', arc: 'junction', reflect: 'reflect' };

  function init() {
    const sel = U.$('#hs-scene');
    Object.entries(VIS.SCENES).forEach(([k, v]) => sel.insertAdjacentHTML('beforeend', `<option value="${k}">${v}</option>`));
    sel.value = 'shading';
    U.range('hs-sev', v => v.toFixed(2));
    U.range('hs-noise', v => v.toFixed(2));
    U.range('hs-th', v => v.toFixed(1) + ' K', () => { if (st.src) analyzeAndRender(); });
    U.$('#hs-run').onclick = () => run();
    U.$('#hs-rand').onclick = () => {
      sel.value = U.pick(Object.keys(VIS.SCENES));
      U.$('#hs-sev').value = U.rand(0.3, 1).toFixed(2); U.$('#hs-sev').dispatchEvent(new Event('input'));
      U.$('#hs-reflect').checked = Math.random() < 0.25; U.$('#hs-wind').checked = Math.random() < 0.3;
      run();
    };
    U.$('#hs-file').onchange = e => {
      const f = e.target.files[0]; if (!f) return;
      const img = new Image();
      img.onload = () => {
        const tmin = +U.$('#hs-tmin').value, tmax = +U.$('#hs-tmax').value;
        const d = VIS.fromImage(img, Math.min(tmin, tmax), Math.max(tmin, tmax) + 0.1);
        st.src = { ...d, grid: false, truth: [], label: `导入图像：${f.name}（${d.W}×${d.H}，亮度映射 ${tmin}–${tmax} ℃）` };
        analyzeAndRender();
        URL.revokeObjectURL(img.src);
        U.toast('已导入红外图像并完成诊断', 'ok');
      };
      img.onerror = () => U.toast('图像读取失败', 'danger');
      img.src = URL.createObjectURL(f);
    };
  }

  function run(opts = {}) {
    const scene = opts.scene || U.$('#hs-scene').value;
    const s = VIS.synth(scene, {
      sev: +U.$('#hs-sev').value, noise: +U.$('#hs-noise').value,
      reflect: U.$('#hs-reflect').checked, wind: U.$('#hs-wind').checked, amp: opts.amp, Tb: opts.Tb
    });
    st.src = { T: s.T, W: s.W, H: s.H, grid: true, truth: s.truth, label: opts.label || `仿真组件热像：${VIS.SCENES[scene]}` };
    analyzeAndRender();
  }

  function loadModule(m) {
    const scene = m.fault ? MAP[m.fault.type] : 'normal';
    U.$('#hs-scene').value = scene;
    run({ scene, amp: m.fault ? Math.max(3, m.dTraw) : undefined, Tb: m.Tbg, label: `电站组件 ${m.id} 红外巡检图像（实测 ΔT = ${U.fmt(m.dTraw, 1)} K）` });
  }

  function analyzeAndRender() {
    const s = st.src;
    const res = VIS.analyze(s.T, s.W, s.H, { thK: +U.$('#hs-th').value, grid: s.grid });
    st.res = res;
    st.history.unshift({ time: new Date(), label: s.label, regions: res.regions.map(r => ({ cls: VIS.CLS_NAMES[r.cls], conf: r.conf, dT: r.dTmax, grade: r.grade.name })) });
    st.history.length = Math.min(st.history.length, 20);
    render();
  }

  function render() {
    const s = st.src, res = st.res; if (!s || !res) return;
    const { W, H } = s;
    U.$('#hs-src').textContent = '数据来源：' + s.label;
    U.drawField(U.$('#hs-c1'), s.T, W, H, 'iron', res.mn, res.mx, 2);
    U.$('#hs-cap1').textContent = `温度范围 ${res.mn.toFixed(1)} – ${res.mx.toFixed(1)} ℃`;
    U.drawField(U.$('#hs-c2'), res.gray, W, H, 'gray', 0, 1, 2);
    U.drawField(U.$('#hs-f1'), res.g, W, H, 'iron', res.mn, res.mx, 1);
    let smax = 0; for (const v of res.sob) smax = Math.max(smax, v);
    U.drawField(U.$('#hs-f2'), res.sob, W, H, 'gray', 0, smax * 0.7, 1);
    let lmax = 0; for (const v of res.lg) lmax = Math.max(lmax, Math.abs(v));
    U.drawField(U.$('#hs-f3'), res.lg, W, H, 'diverge', -lmax * 0.6, lmax * 0.6, 1);
    let dmax = res.th; for (const v of res.dT) dmax = Math.max(dmax, v);
    U.drawField(U.$('#hs-f4'), res.dT, W, H, 'diverge', -dmax, dmax, 1);
    // 候选框
    const sc = 2, c4 = U.drawField(U.$('#hs-c4'), res.dT, W, H, 'iron', 0, dmax, sc);
    c4.setLineDash([4, 3]); c4.lineWidth = 1.5; c4.strokeStyle = '#22d3ee';
    res.regions.forEach(r => c4.strokeRect(r.box[0] * sc, r.box[1] * sc, (r.box[2] - r.box[0]) * sc, (r.box[3] - r.box[1]) * sc));
    c4.setLineDash([]);
    U.$('#hs-cap4').textContent = `连通候选 ${res.nProposals} 个 → 保留 ${res.regions.length} 个（阈值 ${res.th.toFixed(1)} K，背景中位温度 ${res.med.toFixed(1)} ℃）`;
    // 分类结果
    const annotate = (cv, sc, labels) => {
      const c = U.drawField(cv, s.T, W, H, 'iron', res.mn, res.mx, sc);
      const fs = Math.max(12, Math.round(W * sc / 42));
      c.font = `bold ${fs}px "Microsoft YaHei",sans-serif`; c.lineWidth = Math.max(2, sc * 0.8);
      res.regions.forEach((r, i) => {
        const col = VIS.CLS_COLORS[r.cls];
        const x = r.box[0] * sc, y = r.box[1] * sc, bw = (r.box[2] - r.box[0]) * sc, bh = (r.box[3] - r.box[1]) * sc;
        c.strokeStyle = col; c.strokeRect(x, y, bw, bh);
        if (!labels) return;
        const txt = `#${i + 1} ${VIS.CLS_NAMES[r.cls]} ${(r.conf * 100).toFixed(0)}% · ΔT ${r.dTmax.toFixed(0)}K`;
        const tw = c.measureText(txt).width + 10, th = fs + 8;
        const ty = y > th + 2 ? y - th - 2 : Math.min(H * sc - th, y + bh + 2), tx = Math.max(0, Math.min(x, W * sc - tw));
        c.fillStyle = col; c.fillRect(tx, ty, tw, th);
        c.fillStyle = '#0b1220'; c.fillText(txt, tx + 5, ty + fs + 1);
      });
    };
    annotate(U.$('#hs-c5'), 2, false);
    annotate(U.$('#hs-big'), 4, true);
    U.$('#hs-cap5').textContent = res.regions.length ? `检出 ${res.regions.length} 处异常` : '未检出异常';
    // 表格与结论
    const real = res.regions.filter(r => VIS.CLS[r.cls] !== 'reflect');
    const worst = real.reduce((a, r) => (!a || r.grade.g > a.grade.g) ? r : a, null);
    U.$('#hs-verdict').innerHTML = !res.regions.length
      ? `<div class="big-verdict" style="color:#22c55e">✓ 组件正常，未发现热异常</div>`
      : worst
        ? `<div class="big-verdict" style="color:${VIS.CLS_COLORS[worst.cls]}">${VIS.CLS_NAMES[worst.cls]} · ${worst.grade.name}</div><div class="hint" style="margin-bottom:8px">${advice(VIS.CLS[worst.cls], worst.grade.g)}</div>`
        : `<div class="big-verdict" style="color:#94a3b8">仅检测到反光伪热斑，已自动抑制告警</div>`;
    U.$('#hs-table').innerHTML = res.regions.map((r, i) => `<tr><td>${i + 1}</td><td style="color:${VIS.CLS_COLORS[r.cls]}">${VIS.CLS_NAMES[r.cls]}</td><td>${(r.conf * 100).toFixed(1)}%</td><td>${r.dTmax.toFixed(1)} K</td><td>${r.area} px</td><td>${U.tag(r.grade.name, r.grade.lv)}</td></tr>`).join('') || '<tr><td colspan="6" class="muted">无</td></tr>';
    // 剖面
    let mi = 0; for (let i = 1; i < res.dT.length; i++) if (res.dT[i] > res.dT[mi]) mi = i;
    const y = Math.floor(mi / W), row = Array.from(s.T.subarray(y * W, y * W + W)), gr = Array.from(res.g.subarray(y * W, y * W + W));
    U.lineChart(U.$('#hs-profile'), {
      series: [{ y: row, color: '#f97316', width: 1, label: `原始温度 (y=${y})` }, { y: gr, color: '#22d3ee', label: '高斯平滑' }],
      hlines: [{ y: res.med, label: '背景中位温度', color: '#94a3b8', left: true, below: true }, { y: res.med + res.th, label: '检出阈值', color: '#ef4444', left: true }],
      xLabel: '像素列', yLabel: '℃'
    });
    const top = res.regions[0];
    U.$('#hs-probs').innerHTML = top ? top.probs.map((p, i) => `<div class="pr"><span>${VIS.CLS_NAMES[i]}</span><div class="bar"><i style="width:${(p * 100).toFixed(1)}%;background:${VIS.CLS_COLORS[i]}"></i></div><span style="text-align:right">${(p * 100).toFixed(1)}%</span></div>`).join('') : '<div class="hint">无候选区域</div>';
  }

  function advice(cls, g) {
    const base = {
      shading: '清除遮挡物（树叶/鸟粪/杂物），复测热斑温差；持续存在需检查对应电池片与旁路二极管。',
      junction: '检查接线盒焊点、汇流条与 MC4 连接器压接质量，紧固或更换；高温时优先断开组串。',
      bypass: '更换失效旁路二极管，检查子串电池是否存在反偏损伤。',
      crack: '记录隐裂位置，结合 EL 检测确认；发热加剧时安排更换组件。',
      soiling: '安排清洗，检查下边框排水与积灰情况。',
      reflect: '反光引起的伪热斑，调整拍摄角度复核即可。'
    }[cls] || '';
    return (g >= 4 ? '【紧急】建议立即快速关断所在组串并现场处置。' : g >= 3 ? '【尽快】建议 24 小时内处理。' : '') + base;
  }

  function onShow() { if (!st.src) run(); else render(); }

  return { init, run, loadModule, onShow, get state() { return st; } };
})();
