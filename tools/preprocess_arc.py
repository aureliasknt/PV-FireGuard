"""
电弧实验实测数据预处理（5-30.rar → data/arc-real.js）

原始数据：30 个 CSV，采集卡 DAQ，采样率 100 kHz，2 通道（通道0 = 交流侧电流，通道1 = 直流侧电流），
单文件 5–45 s，总计约 3 GB。文件名即标签：<负载类型>[交流侧弧|直流侧弧]_<序号>_<arc|noarc>.csv

浏览器端（file:// 打开）无法直接读取 3 GB CSV，因此按以下步骤压缩为可内嵌的 JS 数据包：
  1. 解析表头（GBK 编码）：采样率、通道数；按文件名解析负载类型、电弧位置、标签与序号。
  2. 量化校验：采集卡 ADC 步长 LSB ≈ 4.9309 mV，按 LSB 还原为 int16 整数码（误差 < 0.5 LSB，近似无损）。
  3. 分窗：窗长 N = 1024 点（10.24 ms），与在线诊断窗长一致。
  4. 数据清洗：剔除无电流窗口（交流侧标准差 < 20 mV，如负载断开/停机段）。
  5. 抽样：每个记录在 12.5% / 37.5% / 62.5% / 87.5% 处各取 1 段连续 10 窗（≈102 ms），共 40 窗，
     兼顾全时段分布（训练多样性）与局部连续性（实时检测回放）。
  6. 全时段概览：每 0.1 s 计算直流均值、直流高频分量（一阶差分标准差）、交流有效值，用于记录总览图。
  7. 数据集划分：按记录划分（序号 1 → 训练集，序号 ≥2 → 测试集），避免同一记录的窗口同时出现在训练与测试中。
  8. 编码：int16 → 一阶差分 → gzip → base64，浏览器端用 DecompressionStream 解压。

用法：python tools/preprocess_arc.py <解压后的 5-30 目录> [输出文件，默认 data/arc-real.js]
"""
import base64
import glob
import gzip
import json
import os
import re
import sys

import numpy as np
import pandas as pd

sys.stdout.reconfigure(encoding='utf-8')

LSB = 0.0049309          # ADC 量化步长 / V
N = 1024                 # 窗长
BLOCKS = 4               # 每记录连续段数
WPB = 10                 # 每段窗数
OVERVIEW_DT = 0.1        # 概览时间分辨率 / s
MIN_AC_STD = 0.02        # 有效窗口门限 / V

LOADS = [('电子开关类负载', '电子开关类'), ('混合负载', '混合'), ('阻性负载', '阻性'), ('阻感', '阻感'), ('感性', '感性')]


def parse_name(name):
    load = next(short for key, short in LOADS if name.startswith(key))
    side = 'dc' if '直流侧弧' in name else 'ac' if '交流侧弧' in name else 'none'
    label = 'arc' if name.endswith('_arc') else 'noarc'
    assert (side == 'none') == (label == 'noarc'), name
    m = re.search(r'_(\d+)_(?:no)?arc$', name)
    seq = int(m.group(1)) if m else 1
    return load, side, seq


def read_header(path):
    with open(path, 'rb') as f:
        lines = [f.readline().decode('gbk').strip() for _ in range(4)]
    fs = int(lines[1].split(':')[1])
    nch = int(lines[2].split(':')[1])
    return fs, nch, lines[3].split(',')


