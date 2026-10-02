/* Check CNTRS - ตรรกะตรวจเทียบ MANIFEST vs CNTRS (พอร์ตจาก check_cntrs.py)
 * ทำงานในเบราว์เซอร์ทั้งหมด รับข้อมูลเป็นแถวของตาราง (array of arrays) หรือบรรทัดข้อความจาก PDF */
(function (root) {
  "use strict";

  const EXCLUDED_PORTS = ["BKK", "UCT"]; // ตรวจทุก PORT ยกเว้นรหัสที่ลงท้ายด้วยชุดนี้ (THBKK, THUCT)
  const SHED_RULES = {
    "2826": "DG (สินค้าอันตราย)",
    "0302": "SCT", "302": "SCT",
    "0110": "BMT", "110": "BMT",
    "0332": "ลาดกระบัง (ราง/รถไฟ)", "332": "ลาดกระบัง (ราง/รถไฟ)",
  };

  const PKG_RE = /^[\d,]+\s+[A-Z/]+\s*\(/;
  const NUM_RE = /([+-]?\d+)/;
  const CONTAINER_RE = /^[A-Z]{4}\d{6,7}$/;
  const CLASS_SRC = "CL(?:ASS)?\\s*(?:NO)?[\\s:#]*([0-9]+(?:\\.[0-9]+)?(?:\\+[0-9.]+)?)";
  const UN_SRC = "UN\\s*(?:NO)?[\\s:#.]*([0-9]{3,4})";
  const CLASS_RE = new RegExp(CLASS_SRC, "i");
  const UN_RE = new RegExp(UN_SRC, "i");
  const SHORTHAND_DG_RE = /(?<!\d)([0-9]{1,2}(?:\.[0-9])?)\s*\/\s*([0-9]{3,4})\s*\/\s*(I{1,3}|N\/?A)/i;
  const TEMP_AFTER_KEYWORD_RE = /TEMP\w*\s*:?\s*([+-]?\d+)/i;
  const PAGE_PORT_RE = /PortOfDischarge:\s*([A-Z]{5})/;
  const REEFER_TYPE_RE = /^\d{2}R\d/;
  const VENT_RE = /(?<!PRE)(?<!E)VENT[A-Z]*\s*[:.]?\s*([A-Z0-9]\S*)/i;
  const CARGO_MOVEMENT_RE = /CARGO\s+MOVEMENT\s*\(([^)]*)\)/i;
  const TRANSIT_DEST_CAPTURE_RE = /\bTO\s+([A-Z]{3,})/i;
  function transitDestination(text) {
    // ดึงชื่อปลายทาง (เช่น LAOS, MYANMAR) จากข้อความ "TO <ปลายทาง>" ใน CARGO MOVEMENT
    if (!text) return null;
    const m = TRANSIT_DEST_CAPTURE_RE.exec(text.toUpperCase());
    return m ? m[1] : null;
  }

  const cellOf = (rows, i, c) => {
    const r = rows[i];
    if (!r) return null;
    const v = r[c];
    if (v === null || v === undefined || v === "") return null;
    return String(v).trim();
  };
  const ncolsOf = rows => rows.reduce((m, r) => Math.max(m, (r || []).length), 0);

  // ---------- helpers ----------
  function formatShedCode(raw) {
    if (raw === null || raw === undefined) return null;
    let s = String(raw).trim();
    if (s.endsWith(".0")) s = s.slice(0, -2);
    if (/^\d+$/.test(s) && s.length < 4) s = s.padStart(4, "0");
    return s;
  }
  function normStatus(raw) {
    if (!raw) return null;
    let r = String(raw).toUpperCase().trim();
    if (r.includes("=")) r = r.split("=").slice(1).join("=");
    if (r === "CY" || r.includes("FCL")) return "FCL";
    if (r.includes("LCL")) return "LCL";
    return r;
  }
  function extractManifestTemp(temps) {
    // ตัดข้อความก่อนคำว่า TEMP ทิ้งก่อนหาตัวเลขเสมอ กันเลขอื่นที่อยู่ก่อนหน้า (เช่น
    // "GS100-200 TEMP. ATMINUS 18...") ถูกหยิบผิดตัว แล้วเช็ค MINUS ระหว่าง TEMP
    // กับตัวเลขนั้น (รวมแบบติดกัน "ATMINUS") แทนเครื่องหมาย "-"
    const text = temps.join(" ").trim();
    if (!text) return null;
    const idx = text.toUpperCase().indexOf("TEMP");
    const searchText = idx !== -1 ? text.slice(idx) : text;
    const m = TEMP_AFTER_KEYWORD_RE.exec(searchText) || NUM_RE.exec(searchText);
    if (!m) return null;
    let val = m[1];
    if (!/^[+-]/.test(val)) val = (searchText.slice(0, m.index).toUpperCase().includes("MINUS") ? "-" : "+") + val;
    return val + "C";
  }
  function extractCntrsTemp(remark) {
    if (!remark || !remark.toUpperCase().includes("REEFER")) return null;
    const m = NUM_RE.exec(remark);
    if (!m) return null;
    let val = m[1];
    if (!/^[+-]/.test(val)) val = "+" + val;
    return val + "C";
  }
  function extractDgParts(text) {
    if (!text) return null;
    const b = text.toUpperCase();
    const cls = CLASS_RE.exec(b), un = UN_RE.exec(b);
    if (cls && un) return [cls[1], un[1]];
    const sh = SHORTHAND_DG_RE.exec(b);
    if (sh) return [sh[1], sh[2]];
    if (b.includes("HAZARDOUS") || b.includes("DANGEROUS")) return ["?", null];
    return null;
  }
  function extractDg(text) {
    const p = extractDgParts(text);
    if (!p) return null;
    return p[1] === null ? "DG (unspecified class/UN)" : `CLASS ${p[0]} UN${p[1]}`;
  }
  function dgMatches(mText, cText) {
    const m = extractDgParts(mText), c = extractDgParts(cText);
    if (!m || !c) return (m === null) === (c === null);
    if (m[1] !== c[1]) return false;
    if (m[1] === null) return m[0] === c[0];
    return m[0].split("+")[0].trim() === c[0].split("+")[0].trim();
  }
  function truncateConsignee(s) {
    if (!s) return s;
    const i = s.indexOf("C/O");
    return i !== -1 ? s.slice(0, i + 3).trim() : s.trim();
  }

  // ---------- MANIFEST ----------
  function parseManifest(rows, keepPort) {
    const n = rows.length, ncols = ncolsOf(rows);
    const cells = idx => {
      const out = [];
      for (let c = 0; c < ncols; c++) { const v = cellOf(rows, idx, c); if (v !== null) out.push([c, v]); }
      return out;
    };
    const footers = [];
    for (let i = 0; i < n; i++) {
      const c0 = cellOf(rows, i, 0);
      if (c0) { const m = PAGE_PORT_RE.exec(c0); if (m) footers.push([i, m[1]]); }
    }
    const portOfRow = idx => { for (const [f, p] of footers) if (f >= idx) return p; return null; };

    const headerRows = [];
    for (let i = 0; i < n; i++) {
      const c0 = cellOf(rows, i, 0);
      if (!c0) continue;
      if (["S :", "C :", "N :", "("].some(p => c0.startsWith(p))) continue;
      if (cells(i).some(([c, v]) => c !== 0 && PKG_RE.test(v))) headerRows.push(i);
    }

    const map = {};
    headerRows.forEach((start, hi) => {
      const end = hi + 1 < headerRows.length ? headerRows[hi + 1] : n;
      const blNo = cellOf(rows, start, 0);
      let consignee = null, statusRaw = null, shedNo = null, isReefer = false;
      const containers = [], temps = [], descAll = [];
      for (let r = start; r < end; r++) {
        const c0 = cellOf(rows, r, 0);
        if (c0 && c0.startsWith("C :")) consignee = c0.slice(3).trim();
        for (const [c, vs] of cells(r)) {
          if (c === 0) continue;
          const mc = /^\d+\.\s*([A-Z]{4}\d{6,7})/.exec(vs);
          if (mc) { containers.push(mc[1]); continue; }
          if (statusRaw === null && /^(CY|LCL(\/CFS)?|FCL)\b/i.test(vs)) { statusRaw = vs; continue; }
          descAll.push(vs);
          if (REEFER_TYPE_RE.test(vs)) isReefer = true;
          const vsu = vs.toUpperCase();
          // "MINUS" เก็บด้วยเพราะบางเซลล์มีแค่ตัวเลขอุณหภูมิ (เช่น "...SET AT MINUS 18")
          // ส่วนคำว่า DEGREES CELSIUS ไปอยู่คนละเซลล์/บรรทัดถัดไป
          if (vsu.includes("TEMP") || vsu.includes("DEGREE") || vsu.includes("CELSIUS") || vsu.includes("MINUS")) temps.push(vs);
          const ms = /SHED\s*NO\.?\s*([0-9]+)/.exec(vsu);
          if (ms) shedNo = ms[1];
        }
      }
      const vm = VENT_RE.exec(descAll.join(" "));
      const cm = CARGO_MOVEMENT_RE.exec(descAll.join(" "));
      const cargoMovement = cm ? cm[1].trim() : null;
      const isTransit = !!cargoMovement && /TRANSIT|TRANSHIP/i.test(cargoMovement);
      const block = { blNo, consignee, statusRaw, shedNo, containers, temps, descAll,
                      isReefer, vent: vm ? vm[1] : null, port: portOfRow(start), cargoMovement, isTransit };
      if (block.port && block.port !== keepPort && EXCLUDED_PORTS.some(x => block.port.endsWith(x))) return;
      containers.forEach(c => { map[c] = block; });
    });
    return map;
  }

  // ---------- CNTRS (xls) ----------
  function findCntrsColumns(rows) {
    const header = {}, ncols = ncolsOf(rows);
    for (let i = 0; i < Math.min(10, rows.length); i++) {
      for (let c = 0; c < ncols; c++) {
        const v = cellOf(rows, i, c);
        if (v && ["STATUS", "POL", "REMARK", "CONSIGNEE"].includes(v.toUpperCase())) header[v.toUpperCase()] = c;
      }
      if (header.REMARK !== undefined && header.STATUS !== undefined && header.CONSIGNEE !== undefined) break;
    }
    const sample = [];
    for (let i = 0; i < rows.length && sample.length < 20; i++) {
      const c0 = cellOf(rows, i, 0);
      if (c0 && CONTAINER_RE.test(c0)) sample.push(i);
    }
    const resolve = (label, dflt) => {
      const hc = header[label];
      if (hc === undefined) return dflt;
      let best = hc, bestCount = -1;
      for (const cand of [hc - 1, hc, hc + 1]) {
        if (cand < 0 || cand >= ncols) continue;
        const count = sample.filter(i => cellOf(rows, i, cand) !== null).length;
        if (count > bestCount) { bestCount = count; best = cand; }
      }
      return best;
    };
    return { status: resolve("STATUS", 18), remark: resolve("REMARK", 22), consignee: resolve("CONSIGNEE", 9) };
  }

  function deliveryOfRows(rows) {
    const ncols = ncolsOf(rows);
    for (let c = 0; c < ncols; c++) {
      const v = cellOf(rows, 3, c);
      if (v && v.toUpperCase() === "PORT OF DELIVERY") {
        for (let c2 = c + 1; c2 < ncols; c2++) { const w = cellOf(rows, 3, c2); if (w) return w; }
      }
    }
    return null;
  }

  function parseCntrsRows(rows) {
    const cols = findCntrsColumns(rows), delivery = deliveryOfRows(rows);
    const out = {};
    let curShed = null, curDesc = null;
    for (let i = 0; i < rows.length; i++) {
      const c0 = cellOf(rows, i, 0);
      if (c0 === "SHED NUMBER:") {
        const code = cellOf(rows, i, 2);
        curShed = code !== null ? formatShedCode(code) : null;
        curDesc = cellOf(rows, i, 5);
        continue;
      }
      const c2 = cellOf(rows, i, 2);
      if (c0 && c2 !== null && CONTAINER_RE.test(c0) && curShed !== null) {
        const parts = [];
        const c9 = cellOf(rows, i, cols.consignee);
        if (c9) parts.push(c9);
        if (i + 1 < rows.length && cellOf(rows, i + 1, 0) === null && cellOf(rows, i + 1, 2) === null) {
          const nx = cellOf(rows, i + 1, cols.consignee);
          if (nx) parts.push(nx);
        }
        out[c0] = {
          item: parseInt(c2, 10), shedNo: curShed, shedDesc: curDesc, delivery,
          consignee: truncateConsignee(parts.join(" ") || null),
          statusRaw: cellOf(rows, i, cols.status), remarkRaw: cellOf(rows, i, cols.remark),
        };
      }
    }
    return out;
  }

  function parseCntrsHeaderRows(rows) {
    const ncols = ncolsOf(rows), row = 3;
    const after = label => {
      for (let c = 0; c < ncols; c++) {
        const v = cellOf(rows, row, c);
        if (v && v.toUpperCase() === label) {
          for (let c2 = c + 1; c2 < ncols; c2++) { const w = cellOf(rows, row, c2); if (w) return w; }
        }
      }
      return "-";
    };
    return { feeder: after("CONTAINER LIST FOR FEEDER"), voyage: after("VOYAGE"),
             arrivalDate: after("ARRIVAL DATE"), portOfDischarge: after("PORT OF DISCHARGE") };
  }

  // ---------- CNTRS (pdf text lines) ----------
  // STATUS กับ POL บางครั้งพิมพ์ติดกันไม่มีเว้นวรรค เช่น "9=LCL/CFSKRPUS" จึงระบุค่า
  // STATUS ที่เป็นไปได้ตรงๆ แทน \S+ กว้างๆ แล้วให้ \s* รับทั้งมีและไม่มีวรรค
  const PDF_CONTAINER_LINE_RE = new RegExp(
    "^(?<cno>[A-Z]{4}\\d{6,7})\\s+(?<item>\\d+)\\s+(?<type>\\S+)\\s+(?<size>\\S+\\s*\\(\\d+'\\))\\s+" +
    "(?<cons>.*?)\\s+(?<wt>[\\d,]+(?:\\.\\d+)?)\\s+KGM\\s+(?<status>\\d=(?:FCL|LCL\\/CFS))\\s*(?<pol>[A-Z]{5})\\s*(?<remark>.*)$");
  const PDF_HEADER_RE = new RegExp(
    "CONTAINER LIST FOR FEEDER\\s+(?<feeder>.+?)\\s+VOYAGE\\s+(?<voyage>\\S+)\\s+ARRIVAL DATE\\s+(?<arr>\\S+)\\s+" +
    "Port Of Discharge\\s+(?<pod>\\w+)(?:\\s+Port Of Delivery\\s+(?<pod2>\\w+))?", "i");
  const PDF_SKIP = ["TOTAL", "PORTOFDISCHARGE", "HEUNG A LINE (THAILAND)", "TEL.", "CONTAINER LIST", "CONTAINER NO.",
                    "AS AGENTS", "SHED NUMBER", "CO.,LTD.", "/"];

  function parseCntrsPdfLines(lines) {
    const out = {};
    let shed = null, desc = null, delivery = null, last = null;
    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;
      const h = PDF_HEADER_RE.exec(line);
      if (h) { delivery = h.groups.pod2 || null; last = null; continue; }
      const ms = /^SHED NUMBER:\s*(\d+)\s*(.*)$/.exec(line);
      if (ms) { shed = formatShedCode(ms[1]); desc = ms[2].trim() || null; last = null; continue; }
      const m = PDF_CONTAINER_LINE_RE.exec(line);
      if (m && shed !== null) {
        const g = m.groups;
        out[g.cno] = { item: parseInt(g.item, 10), shedNo: shed, shedDesc: desc, delivery,
                       consignee: truncateConsignee(g.cons), statusRaw: g.status, remarkRaw: g.remark.trim() || null };
        last = g.cno;
        continue;
      }
      if (last && !PDF_SKIP.some(p => line.toUpperCase().startsWith(p))) {
        const prev = out[last].remarkRaw;
        out[last].remarkRaw = prev ? `${prev} ${line}` : line;
      }
    }
    return out;
  }
  function parseCntrsHeaderPdfLines(lines) {
    for (const l of lines) {
      const h = PDF_HEADER_RE.exec(l);
      if (h) return { feeder: h.groups.feeder, voyage: h.groups.voyage, arrivalDate: h.groups.arr, portOfDischarge: h.groups.pod };
    }
    return { feeder: "-", voyage: "-", arrivalDate: "-", portOfDischarge: "-" };
  }

  // ---------- classify ----------
  function classifyText(text) {
    const t = text.toUpperCase();
    if (t.includes("CARGO MANIFEST")) return "MANIFEST";
    if (t.includes("CONTAINER LIST FOR FEEDER")) return "CNTRS";
    return null;
  }
  function classifyRows(rows) {
    const parts = [];
    for (let i = 0; i < Math.min(8, rows.length); i++) (rows[i] || []).forEach(v => { if (v !== null && v !== undefined) parts.push(String(v)); });
    return classifyText(parts.join(" "));
  }

  // ---------- rules ----------
  const HICUBE_AND = /\bAND\b|\bHI-CUBE\b/gi;
  const REEFER_TEMP = /REEFER\s*[+-]?\d+\s*C/gi;
  const HAZARDOUS = /\bHAZARDOUS\b/gi;
  function simplifyRemark(raw, tempC, dgC) {
    if (!raw) return null;
    let core = raw.trim().replace(/\s+/g, " ").replace(HICUBE_AND, " ");
    if (tempC) core = core.replace(REEFER_TEMP, " ");
    if (dgC) {
      core = core.replace(HAZARDOUS, " ").replace(new RegExp(CLASS_SRC, "gi"), " ")
                 .replace(new RegExp(UN_SRC, "gi"), " ").replace(/\b(UN|CLASS)\b/gi, " ");
    }
    core = core.replace(/[\s,]+/g, " ").trim();
    return core || null;
  }
  // SHED ที่ล็อกไว้ผูกกับปลายทางอยู่แล้ว: ถ้า CNTRS ไม่ระบุ Port Of Delivery (หรือเป็น THLCH) ดูปลายทางจากเลข SHED
  const SHED_DELIVERY = { "0110": "THBMT", "0302": "THSCT", "0332": "THLKR" };
  function effectiveDelivery(cc) {
    const d = (cc.delivery || "").toUpperCase();
    if (d === "" || d === "THLCH") return SHED_DELIVERY[cc.shedNo] || d || null;
    return d;
  }
  function expectedShed(delivery, hasTemp, hasDg) {
    if (hasDg) return "2826";
    if (hasTemp) return null;
    const d = (delivery || "").toUpperCase();
    if (d === "THBMT") return "0110";
    if (d === "THLKR") return "0332";
    return null;
  }
  function remarkCheck(delivery, hasTemp, hasDg, remarkRaw) {
    const d = (delivery || "").toUpperCase();
    let expected;
    if (d === "THBMT") expected = "BY BARGE";
    else if (d.endsWith("SCT")) expected = "BY TRUCK";
    else if (d === "THLKR") expected = (hasTemp || hasDg) ? "BY TRUCK" : "BY TRAIN";
    else return { expected: null, actual: null, ok: null };
    const r = (remarkRaw || "").toUpperCase();
    let actual;
    if (r.includes("BARGE")) actual = "BY BARGE";
    else if (r.includes("TRUCK")) actual = "BY TRUCK";
    else if (r.includes("TRAN") || r.includes("TRAIN")) actual = "BY TRAIN";
    else actual = "(ไม่ระบุ)";
    return { expected, actual, ok: expected === actual };
  }
  function ventOk(mb, tempM, tempC) {
    const isReefer = mb.isReefer || !!tempM || !!tempC;
    return !isReefer || !!mb.vent;
  }
  const TRANSIT_DEST_RE = /\bTO\s+[A-Z]{3,}/i;
  const TRANSIT_TO_PHRASE_RE = /\bTRANSIT\s+TO\s+[A-Z]+/gi;
  function transitOk(remarkRaw) {
    // REMARK ที่บอกปลายทางต่างประเทศ (เช่น "TO LAOS") คือสินค้า TRANSIT ผ่านไทย
    // ต้องมีคำว่า TRANSIT ระบุไว้ด้วยเสมอ (เช่น "TRANSIT TO LAOS")
    if (!remarkRaw) return true;
    const r = remarkRaw.toUpperCase();
    return !(TRANSIT_DEST_RE.test(r) && !r.includes("TRANSIT"));
  }

  // ---------- build report rows ----------
  function buildReport(manifest, cntrs) {
    const order = Object.keys(cntrs).concat(Object.keys(manifest).filter(c => !(c in cntrs)));
    const rows = [];
    let mismatch = 0;
    for (const cno of order) {
      const mb = manifest[cno], cc = cntrs[cno];
      if (!mb) {
        const tC0 = extractCntrsTemp(cc.remarkRaw), dC0 = extractDg(cc.remarkRaw);
        const transitGood0 = transitOk(cc.remarkRaw);
        let note0 = "⚠ CONTAINER นี้มีใน CNTRS แต่ไม่พบใน MANIFEST";
        if (!transitGood0) note0 += " | REMARK ไม่มีคำว่า TRANSIT (พบปลายทางต่างประเทศแต่ไม่ระบุว่าเป็น TRANSIT)";
        let remark0 = simplifyRemark(cc.remarkRaw, tC0, dC0);
        if (transitGood0 && remark0) remark0 = remark0.replace(TRANSIT_TO_PHRASE_RE, " ").replace(/\s+/g, " ").trim() || null;
        rows.push({ critical: true, item: cc.item, cno, blNo: "-", consignee: cc.consignee || "-",
          shedM: "-", shedC: cc.shedNo, shedOk: false, statusM: "-", statusC: normStatus(cc.statusRaw), statusOk: false,
          tempM: "-", tempC: tC0, tempOk: false,
          dgM: "-", dgC: dC0, dgOk: false, ventOk: true,
          remark: remark0, remarkOk: false, note: note0 });
        mismatch++; continue;
      }
      if (!cc) {
        const tM = extractManifestTemp(mb.temps);
        rows.push({ critical: true, item: "-", cno, blNo: mb.blNo, consignee: mb.consignee,
          shedM: mb.shedNo, shedC: "-", shedOk: false, statusM: normStatus(mb.statusRaw), statusC: "-", statusOk: false,
          tempM: tM, tempC: "-", tempOk: false, dgM: extractDg(mb.descAll.join(" ")), dgC: "-", dgOk: false,
          ventOk: ventOk(mb, tM, null), remark: "-", remarkOk: false, note: "⚠ CONTAINER นี้มีใน MANIFEST แต่ไม่พบใน CNTRS" });
        mismatch++; continue;
      }
      const shedM = mb.shedNo, shedC = cc.shedNo;
      let shedOk = shedM === shedC;
      const statusM = normStatus(mb.statusRaw), statusC = normStatus(cc.statusRaw);
      const statusOk = statusM === statusC;
      const tempM = extractManifestTemp(mb.temps), tempC = extractCntrsTemp(cc.remarkRaw);
      const tempOk = tempM === tempC;
      const blob = mb.descAll.join(" ");
      const dgM = extractDg(blob), dgC = extractDg(cc.remarkRaw);
      const dgOk = dgMatches(blob, cc.remarkRaw);
      const vent = ventOk(mb, tempM, tempC);

      const expShed = expectedShed(effectiveDelivery(cc), !!(tempM || tempC), !!(dgM || dgC));
      const shedRuleBad = !!expShed && cc.shedNo !== expShed;
      const shedEqual = shedOk;
      if (shedRuleBad) shedOk = false;

      const rc = remarkCheck(effectiveDelivery(cc), !!(tempM || tempC), !!(dgM || dgC), cc.remarkRaw);
      const transitGood = transitOk(cc.remarkRaw);
      if (!transitGood && rc.ok !== false) rc.ok = false;
      let remark = simplifyRemark(cc.remarkRaw, tempC, dgC);
      if (remark) {
        if (rc.ok) remark = remark.replace(/\bBY\s+(BARGE|TRUCK|TRAIN|TRAN)\b/gi, " ");
        if (transitGood) remark = remark.replace(TRANSIT_TO_PHRASE_RE, " ");
        remark = remark.replace(/\s+/g, " ").trim() || null;
      }

      const notes = [];
      if (!shedEqual) {
        const hint = SHED_RULES[cc.shedNo];
        notes.push(`SHED ไม่ตรง: MANIFEST=${shedM || "-"} / CNTRS=${shedC || "-"}${hint ? ` (CNTRS จัดเก็บที่ ${hint})` : ""}`);
      }
      if (shedRuleBad) notes.push(`SHED ผิดกฎที่ล็อกไว้: ควรเป็น ${expShed} แต่ CNTRS อยู่ SHED ${cc.shedNo} (ปลายทาง ${effectiveDelivery(cc) || "-"})`);
      if (!statusOk) notes.push(`STATUS ไม่ตรง: MANIFEST=${statusM || "-"} / CNTRS=${statusC || "-"}`);
      if (!tempOk) notes.push(`TEMP ไม่ตรง: MANIFEST=${tempM || "-"} / CNTRS=${tempC || "-"}`);
      if (!dgOk) notes.push(`DG ไม่ตรง: MANIFEST=${dgM || "-"} / CNTRS=${dgC || "-"}`);
      if (!vent) notes.push("VENT ไม่ระบุใน MANIFEST");
      if (rc.ok === false && rc.expected) notes.push(`REMARK ไม่ตรงกฎ: ควรเป็น '${rc.expected}' แต่พบ '${rc.actual}'`);
      if (!transitGood) notes.push("REMARK ไม่มีคำว่า TRANSIT (พบปลายทางต่างประเทศแต่ไม่ระบุว่าเป็น TRANSIT)");

      const bad = !(shedOk && statusOk && tempOk && dgOk && vent && rc.ok !== false);
      if (bad) mismatch++;
      rows.push({ critical: false, isTransit: !!mb.isTransit, cargoMovement: mb.cargoMovement, item: cc.item, cno, blNo: mb.blNo, consignee: cc.consignee || mb.consignee,
        shedM, shedC, shedOk, statusM, statusC, statusOk, tempM, tempC, tempOk, dgM, dgC, dgOk, ventOk: vent,
        remark, remarkOk: rc.ok, note: notes.join(" | ") });
    }
    return { rows, mismatch, total: order.length };
  }

  // แปลงแถวเป็นเซลล์แสดงผล (ใช้ร่วมกันทั้งหน้าเว็บและ Excel)
  // style: null | "ok" | "bad" | "warn" | "na"
  function displayCells(r, i) {
    const dash = v => (v === null || v === undefined || v === "" ? "-" : v);
    const pair = (mv, cv, ok, hide) => (hide && ok)
      ? [{ v: "-" }, { v: "-" }]
      : [{ v: dash(mv), s: ok ? null : "bad" }, { v: dash(cv) }];
    const icon = ok => ({ v: ok ? "✓" : "⚠", s: ok ? "ok" : "bad" });
    const cells = [{ v: i }, { v: dash(r.item) }, { v: r.cno }, { v: dash(r.blNo) }, { v: dash(r.consignee) }];
    cells.push(...pair(r.shedM, r.shedC, r.shedOk, true), icon(r.shedOk));
    cells.push(...pair(r.statusM, r.statusC, r.statusOk, true), icon(r.statusOk));
    cells.push(...pair(r.tempM, r.tempC, r.tempOk, true), icon(r.tempOk));
    cells.push(r.ventOk ? { v: "-" } : { v: "❗", s: "vent" });
    cells.push(...pair(r.dgM, r.dgC, r.dgOk, true), icon(r.dgOk));
    cells.push({ v: dash(r.remark), s: r.remarkOk === false ? "bad" : null });
    cells.push(r.remarkOk === null ? { v: "-", s: "na" } : icon(r.remarkOk));
    cells.push({ v: r.note || "", s: "note" });
    return cells;
  }

  const HEADERS = ["NO.", "ITEM", "CONTAINER NO.", "B/L NO.", "CONSIGNEE",
    "SHED (MANIFEST)", "SHED (CNTRS)", "SHED ✓/⚠", "STATUS (MANIFEST)", "STATUS (CNTRS)", "STATUS ✓/⚠",
    "TEMP (MANIFEST)", "TEMP (CNTRS)", "TEMP ✓/⚠", "VENT (MANIFEST)",
    "DG CLASS/UN (MANIFEST)", "DG CLASS/UN (CNTRS)", "DG ✓/⚠", "REMARK (CNTRS)", "REMARK ✓/⚠", "หมายเหตุ / NOTE"];

  root.CheckCntrs = {
    HEADERS, classifyRows, classifyText, parseManifest, parseCntrsRows, parseCntrsHeaderRows,
    parseCntrsPdfLines, parseCntrsHeaderPdfLines, buildReport, displayCells, transitDestination,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = root.CheckCntrs;
})(typeof window !== "undefined" ? window : globalThis);
