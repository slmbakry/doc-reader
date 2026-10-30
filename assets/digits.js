// Our own digit reader. Tesseract reads Arabic text well but misreads the
// digit fonts on Egyptian documents, so digits are read here instead: split a
// region into ink blobs, normalise each to 16×16 and match it against known
// shapes (starter shapes from several fonts plus shapes learned from the
// user's corrections, kept in this browser).
(function () {
  const SIZE = 16;
  const STORE = "doc-reader-learned-digits";
  const base = window.DIGIT_TEMPLATES;

  function loadLearned() {
    try { return JSON.parse(localStorage.getItem(STORE) || "[]"); } catch { return []; }
  }
  let learned = loadLearned();

  // 8-connected blobs of ink inside a box of a binary image (1 = ink).
  function blobs(bw, x0, y0, x1, y1, minPix) {
    const W = x1 - x0, H = y1 - y0, seen = new Uint8Array(W * H), out = [];
    const stack = [];
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (seen[i] || !bw.data[(y + y0) * bw.w + x + x0]) continue;
      seen[i] = 1; stack.push(i);
      let bx0 = x, bx1 = x, by0 = y, by1 = y, n = 0, sx = 0, sy = 0, sxy = 0, syy = 0;
      const pts = [];
      while (stack.length) {
        const j = stack.pop(), cy = (j / W) | 0, cx = j - cy * W;
        pts.push(j); n++; sx += cx; sy += cy; sxy += cx * cy; syy += cy * cy;
        if (cx < bx0) bx0 = cx; if (cx > bx1) bx1 = cx; if (cy < by0) by0 = cy; if (cy > by1) by1 = cy;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const nx = cx + dx, ny = cy + dy;
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
          const k = ny * W + nx;
          if (!seen[k] && bw.data[(ny + y0) * bw.w + nx + x0]) { seen[k] = 1; stack.push(k); }
        }
      }
      if (n < minPix) continue;
      const mx = sx / n, my = sy / n;
      const slant = (sxy / n - mx * my) / Math.max(syy / n - my * my, 1);
      out.push({ x0: bx0, y0: by0, x1: bx1, y1: by1, w: bx1 - bx0 + 1, h: by1 - by0 + 1, n, pts, W, slant });
    }
    return out;
  }

  // The blob centred in a square and averaged down to 16×16, zero-mean, unit length.
  function vector(b) {
    const s = Math.max(b.w, b.h), ox = (s - b.w) / 2, oy = (s - b.h) / 2;
    const grid = new Float32Array(SIZE * SIZE), cell = s / SIZE;
    for (const j of b.pts) {
      const y = ((j / b.W) | 0) - b.y0, x = (j % b.W) - b.x0;
      const gx = Math.min(SIZE - 1, Math.floor((x + ox) / cell)), gy = Math.min(SIZE - 1, Math.floor((y + oy) / cell));
      grid[gy * SIZE + gx] += 1;
    }
    const area = cell * cell;
    let mean = 0;
    for (let i = 0; i < grid.length; i++) { grid[i] = Math.min(1, grid[i] / area); mean += grid[i]; }
    mean /= grid.length;
    let norm = 0;
    for (let i = 0; i < grid.length; i++) { grid[i] -= mean; norm += grid[i] * grid[i]; }
    norm = Math.sqrt(norm) || 1;
    for (let i = 0; i < grid.length; i++) grid[i] /= norm;
    return grid;
  }

  function best(v, set) {
    let top = { ch: "?", score: -1 };
    for (const [ch, t] of set) {
      let s = 0;
      for (let i = 0; i < t.length; i++) s += v[i] * t[i];
      if (s > top.score) top = { ch, score: s };
    }
    return top;
  }

  const sets = (script) => {
    const own = learned.filter((x) => x[2] === script).map((x) => [x[0], x[1]]);
    return own.concat(base[script]);
  };

  // Reads the digits in a box, left to right. Arabic zero is a small dot, and
  // a thin slanted stroke is a slash.
  function read(bw, box, script = "auto") {
    const x0 = Math.max(0, box.x0 | 0), y0 = Math.max(0, box.y0 | 0);
    const x1 = Math.min(bw.w, box.x1 | 0), y1 = Math.min(bw.h, box.y1 | 0);
    if (x1 - x0 < 4 || y1 - y0 < 4) return { text: "", conf: 0, items: [] };
    const all = blobs(bw, x0, y0, x1, y1, Math.max(6, ((y1 - y0) * (y1 - y0)) / 900));
    if (!all.length) return { text: "", conf: 0, items: [] };
    const tallest = Math.max(...all.map((b) => b.h));
    const tall = all.filter((b) => b.h > 0.5 * tallest).map((b) => b.h).sort((a, b) => a - b);
    const H = tall[tall.length >> 1] || tallest;
    const items = [];
    for (const b of all.sort((a, c) => a.x0 - c.x0)) {
      if (b.h < 0.55 * H) {
        // Below half height: a short wide bar is a dash, a small round blob is
        // the Arabic zero, anything smaller is a speck.
        if (b.h < 0.32 * H && b.w / b.h > 1.6 && b.w < 0.9 * H) items.push({ ch: "-", score: 0.9, b, kind: "sep" });
        else if (b.w < 0.75 * H && b.h > 0.24 * H && b.w > 0.15 * H) items.push({ ch: "0", score: 0.9, b, kind: "zero" });
        continue;
      }
      const v = vector(b);
      let pick;
      if (script === "auto") {
        const a = best(v, sets("arabic")), l = best(v, sets("latin"));
        pick = a.score >= l.score ? { ...a, script: "arabic" } : { ...l, script: "latin" };
      } else pick = { ...best(v, sets(script)), script };
      // A thin slanted stroke that matches no digit well is a slash.
      if (pick.ch === "/" || (pick.score < 0.6 && b.w / b.h < 0.6 && Math.abs(b.slant) > 0.3)) { items.push({ ch: "/", score: 0.9, b, kind: "sep" }); continue; }
      items.push({ ch: pick.score < 0.45 ? "?" : pick.ch, score: pick.score, b, v, script: pick.script, kind: "digit" });
    }
    const digits = items.filter((i) => i.kind === "digit");
    const conf = digits.length ? digits.reduce((s, i) => s + i.score, 0) / digits.length : items.length ? 0.9 : 0;
    return { text: items.map((i) => i.ch).join(""), conf, items };
  }

  // A correction teaches the reader: when the corrected value has as many
  // digits as the blobs it read, each blob is stored under its right digit.
  function learn(result, corrected) {
    if (!result?.items) return 0;
    const want = String(corrected).replace(/[٠-٩]/g, (d) => "٠١٢٣٤٥٦٧٨٩".indexOf(d)).replace(/[^0-9]/g, "");
    const shapes = result.items.filter((i) => i.kind !== "sep");
    if (want.length !== shapes.length) return 0;
    let added = 0;
    shapes.forEach((it, k) => {
      if (it.kind !== "digit" || it.ch === want[k]) return;
      learned.push([want[k], Array.from(it.v, (x) => Math.round(x * 100) / 100), it.script || "arabic"]);
      added++;
    });
    if (added) {
      learned = learned.slice(-600);
      try { localStorage.setItem(STORE, JSON.stringify(learned)); } catch {}
    }
    return added;
  }

  window.DigitReader = { read, learn, learnedCount: () => learned.length, forget: () => { learned = []; try { localStorage.removeItem(STORE); } catch {} } };
})();
