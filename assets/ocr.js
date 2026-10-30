// The reading pipeline: prepare each page, read its text with Tesseract,
// then re-read every number with our own digit reader.
(function () {
  const AR = /[ء-ي]/;
  let worker = null;

  async function getWorker(onProgress) {
    if (!worker) {
      onProgress?.("تحميل محرك القراءة، أول مرة بس");
      worker = await Tesseract.createWorker(["ara", "eng"], 1);
      await worker.setParameters({ tessedit_pageseg_mode: "4", preserve_interword_spaces: "1" });
    }
    return worker;
  }

  const meanConf = (data) => {
    const words = (data.words || []).filter((w) => AR.test(w.text) && w.text.length > 1);
    if (!words.length) return 0;
    return (words.reduce((s, w) => s + w.confidence, 0) / words.length) * Math.min(1, words.length / 12);
  };

  // Which way up: read a small copy in each orientation and keep the one
  // Tesseract is most sure about.
  async function orient(w, src) {
    const small = Img.scaled(src, 1000);
    let best = { deg: 0, score: -1 };
    for (const deg of [0, 90, 270, 180]) {
      const c = Img.bwToCanvas(Img.binarize(Img.rotate(small, deg)));
      const { data } = await w.recognize(c);
      const score = meanConf(data);
      if (score > best.score) best = { deg, score };
      if (score > 80) break;
    }
    return best.deg;
  }

  const pad = (b, p, bw) => ({ x0: Math.max(0, b.x0 - p), y0: Math.max(0, b.y0 - p), x1: Math.min(bw.w, b.x1 + p), y1: Math.min(bw.h, b.y1 + p) });
  const union = (a, b) => ({ x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) });

  // Runs of words that are not confidently Arabic (no Arabic letters, Arabic
  // digits, or a low-confidence reading) may be numbers: each run is read
  // again as one group by the digit reader, and kept when it reads as digits.
  function fixDigits(line, bw) {
    const parts = [];
    let group = null;
    const flush = () => {
      if (!group) return;
      const r = DigitReader.read(bw, pad(group.bbox, 4, bw));
      const digits = (r.text.match(/\d/g) || []).length, unknown = (r.text.match(/\?/g) || []).length;
      const numeric = digits >= 2 && unknown <= digits / 4 && r.conf > 0.62;
      parts.push(numeric || (digits >= 1 && !group.arabic && r.conf > 0.5) ? { text: r.text, read: r, bbox: group.bbox } : { text: group.text });
      group = null;
    };
    for (const w of line.words || []) {
      const arabic = AR.test(w.text);
      const sure = arabic && !/[٠-٩]/.test(w.text) && w.confidence >= 60;
      if (sure) { flush(); parts.push({ text: w.text }); continue; }
      group = group ? { text: group.text + " " + w.text, bbox: union(group.bbox, w.bbox), arabic: group.arabic || arabic }
        : { text: w.text, bbox: { ...w.bbox }, arabic };
    }
    flush();
    return { digitText: parts.map((p) => p.text).join(" "), reads: parts.filter((p) => p.read) };
  }

  // Bands of ink rows, for lines Tesseract missed (the national ID digits).
  // Rows are counted over a few column windows, so pictures at the card's
  // edges (the eagle, the pharaoh) do not merge neighbouring rows into one.
  function bands(bw) {
    const out = [];
    for (const [a, b] of [[0, 1], [0.2, 0.8], [0.3, 1]]) {
      const xa = Math.round(bw.w * a), xb = Math.round(bw.w * b), rows = new Uint32Array(bw.h);
      for (let y = 0; y < bw.h; y++) { let n = 0; for (let x = xa; x < xb; x++) n += bw.data[y * bw.w + x]; rows[y] = n; }
      const peak = Array.from(rows).sort((p, q) => p - q)[Math.floor(bw.h * 0.99)] || 1;
      // Tight line spacing: besides any ink at all, cut at rows well below the
      // busiest rows, which falls between lines.
      for (const min of [(xb - xa) * 0.004, peak * 0.05, peak * 0.1]) {
        let start = -1;
        for (let y = 0; y <= bw.h; y++) {
          const on = y < bw.h && rows[y] > min;
          if (on && start < 0) start = y;
          if (!on && start >= 0) { if (y - start > bw.h * 0.015 && y - start < bw.h * 0.15) out.push({ x0: xa, y0: start, x1: xb, y1: y }); start = -1; }
        }
      }
    }
    return out;
  }

  function findNid(lines, bw) {
    // Whole rows: on the back the issue month sits on the same row as the number.
    const tries = lines.map((l) => ({ x0: 0, y0: l.bbox.y0, x1: bw.w, y1: l.bbox.y1 })).concat(bands(bw));
    for (const box of tries) {
      const r = DigitReader.read(bw, pad(box, 6, bw), "arabic");
      for (const m of r.text.replace(/\//g, "").matchAll(/[23]\d{13}/g)) {
        if (!Fields.decodeNid(m[0])) continue;
        // The whole row, for what sits beside the number (the issue month on the back).
        const row = DigitReader.read(bw, pad({ x0: 0, y0: box.y0, x1: bw.w, y1: box.y1 }, 6, bw), "arabic");
        return { value: m[0], result: r, text: row.text.includes(m[0]) ? row.text : r.text, bbox: box, where: box.y0 > bw.h * 0.55 ? "bottom" : "top" };
      }
    }
    return null;
  }

  async function readPage(src, onProgress, turn = null) {
    const w = await getWorker(onProgress);
    let page = Img.autoCrop(src);
    onProgress?.("تحديد اتجاه المستند");
    const deg = turn ?? (await orient(w, page));
    if (deg) page = Img.rotate(page, deg);
    onProgress?.("تعديل الميل");
    const skew = Img.skewAngle(page);
    if (Math.abs(skew) >= 0.5) page = Img.rotate(page, -skew);
    const cardLike = page.width / page.height > 1.35 && page.width / page.height < 1.9;
    page = Img.resizeTo(page, cardLike ? 2000 : 2600);
    onProgress?.("فصل الكتابة عن الخلفية");
    const bw = Img.binarize(page);
    const clean = Img.bwToCanvas(bw);
    onProgress?.("قراءة النص");
    const { data } = await w.recognize(clean);
    onProgress?.("قراءة الأرقام");
    const lines = (data.lines || []).filter((l) => l.text.trim()).map((l) => {
      const fx = fixDigits(l, bw);
      return { text: l.text.trim(), digitText: fx.digitText, reads: fx.reads, bbox: l.bbox, conf: l.confidence };
    });
    const nid = findNid(lines, bw);
    return { page, clean, bw, lines, nid, deg };
  }

  async function readFile(file, onProgress) {
    onProgress?.("فتح الملف");
    const pages = await Img.fileToCanvases(file);
    const out = [];
    for (let i = 0; i < pages.length; i++) {
      const tag = pages.length > 1 ? ` · صفحة ${i + 1} من ${pages.length}` : "";
      out.push(await readPage(pages[i], (m) => onProgress?.(m + tag)));
    }
    return out;
  }

  window.OCR = { readFile, readPage };
})();