def main():
    src = sys.argv[1]
    out = sys.argv[2] if len(sys.argv) > 2 else os.path.join(os.path.dirname(__file__), '..', 'data', 'arc-real.js')
    files = sorted(glob.glob(os.path.join(src, '*.csv')))
    order = {'none': 0, 'dc': 1, 'ac': 2}
    recs = []
    for p in files:
        name = os.path.splitext(os.path.basename(p))[0]
        load, side, seq = parse_name(name)
        recs.append((load, order[side], seq, p, name, side))
    recs.sort(key=lambda r: ([s for _, s in LOADS].index(r[0]), r[1], r[2]))

    meta, chunks, offset = [], [], 0
    tot_raw = tot_win = tot_bad = 0
    max_err = 0.0
    for i, (load, _, seq, p, name, side) in enumerate(recs):
        fs, nch, cols = read_header(p)
        assert fs == 100000 and nch == 2, (name, fs, nch)
        a = pd.read_csv(p, skiprows=4, header=None, dtype=np.float64, engine='c', encoding='latin-1').values
        tot_raw += os.path.getsize(p)
        q = np.round(a / LSB)
        max_err = max(max_err, float(np.abs(a / LSB - q).max()))
        q = q.astype(np.int16)
        ac, dc = q[:, 0], q[:, 1]
        nw = len(q) // N
        acw = ac[:nw * N].reshape(nw, N).astype(np.float64) * LSB
        valid = acw.std(1) >= MIN_AC_STD
        tot_win += nw
        tot_bad += int((~valid).sum())

        # 选取 4 段连续有效窗口
        starts = []
        for b in range(BLOCKS):
            c = int(nw * (b + 0.5) / BLOCKS) - WPB // 2
            cands = sorted(range(0, nw - WPB + 1), key=lambda s: abs(s - c))
            s0 = next(s for s in cands if valid[s:s + WPB].all() and all(abs(s - t) >= WPB for t in starts))
            starts.append(s0)
        starts.sort()
        buf = []
        for s0 in starts:
            sl = slice(s0 * N, (s0 + WPB) * N)
            buf.append(dc[sl]); buf.append(ac[sl])
        arr = np.concatenate(buf).astype(np.int16)
        chunks.append(arr)

        # 全时段概览
        step = int(fs * OVERVIEW_DT)
        k = len(q) // step
        dcs = dc[:k * step].reshape(k, step).astype(np.float64) * LSB
        acs = ac[:k * step].reshape(k, step).astype(np.float64) * LSB
        ov = {
            'dcMean': np.round(dcs.mean(1), 3).tolist(),
            'dcHf': np.round(np.diff(dcs, axis=1).std(1) * 1000, 1).tolist(),   # mV
            'acRms': np.round(np.sqrt((acs ** 2).mean(1)), 3).tolist(),
        }
        meta.append({
            'id': f'R{i + 1:02d}', 'file': name + '.csv', 'load': load, 'side': side, 'seq': seq,
            'split': 'train' if seq == 1 else 'test', 'dur': round(len(q) / fs, 2), 'samples': int(len(q)),
            'windows': nw, 'invalid': int((~valid).sum()), 'blocks': [int(s) for s in starts],
            'offset': offset, 'len': int(len(arr)), 'ov': ov,
        })
        offset += len(arr)
        print(f'{meta[-1]["id"]} {name:<22} {load:<6} {side:<4} seq={seq} {len(q) / fs:5.1f}s 窗={nw} 剔除={int((~valid).sum())} 段起点={starts}')

    allq = np.concatenate(chunks)
    delta = np.diff(allq.astype(np.int32), prepend=0)
    assert np.abs(delta).max() < 32768
    gz = gzip.compress(delta.astype('<i2').tobytes(), 9)
    pack = {
        'source': '5-30.rar（电弧实验平台 DAQ 实测，2025-05-30）', 'fs': 100000, 'N': N, 'lsb': LSB,
        'blocks': BLOCKS, 'wpb': WPB, 'overviewDt': OVERVIEW_DT,
        'channels': ['直流侧电流（通道1）', '交流侧电流（通道0）'],
        'stats': {'files': len(recs), 'rawBytes': tot_raw, 'rawWindows': tot_win, 'invalidWindows': tot_bad,
                  'keptWindows': len(recs) * BLOCKS * WPB, 'packBytes': len(gz), 'maxQuantErrLsb': round(max_err, 3)},
        'records': meta,
    }
    os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
    with open(out, 'w', encoding='utf-8') as f:
        f.write("'use strict';\n/* 由 tools/preprocess_arc.py 自动生成，请勿手工编辑 */\n")
        f.write('const ARC_REAL = ' + json.dumps(pack, ensure_ascii=False, separators=(',', ':')) + ';\n')
        f.write("ARC_REAL.blob = '" + base64.b64encode(gz).decode() + "';\n")
    print(f'\n原始 {tot_raw / 1e9:.2f} GB → 数据包 {os.path.getsize(out) / 1e6:.2f} MB；'
          f'窗口 {tot_win} → 保留 {len(recs) * BLOCKS * WPB}（剔除无电流窗 {tot_bad}）；最大量化误差 {max_err:.3f} LSB')


if __name__ == '__main__':
    main()
