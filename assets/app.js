// The tool's screens: pick a file, follow the reading, review and correct the
// fields, then save, copy or download. Saved records stay in this browser.
(function () {
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const HISTORY = "doc-reader-history";
  const STEPS = ["فتح الملف", "تحميل محرك القراءة، أول مرة بس", "تحديد اتجاه المستند", "تعديل الميل", "فصل الكتابة عن الخلفية", "قراءة النص", "قراءة الأرقام"];
  const STATE = { ok: ["ok", "مؤكد"], check: ["check", "راجعه"], missing: ["", "مش لاقيه"] };
  let current = null;

  let toastTimer;
  function toast(msg, isError) {
    const el = $("#toast");
    el.textContent = msg; el.classList.toggle("error", !!isError); el.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.hidden = true; }, 3200);
  }

  const readHistory = () => { try { return JSON.parse(localStorage.getItem(HISTORY) || "[]"); } catch { return []; } };
  const writeHistory = (h) => { try { localStorage.setItem(HISTORY, JSON.stringify(h)); } catch {} };

  // ---------- Reading ----------
  function progress(msg) {
    const base = msg.split(" · ")[0];
    const i = STEPS.indexOf(base);
    $("#steps").innerHTML = STEPS.map((s, k) => `<li class="${k < i ? "done" : k === i ? "now" : ""}">${esc(k === i ? msg : s)}</li>`).join("");
  }

  async function run(file) {
    if (!file) return;
    if (file.size > 25 * 1024 * 1024) return toast("الملف أكبر من ٢٥ ميجا", true);
    $("#start").hidden = true; $("#result").hidden = true; $("#work").hidden = false;
    progress("فتح الملف");
    try {
      const pages = await OCR.readFile(file, progress);
      current = { file: file.name, pages, view: 0, mode: "clean" };
      extract($("#type").value);
      showResult();
    } catch (e) {
      console.error(e);
      toast("ماقدرناش نقرا الملف ده. جرب صورة أوضح", true);
      $("#start").hidden = false;
    } finally {
      $("#work").hidden = true;
    }
  }

  // Lines from every page go to one set of rules, so an ID's front and back
  // in one file fill one record.
  function extract(choice) {
    const lines = current.pages.flatMap((p) => p.lines);
    const nid = current.pages.map((p) => p.nid).find(Boolean) || null;
    const type = choice !== "auto" ? choice : Fields.detect(lines) || "id";
    current.type = type;
    current.fields = Fields.TYPES[type].run({ lines, nid, pages: current.pages });
  }

  // ---------- Review ----------
  function showResult() {
    const p = current.pages[current.view];
    const typeOpts = Object.entries(Fields.TYPES).map(([k, t]) => `<option value="${k}" ${k === current.type ? "selected" : ""}>${t.label}</option>`).join("");
    const found = current.fields.filter((f) => f.value).length;
    $("#result").innerHTML = `
      <div class="split">
        <section class="panel split-main">
          <div class="row between"><h2>البيانات</h2><span class="note">${found} من ${current.fields.length} اتقروا</span></div>
          <div class="field"><label for="rtype">نوع المستند</label><select id="rtype">${typeOpts}</select></div>
          <form class="fields" id="fields">${current.fields.map((f, i) => `
            <div class="fld ${f.state}"><div class="fld-h"><label for="f-${i}">${esc(f.label)}</label><span class="chip ${STATE[f.state][0]}">${STATE[f.state][1]}</span></div>
              <input id="f-${i}" data-i="${i}" value="${esc(f.value)}" ${/\d/.test(f.value) && !/[ء-ي]/.test(f.value) ? 'class="ltr"' : ""}></div>`).join("")}
          </form>
          <div class="row">
            <button class="btn primary" id="save" type="button">احفظ في السجل</button>
            <button class="btn" id="copy" type="button">انسخ البيانات</button>
            <button class="btn" id="json" type="button">نزّل ملف بيانات</button>
            <button class="btn" id="again" type="button">مستند تاني</button>
          </div>
          <p class="note">لو صححت رقم، القارئ بيتعلّم الشكل ده ويبقى أدق المرة الجاية.</p>
        </section>
        <aside class="split-side">
          <section class="panel preview">
            <div class="row between"><h2>الصورة</h2>
              <div class="tabs"><button class="tab" type="button" data-mode="clean" aria-pressed="${current.mode === "clean"}">بعد التنظيف</button><button class="tab" type="button" data-mode="page" aria-pressed="${current.mode === "page"}">الأصل</button></div></div>
            ${current.pages.length > 1 ? `<div class="tabs">${current.pages.map((_, i) => `<button class="tab" type="button" data-page="${i}" aria-pressed="${i === current.view}">صفحة ${i + 1}</button>`).join("")}</div>` : ""}
            <div id="canvas-host"></div>
            <div class="row"><button class="btn small" id="turn" type="button">لف الصورة واقرا تاني</button></div>
          </section>
          <section class="panel"><details class="raw"><summary>اللي اتقرا سطر بسطر</summary>
            <ol>${p.lines.map((l) => `<li>${esc(l.text)}${l.digitText && l.digitText !== l.text ? `<small>بعد قراءة الأرقام: ${esc(Fields.latin(l.digitText))}</small>` : ""}</li>`).join("")}</ol></details></section>
        </aside>
      </div>`;
    $("#result").hidden = false;
    const c = current.mode === "clean" ? p.clean : p.page;
    c.removeAttribute("style");
    $("#canvas-host").appendChild(c);

    $("#rtype").addEventListener("change", (e) => { keepEdits(); extract(e.target.value); showResult(); });
    $("#result").querySelectorAll("[data-mode]").forEach((b) => b.addEventListener("click", () => { keepEdits(); current.mode = b.dataset.mode; showResult(); }));
    $("#result").querySelectorAll("[data-page]").forEach((b) => b.addEventListener("click", () => { keepEdits(); current.view = +b.dataset.page; showResult(); }));
    $("#turn").addEventListener("click", turnPage);
    $("#save").addEventListener("click", save);
    $("#copy").addEventListener("click", copy);
    $("#json").addEventListener("click", download);
    $("#again").addEventListener("click", reset);
  }

  function keepEdits() {
    document.querySelectorAll("#fields input").forEach((i) => {
      const f = current.fields[+i.dataset.i];
      if (f.value !== i.value) { f.edited = true; f.value = i.value; }
    });
  }

  async function turnPage() {
    keepEdits();
    const i = current.view, p = current.pages[i];
    $("#result").hidden = true; $("#work").hidden = false;
    try {
      current.pages[i] = await OCR.readPage(p.page, progress, 90);
      extract($("#rtype")?.value || current.type);
    } catch (e) { console.error(e); toast("ماقدرناش نقرا الصورة بعد اللف", true); }
    $("#work").hidden = true; showResult();
  }

  const record = () => ({ type: current.type, label: Fields.TYPES[current.type].label, file: current.file, at: new Date().toISOString(),
    fields: Object.fromEntries(current.fields.filter((f) => f.value).map((f) => [f.label, f.value])) });

  function save() {
    keepEdits();
    // Corrected numbers teach the digit reader.
    let learned = 0;
    current.fields.forEach((f) => { if (f.edited && f.digits) learned += DigitReader.learn(f.digits, f.value); });
    const h = readHistory(); h.unshift(record()); writeHistory(h.slice(0, 500));
    toast(learned ? `اتحفظ، والقارئ اتعلم ${learned} شكل جديد` : "اتحفظ في السجل");
  }

  async function copy() {
    keepEdits();
    const text = current.fields.filter((f) => f.value).map((f) => `${f.label}: ${f.value}`).join("\n");
    try { await navigator.clipboard.writeText(text); toast("اتنسخت البيانات"); } catch { toast("ماقدرناش ننسخ", true); }
  }

  function saveFile(name, text, type) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text], { type }));
    a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  function download() { keepEdits(); saveFile(`${current.type}-${Date.now()}.json`, JSON.stringify(record(), null, 2), "application/json"); }

  function reset() {
    current = null;
    $("#result").hidden = true; $("#result").innerHTML = ""; $("#start").hidden = false;
    $("#file").value = ""; $("#camera").value = "";
  }

  // ---------- History ----------
  function showHistory() {
    const h = readHistory();
    $("#start").hidden = true; $("#work").hidden = true; $("#result").hidden = false;
    const cols = [...new Set(h.flatMap((r) => Object.keys(r.fields)))];
    $("#result").innerHTML = `<section class="panel">
      <div class="row between"><h2>السجل</h2><div class="row">
        ${h.length ? '<button class="btn small" id="csv" type="button">نزّل جدول</button><button class="btn small" id="clear" type="button">امسح السجل</button>' : ""}
        <button class="btn small primary" id="back" type="button">مستند جديد</button></div></div>
      <p class="note">السجل محفوظ على الجهاز ده بس. القارئ اتعلم ${DigitReader.learnedCount()} شكل من تصحيحاتك.</p>
      ${h.length ? `<div class="table-wrap"><table><thead><tr><th>النوع</th><th>التاريخ</th>${cols.map((c) => `<th>${esc(c)}</th>`).join("")}</tr></thead><tbody>
        ${h.map((r) => `<tr><td>${esc(r.label)}</td><td>${new Date(r.at).toLocaleDateString("ar-EG")}</td>${cols.map((c) => `<td>${esc(r.fields[c] || "")}</td>`).join("")}</tr>`).join("")}
      </tbody></table></div>` : '<p class="empty">مفيش مستندات محفوظة لسه.</p>'}
    </section>`;
    $("#back").addEventListener("click", reset);
    $("#csv")?.addEventListener("click", () => {
      const q = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
      const rows = [["النوع", "التاريخ", ...cols].map(q).join(",")].concat(h.map((r) => [r.label, r.at.slice(0, 10), ...cols.map((c) => r.fields[c] || "")].map(q).join(",")));
      saveFile(`documents-${Date.now()}.csv`, "﻿" + rows.join("\n"), "text/csv");
    });
    $("#clear")?.addEventListener("click", () => { if (confirm("تمسح كل السجل؟")) { writeHistory([]); showHistory(); } });
  }

  // For checking a reading by hand from the browser console.
  window.docReaderState = () => current;

  // ---------- Start ----------
  $("#file").addEventListener("change", (e) => run(e.target.files[0]));
  $("#camera").addEventListener("change", (e) => run(e.target.files[0]));
  $("#history-btn").addEventListener("click", showHistory);
  const drop = $("#drop");
  ["dragenter", "dragover"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("over"); }));
  ["dragleave", "drop"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("over"); }));
  drop.addEventListener("drop", (e) => run(e.dataTransfer.files[0]));
})();
