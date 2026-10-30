// Image preparation: load a photo or PDF, crop to the document, turn it the
// right way up, straighten it and separate the ink from the coloured background.
(function () {
  const canvas = (w, h) => { const c = document.createElement("canvas"); c.width = Math.max(1, Math.round(w)); c.height = Math.max(1, Math.round(h)); return c; };

  async function fileToCanvases(file) {
    if (file.type === "application/pdf" || /\.pdf$/i.test(file.name)) {
      const pdf = await window.pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;
      const pages = [];
      for (let p = 1; p <= Math.min(pdf.numPages, 4); p++) {
        const page = await pdf.getPage(p);
        const vp = page.getViewport({ scale: 1 });
        const scale = 2600 / Math.max(vp.width, vp.height);
        const v = page.getViewport({ scale });
        const c = canvas(v.width, v.height);
        const ctx = c.getContext("2d");
        ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, c.width, c.height);
        await page.render({ canvasContext: ctx, viewport: v }).promise;
        pages.push(c);
      }
      return pages;
    }
    const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
    const c = canvas(bmp.width, bmp.height);
    c.getContext("2d").drawImage(bmp, 0, 0);
    return [c];
  }

  function scaled(src, maxSide) {
    const k = Math.min(1, maxSide / Math.max(src.width, src.height));
    const c = canvas(src.width * k, src.height * k);
    c.getContext("2d").drawImage(src, 0, 0, c.width, c.height);
    return c;
  }

  function resizeTo(src, longSide) {
    const k = longSide / Math.max(src.width, src.height);
    const c = canvas(src.width * k, src.height * k);
    const ctx = c.getContext("2d");
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(src, 0, 0, c.width, c.height);
    return c;
  }

  function rotate(src, deg) {
    const r = (deg * Math.PI) / 180, s = Math.abs(Math.sin(r)), co = Math.abs(Math.cos(r));
    const c = canvas(src.width * co + src.height * s, src.width * s + src.height * co);
    const ctx = c.getContext("2d");
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, c.width, c.height);
    ctx.translate(c.width / 2, c.height / 2); ctx.rotate(r);
    ctx.drawImage(src, -src.width / 2, -src.height / 2);
    return c;
  }

  function crop(src, b) {
    const c = canvas(b.x1 - b.x0, b.y1 - b.y0);
    c.getContext("2d").drawImage(src, b.x0, b.y0, c.width, c.height, 0, 0, c.width, c.height);
    return c;
  }

  function gray(c) {
    const { data } = c.getContext("2d").getImageData(0, 0, c.width, c.height);
    const g = new Uint8ClampedArray(c.width * c.height);
    for (let i = 0, j = 0; j < g.length; i += 4, j++) g[j] = (data[i] * 299 + data[i + 1] * 587 + data[i + 2] * 114) / 1000;
    return g;
  }

  // A scan with wide white margins (a card on an A4 page) is cut down to the
  // document itself.
  function autoCrop(src) {
    const small = scaled(src, 600), g = gray(small), W = small.width, H = small.height;
    let x0 = W, y0 = H, x1 = 0, y1 = 0;
    const rows = new Uint16Array(H), cols = new Uint16Array(W);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (g[y * W + x] < 215) { rows[y]++; cols[x]++; }
    const rowMin = W * 0.02, colMin = H * 0.02;
    for (let y = 0; y < H; y++) if (rows[y] > rowMin) { y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
    for (let x = 0; x < W; x++) if (cols[x] > colMin) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); }
    if (x1 <= x0 || y1 <= y0) return src;
    const area = ((x1 - x0) * (y1 - y0)) / (W * H);
    if (area > 0.7) return src;
    const k = src.width / W, pad = 0.02 * Math.max(W, H);
    return crop(src, { x0: Math.max(0, (x0 - pad) * k), y0: Math.max(0, (y0 - pad) * k), x1: Math.min(src.width, (x1 + pad) * k), y1: Math.min(src.height, (y1 + pad) * k) });
  }

  // Ink is whatever is clearly darker than its own neighbourhood, which strips
  // printed backgrounds, watermarks and uneven light from phone photos.
  function binarize(c, opts = {}) {
    const W = c.width, H = c.height, g = gray(c);
    const r = Math.max(8, Math.round(Math.max(W, H) / (opts.radiusDiv || 70)));
    const integral = new Float64Array((W + 1) * (H + 1));
    for (let y = 1; y <= H; y++) {
      let row = 0;
      for (let x = 1; x <= W; x++) { row += g[(y - 1) * W + x - 1]; integral[y * (W + 1) + x] = integral[(y - 1) * (W + 1) + x] + row; }
    }
    const data = new Uint8Array(W * H), diff = opts.diff || 38, dark = opts.dark || 70;
    for (let y = 0; y < H; y++) {
      const ya = Math.max(0, y - r), yb = Math.min(H, y + r + 1);
      for (let x = 0; x < W; x++) {
        const xa = Math.max(0, x - r), xb = Math.min(W, x + r + 1);
        const sum = integral[yb * (W + 1) + xb] - integral[ya * (W + 1) + xb] - integral[yb * (W + 1) + xa] + integral[ya * (W + 1) + xa];
        const mean = sum / ((yb - ya) * (xb - xa)), v = g[y * W + x];
        data[y * W + x] = mean - v > diff || v < dark ? 1 : 0;
      }
    }
    return { w: W, h: H, data };
  }

  function bwToCanvas(bw) {
    const c = canvas(bw.w, bw.h), ctx = c.getContext("2d"), img = ctx.createImageData(bw.w, bw.h);
    for (let i = 0; i < bw.data.length; i++) { const v = bw.data[i] ? 0 : 255; img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = v; img.data[i * 4 + 3] = 255; }
    ctx.putImageData(img, 0, 0);
    return c;
  }

  // Small tilt: the angle at which text rows line up best (sharpest row profile).
  function skewAngle(c) {
    const small = scaled(c, 900), bw = binarize(small, { radiusDiv: 40 });
    let bestA = 0, bestScore = -1;
    for (let a = -6; a <= 6; a += 0.5) {
      const t = Math.tan((a * Math.PI) / 180), rows = new Float32Array(bw.h + bw.w);
      for (let y = 0; y < bw.h; y++) for (let x = 0; x < bw.w; x++) if (bw.data[y * bw.w + x]) {
        const ry = Math.round(y - (x - bw.w / 2) * t + bw.w / 2);
        if (ry >= 0 && ry < rows.length) rows[ry]++;
      }
      let s = 0;
      for (let i = 1; i < rows.length; i++) s += (rows[i] - rows[i - 1]) ** 2;
      if (s > bestScore) { bestScore = s; bestA = a; }
    }
    return bestA;
  }

  window.Img = { fileToCanvases, scaled, resizeTo, rotate, crop, autoCrop, binarize, bwToCanvas, skewAngle };
})();
