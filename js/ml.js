'use strict';
/* 浏览器端神经网络：标准化 + 单隐层 MLP（tanh + softmax）+ Adam 优化 + 置换特征重要性 */
const ML = (() => {
  class Scaler {
    fit(X) {
      const d = X[0].length, n = X.length;
      this.mu = new Float64Array(d); this.sd = new Float64Array(d);
      X.forEach(x => x.forEach((v, j) => this.mu[j] += v / n));
      X.forEach(x => x.forEach((v, j) => this.sd[j] += (v - this.mu[j]) ** 2 / n));
      for (let j = 0; j < d; j++) this.sd[j] = Math.sqrt(this.sd[j]) + 1e-8;
      return this;
    }
    transform(x) { return x.map((v, j) => (v - this.mu[j]) / this.sd[j]); }
  }

  class MLP {
    constructor(nIn, nHid, nOut) {
      Object.assign(this, { nIn, nHid, nOut, t: 0 });
      this.W1 = new Float64Array(nHid * nIn).map(() => U.randn() * Math.sqrt(1 / nIn));
      this.b1 = new Float64Array(nHid);
      this.W2 = new Float64Array(nOut * nHid).map(() => U.randn() * Math.sqrt(1 / nHid));
      this.b2 = new Float64Array(nOut);
      this.params = [this.W1, this.b1, this.W2, this.b2];
      this.m = this.params.map(p => new Float64Array(p.length));
      this.v = this.params.map(p => new Float64Array(p.length));
    }
    forward(x) {
      const { nIn, nHid, nOut, W1, b1, W2, b2 } = this;
      const h = new Float64Array(nHid), z = new Float64Array(nOut);
      for (let j = 0; j < nHid; j++) { let s = b1[j]; const o = j * nIn; for (let i = 0; i < nIn; i++) s += W1[o + i] * x[i]; h[j] = Math.tanh(s); }
      let mx = -Infinity;
      for (let k = 0; k < nOut; k++) { let s = b2[k]; const o = k * nHid; for (let j = 0; j < nHid; j++) s += W2[o + j] * h[j]; z[k] = s; if (s > mx) mx = s; }
      let sum = 0; for (let k = 0; k < nOut; k++) { z[k] = Math.exp(z[k] - mx); sum += z[k]; }
      for (let k = 0; k < nOut; k++) z[k] /= sum;
      return { h, p: z };
    }
    predict(x) { return Array.from(this.forward(x).p); }
    trainEpoch(X, Y, { lr = 0.01, batch = 32, l2 = 1e-4 } = {}) {
      const { nIn, nHid, nOut, W1, W2 } = this;
      const idx = X.map((_, i) => i);
      for (let i = idx.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [idx[i], idx[j]] = [idx[j], idx[i]]; }
      const g = this.params.map(p => new Float64Array(p.length));
      let loss = 0;
      for (let s = 0; s < idx.length; s += batch) {
        g.forEach(a => a.fill(0));
        const end = Math.min(idx.length, s + batch), bs = end - s;
        for (let q = s; q < end; q++) {
          const x = X[idx[q]], y = Y[idx[q]];
          const { h, p } = this.forward(x);
          loss -= Math.log(p[y] + 1e-12);
          const dh = new Float64Array(nHid);
          for (let k = 0; k < nOut; k++) {
            const dz = p[k] - (k === y ? 1 : 0), o = k * nHid;
            g[3][k] += dz;
            for (let j = 0; j < nHid; j++) { g[2][o + j] += dz * h[j]; dh[j] += W2[o + j] * dz; }
          }
          for (let j = 0; j < nHid; j++) {
            const dz = dh[j] * (1 - h[j] * h[j]), o = j * nIn;
            g[1][j] += dz;
            for (let i = 0; i < nIn; i++) g[0][o + i] += dz * x[i];
          }
        }
        g.forEach(a => { for (let i = 0; i < a.length; i++) a[i] /= bs; });
        for (let i = 0; i < W1.length; i++) g[0][i] += l2 * W1[i];
        for (let i = 0; i < W2.length; i++) g[2][i] += l2 * W2[i];
        this.adam(g, lr);
      }
      return loss / X.length;
    }
    adam(g, lr, b1 = 0.9, b2 = 0.999, eps = 1e-8) {
      this.t++;
      const c1 = 1 - b1 ** this.t, c2 = 1 - b2 ** this.t;
      this.params.forEach((p, k) => {
        const m = this.m[k], v = this.v[k], gk = g[k];
        for (let i = 0; i < p.length; i++) {
          m[i] = b1 * m[i] + (1 - b1) * gk[i];
          v[i] = b2 * v[i] + (1 - b2) * gk[i] * gk[i];
          p[i] -= lr * (m[i] / c1) / (Math.sqrt(v[i] / c2) + eps);
        }
      });
    }
    evaluate(X, Y) {
      const cm = Array.from({ length: this.nOut }, () => new Array(this.nOut).fill(0));
      let ok = 0, loss = 0;
      X.forEach((x, i) => {
        const p = this.forward(x).p;
        let best = 0; for (let k = 1; k < p.length; k++) if (p[k] > p[best]) best = k;
        cm[Y[i]][best]++; if (best === Y[i]) ok++;
        loss -= Math.log(p[Y[i]] + 1e-12);
      });
      return { acc: ok / X.length, loss: loss / X.length, cm };
    }
  }

  /* 置换特征重要性：打乱某一特征列后准确率下降幅度 */
  function permutationImportance(model, X, Y, repeats = 3) {
    const base = model.evaluate(X, Y).acc, d = X[0].length, out = new Array(d).fill(0);
    for (let j = 0; j < d; j++) {
      for (let r = 0; r < repeats; r++) {
        const col = X.map(x => x[j]);
        for (let i = col.length - 1; i > 0; i--) { const k = Math.floor(Math.random() * (i + 1)); [col[i], col[k]] = [col[k], col[i]]; }
        const Xp = X.map((x, i) => { const c = x.slice(); c[j] = col[i]; return c; });
        out[j] += (base - model.evaluate(Xp, Y).acc) / repeats;
      }
    }
    return out;
  }

  return { Scaler, MLP, permutationImportance };
})();
if (typeof module !== 'undefined') module.exports = ML;
