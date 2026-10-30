// Rules that turn read lines into named fields, one set per document type.
// Every field carries a state: ok (checked against a rule), check (found but
// worth a look) or missing.
(function () {
  const AR_DIGITS = "٠١٢٣٤٥٦٧٨٩";
  const latin = (s) => String(s || "").replace(/[٠-٩]/g, (d) => AR_DIGITS.indexOf(d)).replace(/[۰-۹]/g, (d) => "۰۱۲۳۴۵۶۷۸۹".indexOf(d));
  // Letters folded so rules match whatever form the reader returns.
  const norm = (s) => latin(s).replace(/[ً-ْـ]/g, "").replace(/[أإآ]/g, "ا").replace(/ى/g, "ي").replace(/ة/g, "ه").replace(/\s+/g, " ").trim();
  const hasArabic = (s) => /[ء-ي]/.test(s);
  const arabicShare = (s) => { const t = s.replace(/\s/g, ""); return t ? (t.match(/[ء-ي]/g) || []).length / t.length : 0; };
  const clean = (s) => String(s || "").replace(/[|_«»"“”‎‏]/g, " ").replace(/\s+/g, " ").trim();

  const GOV = { "01": "القاهرة", "02": "الإسكندرية", "03": "بورسعيد", "04": "السويس", "11": "دمياط", "12": "الدقهلية", "13": "الشرقية", "14": "القليوبية", "15": "كفر الشيخ", "16": "الغربية", "17": "المنوفية", "18": "البحيرة", "19": "الإسماعيلية", "21": "الجيزة", "22": "بني سويف", "23": "الفيوم", "24": "المنيا", "25": "أسيوط", "26": "سوهاج", "27": "قنا", "28": "أسوان", "29": "الأقصر", "31": "البحر الأحمر", "32": "الوادي الجديد", "33": "مطروح", "34": "شمال سيناء", "35": "جنوب سيناء", "88": "خارج الجمهورية" };

  // A national ID holds the birth date, the governorate and the sex.
  function decodeNid(n) {
    if (!/^[23]\d{13}$/.test(n)) return null;
    const year = (n[0] === "2" ? 1900 : 2000) + +n.slice(1, 3), month = +n.slice(3, 5), day = +n.slice(5, 7);
    const d = new Date(Date.UTC(year, month - 1, day));
    if (d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day || d > new Date()) return null;
    const gov = GOV[n.slice(7, 9)];
    if (!gov) return null;
    return { birth: `${year}/${String(month).padStart(2, "0")}/${String(day).padStart(2, "0")}`, gov, sex: +n[12] % 2 ? "ذكر" : "أنثى" };
  }

  function dates(s) {
    const out = [];
    const t = latin(s).replace(/\s*([\/\-.])\s*/g, "$1");
    for (const m of t.matchAll(/(\d{4})[\/\-.](\d{1,2})(?:[\/\-.](\d{1,2}))?/g)) {
      const y = +m[1], mo = +m[2], d = m[3] ? +m[3] : null;
      if (y < 1950 || y > 2100 || mo < 1 || mo > 12 || (d !== null && (d < 1 || d > 31))) continue;
      out.push({ text: `${y}/${String(mo).padStart(2, "0")}${d ? "/" + String(d).padStart(2, "0") : ""}`, y, mo, d, index: m.index });
    }
    for (const m of t.matchAll(/(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})/g)) {
      const d = +m[1], mo = +m[2], y = +m[3];
      if (y < 1950 || y > 2100 || mo < 1 || mo > 12 || d < 1 || d > 31) continue;
      out.push({ text: `${y}/${String(mo).padStart(2, "0")}/${String(d).padStart(2, "0")}`, y, mo, d, index: m.index });
    }
    // Specks read as dashes inside a year, as in 2-03-1/08/04.
    const joined = t.replace(/(\d)-(?=\d)/g, "$1");
    if (joined !== t) for (const d of dates(joined)) if (!out.some((o) => o.text === d.text)) out.push(d);
    // Last resort: a slash the reader took for a one, as in 2033109115.
    if (!out.length) for (const m of t.matchAll(/(\d{4})[\/1](\d{2})[\/1](\d{2})/g)) {
      const y = +m[1], mo = +m[2], d = +m[3];
      if (y < 1950 || y > 2100 || mo < 1 || mo > 12 || d < 1 || d > 31) continue;
      out.push({ text: `${y}/${m[2]}/${m[3]}`, y, mo, d, index: m.index, loose: true });
    }
    return out;
  }
  const dateKey = (d) => d.y * 10000 + d.mo * 100 + (d.d || 1);

  const f = (key, label, value, state, extra = {}) => ({ key, label, value: value || "", state: value ? state : "missing", ...extra });

  // ---------- National ID ----------
  // Bidi marks and stray symbols removed, so a line's share of Arabic letters
  // says whether it is text or noise.
  const strip = (s) => String(s || "").replace(/[‎‏‪-‮]/g, "").replace(/[^ء-ي0-9٠-٩A-Za-z\s\-\/]/g, " ").replace(/\s+/g, " ").trim();
  // Reader noise shows up as one- or two-letter scraps at the ends of a line.
  const trimScraps = (s) => { const t = s.split(" "); while (t.length && t[t.length - 1].length <= 2) t.pop(); while (t.length && t[0].length <= 2) t.shift(); return t.join(" "); };
  const BACK = /ساريه|حتي|ذكر|انثي|مسلم|مسيحي|متزوج|اعزب|انسه|مطلق|ارمل/;

  function nationalId(doc) {
    const fields = [];
    const pages = doc.pages?.length ? doc.pages : [{ lines: doc.lines, nid: doc.nid }];
    const kind = (p) => (BACK.test(norm(p.lines.map((l) => l.text).join(" "))) || p.nid?.where === "top" ? "back" : "front");
    const front = pages.find((p) => kind(p) === "front"), back = pages.find((p) => kind(p) === "back");
    const nidOf = (p) => p?.nid;
    const n = nidOf(front) || nidOf(back) || doc.nid;
    const info = decodeNid(n?.value || "");
    fields.push(f("nid", "الرقم القومي", n?.value, info ? "ok" : "check", { digits: n?.result }));

    if (front) {
      const limit = front.nid?.bbox?.y0 ?? Infinity;
      const textLines = front.lines
        .map((l) => ({ ...l, s: strip(l.text) }))
        .filter((l) => l.bbox.y1 <= limit + 5 && arabicShare(l.s) > 0.6 && l.s.replace(/\s/g, "").length > 2 && !/جمهوريه|العربيه|بطاقه|تحقيق|الشخصيه/.test(norm(l.s)));
      const name = textLines.slice(0, 2).map((l) => trimScraps(l.s.replace(/[0-9٠-٩\/]/g, " ").replace(/\s+/g, " ").trim())).join(" ");
      fields.push(f("name", "الاسم", name, "check"));
      fields.push(f("address", "العنوان", textLines.slice(2).map((l) => l.s.replace(/^[\s\-\/]+|[\s\-\/]+$/g, "")).join(" ، "), "check"));
      const serial = latin(front.lines.map((l) => l.text).join(" ")).match(/\b[A-Z]{2}\s?\d{7}\b/);
      fields.push(f("serial", "رقم البطاقة", serial?.[0].replace(/\s/g, ""), "check"));
    }
    if (back) {
      const lines = back.lines.map((l) => ({ ...l, s: strip(l.text), n: norm(strip(l.text)) }));
      const all = lines.map((l) => l.n).join(" ");
      // The expiry date sits to the left of «البطاقة سارية حتى» on the same row.
      const expLine = lines.find((l) => /ساريه|حتي/.test(l.n));
      let exp = null, expRead = null;
      if (expLine && back.bw) {
        const h = expLine.bbox.y1 - expLine.bbox.y0;
        expRead = DigitReader.read(back.bw, { x0: 0, y0: expLine.bbox.y0 - h * 0.4, x1: expLine.bbox.x0 + h * 0.3, y1: expLine.bbox.y1 + h * 0.4 }, "arabic");
        exp = dates(expRead.text).find((d) => d.d) || null;
      }
      exp ||= lines.flatMap((l) => dates(l.digitText || "")).filter((d) => d.d).sort((a, b) => dateKey(b) - dateKey(a))[0];
      fields.push(f("expiry", "سارية حتى", exp?.text, exp && exp.y >= new Date().getFullYear() - 10 ? "ok" : "check", { digits: expRead }));
      const issue = back.nid?.text ? dates(back.nid.text.replace(back.nid.value, " ")).find((d) => !d.d) : null;
      fields.push(f("issued", "تاريخ الإصدار", issue?.text, "check"));
      const word = (re) => (all.match(re) || [])[0] || "";
      const pretty = { مسلم: "مسلم", مسيحي: "مسيحي", ذكر: "ذكر", انثي: "أنثى", متزوج: "متزوج", متزوجه: "متزوجة", اعزب: "أعزب", انسه: "آنسة", مطلق: "مطلق", مطلقه: "مطلقة", ارمل: "أرمل", ارمله: "أرملة" };
      const rel = word(/مسلم|مسيحي/), mar = word(/متزوجه|متزوج|اعزب|انسه|مطلقه|مطلق|ارمله|ارمل/);
      fields.push(f("religion", "الديانة", pretty[rel] || rel, "check"));
      fields.push(f("marital", "الحالة الاجتماعية", pretty[mar] || mar, "check"));
      const nb = back.nid?.bbox;
      const job = lines.map((l) => ({ ...l, a: l.s.replace(/[A-Za-z0-9٠-٩\/]/g, " ").replace(/\s+/g, " ").trim() }))
        .filter((l) => arabicShare(l.a) > 0.8 && l.a.replace(/\s/g, "").length > 3 && !BACK.test(l.n) && (!nb || l.bbox.y0 >= nb.y1 - 5));
      fields.push(f("job", "المهنة وجهة العمل", job.slice(0, 2).map((l) => trimScraps(l.a)).join(" ، "), "check"));
    }
    if (info) {
      fields.push(f("birth", "تاريخ الميلاد", info.birth, "ok"));
      fields.push(f("gov", "محافظة الميلاد", info.gov, "ok"));
      fields.push(f("sex", "النوع", info.sex, "ok"));
    }
    return fields;
  }

  // ---------- Tax card ----------
  function taxCard(doc) {
    const lines = doc.lines.map((l) => ({ ...l, n: norm(l.text) }));
    const body = lines.filter((l) => !/جمهوريه|وزاره|مصلحه|الماليه/.test(l.n));
    const fields = [];
    const officeLine = body.find((l) => /\//.test(l.text) && hasArabic(l.text));
    const forms = /توصيه|تضامن|مسئوليه محدوده|مساهمه|شخص واحد|فرديه|فردي/;
    const formName = { توصيه: "توصية بسيطة", تضامن: "تضامن", "مسئوليه محدوده": "ذات مسئولية محدودة", مساهمه: "مساهمة", "شخص واحد": "شخص واحد", فرديه: "منشأة فردية", فردي: "منشأة فردية" };
    const formLine = body.find((l) => forms.test(l.n));
    fields.push(f("office", "المأمورية", officeLine && clean(officeLine.text.split("/")[0].replace(/[^ء-ي\s]/g, " ")), "check"));
    fields.push(f("form", "الكيان القانوني", formLine && formName[(formLine.n.match(forms) || [])[0]], "check"));
    const trade = body.find((l) => /[A-Za-z]{3,}/.test(l.text));
    fields.push(f("trade", "الاسم التجاري", trade && clean(trade.text.replace(/[^ء-يA-Za-z\s]/g, " ")), "check"));
    const owner = body.find((l) => /وشريك|وشركاه/.test(l.n)) || body[body.indexOf(trade) + 1];
    fields.push(f("owner", "اسم الممول", owner && clean(owner.text.replace(/[^ء-ي\s]/g, " ")), "check"));
    const act = body.find((l) => /الانشطه|نشاط/.test(l.n) && !/كود|بدء|بدع/.test(l.n));
    fields.push(f("activity", "النشاط", act && clean(act.text.replace(/[^ء-ي\s]/g, " ")), "check"));
    const codeLine = lines.find((l) => /كود/.test(l.n));
    const code = codeLine && latin(codeLine.digitText || codeLine.text).match(/\b\d{4}\b/);
    fields.push(f("code", "كود النشاط", code?.[0], "check"));
    const startLine = lines.find((l) => /بدء|بدع|بدا/.test(l.n)) || lines.find((l) => /النشاط/.test(l.n) && dates(l.digitText || "").length);
    fields.push(f("start", "بدء النشاط", startLine && dates(startLine.digitText || startLine.text)[0]?.text, "check"));
    const all = lines.flatMap((l) => dates(l.digitText || l.text).map((d) => ({ ...d, line: l }))).filter((d) => d.line !== startLine && d.d);
    all.sort((a, b) => dateKey(a) - dateKey(b));
    const exp = all[all.length - 1], issue = all.length > 1 ? all[all.length - 2] : null;
    fields.push(f("issued", "تاريخ الإصدار", issue?.text, "check"));
    fields.push(f("expiry", "تاريخ الانتهاء", exp?.text, exp && issue ? "ok" : "check"));
    const joined = latin(lines.map((l) => l.digitText || l.text).join(" "));
    const reg = joined.match(/\d{3}\s?-\s?\d{3}\s?-\s?\d{3}(?!\d)/);
    fields.push(f("reg", "رقم التسجيل الضريبي", reg?.[0].replace(/\s/g, ""), /^\d{3}-\d{3}-\d{3}$/.test(reg?.[0].replace(/\s/g, "") || "") ? "ok" : "check"));
    const card = joined.replace(/\s/g, "").match(/\d{14,18}/);
    fields.push(f("card", "رقم الكارت", card?.[0], "check"));
    return fields;
  }

  // ---------- Commercial register ----------
  function commercialRegister(doc) {
    const lines = doc.lines.map((l) => ({ ...l, n: norm(l.text) }));
    const text = lines.map((l) => l.digitText ? norm(l.digitText) + " " + l.n : l.n).join("\n");
    const fields = [];
    const numLine = lines.find((l) => /سجل تجار[يى] رقم|مستخرج سجل/.test(l.n));
    const num = numLine && latin(numLine.digitText || numLine.text).match(/رقم\s*:?\s*(\d{3,7})|(\d{4,7})/);
    fields.push(f("number", "رقم القيد", num && (num[1] || num[2]), "check"));
    const forms = /توصيه بسيطه|تضامن|ذات مسئوليه محدوده|مساهمه|شخص واحد|فرد[يى]/;
    fields.push(f("form", "الشكل القانوني", (numLine?.n.match(forms) || text.match(forms) || [])[0], "check"));
    const office = text.match(/مكتب سجل تجار[يى]\s+([ء-ي]+(?:\s[ء-ي]+)?)/);
    fields.push(f("office", "مكتب السجل", office?.[1], "check"));
    const nat = text.match(/الرقم القوم[يى] للمنشا[هت]\s*:?\s*([\d\/\-\s]{6,})/);
    fields.push(f("national", "الرقم القومي للمنشأة", nat && nat[1].replace(/\s/g, ""), "check"));
    const unified = text.match(/الرقم الموحد[^\d]{0,30}([\d\-\/\s]{6,})/);
    fields.push(f("unified", "الرقم الموحد", unified && unified[1].replace(/\s/g, ""), "check"));
    const trade = lines.find((l) => /\b[A-Z]{4,}\b/.test(l.text));
    fields.push(f("trade", "الاسم التجاري", trade && (trade.text.match(/[A-Z][A-Za-z]{2,}(?:\s+[A-Z][A-Za-z]{2,})*/) || [])[0], "check"));
    const cap = text.match(/راس المال[^\d]{0,20}([\d,.]{3,})/);
    fields.push(f("capital", "رأس المال", cap?.[1], "check"));
    const ds = lines.flatMap((l) => dates(l.digitText || l.text)).filter((d) => d.d).sort((a, b) => dateKey(a) - dateKey(b));
    fields.push(f("first", "أقدم تاريخ في المستخرج", ds[0]?.text, "check"));
    fields.push(f("last", "أحدث تاريخ في المستخرج", ds[ds.length - 1]?.text, "check"));
    return fields;
  }

  const TYPES = {
    id: { label: "بطاقة الرقم القومي", run: nationalId },
    tax: { label: "البطاقة الضريبية", run: taxCard },
    cr: { label: "السجل التجاري", run: commercialRegister },
  };

  function detect(lines) {
    const t = norm(lines.map((l) => l.text).join(" "));
    const score = {
      id: (/تحقيق الشخصيه|بطاقه تحقيق/.test(t) ? 3 : 0) + (/ساريه حتي/.test(t) ? 2 : 0) + (/مسلم|مسيحي|ذكر|انثي/.test(t) ? 1 : 0),
      tax: (/مصلحه الضرائب|الضرائب/.test(t) ? 3 : 0) + (/كود النشاط|بدء النشاط/.test(t) ? 2 : 0),
      cr: (/سجل تجار/.test(t) ? 3 : 0) + (/مستخرج|التجاره الداخليه/.test(t) ? 2 : 0),
    };
    const top = Object.entries(score).sort((a, b) => b[1] - a[1])[0];
    return top[1] ? top[0] : null;
  }

  window.Fields = { TYPES, detect, decodeNid, latin, norm, dates };
})();
