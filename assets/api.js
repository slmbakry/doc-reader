// The reader's one entry point for other sites (the Waraqak platform loads
// these scripts from this site): read a file into typed fields, and learn
// from corrections. Its shape stays stable while the reading rules improve.
(function () {
  let last = null;

  // type: "auto", "id", "tax" or "cr". Returns { type, label, fields }, where
  // each field is { key, label, value, state } and state is ok, check or missing.
  async function read(file, { type = "auto", onProgress } = {}) {
    const pages = await OCR.readFile(file, onProgress);
    const lines = pages.flatMap((p) => p.lines);
    const nid = pages.map((p) => p.nid).find(Boolean) || null;
    const kind = type !== "auto" ? type : Fields.detect(lines) || "id";
    const fields = Fields.TYPES[kind].run({ lines, nid, pages });
    last = fields;
    return { type: kind, label: Fields.TYPES[kind].label, fields: fields.map(({ key, label, value, state }) => ({ key, label, value, state })) };
  }

  // Corrected values by field key, for the last read: corrected numbers teach the digit reader.
  function learn(corrections) {
    if (!last) return 0;
    let added = 0;
    last.forEach((f) => {
      const v = corrections[f.key];
      if (f.digits && v != null && v !== f.value) added += DigitReader.learn(f.digits, v);
    });
    return added;
  }

  const types = () => Object.entries(Fields.TYPES).map(([key, t]) => ({ key, label: t.label }));

  window.DocReader = { version: 1, read, learn, types };
})();
