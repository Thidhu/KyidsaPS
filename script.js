// ---------- Constants ----------
// PASTE YOUR APPS SCRIPT WEB APP URL HERE (from Deploy > New deployment)
const BACKEND_URL = "https://script.google.com/macros/s/AKfycbw5Wonq1vPux7p1Y09d3vJd4X0pxQYaodF8diNotLdOGYcMzte-yh1jxmQgA-x80dwzoQ/exec";

// Put your welcome sound file (e.g. "audio/welcome.mp3") in your project folder,
// then update this path if needed. If the file is missing, playback just silently
// fails — nothing breaks.
const AUDIO_URL = "audio/welcome.mp3";

// Put your logo file (e.g. "images/logo.png") in your images folder, then update
// this path if needed. If the file is missing, the logo just quietly doesn't show —
// nothing breaks.
const LOGO_URL = "images/logo.png";

const CATEGORY_LABEL = { lessonPlan: "Lesson Plan", otherDocuments: "Other Document" };

const CLASS_OPTIONS = ["Class PP", "Class I", "Class II", "Class III", "Class IV", "Class V", "Class VI"];
const SUBJECT_OPTIONS = ["English", "Dzongkha", "Mathematics", "Science", "ICT", "DTI", "Arts", "HPE"];

// Builds <option> tags for a fixed list, plus the currently-saved value if it's
// something outside the list (e.g. was typed in before this became a dropdown) —
// so nobody's existing data silently disappears or gets reset.
function selectOptionsHtml(options, currentValue) {
  const list = currentValue && !options.includes(currentValue) ? [currentValue, ...options] : options;
  return `<option value="">Select…</option>` + list.map((o) => `<option value="${esc(o)}" ${o === currentValue ? "selected" : ""}>${esc(o)}</option>`).join("");
}

// Only compacts genuinely short columns (Timestamp, or a column that's EXACTLY
// "Day" e.g. a day-of-week answer) — deliberately does NOT match "Day's Activity"
// or similar free-text columns, which need room to actually show what was written.
function tableColumnClass(header) {
  if (/^timestamp$|^day$/i.test(header)) return "col-compact";
  if (/name/i.test(header)) return "col-name";
  return "col-content";
}

// Edit these to point at your actual links — shown on the Home page
const PORTFOLIO_LINKS = [
  { label: "School Records (Google Drive)", url: "Coming Soon!!!", icon: "📁" },
  { label: "Master Data Sheet", url: "Coming Soon!!!", icon: "📊" },
  { label: "School Vision & Mission", url: "Coming Soon!!!", icon: "🏫" },
];

// Paste your published Google Form links here.
// Use the form's "Send" > link icon URL (ending in /viewform). The app embeds it
// automatically. Responses land in whatever Google Sheet you attach the form to —
// share that sheet only with the principal to keep it principal-only viewing.
const ATTENDANCE_FORM_URL = "https://forms.gle/zdDsEDyXt71dFQGf8";
const TOD_FORM_URL = "https://forms.gle/9cC3tdPFxaXDSkJi8";
const LEAVE_FORM_URL = "https://forms.gle/4PyP1VapqVohfvvG8";

// External tools (not Google Forms) — opened in a new tab rather than embedded,
// since most external sites block being shown in an iframe.
const TIMETABLE_GENERATOR_URL = "https://thinleywangchuk478.github.io/TIME-TABLE-GENERATOR/";
const EMIS_URL = "https://portal.education.gov.bt/";

function emptyData() {
  return {
    teachers: [],
    documents: [],
    schedules: {
      lessonPlan: { type: "daily", requiredCount: 2 },
      otherDocuments: { type: "calendar", dates: [] },
    },
    overrides: {},
    adminPin: null,
    attendanceResponses: [],
    todResponses: [],
    leaveResponses: [],
    todRemarks: {},
    todRemarksSeen: {},
    timetableUrl: null,
    customFolders: [],
    links: [],
    teacherPins: {},
    staff: [],
    totalStudents: "",
  };
}

// ---------- State ----------
const state = {
  data: emptyData(),
  loaded: false,
  adminMode: false,
  view: "home", // home | directory | dashboard | folder
  activeTeacherId: null,
  session: null, // { teacherId }
  modal: null, // { type, ...props }
  toast: null,
  saveError: "",
  today: new Date(),
  busyUpload: false,
  pendingUpload: null, // { category, docName, fileName, mimeType, dataUrl } — staged, not yet submitted
  audioMuted: false,
  directorySearch: "",
};

// ---------- Decorative page-wide twinkling stars (injected once, lives outside #app so re-renders don't touch it) ----------
function generateStarsHtml(count) {
  let html = "";
  for (let i = 0; i < count; i++) {
    const top = (Math.random() * 100).toFixed(1);
    const left = (Math.random() * 100).toFixed(1);
    const size = (Math.random() * 1.8 + 1).toFixed(1);
    const delay = (Math.random() * 5).toFixed(2);
    const duration = (Math.random() * 2 + 2.5).toFixed(2);
    html += `<span class="star" style="top:${top}%; left:${left}%; width:${size}px; height:${size}px; animation-delay:${delay}s; animation-duration:${duration}s;"></span>`;
  }
  return html;
}
function initPageStars() {
  const el = document.getElementById("page-stars");
  if (el) el.innerHTML = generateStarsHtml(70);
}
initPageStars();

// ---------- Welcome sound (plays once on open; toggled via the header speaker button) ----------
const AUDIO_MUTE_KEY = "kyidsaAudioMuted_v1";

function initAudio() {
  const audio = document.getElementById("bg-audio");
  if (!audio) return;
  audio.src = AUDIO_URL;
  audio.volume = 0.55;

  let savedMute = null;
  try { savedMute = localStorage.getItem(AUDIO_MUTE_KEY); } catch (e) { /* ignore */ }
  state.audioMuted = savedMute === "1";
  if (state.audioMuted) return;

  audio.play().catch(() => {
    // Most browsers block autoplay-with-sound until the visitor interacts with the
    // page at least once — fall back to starting it on their first tap/click/key.
    const startOnInteract = () => {
      if (!state.audioMuted) audio.play().catch(() => {});
      document.removeEventListener("click", startOnInteract);
      document.removeEventListener("keydown", startOnInteract);
      document.removeEventListener("touchstart", startOnInteract);
    };
    document.addEventListener("click", startOnInteract, { once: true });
    document.addEventListener("keydown", startOnInteract, { once: true });
    document.addEventListener("touchstart", startOnInteract, { once: true });
  });
}

function toggleAudio() {
  state.audioMuted = !state.audioMuted;
  try { localStorage.setItem(AUDIO_MUTE_KEY, state.audioMuted ? "1" : "0"); } catch (e) { /* ignore */ }
  const audio = document.getElementById("bg-audio");
  if (audio) {
    if (state.audioMuted) audio.pause();
    else audio.play().catch(() => {});
  }
  render();
}

// Drive's "uc?export=view" links are slow and sometimes show an interstitial page.
// The "thumbnail" endpoint is much faster and more reliable for <img> display.
// Works on any Drive file URL format (uc?id=, /d/ID/, open?id=) by pulling out the file ID.
function driveThumb(url, size) {
  if (!url) return url;
  const match = url.match(/[?&]id=([^&]+)/) || url.match(/\/d\/([^/]+)/);
  if (!match) return url;
  return `https://drive.google.com/thumbnail?id=${match[1]}&sz=w${size || 200}`;
}

// ---------- Utils ----------
function uid() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

function startOfDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

// Keeps rows submitted within the last `days` days (inclusive of today), by the
// given Timestamp column. Rows with an unparseable/missing timestamp are kept
// rather than hidden, since silently dropping them would be worse than showing
// one extra row.
function filterToLastNDays(rows, tsCol, today, days) {
  if (!tsCol) return rows;
  const cutoff = startOfDay(today);
  cutoff.setDate(cutoff.getDate() - (days - 1));
  return rows.filter((r) => {
    const d = parseSheetTimestamp(r[tsCol]);
    if (!d) return true;
    return startOfDay(d) >= cutoff;
  });
}

function computeCalendarDues(schedule, today) {
  const dates = (schedule && schedule.dates ? schedule.dates : [])
    .map((s) => startOfDay(new Date(s)))
    .sort((a, b) => a - b);
  const t = startOfDay(today);
  let mostRecentDue = null;
  let nextDue = null;
  for (const d of dates) {
    if (d <= t) mostRecentDue = d;
    else { nextDue = d; break; }
  }
  return { mostRecentDue, nextDue };
}

function computeLessonPlanStatus(schedule, documents, teacherId, today) {
  const required = (schedule && schedule.requiredCount) || 2;
  const t = startOfDay(today);
  const count = documents.filter((d) => {
    if (d.teacherId !== teacherId || d.category !== "lessonPlan") return false;
    return startOfDay(new Date(d.uploadedAt)).getTime() === t.getTime();
  }).length;
  return { overdue: count < required, required, count, dueDate: t };
}

function latestUploadDate(documents, teacherId, category) {
  const docs = documents.filter((d) => d.teacherId === teacherId && d.category === category);
  if (docs.length === 0) return null;
  return docs.reduce((max, d) => (new Date(d.uploadedAt) > max ? new Date(d.uploadedAt) : max), new Date(docs[0].uploadedAt));
}

function getStatus(data, teacherId, category, today) {
  if (category === "lessonPlan") {
    return computeLessonPlanStatus(data.schedules.lessonPlan, data.documents, teacherId, today);
  }

  // otherDocuments — calendar-based due dates, with optional per-teacher custom override
  const overrideKey = `${teacherId}:${category}`;
  const customDueStr = data.overrides[overrideKey];
  const last = latestUploadDate(data.documents, teacherId, category);
  const t = startOfDay(today);

  if (customDueStr) {
    const customDue = startOfDay(new Date(customDueStr));
    const overdue = t >= customDue && (!last || last < customDue);
    return { overdue, dueDate: customDue, source: "custom", lastUpload: last };
  }

  const { mostRecentDue, nextDue } = computeCalendarDues(data.schedules.otherDocuments, today);
  if (!mostRecentDue) return { overdue: false, dueDate: nextDue || null, source: null, lastUpload: last };
  const overdue = t >= mostRecentDue && (!last || last < mostRecentDue);
  return { overdue, dueDate: overdue ? mostRecentDue : nextDue, source: "recurring", lastUpload: last };
}

function fmtDate(d) {
  if (!d) return "—";
  const date = new Date(d);
  const day = date.toLocaleDateString(undefined, { weekday: "long" });
  const dd = String(date.getDate()).padStart(2, "0");
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const yyyy = date.getFullYear();
  return `${day} - ${dd}/${mm}/${yyyy}`;
}

function esc(str) {
  if (str == null) return "";
  return String(str).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---------- Export / Print (Attendance & TOD tables) ----------
// Always pulls the FULL underlying dataset, not just whatever subset is currently
// shown on screen (the on-screen table may be narrowed to "today" for readability,
// but export/print is for record-keeping so it should include everything, unless
// a date range is chosen).
function exportSourceRows(source) {
  if (source === "attendance") return { rows: state.data.attendanceResponses, title: "Attendance Records" };
  if (source === "tod") return { rows: state.data.todResponses, title: "Day's Activity (TOD Reports)" };
  return { rows: [], title: "Export" };
}

// fromStr/toStr are "YYYY-MM-DD" (native <input type="date"> format) or empty/null for open-ended.
// Rows with a Timestamp that can't be parsed are kept rather than silently dropped.
function filterRowsByDateRange(rows, fromStr, toStr) {
  if (!fromStr && !toStr) return rows;
  const cols = [];
  rows.forEach((r) => Object.keys(r).forEach((k) => { if (!cols.includes(k)) cols.push(k); }));
  const tsCol = cols.find((c) => /timestamp/i.test(c));
  if (!tsCol) return rows;
  const from = fromStr ? startOfDay(new Date(fromStr + "T00:00:00")) : null;
  const to = toStr ? startOfDay(new Date(toStr + "T00:00:00")) : null;
  return rows.filter((r) => {
    const d = parseSheetTimestamp(r[tsCol]);
    if (!d) return true;
    const day = startOfDay(d);
    if (from && day < from) return false;
    if (to && day > to) return false;
    return true;
  });
}

function rowsToCsv(rows) {
  const cols = [];
  rows.forEach((r) => Object.keys(r).forEach((k) => { if (!cols.includes(k)) cols.push(k); }));
  const cell = (val) => {
    const s = String(val ?? "");
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.map(cell).join(",")].concat(rows.map((r) => cols.map((c) => cell(r[c])).join(","))).join("\n");
}

function exportTableCsv(source, fromStr, toStr) {
  const { rows: allRows, title } = exportSourceRows(source);
  const rows = filterRowsByDateRange(allRows, fromStr, toStr);
  if (!rows || rows.length === 0) { alert("No records in that date range."); return; }
  const csv = rowsToCsv(rows);
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  const rangeLabel = fromStr || toStr ? `_${fromStr || "start"}_to_${toStr || "end"}` : "";
  a.download = `${title.replace(/[^a-z0-9]+/gi, "_")}${rangeLabel}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function printTable(source, fromStr, toStr) {
  const { rows: allRows, title } = exportSourceRows(source);
  const rows = filterRowsByDateRange(allRows, fromStr, toStr);
  if (!rows || rows.length === 0) { alert("No records in that date range."); return; }
  const cols = [];
  rows.forEach((r) => Object.keys(r).forEach((k) => { if (!cols.includes(k)) cols.push(k); }));
  const tsCol = cols.find((c) => /timestamp/i.test(c));
  const sorted = tsCol
    ? [...rows].sort((a, b) => (parseSheetTimestamp(b[tsCol]) || 0) - (parseSheetTimestamp(a[tsCol]) || 0))
    : rows;

  const win = window.open("", "_blank");
  if (!win) { alert("Please allow pop-ups for this site to print."); return; }
  const rangeLabel = fromStr || toStr ? ` (${fromStr ? fmtDate(fromStr) : "…"} – ${toStr ? fmtDate(toStr) : "…"})` : "";
  const rowsHtml = sorted.map((r) => `<tr>${cols.map((c) => `<td>${esc(r[c] ?? "")}</td>`).join("")}</tr>`).join("");
  win.document.write(`
    <html>
      <head>
        <title>${esc(title)}</title>
        <style>
          body { font-family: Arial, Helvetica, sans-serif; padding: 24px; color: #1e2733; }
          h1 { font-size: 18px; margin: 0 0 2px; }
          .meta { font-size: 12px; color: #666; margin-bottom: 18px; }
          table { border-collapse: collapse; width: 100%; }
          th, td { border: 1px solid #ccc; padding: 6px 8px; font-size: 11.5px; text-align: left; vertical-align: top; }
          th { background: #f0f1f4; }
          @media print { body { padding: 0; } }
        </style>
      </head>
      <body>
        <h1>${esc(title)}${esc(rangeLabel)} — Kyidsa Primary School</h1>
        <div class="meta">Exported ${esc(new Date().toLocaleString())} · ${sorted.length} record${sorted.length === 1 ? "" : "s"}</div>
        <table><thead><tr>${cols.map((c) => `<th>${esc(c)}</th>`).join("")}</tr></thead><tbody>${rowsHtml}</tbody></table>
      </body>
    </html>
  `);
  win.document.close();
  win.focus();
  win.print();
}

// ---------- Attendance daily summary ----------
// Google Forms writes Timestamp as "dd/mm/yyyy hh:mm:ss" (sheet locale), which plain
// `new Date()` misreads in most browsers (it expects mm/dd/yyyy). Parse it explicitly.
function parseSheetTimestamp(str) {
  if (!str) return null;
  const m = String(str).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})[\s,]+(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (m) {
    const [, d, mo, y, h, mi, s] = m;
    return new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s || 0));
  }
  const fallback = new Date(str);
  return isNaN(fallback) ? null : fallback;
}

function isSameLocalDay(a, b) {
  return !!a && !!b && a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

// Form questions are stored as "3. No. of Total Students" etc — the leading number can
// shift if the form is edited, so match by keyword rather than an exact header string.
function findColumnKey(rows, regex) {
  for (const r of rows) {
    const key = Object.keys(r).find((k) => regex.test(k));
    if (key) return key;
  }
  return null;
}

// Filters attendance rows down to today's submissions only, and sums Present/Absent/Total
// across every class that submitted today (each class submits its own row).
function getTodaysAttendance(rows, today) {
  const tsCol = findColumnKey(rows, /timestamp/i);
  const todayRows = tsCol ? rows.filter((r) => isSameLocalDay(parseSheetTimestamp(r[tsCol]), today)) : rows;

  const presentCol = findColumnKey(rows, /present/i);
  const absentCol = findColumnKey(rows, /absent/i);
  const totalCol = findColumnKey(rows, /total.*student/i);
  const sumCol = (col) => (col ? todayRows.reduce((acc, r) => acc + (Number(r[col]) || 0), 0) : null);

  return {
    todayRows,
    presentTotal: sumCol(presentCol),
    absentTotal: sumCol(absentCol),
    totalStudents: sumCol(totalCol),
  };
}

// ---------- Leave requests ----------
// Leave rows have no built-in unique ID (Form-linked sheets don't have one), so we
// build a stable one from Timestamp + Name — unique enough for a single school.
function leaveRowId(row, tsCol, nameCol) {
  const raw = `${row[tsCol] || ""}_${row[nameCol] || ""}`;
  return raw.replace(/[^a-zA-Z0-9]+/g, "_").slice(0, 80);
}

function leaveCols(rows) {
  return {
    tsCol: findColumnKey(rows, /timestamp/i),
    nameCol: findColumnKey(rows, /name/i),
    startCol: findColumnKey(rows, /start/i),
    endCol: findColumnKey(rows, /end/i),
    reasonCol: findColumnKey(rows, /reason/i),
  };
}

// Approved leaves whose date range covers today (inclusive of both start & end dates).
function getTeachersOnLeaveToday(leaveResponses, leaveStatuses, today) {
  if (!leaveResponses || leaveResponses.length === 0) return [];
  const { tsCol, nameCol, startCol, endCol } = leaveCols(leaveResponses);
  if (!nameCol || !startCol || !endCol) return [];
  const t = startOfDay(today);
  const out = [];
  leaveResponses.forEach((row) => {
    const id = leaveRowId(row, tsCol, nameCol);
    if (leaveStatuses[id] !== "approved") return;
    const start = parseSheetTimestamp(row[startCol]);
    const end = parseSheetTimestamp(row[endCol]);
    if (!start || !end) return;
    const s = startOfDay(start);
    const e = startOfDay(end);
    if (t >= s && t <= e) out.push({ name: row[nameCol], start: s, end: e });
  });
  return out;
}

// All of this teacher's leave requests, every status, for a permanent view on their
// own folder page (unlike getTeacherLeaveNotices, this doesn't disappear once "seen").
function getTeacherLeaveRequests(teacher, leaveResponses, leaveStatuses) {
  if (!teacher || !leaveResponses || leaveResponses.length === 0) return [];
  const { tsCol, nameCol, startCol, endCol, reasonCol } = leaveCols(leaveResponses);
  if (!nameCol) return [];
  const teacherName = String(teacher.name || "").trim().toLowerCase();
  return leaveResponses
    .filter((row) => String(row[nameCol] || "").trim().toLowerCase() === teacherName)
    .map((row) => {
      const id = leaveRowId(row, tsCol, nameCol);
      return {
        id,
        status: leaveStatuses[id] || "pending",
        start: startCol ? row[startCol] : "",
        end: endCol ? row[endCol] : "",
        reason: reasonCol ? row[reasonCol] : "",
        submittedAt: tsCol ? row[tsCol] : "",
      };
    })
    .sort((a, b) => (parseSheetTimestamp(b.submittedAt) || 0) - (parseSheetTimestamp(a.submittedAt) || 0));
}

// Approved/rejected leave decisions for one teacher that they haven't seen yet —
// matched by name against the Leave form's "Name" answer.
function getTeacherLeaveNotices(teacher, leaveResponses, leaveStatuses, leaveSeen) {
  if (!teacher || !leaveResponses || leaveResponses.length === 0) return [];
  const { tsCol, nameCol, startCol, endCol } = leaveCols(leaveResponses);
  if (!nameCol) return [];
  const teacherName = String(teacher.name || "").trim().toLowerCase();
  return leaveResponses
    .filter((row) => String(row[nameCol] || "").trim().toLowerCase() === teacherName)
    .map((row) => {
      const id = leaveRowId(row, tsCol, nameCol);
      return { id, status: leaveStatuses[id], start: row[startCol], end: row[endCol] };
    })
    .filter((n) => (n.status === "approved" || n.status === "rejected") && leaveSeen[n.id] !== "true");
}

// ---------- TOD report remarks (principal writes a note on a day's activity entry) ----------
// Same "no built-in unique ID" situation as leave rows — build a stable one from
// Timestamp + Name so a remark stays attached to the right row.
function todCols(rows) {
  return {
    tsCol: findColumnKey(rows, /timestamp/i),
    nameCol: findColumnKey(rows, /name/i),
  };
}

function todRowId(row, tsCol, nameCol) {
  const raw = `${row[tsCol] || ""}_${row[nameCol] || ""}`;
  return raw.replace(/[^a-zA-Z0-9]+/g, "_").slice(0, 80);
}

// All principal remarks written against this teacher's TOD reports (newest first).
function getTeacherTodRemarks(teacher, todResponses, todRemarks) {
  if (!teacher || !todResponses || todResponses.length === 0) return [];
  const { tsCol, nameCol } = todCols(todResponses);
  if (!nameCol) return [];
  const teacherName = String(teacher.name || "").trim().toLowerCase();
  return todResponses
    .filter((row) => String(row[nameCol] || "").trim().toLowerCase() === teacherName)
    .map((row) => ({ id: todRowId(row, tsCol, nameCol), date: tsCol ? row[tsCol] : "", remark: todRemarks[todRowId(row, tsCol, nameCol)] || "" }))
    .filter((r) => r.remark)
    .sort((a, b) => (parseSheetTimestamp(b.date) || 0) - (parseSheetTimestamp(a.date) || 0));
}

// Remarks the teacher hasn't seen yet — shown once in the login notice popup.
function getUnseenTodRemarks(teacher, todResponses, todRemarks, todRemarksSeen) {
  return getTeacherTodRemarks(teacher, todResponses, todRemarks).filter((r) => todRemarksSeen[r.id] !== "true");
}


async function apiGet() {
  try {
    const res = await fetch(BACKEND_URL);
    if (!res.ok) return { error: `Server returned ${res.status} ${res.statusText}` };
    return await res.json();
  } catch (err) {
    // Network failure, or the server returned something that isn't valid JSON
    // (e.g. an Apps Script authorization/error page instead of real data).
    return { error: "Could not reach the server: " + err.message };
  }
}

async function apiPost(payload) {
  try {
    // Sent as text/plain (no custom headers) to avoid CORS preflight against Apps Script
    const res = await fetch(BACKEND_URL, { method: "POST", body: JSON.stringify(payload) });
    if (!res.ok) return { success: false, error: `Server returned ${res.status} ${res.statusText}` };
    return await res.json();
  } catch (err) {
    // Same as above — this used to throw silently, which is why some actions could
    // look like "nothing happens": the failure never reached any error banner or toast.
    return { success: false, error: "Could not reach the server: " + err.message };
  }
}

function backendToState(raw) {
  const teacherFolderUrls = raw.teacherFolderUrls || {};
  const teachers = (raw.teachers || []).map((t) => ({
    id: t.ID, name: t.Name, subject: t.Subject, phone: t.Phone, photo: t.PhotoURL || null,
    folderUrl: teacherFolderUrls[t.ID] || null,
  }));

  const customFolders = (raw.customFolders || []).map((f) => ({
    id: f.ID, teacherId: f.TeacherID, folderName: f.FolderName, folderUrl: f.DriveFolderURL, createdAt: f.CreatedAt,
    parentFolderId: f.ParentFolderId || "", driveFolderId: f.DriveFolderId || "",
  }));

  const links = (raw.links || []).map((l) => ({
    id: l.ID, teacherId: l.TeacherID, title: l.Title, url: l.URL, addedBy: l.AddedBy, createdAt: l.CreatedAt,
  }));

  const documents = (raw.uploads || []).map((u) => ({
    id: u.ID, teacherId: u.TeacherID, category: u.Category, fileName: u.FileName,
    docName: u.DocName || undefined, docClass: u.Class || undefined, docSubject: u.Subject || undefined,
    dataUrl: u.DriveFileURL, uploadedAt: u.UploadedAt,
    comment: u.Comment || "", commentSeen: String(u.CommentSeen).toLowerCase() !== "false",
  }));

  const settings = raw.settings || {};
  const schedules = {
    lessonPlan: settings.schedule_lessonPlan ? JSON.parse(settings.schedule_lessonPlan) : { type: "daily", requiredCount: 2 },
    otherDocuments: settings.schedule_otherDocuments ? JSON.parse(settings.schedule_otherDocuments) : { type: "calendar", dates: [] },
  };

  const overrides = {};
  const leaveStatuses = {};
  const leaveSeen = {};
  const todRemarks = {};
  const todRemarksSeen = {};
  const teacherPins = {};
  Object.keys(settings).forEach((k) => {
    if (k.startsWith("override_") && settings[k]) {
      const rest = k.slice("override_".length);
      const idx = rest.lastIndexOf("_");
      const teacherId = rest.slice(0, idx);
      const category = rest.slice(idx + 1);
      overrides[`${teacherId}:${category}`] = settings[k];
    } else if (k.startsWith("leave_status_")) {
      leaveStatuses[k.slice("leave_status_".length)] = settings[k];
    } else if (k.startsWith("leave_seen_")) {
      leaveSeen[k.slice("leave_seen_".length)] = settings[k];
    } else if (k.startsWith("tod_remark_seen_")) {
      todRemarksSeen[k.slice("tod_remark_seen_".length)] = settings[k];
    } else if (k.startsWith("tod_remark_")) {
      todRemarks[k.slice("tod_remark_".length)] = settings[k];
    } else if (k.startsWith("teacher_pin_")) {
      teacherPins[k.slice("teacher_pin_".length)] = settings[k];
    }
  });

  const staff = (raw.staff || []).map((s) => ({ id: s.ID, name: s.Name, role: s.Role, photo: s.PhotoURL || null }));

  return {
    teachers, documents, schedules, overrides,
    adminPin: settings.adminPin || null,
    attendanceResponses: raw.attendanceResponses || [],
    todResponses: raw.todResponses || [],
    leaveResponses: raw.leaveResponses || [],
    leaveStatuses, leaveSeen,
    todRemarks, todRemarksSeen,
    timetableUrl: settings.timetableUrl || null,
    customFolders, links,
    teacherPins, staff,
    totalStudents: settings.totalStudents || "",
  };
}

// ---------- Local cache (so repeat visits render instantly while fresh data loads behind it) ----------
const LOCAL_CACHE_KEY = "kyidsaPortalCache_v1";
function readLocalCache() {
  try {
    const raw = localStorage.getItem(LOCAL_CACHE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
}
function writeLocalCache(raw) {
  try {
    localStorage.setItem(LOCAL_CACHE_KEY, JSON.stringify(raw));
  } catch (e) {
    // storage full/unavailable (e.g. private browsing) — safe to ignore, just skip caching
  }
}

// ---------- Persisted navigation (so a hard refresh lands back where you were,
// e.g. deep in the admin dashboard, instead of resetting to Home) ----------
const NAV_STATE_KEY = "kyidsaPortalNav_v1";
function saveNavState() {
  try {
    localStorage.setItem(NAV_STATE_KEY, JSON.stringify({
      view: state.view,
      adminMode: state.adminMode,
      activeTeacherId: state.activeTeacherId,
      session: state.session,
    }));
  } catch (e) {
    // ignore — worst case, next refresh just lands on Home like before
  }
}
function restoreNavState() {
  try {
    const raw = localStorage.getItem(NAV_STATE_KEY);
    if (!raw) return;
    const nav = JSON.parse(raw);
    if (nav.view) state.view = nav.view;
    if (nav.adminMode) state.adminMode = true;
    if (nav.activeTeacherId) state.activeTeacherId = nav.activeTeacherId;
    if (nav.session) state.session = nav.session;
  } catch (e) {
    // ignore — falls back to the default Home view
  }
}

// ---------- Persistence ----------
async function loadData() {
  const cached = readLocalCache();
  if (cached) {
    // Show the last-known data immediately instead of a blank loading screen,
    // then quietly refresh with the latest from the backend below.
    state.data = backendToState(cached);
    state.loaded = true;
    render();
  }
  const raw = await apiGet();
  if (raw && raw.error) {
    if (!cached) state.saveError = "Could not connect to the backend: " + raw.error;
  } else {
    state.data = backendToState(raw);
    state.saveError = "";
    writeLocalCache(raw);
  }
  state.loaded = true;
  render();
}

async function refreshData() {
  const raw = await apiGet();
  if (raw && raw.error) {
    state.saveError = "Could not refresh: " + raw.error;
  } else {
    state.data = backendToState(raw);
    state.saveError = "";
    writeLocalCache(raw);
  }
  render();
}

function showToast(msg) {
  state.toast = msg;
  render();
  setTimeout(() => {
    if (state.toast === msg) {
      state.toast = null;
      render();
    }
  }, 2200);
}

// ---------- Mutations ----------
async function addTeacher(teacher) {
  showToast("Adding teacher…");
  const res = await apiPost({
    action: "addTeacher",
    name: teacher.name,
    subject: teacher.subject,
    phone: teacher.phone,
    photoBase64: teacher.photo || undefined,
    photoMime: teacher.photo ? teacher.photo.substring(5, teacher.photo.indexOf(";")) : undefined,
  });
  if (res && res.success) {
    state.data.teachers.push({
      id: res.id, name: teacher.name, subject: teacher.subject, phone: teacher.phone,
      photo: res.photoUrl || teacher.photo || null,
    });
    state.saveError = "";
  } else {
    state.saveError = "Could not add teacher. Please try again.";
  }
  render();
  showToast(res && res.success ? "Teacher added" : "Failed to add teacher");
}

// Editing is optimistic (revert on failure) except the photo isn't shown as "saved"
// until the real Drive-hosted URL comes back, since we only have a local data: URL
// for it until then.
async function updateTeacher(id, teacher) {
  const target = state.data.teachers.find((t) => t.id === id);
  const prevSnapshot = target ? { ...target } : null;
  const pickedNewPhoto = teacher.photo && teacher.photo.startsWith("data:");
  if (target) {
    target.name = teacher.name;
    target.subject = teacher.subject;
    target.phone = teacher.phone;
    if (pickedNewPhoto) target.photo = teacher.photo;
  }
  state.saveError = "";
  render();

  const res = await apiPost({
    action: "updateTeacher",
    teacherId: id,
    name: teacher.name,
    subject: teacher.subject,
    phone: teacher.phone,
    photoBase64: pickedNewPhoto ? teacher.photo : undefined,
    photoMime: pickedNewPhoto ? teacher.photo.substring(5, teacher.photo.indexOf(";")) : undefined,
  });

  if (res && res.success) {
    if (target && res.photoUrl) target.photo = res.photoUrl;
  } else {
    if (target && prevSnapshot) Object.assign(target, prevSnapshot);
    state.saveError = "Could not update teacher: " + (res && res.error ? res.error : "please try again.");
  }
  render();
  showToast(res && res.success ? "Teacher updated" : "Failed to update teacher");
}

async function removeTeacher(id) {
  const res = await apiPost({ action: "removeTeacher", teacherId: id });
  if (res && res.success) {
    state.data.teachers = state.data.teachers.filter((t) => t.id !== id);
    state.data.documents = state.data.documents.filter((d) => d.teacherId !== id);
    state.saveError = "";
  } else {
    state.saveError = "Could not remove teacher. Please try again.";
  }
  state.activeTeacherId = null;
  state.view = "directory";
  render();
  showToast(res && res.success ? "Teacher removed" : "Failed to remove teacher");
}

async function addDocument(doc) {
  const teacher = state.data.teachers.find((t) => t.id === doc.teacherId);
  const res = await apiPost({
    action: "addDocument",
    teacherId: doc.teacherId,
    teacherName: teacher ? teacher.name : "Unknown",
    category: doc.category,
    fileName: doc.fileName,
    docName: doc.docName || "",
    class: doc.docClass || "",
    subject: doc.docSubject || "",
    mimeType: doc.mimeType,
    fileBase64: doc.dataUrl,
  });
  if (res && res.success) {
    state.data.documents.push({
      id: res.id, teacherId: doc.teacherId, category: doc.category, fileName: doc.fileName,
      docName: doc.docName, docClass: doc.docClass, docSubject: doc.docSubject,
      dataUrl: res.fileUrl, uploadedAt: doc.uploadedAt, comment: "", commentSeen: true,
    });
    state.saveError = "";
  } else {
    state.saveError = "Could not upload. Please check your connection and try again.";
  }
  render();
  showToast(res && res.success ? "Document uploaded" : "Upload failed");
}

async function removeDocument(id) {
  const res = await apiPost({ action: "removeDocument", docId: id });
  if (res && res.success) {
    state.data.documents = state.data.documents.filter((d) => d.id !== id);
    state.saveError = "";
  } else {
    state.saveError = "Could not remove document. Please try again.";
  }
  render();
  showToast(res && res.success ? "Document removed" : "Failed to remove");
}

async function updateSchedule(category, schedule) {
  const key = category === "lessonPlan" ? "schedule_lessonPlan" : "schedule_otherDocuments";
  const prev = state.data.schedules[category];
  state.data.schedules[category] = schedule;
  state.saveError = "";
  render();
  const res = await apiPost({ action: "setSetting", key, value: JSON.stringify(schedule) });
  if (!(res && res.success)) {
    state.data.schedules[category] = prev;
    state.saveError = "Could not update schedule. Please try again.";
    render();
  }
  showToast(res && res.success ? "Schedule updated" : "Failed to update");
}

async function saveLessonPlanRequiredCount(count) {
  const n = Math.max(1, Math.min(10, Number(count) || 2));
  await updateSchedule("lessonPlan", { type: "daily", requiredCount: n });
}

async function addCalendarDueDate(dateStr) {
  if (!dateStr) return;
  const current = (state.data.schedules.otherDocuments && state.data.schedules.otherDocuments.dates) || [];
  if (current.includes(dateStr)) return;
  const dates = [...current, dateStr].sort();
  await updateSchedule("otherDocuments", { type: "calendar", dates });
}

async function removeCalendarDueDate(dateStr) {
  const current = (state.data.schedules.otherDocuments && state.data.schedules.otherDocuments.dates) || [];
  const dates = current.filter((d) => d !== dateStr);
  await updateSchedule("otherDocuments", { type: "calendar", dates });
}

async function setOverride(teacherId, category, dateStr) {
  const key = `override_${teacherId}_${category}`;
  const overrideKey = `${teacherId}:${category}`;
  const prev = state.data.overrides[overrideKey];
  if (dateStr) state.data.overrides[overrideKey] = dateStr; else delete state.data.overrides[overrideKey];
  state.saveError = "";
  render();
  const res = await apiPost({ action: "setSetting", key, value: dateStr || "" });
  if (!(res && res.success)) {
    if (prev !== undefined) state.data.overrides[overrideKey] = prev; else delete state.data.overrides[overrideKey];
    state.saveError = "Could not save due date. Please try again.";
    render();
  }
  showToast(res && res.success ? (dateStr ? "Custom due date set" : "Custom due date cleared") : "Failed to save");
}

async function setLeaveStatus(id, status) {
  const key = `leave_status_${id}`;
  const prev = state.data.leaveStatuses[id];
  state.data.leaveStatuses[id] = status;
  state.saveError = "";
  render();
  const res = await apiPost({ action: "setSetting", key, value: status });
  if (!(res && res.success)) {
    if (prev === undefined) delete state.data.leaveStatuses[id]; else state.data.leaveStatuses[id] = prev;
    state.saveError = "Could not update leave status. Please try again.";
    render();
  }
  showToast(res && res.success ? `Leave ${status}` : "Failed to update leave status");
}

async function markLeaveSeen(id) {
  const key = `leave_seen_${id}`;
  const res = await apiPost({ action: "setSetting", key, value: "true" });
  if (res && res.success) state.data.leaveSeen[id] = "true";
}

async function saveTodRemark(id, text) {
  const key = `tod_remark_${id}`;
  const seenKey = `tod_remark_seen_${id}`;
  const prevRemark = state.data.todRemarks[id];
  const prevSeen = state.data.todRemarksSeen[id];
  state.data.todRemarks[id] = text;
  state.data.todRemarksSeen[id] = "false"; // a new/edited remark should surface again in the teacher's notice popup
  state.saveError = "";
  render();
  const [res, seenRes] = await Promise.all([
    apiPost({ action: "setSetting", key, value: text }),
    apiPost({ action: "setSetting", key: seenKey, value: "false" }),
  ]);
  if (!(res && res.success)) {
    state.data.todRemarks[id] = prevRemark || "";
    state.saveError = "Could not save remark. Please try again.";
    render();
  }
  if (!(seenRes && seenRes.success)) {
    state.data.todRemarksSeen[id] = prevSeen;
  }
  showToast(res && res.success ? "Remark saved" : "Failed to save remark");
}

async function markTodRemarkSeen(id) {
  const key = `tod_remark_seen_${id}`;
  const res = await apiPost({ action: "setSetting", key, value: "true" });
  if (res && res.success) state.data.todRemarksSeen[id] = "true";
}

async function setTeacherPin(teacherId, pin) {
  const key = `teacher_pin_${teacherId}`;
  const res = await apiPost({ action: "setSetting", key, value: pin });
  if (res && res.success) {
    state.data.teacherPins[teacherId] = pin;
  } else {
    state.saveError = "Could not set PIN. Please try again.";
  }
  return res && res.success;
}

async function resetTeacherPin(teacherId, teacherName) {
  if (!confirm(`Reset ${teacherName}'s PIN? They'll be asked to set a new one next time they log in.`)) return;
  const key = `teacher_pin_${teacherId}`;
  const prev = state.data.teacherPins[teacherId];
  delete state.data.teacherPins[teacherId];
  render();
  const res = await apiPost({ action: "setSetting", key, value: "" });
  if (!(res && res.success)) {
    state.data.teacherPins[teacherId] = prev;
    state.saveError = "Could not reset PIN. Please try again.";
    render();
  }
  showToast(res && res.success ? "PIN reset" : "Failed to reset PIN");
}

async function saveTotalStudents(value) {
  const prev = state.data.totalStudents;
  state.data.totalStudents = value;
  state.saveError = "";
  render();
  const res = await apiPost({ action: "setSetting", key: "totalStudents", value: String(value) });
  if (!(res && res.success)) {
    state.data.totalStudents = prev;
    state.saveError = "Could not save student count. Please try again.";
    render();
  }
  showToast(res && res.success ? "Updated" : "Failed to save");
}

async function addStaffMember(name, role, photo) {
  const res = await apiPost({
    action: "addStaff", name, role,
    photoBase64: photo && photo.startsWith("data:") ? photo : undefined,
    photoMime: photo && photo.startsWith("data:") ? photo.substring(5, photo.indexOf(";")) : undefined,
  });
  if (res && res.success) {
    state.data.staff.push({ id: res.id, name, role, photo: res.photoUrl || null });
    state.saveError = "";
  } else {
    state.saveError = "Could not add staff member: " + (res && res.error ? res.error : "please try again.");
  }
  render();
  showToast(res && res.success ? "Staff member added" : "Failed to add");
}

async function updateStaffMember(id, name, role, photo) {
  const target = state.data.staff.find((s) => s.id === id);
  const prevSnapshot = target ? { ...target } : null;
  const pickedNewPhoto = photo && photo.startsWith("data:");
  if (target) {
    target.name = name;
    target.role = role;
    if (pickedNewPhoto) target.photo = photo;
  }
  render();
  const res = await apiPost({
    action: "updateStaff", staffId: id, name, role,
    photoBase64: pickedNewPhoto ? photo : undefined,
    photoMime: pickedNewPhoto ? photo.substring(5, photo.indexOf(";")) : undefined,
  });
  if (res && res.success) {
    if (target && res.photoUrl) target.photo = res.photoUrl;
    state.saveError = "";
  } else {
    if (target && prevSnapshot) Object.assign(target, prevSnapshot);
    state.saveError = "Could not update staff member: " + (res && res.error ? res.error : "please try again.");
  }
  render();
  showToast(res && res.success ? "Staff member updated" : "Failed to update");
}

async function removeStaffMember(id) {
  const prev = state.data.staff;
  state.data.staff = state.data.staff.filter((s) => s.id !== id);
  render();
  const res = await apiPost({ action: "removeStaff", staffId: id });
  if (!(res && res.success)) {
    state.data.staff = prev;
    state.saveError = "Could not remove staff member. Please try again.";
    render();
  }
  showToast(res && res.success ? "Staff member removed" : "Failed to remove");
}

async function saveTimetableUrl(url) {
  const prev = state.data.timetableUrl;
  state.data.timetableUrl = url || null;
  state.saveError = "";
  render();
  const res = await apiPost({ action: "setSetting", key: "timetableUrl", value: url });
  if (!(res && res.success)) {
    state.data.timetableUrl = prev;
    state.saveError = "Could not save timetable link. Please try again.";
    render();
  }
  showToast(res && res.success ? "Timetable link updated" : "Failed to save");
}

// These two genuinely need the server round-trip (a real Drive folder has to be
// created), so they're not optimistic — but the button shows "Creating…" the
// instant it's clicked via state.busyFolder, so it never feels frozen.
async function createCustomFolder(teacherId, teacherName, folderName, parentFolderId) {
  state.busyFolder = true;
  render();
  const res = await apiPost({ action: "createFolder", teacherId, teacherName, folderName, parentFolderId: parentFolderId || "" });
  if (res && res.success) {
    state.data.customFolders.push({
      id: res.id, teacherId, folderName, folderUrl: res.folderUrl,
      driveFolderId: res.folderId || "", parentFolderId: parentFolderId || "",
      createdAt: new Date().toISOString(),
    });
    state.saveError = "";
  } else {
    state.saveError = "Could not create folder: " + (res && res.error ? res.error : "please try again.");
  }
  state.busyFolder = false;
  render();
  showToast(res && res.success ? "Folder created" : "Failed to create folder");
}

async function removeCustomFolder(folderId) {
  const prev = state.data.customFolders;
  state.data.customFolders = state.data.customFolders.filter((f) => f.id !== folderId);
  render();
  const res = await apiPost({ action: "removeFolderRecord", folderId });
  if (!(res && res.success)) {
    state.data.customFolders = prev;
    state.saveError = "Could not remove folder from the list. Please try again.";
    render();
  }
  showToast(res && res.success ? "Removed from list" : "Failed to remove");
}

async function addResourceLink(teacherId, title, url, addedBy) {
  state.busyLink = true;
  render();
  const res = await apiPost({ action: "addLink", teacherId, title, url, addedBy });
  if (res && res.success) {
    state.data.links.push({ id: res.id, teacherId, title: title || url, url, addedBy, createdAt: new Date().toISOString() });
    state.saveError = "";
  } else {
    state.saveError = "Could not save link: " + (res && res.error ? res.error : "please try again.");
  }
  state.busyLink = false;
  render();
  showToast(res && res.success ? "Link added" : "Failed to add link");
}

async function removeResourceLink(linkId) {
  const prev = state.data.links;
  state.data.links = state.data.links.filter((l) => l.id !== linkId);
  render();
  const res = await apiPost({ action: "removeLink", linkId });
  if (!(res && res.success)) {
    state.data.links = prev;
    state.saveError = "Could not remove link. Please try again.";
    render();
  }
  showToast(res && res.success ? "Link removed" : "Failed to remove");
}

async function setAdminPin(pin) {
  const res = await apiPost({ action: "setSetting", key: "adminPin", value: pin });
  if (res && res.success) {
    state.data.adminPin = pin;
    state.saveError = "";
  } else {
    state.saveError = "Could not update PIN. Please try again.";
  }
  render();
  showToast(res && res.success ? "Principal PIN updated" : "Failed to update PIN");
}

async function saveComment(docId, commentText) {
  const doc = state.data.documents.find((d) => d.id === docId);
  const prevComment = doc ? doc.comment : undefined;
  const prevSeen = doc ? doc.commentSeen : undefined;
  if (doc) { doc.comment = commentText; doc.commentSeen = false; }
  state.saveError = "";
  render(); // show it immediately — don't wait on the network round-trip
  const res = await apiPost({ action: "setComment", docId, comment: commentText });
  if (!(res && res.success)) {
    if (doc) { doc.comment = prevComment; doc.commentSeen = prevSeen; }
    state.saveError = "Could not save feedback: " + (res && res.error ? res.error : "unknown error, please try again.");
    render();
  }
  showToast(res && res.success ? "Feedback saved" : "Failed to save feedback");
}

async function markCommentSeen(docId) {
  const res = await apiPost({ action: "markCommentSeen", docId });
  if (res && res.success) {
    const doc = state.data.documents.find((d) => d.id === docId);
    if (doc) doc.commentSeen = true;
  }
}

// ---------- Navigation ----------
function openFolder(teacherId) {
  state.activeTeacherId = teacherId;
  state.view = "folder";
  render();
}

function handleTeacherLogin(teacherId) {
  state.session = { teacherId };
  state.modal = null;
  const teacher = state.data.teachers.find((t) => t.id === teacherId);
  const lpStatus = getStatus(state.data, teacherId, "lessonPlan", state.today);
  const feedbackDocs = state.data.documents.filter((d) => d.teacherId === teacherId && d.comment && !d.commentSeen);
  const leaveNotices = getTeacherLeaveNotices(teacher, state.data.leaveResponses, state.data.leaveStatuses, state.data.leaveSeen);
  const todRemarkNotices = getUnseenTodRemarks(teacher, state.data.todResponses, state.data.todRemarks, state.data.todRemarksSeen);
  openFolder(teacherId);
  const overdueItems = lpStatus.overdue ? [{ cat: "lessonPlan", status: lpStatus }] : [];
  if (overdueItems.length > 0 || feedbackDocs.length > 0 || leaveNotices.length > 0 || todRemarkNotices.length > 0) {
    state.modal = { type: "notice", overdueItems, feedbackDocs, leaveNotices, todRemarkNotices };
  }
  render();
}

function logout() {
  state.session = null;
  state.activeTeacherId = null;
  state.view = "directory";
  render();
}

function requestAdminMode() {
  if (state.adminMode) {
    state.adminMode = false;
    state.view = "directory";
    render();
  } else {
    state.modal = { type: "adminPin" };
    render();
  }
}

// ---------- Rendering ----------
function render() {
  const app = document.getElementById("app");
  if (!state.loaded) {
    app.innerHTML = `<div style="min-height:100vh;display:flex;align-items:center;justify-content:center;font-family:Georgia,serif;color:#5A4632;">Loading school records…</div>`;
    return;
  }

  const activeTeacher = state.data.teachers.find((t) => t.id === state.activeTeacherId) || null;

  // Sanity-check a restored (persisted) view against current data/permissions —
  // e.g. don't strand someone on "dashboard" if adminMode somehow isn't on, or
  // on "folder" for a teacher that no longer exists.
  if (state.view === "dashboard" && !state.adminMode) state.view = "home";
  if (state.view === "folder" && !activeTeacher) { state.view = "home"; state.activeTeacherId = null; }

  saveNavState();

  document.body.classList.toggle("home-view", state.view === "home");

  // The whole #app subtree gets replaced below, which would normally yank focus
  // out of whatever input the person is actively typing in (e.g. the directory
  // search box) on every keystroke. Remember it, and restore it after.
  const activeEl = document.activeElement;
  const hadFocus = activeEl && activeEl.id && app.contains(activeEl);
  const focusedId = hadFocus ? activeEl.id : null;
  const selStart = hadFocus && "selectionStart" in activeEl ? activeEl.selectionStart : null;
  const selEnd = hadFocus && "selectionEnd" in activeEl ? activeEl.selectionEnd : null;

  app.innerHTML = `
    <header class="top">
      <div class="header-inner">
        <div class="header-brand">
          <img class="header-logo" src="${esc(LOGO_URL)}" alt="Kyidsa Primary School logo" onerror="this.style.display='none'" />
          <div>
            <div class="school-name serif">Kyidsa Primary School</div>
            <div class="school-sub">${state.session ? `Signed in as ${esc(activeTeacher?.name || "")}` : "Teacher Records &amp; Directory"}</div>
          </div>
        </div>
        <div style="display:flex; gap:8px; flex-wrap:wrap; align-items:center;">
          ${state.session
            ? `<button class="btn btn-ghost" data-action="logout">↩ Log out</button>`
            : `
              <button class="btn btn-ghost" data-action="set-view" data-view="home">🏠 Home</button>
              <button class="btn btn-ghost" data-action="open-teacher-login">🔓 I'm a Teacher</button>
              <button class="btn ${state.adminMode ? "btn-accent" : "btn-ghost"}" data-action="toggle-admin">🛡 ${state.adminMode ? "Admin Mode: On" : "Admin Mode"}</button>
            `}
          <button class="btn btn-ghost" data-action="toggle-audio" title="${state.audioMuted ? "Turn sound on" : "Turn sound off"}">${state.audioMuted ? "🔇" : "🔊"}</button>
        </div>
      </div>
    </header>
    <main>
      ${state.saveError ? `<div class="error-banner">${esc(state.saveError)}</div>` : ""}
      ${state.adminMode && !state.session && state.view !== "folder" ? renderTabs() : ""}
      ${state.view === "home" ? renderHome() : ""}
      ${state.view === "directory" ? renderDirectory() : ""}
      ${state.view === "dashboard" && state.adminMode ? renderDashboard() : ""}
      ${state.view === "folder" && activeTeacher ? renderFolder(activeTeacher) : ""}
    </main>
    ${state.modal ? renderModal() : ""}
    ${state.toast ? `<div class="toast">${esc(state.toast)}</div>` : ""}
  `;

  if (focusedId) {
    const el = document.getElementById(focusedId);
    if (el) {
      el.focus();
      if (selStart !== null && selEnd !== null && "setSelectionRange" in el) {
        try { el.setSelectionRange(selStart, selEnd); } catch (e) { /* not applicable to this input type */ }
      }
    }
  }
}

function renderTabs() {
  return `
    <div class="tabs">
      <button class="btn btn-tab ${state.view === "home" ? "active" : ""}" data-action="set-view" data-view="home">🏠 Home</button>
      <button class="btn btn-tab ${state.view === "directory" ? "active" : ""}" data-action="set-view" data-view="directory">Directory</button>
      <button class="btn btn-tab ${state.view === "dashboard" ? "active" : ""}" data-action="set-view" data-view="dashboard">📊 Dashboard</button>
    </div>
  `;
}

function renderDirectory() {
  const allTeachers = state.data.teachers;
  const query = (state.directorySearch || "").trim().toLowerCase();
  const teachers = query
    ? allTeachers.filter((t) => `${t.name} ${t.subject || ""}`.toLowerCase().includes(query))
    : allTeachers;
  return `
    <div class="section-head">
      <h2 class="serif" style="font-size:20px; margin:0; color:#4A3B22;">Teachers</h2>
      ${state.adminMode ? `<button class="btn btn-dark" data-action="open-add-teacher">➕ Add Teacher</button>` : ""}
    </div>
    ${allTeachers.length > 0 ? `
      <div class="directory-search">
        <input type="text" id="directory-search-input" placeholder="🔍 Search by name or subject…" value="${esc(state.directorySearch || "")}" />
      </div>
    ` : ""}
    ${allTeachers.length === 0
      ? renderEmptyState()
      : teachers.length === 0
        ? `<div class="doc-empty" style="text-align:center; padding:30px;">No teachers match "${esc(state.directorySearch)}".</div>`
        : `<div class="grid">${teachers.map(renderTeacherCard).join("")}</div>`}
  `;
}

function renderEmptyState() {
  return `
    <div class="empty-state">
      <div class="empty-title serif">No teachers added yet</div>
      <div class="empty-sub">${state.adminMode ? "Add your first teacher to start building the directory." : "Turn on Admin Mode to add teachers."}</div>
      ${state.adminMode ? `<button class="btn btn-dark" data-action="open-add-teacher">➕ Add Teacher</button>` : ""}
    </div>
  `;
}

function renderOutOfStationBanner() {
  const list = getTeachersOnLeaveToday(state.data.leaveResponses, state.data.leaveStatuses, state.today);
  if (list.length === 0) return "";
  return `
    <div class="out-of-station-banner">
      <div class="oos-title">🧳 Out of Station Today</div>
      ${list.map((p) => `
        <div class="oos-row"><strong>${esc(p.name)}</strong> <span class="oos-dates">(${fmtDate(p.start)} &ndash; ${fmtDate(p.end)})</span></div>
      `).join("")}
    </div>
  `;
}

function renderTimetableSection() {
  const url = state.data.timetableUrl;
  const isPrincipal = state.adminMode && !state.session;
  return `
    <div class="doc-section timetable-section" style="margin-top:22px;">
      <div class="doc-section-head"><span>📅 Current Timetable</span></div>
      ${url
        ? `<a class="doc-row link-row" href="${esc(url)}" target="_blank" rel="noopener">
             <span style="font-size:16px;">📅</span>
             <span style="flex:1;">View the latest published timetable</span>
             <span style="color:#9aa2b1;">↗</span>
           </a>`
        : `<div class="doc-empty">${isPrincipal ? "No timetable published yet — paste a link below once one's generated." : "No timetable has been published yet."}</div>`}
      ${isPrincipal ? `
        <div class="timetable-editor">
          <input type="text" id="timetable-url-input" placeholder="Paste the generated timetable link (Drive/image/PDF URL)" value="${esc(url || "")}" />
          <button class="btn btn-dark" data-action="save-timetable-url">Save</button>
        </div>
      ` : ""}
    </div>
  `;
}

function renderHome() {
  const isPrincipal = state.adminMode && !state.session;
  return `
    <div class="hero-panel">
      <img class="hero-logo" src="${esc(LOGO_URL)}" alt="Kyidsa Primary School logo" onerror="this.style.display='none'" />
      <h2 class="serif" style="font-size:24px; margin:0 0 6px;">Kyidsa Primary School Portal</h2>
      <div style="font-size:13.5px; color:#dfe4f0; margin-bottom:20px;">Everything the school needs, in one place.</div>
      <button class="btn btn-ghost" data-action="set-view" data-view="directory">👩‍🏫 Go to Teacher Directory</button>
    </div>

    ${renderOutOfStationBanner()}

    ${renderSchoolStatsSection(isPrincipal)}
    ${renderStaffProfileSection(isPrincipal)}

    <div class="home-actions">
      <button class="action-card" data-action="open-teacher-login">
        <span class="action-icon">🔓</span>
        <span class="action-label">I'm a Teacher</span>
        <span class="action-sub">Log in for Attendance, TOD Report &amp; Leave</span>
      </button>
      <button class="action-card" data-action="open-external" data-url="${esc(TIMETABLE_GENERATOR_URL)}" data-title="Timetable Generator">
        <span class="action-icon">🗓️</span>
        <span class="action-label">Timetable Generator</span>
        <span class="action-sub">Opens here in the app</span>
      </button>
      <button class="action-card" data-action="open-external" data-url="${esc(EMIS_URL)}" data-title="EMIS">
        <span class="action-icon">🏫</span>
        <span class="action-label">EMIS</span>
        <span class="action-sub">Opens here in the app</span>
      </button>
    </div>

    ${renderTimetableSection()}

    <div class="doc-section" style="margin-top:22px;">
      <div class="doc-section-head"><span>Important Links</span></div>
      ${PORTFOLIO_LINKS.map((link) => `
        <a class="doc-row link-row" href="${esc(link.url)}" target="_blank" rel="noopener">
          <span style="font-size:16px;">${link.icon}</span>
          <span style="flex:1;">${esc(link.label)}</span>
          <span style="color:#9aa2b1;">↗</span>
        </a>
      `).join("")}
    </div>
  `;
}

// Public-safe: totals only. Teaching Staff count comes straight from the Teacher
// Directory (always accurate, nothing to keep in sync manually); Non-Teaching
// Staff count comes from the roster below. Only Total Students needs manual entry.
function renderSchoolStatsSection(isPrincipal) {
  return `
    <div class="doc-section">
      <div class="doc-section-head">
        <span style="font-weight:700; font-size:15px;">🏫 School at a Glance</span>
        ${isPrincipal ? `<button class="btn btn-tab btn-sm" style="margin-left:auto;" data-action="open-edit-school-data">✏️ Edit</button>` : ""}
      </div>
      <div class="school-stats-grid">
        <div class="stat-box"><div class="stat-value">${esc(state.data.totalStudents || "—")}</div><div class="stat-label">Students</div></div>
        <div class="stat-box"><div class="stat-value">${state.data.teachers.length}</div><div class="stat-label">Teaching Staff</div></div>
        <div class="stat-box"><div class="stat-value">${state.data.staff.length}</div><div class="stat-label">Non-Teaching Staff</div></div>
      </div>
    </div>
  `;
}

// Public-safe cards only (name/role/photo) — deliberately no phone numbers, no
// links into anyone's private folder, since this is visible to every visitor.
function renderStaffProfileSection(isPrincipal) {
  const teachingCards = state.data.teachers.map((t) => `
    <div class="staff-card">
      <div class="ring"><div class="avatar" style="width:56px; height:56px;">${t.photo ? `<img src="${driveThumb(t.photo, 140)}" alt="${esc(t.name)}" loading="lazy" />` : `<span class="avatar-letter">${esc((t.name || "?")[0])}</span>`}</div></div>
      <div class="staff-card-name">${esc(t.name)}</div>
      <div class="staff-card-role">${esc(t.subject || "Teaching Staff")}</div>
    </div>
  `).join("");

  const nonTeachingCards = state.data.staff.map((s) => `
    <div class="staff-card">
      <div class="ring"><div class="avatar" style="width:56px; height:56px;">${s.photo ? `<img src="${driveThumb(s.photo, 140)}" alt="${esc(s.name)}" loading="lazy" />` : `<span class="avatar-letter">${esc((s.name || "?")[0])}</span>`}</div></div>
      <div class="staff-card-name">${esc(s.name)}</div>
      <div class="staff-card-role">${esc(s.role || "Staff")}</div>
      ${isPrincipal ? `
        <div style="display:flex; gap:4px; margin-top:6px;">
          <button class="btn btn-tab btn-sm" data-action="open-edit-staff" data-id="${s.id}">✏️ Edit</button>
          <button class="btn btn-danger btn-sm" data-action="remove-staff" data-id="${s.id}">🗑</button>
        </div>
      ` : ""}
    </div>
  `).join("");

  return `
    <div class="doc-section">
      <div class="doc-section-head">
        <span style="font-weight:700; font-size:15px;">👥 Staff Profile</span>
        ${isPrincipal ? `<button class="btn btn-tab btn-sm" style="margin-left:auto;" data-action="open-add-staff">➕ Add Staff</button>` : ""}
      </div>
      ${(state.data.teachers.length === 0 && state.data.staff.length === 0)
        ? `<div class="doc-empty">No staff added yet.</div>`
        : `<div class="staff-grid">${teachingCards}${nonTeachingCards}</div>`}
    </div>
  `;
}

function renderTeacherCard(t) {
  const docCount = state.data.documents.filter((d) => d.teacherId === t.id).length;
  const isPrincipal = state.adminMode && !state.session;
  return `
    <div class="card">
      <div class="ring"><div class="avatar">${t.photo ? `<img src="${driveThumb(t.photo, 160)}" alt="${esc(t.name)}" loading="lazy" />` : `<span class="avatar-letter">${esc((t.name || "?")[0])}</span>`}</div></div>
      <div style="text-align:center;">
        <div class="card-name">${esc(t.name)}</div>
        <div class="card-subject">${esc(t.subject || "")}</div>
      </div>
      <div class="card-doccount">${docCount} document${docCount === 1 ? "" : "s"}</div>
      <div class="card-actions">
        ${t.phone ? `<a href="tel:${esc(t.phone)}" class="btn btn-accent">📞 Call</a>` : ""}
        <button class="btn btn-dark" data-action="open-folder" data-id="${t.id}">📁 Folder</button>
        ${isPrincipal ? `<button class="btn btn-tab btn-sm" data-action="open-edit-teacher" data-id="${t.id}">✏️ Edit</button>` : ""}
      </div>
    </div>
  `;
}

function lessonPlanPillHtml(status) {
  if (status.overdue) return `<span class="pill pill-overdue">⚠ ${status.count}/${status.required} submitted today</span>`;
  return `<span class="pill pill-ok">✅ ${status.count}/${status.required} submitted today</span>`;
}

function otherDocsPillHtml(status) {
  if (!status.dueDate) return `<span class="pill pill-none">No schedule</span>`;
  if (status.overdue) return `<span class="pill pill-overdue">⚠ Overdue since ${fmtDate(status.dueDate)}</span>`;
  return `<span class="pill pill-ok">✅ On track</span>`;
}

function renderResponseTable(title, icon, rows, emptyMessage, exportAction) {
  if (!rows || rows.length === 0) {
    return `
      <div class="doc-section" style="margin-top:22px;">
        <div class="doc-section-head"><span>${icon} ${esc(title)}</span></div>
        <div class="doc-empty">${esc(emptyMessage || "No responses yet. Once the linked Google Form receives submissions, they'll show up here.")}</div>
      </div>
    `;
  }

  // Union of columns across all response rows (Form questions can vary slightly row to row).
  // Timestamp — if present — is always shown first, newest response on top.
  const colSet = [];
  rows.forEach((r) => Object.keys(r).forEach((k) => { if (!colSet.includes(k)) colSet.push(k); }));
  const tsCol = colSet.find((c) => /timestamp/i.test(c));
  const cols = tsCol ? [tsCol, ...colSet.filter((c) => c !== tsCol)] : colSet;
  const sorted = tsCol
    ? [...rows].sort((a, b) => (parseSheetTimestamp(b[tsCol]) || 0) - (parseSheetTimestamp(a[tsCol]) || 0))
    : [...rows].reverse();
  const shown = sorted.slice(0, 100);

  return `
    <div class="doc-section" style="margin-top:22px;">
      <div class="doc-section-head">
        <span>${icon} ${esc(title)}</span>
        <span class="count">(${rows.length}${rows.length > 100 ? " — showing latest 100" : ""})</span>
        ${exportAction ? `
          <div style="display:flex; gap:6px; margin-left:auto;">
            <button class="btn btn-tab btn-sm" data-action="export-csv" data-source="${exportAction}">⬇️ CSV</button>
            <button class="btn btn-tab btn-sm" data-action="print-table" data-source="${exportAction}">🖨️ Print</button>
          </div>
        ` : ""}
      </div>
      <div class="dash-table-wrap" style="overflow-x:auto;">
        <table>
          <thead><tr>${cols.map((c) => `<th class="${tableColumnClass(c)}">${esc(c)}</th>`).join("")}</tr></thead>
          <tbody>
            ${shown.map((r) => `<tr>${cols.map((c) => `<td class="${tableColumnClass(c)}">${esc(r[c] ?? "")}</td>`).join("")}</tr>`).join("")}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

function renderAttendanceSummary(summary) {
  const has = summary.presentTotal !== null || summary.absentTotal !== null;
  if (!has) return "";
  return `
    <div class="attendance-summary">
      <div class="summary-chip summary-present">
        <span class="summary-value">${summary.presentTotal ?? "—"}</span>
        <span class="summary-label">Present Today</span>
      </div>
      <div class="summary-chip summary-absent">
        <span class="summary-value">${summary.absentTotal ?? "—"}</span>
        <span class="summary-label">Absent Today</span>
      </div>
      ${summary.totalStudents !== null ? `
      <div class="summary-chip summary-total">
        <span class="summary-value">${summary.totalStudents}</span>
        <span class="summary-label">Total Students</span>
      </div>` : ""}
    </div>
  `;
}

function leaveStatusPillHtml(status) {
  if (status === "approved") return `<span class="pill pill-ok">✅ Approved</span>`;
  if (status === "rejected") return `<span class="pill pill-overdue">✖ Rejected</span>`;
  return `<span class="pill pill-none">⏳ Pending</span>`;
}

function renderLeaveTable(allRows, leaveStatuses) {
  const { tsCol: rawTsCol } = leaveCols(allRows || []);
  const rows = filterToLastNDays(allRows || [], rawTsCol, state.today, 5);

  if (!allRows || allRows.length === 0) {
    return `
      <div class="doc-section" style="margin-top:22px;">
        <div class="doc-section-head"><span>🧳 Leave Requests</span></div>
        <div class="doc-empty">No leave requests yet. Once the linked Google Form receives submissions, they'll show up here.</div>
      </div>
    `;
  }
  if (rows.length === 0) {
    return `
      <div class="doc-section" style="margin-top:22px;">
        <div class="doc-section-head"><span>🧳 Leave Requests</span></div>
        <div class="doc-empty">No leave requests in the last 5 days.</div>
      </div>
    `;
  }

  const { tsCol, nameCol, startCol, endCol, reasonCol } = leaveCols(rows);
  const sorted = tsCol
    ? [...rows].sort((a, b) => (parseSheetTimestamp(b[tsCol]) || 0) - (parseSheetTimestamp(a[tsCol]) || 0))
    : [...rows].reverse();

  return `
    <div class="doc-section" style="margin-top:22px;">
      <div class="doc-section-head">
        <span>🧳 Leave Requests</span>
        <span class="count">(${rows.length} in the last 5 days)</span>
      </div>
      <div class="dash-table-wrap" style="overflow-x:auto;">
        <table>
          <thead><tr>
            <th class="col-compact">Submitted</th>
            <th>Teacher</th>
            <th>Leave Dates</th>
            <th>Reason</th>
            <th>Status</th>
            <th></th>
          </tr></thead>
          <tbody>
            ${sorted.map((row) => {
              const id = leaveRowId(row, tsCol, nameCol);
              const status = leaveStatuses[id] || "pending";
              return `
                <tr>
                  <td class="col-compact">${esc(tsCol ? row[tsCol] : "")}</td>
                  <td style="font-weight:600;">${esc(nameCol ? row[nameCol] : "")}</td>
                  <td>${startCol && endCol ? `${fmtDate(row[startCol])} &ndash; ${fmtDate(row[endCol])}` : "—"}</td>
                  <td>${esc(reasonCol ? row[reasonCol] : "")}</td>
                  <td>${leaveStatusPillHtml(status)}</td>
                  <td style="white-space:nowrap;">
                    <button class="btn" style="background:#dcefe1; color:#235c3b; padding:4px 8px; font-size:12px;" data-action="approve-leave" data-id="${id}">✔ Approve</button>
                    <button class="btn" style="background:#f4dfe1; color:#7c1d2e; padding:4px 8px; font-size:12px;" data-action="reject-leave" data-id="${id}">✖ Reject</button>
                  </td>
                </tr>
              `;
            }).join("")}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

function renderTodReportsTable(rows, todRemarks) {
  if (!rows || rows.length === 0) {
    return `
      <div class="doc-section" style="margin-top:22px;">
        <div class="doc-section-head"><span>📝 Day's Activity (TOD Reports)</span></div>
        <div class="doc-empty">No responses yet. Once the linked Google Form receives submissions, they'll show up here.</div>
      </div>
    `;
  }

  const colSet = [];
  rows.forEach((r) => Object.keys(r).forEach((k) => { if (!colSet.includes(k)) colSet.push(k); }));
  const { tsCol, nameCol } = todCols(rows);
  const cols = tsCol ? [tsCol, ...colSet.filter((c) => c !== tsCol)] : colSet;
  const sorted = tsCol
    ? [...rows].sort((a, b) => (parseSheetTimestamp(b[tsCol]) || 0) - (parseSheetTimestamp(a[tsCol]) || 0))
    : [...rows].reverse();
  const shown = sorted.slice(0, 100);

  return `
    <div class="doc-section" style="margin-top:22px;">
      <div class="doc-section-head">
        <span>📝 Day's Activity (TOD Reports)</span>
        <span class="count">(${rows.length}${rows.length > 100 ? " — showing latest 100" : ""})</span>
        <div style="display:flex; gap:6px; margin-left:auto;">
          <button class="btn btn-tab btn-sm" data-action="export-csv" data-source="tod">⬇️ CSV</button>
          <button class="btn btn-tab btn-sm" data-action="print-table" data-source="tod">🖨️ Print</button>
        </div>
      </div>
      <div class="dash-table-wrap" style="overflow-x:auto;">
        <table>
          <thead><tr>
            ${cols.map((c) => `<th class="${tableColumnClass(c)}" title="${esc(c)}">${esc(c)}</th>`).join("")}
            <th>Principal's Remark</th>
          </tr></thead>
          <tbody>
            ${shown.map((r) => {
              const id = todRowId(r, tsCol, nameCol);
              return `
                <tr>
                  ${cols.map((c) => `<td class="${tableColumnClass(c)}">${esc(r[c] ?? "")}</td>`).join("")}
                  <td style="white-space:normal; min-width:220px;">${todRemarkEditorHtml(id, todRemarks[id] || "")}</td>
                </tr>
              `;
            }).join("")}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

function todRemarkEditorHtml(id, currentRemark) {
  return `
    <div class="comment-wrap" data-tod="${id}">
      ${currentRemark ? `<div class="comment-display" style="margin-top:0;">💬 ${esc(currentRemark)}</div>` : ""}
      <button class="override-btn" data-action="toggle-tod-remark" data-id="${id}">
        📝 ${currentRemark ? "Edit remark" : "Add remark"}
      </button>
      <div class="comment-edit" style="display:none;">
        <textarea data-role="tod-remark-text" rows="2" placeholder="Write a remark on this day's activity…">${esc(currentRemark || "")}</textarea>
        <div style="display:flex; gap:6px; margin-top:6px;">
          <button class="btn btn-dark" data-action="save-tod-remark" data-id="${id}">Save</button>
          <button class="modal-close" data-action="toggle-tod-remark" data-id="${id}">✕</button>
        </div>
      </div>
    </div>
  `;
}


function renderDashboard() {
  const data = state.data;
  const attendanceToday = getTodaysAttendance(data.attendanceResponses, state.today);
  const rows = data.teachers.map((t) => {
    const lp = getStatus(data, t.id, "lessonPlan", state.today);
    const od = getStatus(data, t.id, "otherDocuments", state.today);
    return `
      <tr>
        <td style="font-weight:600;">${esc(t.name)}</td>
        <td>${lessonPlanPillHtml(lp)}</td>
        <td>${otherDocsPillHtml(od)}${overrideEditorHtml(t.id, "otherDocuments", data.overrides[`${t.id}:otherDocuments`])}</td>
        <td><button class="btn" style="background:transparent; color:#2C4A3E; padding:4px 6px;" data-action="open-folder" data-id="${t.id}">📁</button></td>
      </tr>
    `;
  }).join("");

  return `
    <div class="dash-head">
      <div>
        <h2 class="serif" style="font-size:20px; margin:0 0 4px; color:#4A3B22;">Principal Dashboard</h2>
        <div class="dash-sub">See who's up to date and who's overdue on submissions.</div>
      </div>
      <button class="btn" style="background:#E4DEC9; color:#4A3B22;" data-action="open-change-pin">Change Principal PIN</button>
    </div>

    <div class="schedule-grid">
      ${lessonPlanScheduleEditorHtml(state.data.schedules.lessonPlan)}
      ${otherDocumentsCalendarEditorHtml(state.data.schedules.otherDocuments)}
    </div>

    <div class="dash-table-wrap">
      <table>
        <thead><tr><th>Teacher</th><th>Lesson Plan</th><th>Other Documents</th><th></th></tr></thead>
        <tbody>
          ${data.teachers.length === 0 ? `<tr><td colspan="4" style="color:#9A8F72; text-align:center; padding:20px;">No teachers yet.</td></tr>` : rows}
        </tbody>
      </table>
    </div>

    ${renderAttendanceSummary(attendanceToday)}
    ${renderResponseTable("Attendance — Today", "📋", attendanceToday.todayRows, "No attendance submitted yet today.", "attendance")}
    ${renderTodReportsTable(data.todResponses, data.todRemarks)}
    ${renderLeaveTable(data.leaveResponses, data.leaveStatuses)}
  `;
}

function overrideEditorHtml(teacherId, category, current) {
  const dateVal = current ? current.slice(0, 10) : "";
  return `
    <div class="override-wrap" data-teacher="${teacherId}" data-category="${category}">
      <button class="override-btn" data-action="toggle-override" data-teacher="${teacherId}" data-category="${category}">
        🕐 ${current ? `Custom: ${fmtDate(current)}` : "Set custom due date"}
      </button>
      <div class="override-edit" style="display:none;">
        <input type="date" value="${dateVal}" data-role="override-date" />
        <button class="btn btn-dark" data-action="save-override" data-teacher="${teacherId}" data-category="${category}">Save</button>
        ${current ? `<button class="btn btn-danger" data-action="clear-override" data-teacher="${teacherId}" data-category="${category}">Clear</button>` : ""}
        <button class="modal-close" data-action="toggle-override" data-teacher="${teacherId}" data-category="${category}">✕</button>
      </div>
    </div>
  `;
}

function lessonPlanScheduleEditorHtml(schedule) {
  const required = (schedule && schedule.requiredCount) || 2;
  return `
    <div class="schedule-box">
      <div class="title">Lesson Plan requirement</div>
      <div class="schedule-row">
        <div class="schedule-field">
          <label>Required per day</label>
          <input type="number" min="1" max="10" id="lp-required-count" value="${required}" />
        </div>
        <button class="btn btn-dark" data-action="save-lessonplan-schedule">Save</button>
      </div>
      <div style="font-size:12px; color:#6B5E45; margin-top:8px;">
        Every teacher must submit ${required} lesson plan${required === 1 ? "" : "s"} each day. A reminder pops up for them if they log in without having done so.
      </div>
    </div>
  `;
}

function otherDocumentsCalendarEditorHtml(schedule) {
  const dates = ((schedule && schedule.dates) || []).slice().sort();
  return `
    <div class="schedule-box">
      <div class="title">Other Documents — due dates</div>
      <div class="schedule-row">
        <div class="schedule-field">
          <label>Add a due date</label>
          <input type="date" id="od-new-date" />
        </div>
        <button class="btn btn-dark" data-action="add-calendar-date">➕ Add</button>
      </div>
      <div style="display:flex; flex-wrap:wrap; gap:6px; margin-top:10px;">
        ${dates.length === 0
          ? `<span style="font-size:12px; color:#9A8F72;">No due dates set yet.</span>`
          : dates.map((d) => `
              <span class="pill" style="background:#E4DEC9; color:#4A3B22;">
                ${fmtDate(d)}
                <button data-action="remove-calendar-date" data-date="${d}" style="background:none; border:none; color:#7A2E2E; cursor:pointer; font-size:12px; padding:0 0 0 4px;">✕</button>
              </span>
            `).join("")}
      </div>
    </div>
  `;
}

function renderFolder(teacher) {
  const isPrincipal = state.adminMode && !state.session;
  const canUpload = !!state.session && state.session.teacherId === teacher.id;
  const showBack = !state.session;

  // Anyone who isn't logged in as this teacher, and isn't the Principal, gets a
  // locked view — name/photo/subject only (same as the public Directory card),
  // no documents, remarks, leave history, or Drive access.
  if (!isPrincipal && !canUpload) {
    return `
      ${showBack ? `<button class="btn btn-plain" data-action="back-to-directory">⬅ Back to directory</button>` : ""}
      <div class="folder-header">
        <div class="ring"><div class="avatar" style="width:64px;height:64px;">${teacher.photo ? `<img src="${driveThumb(teacher.photo, 160)}" alt="${esc(teacher.name)}" loading="lazy" />` : `<span class="avatar-letter">${esc((teacher.name || "?")[0])}</span>`}</div></div>
        <div style="flex:1; min-width:160px;">
          <div class="folder-name">${esc(teacher.name)}</div>
          <div class="folder-subject">${esc(teacher.subject || "")}</div>
        </div>
      </div>
      <div class="empty-state" style="margin-top:16px;">
        <div class="empty-title">🔒 This folder is private</div>
        <div class="empty-sub">Log in as ${esc(teacher.name)}, or as Admin, to view these documents.</div>
        <button class="btn btn-dark" data-action="open-teacher-login">🔓 I'm a Teacher</button>
      </div>
    `;
  }

  const documents = state.data.documents.filter((d) => d.teacherId === teacher.id);

  const byNewest = (a, b) => (new Date(a.uploadedAt) < new Date(b.uploadedAt) ? 1 : -1);
  const lessonPlans = documents.filter((d) => d.category === "lessonPlan").sort(byNewest);
  const otherDocs = documents.filter((d) => d.category === "otherDocuments").sort(byNewest);

  const lpStatus = getStatus(state.data, teacher.id, "lessonPlan", state.today);
  const odStatus = getStatus(state.data, teacher.id, "otherDocuments", state.today);

  return `
    ${showBack ? `<button class="btn btn-plain" data-action="back-to-directory">⬅ Back to directory</button>` : ""}

    <div class="folder-header">
      <div class="ring"><div class="avatar" style="width:64px;height:64px;">${teacher.photo ? `<img src="${driveThumb(teacher.photo, 160)}" alt="${esc(teacher.name)}" loading="lazy" />` : `<span class="avatar-letter">${esc((teacher.name || "?")[0])}</span>`}</div></div>
      <div style="flex:1; min-width:160px;">
        <div class="folder-name">${esc(teacher.name)}</div>
        <div class="folder-subject">${esc(teacher.subject || "")}</div>
      </div>
      ${teacher.phone ? `<a href="tel:${esc(teacher.phone)}" class="btn btn-accent">📞 Call ${esc(teacher.phone)}</a>` : ""}
      ${(isPrincipal || canUpload) ? `<button class="btn btn-tab btn-sm" data-action="open-edit-teacher" data-id="${teacher.id}">✏️ Edit Details</button>` : ""}
      ${isPrincipal ? `<button class="btn btn-tab btn-sm" data-action="reset-teacher-pin" data-id="${teacher.id}">🔑 Reset PIN</button>` : ""}
      ${isPrincipal ? `<button class="btn btn-danger" data-action="remove-teacher" data-id="${teacher.id}">🗑 Remove</button>` : ""}
    </div>

    <div class="status-row">
      <div><span class="label">${CATEGORY_LABEL.lessonPlan}:</span>${lessonPlanPillHtml(lpStatus)}</div>
      <div><span class="label">${CATEGORY_LABEL.otherDocuments}:</span>${otherDocsPillHtml(odStatus)}</div>
    </div>

    ${canUpload ? renderTeacherServicesSection() : ""}

    ${canUpload ? renderUploadBox() : ""}

    ${renderTeacherRemarksSection(teacher)}
    ${renderTeacherLeaveSection(teacher)}
    ${renderTeacherDriveSection(teacher, isPrincipal, canUpload)}
    ${renderTeacherLinksSection(teacher, isPrincipal, canUpload)}

    ${docSectionHtml("Lesson Plans", lessonPlans, isPrincipal || canUpload, false, isPrincipal)}
    ${docSectionHtml("Other Documents", otherDocs, isPrincipal || canUpload, true, isPrincipal)}
  `;
}

function renderTeacherRemarksSection(teacher) {
  const remarks = getTeacherTodRemarks(teacher, state.data.todResponses, state.data.todRemarks);
  return `
    <div class="doc-section">
      <div class="doc-section-head">
        <span style="font-weight:700; font-size:15px;">📝 Principal's Remarks</span>
        <span class="count">(${remarks.length})</span>
      </div>
      ${remarks.length === 0 ? `<div class="doc-empty">No remarks yet.</div>` : remarks.map((r) => `
        <div class="doc-item">
          <div class="comment-display" style="margin-top:0;"><strong>${fmtDate(r.date)}</strong> — ${esc(r.remark)}</div>
        </div>
      `).join("")}
    </div>
  `;
}

function renderTeacherLeaveSection(teacher) {
  const requests = getTeacherLeaveRequests(teacher, state.data.leaveResponses, state.data.leaveStatuses);
  return `
    <div class="doc-section">
      <div class="doc-section-head">
        <span style="font-weight:700; font-size:15px;">🧳 My Leave Requests</span>
        <span class="count">(${requests.length})</span>
      </div>
      ${requests.length === 0 ? `<div class="doc-empty">No leave requests found for you yet. Make sure the Name you type on the Leave form exactly matches your name in the Teacher Directory (currently: "${esc(teacher.name)}").</div>` : requests.map((r) => `
        <div class="doc-item">
          <div class="doc-row" style="gap:10px; flex-wrap:wrap;">
            <span style="flex:1; font-weight:600;">${r.start && r.end ? `${fmtDate(r.start)} &ndash; ${fmtDate(r.end)}` : "—"}</span>
            ${leaveStatusPillHtml(r.status)}
          </div>
          ${r.reason ? `<div class="doc-meta">${esc(r.reason)}</div>` : ""}
        </div>
      `).join("")}
    </div>
  `;
}

function renderTeacherDriveSection(teacher, isPrincipal, canUpload) {
  // Track where we're currently browsing per-teacher (resets when you switch teachers)
  if (!state.driveNav || state.driveNav.teacherId !== teacher.id) {
    state.driveNav = { teacherId: teacher.id, path: [] };
  }
  const path = state.driveNav.path; // array of { driveFolderId, name, url }
  const currentParentId = path.length > 0 ? path[path.length - 1].driveFolderId : "";
  const currentUrl = path.length > 0 ? path[path.length - 1].url : teacher.folderUrl;
  const currentLabel = path.length > 0 ? path[path.length - 1].name : `${teacher.name}'s Drive Folder`;

  const childFolders = state.data.customFolders.filter(
    (f) => f.teacherId === teacher.id && (f.parentFolderId || "") === currentParentId
  );

  const breadcrumbHtml = `
    <div class="drive-breadcrumbs">
      <button class="crumb ${path.length === 0 ? "active" : ""}" data-action="drive-nav-root">🏠 ${esc(teacher.name)}'s Folder</button>
      ${path.map((p, i) => `
        <span class="crumb-sep">›</span>
        <button class="crumb ${i === path.length - 1 ? "active" : ""}" data-action="drive-nav-crumb" data-index="${i}">${esc(p.name)}</button>
      `).join("")}
    </div>
  `;

  return `
    <div class="doc-section">
      <div class="doc-section-head">
        <span style="font-weight:700; font-size:15px;">📂 Google Drive</span>
      </div>
      ${breadcrumbHtml}
      ${currentUrl ? `
        <a href="${esc(currentUrl)}" target="_blank" rel="noopener" class="doc-row link-row" style="margin-bottom:12px;">
          <span>📁 Open "${esc(currentLabel)}" in Drive — work directly in Docs &amp; Sheets</span>
        </a>
      ` : `<div class="doc-empty">Drive folder link isn't available yet — it's created the first time a document is uploaded.</div>`}

      ${childFolders.length > 0 ? childFolders.map((f) => `
        <div class="doc-row">
          <button class="folder-nav-btn" data-action="drive-nav-into" data-id="${f.id}">📁 ${esc(f.folderName)}</button>
          <a href="${esc(f.folderUrl)}" target="_blank" rel="noopener" class="open-link" title="Open in Drive">↗</a>
          ${(canUpload || isPrincipal) ? `<button class="del" data-action="remove-custom-folder" data-id="${f.id}" title="Remove from this list">✕</button>` : ""}
        </div>
      `).join("") : `<div class="doc-empty">No subfolders here yet.</div>`}

      ${canUpload ? `
        <div class="upload-row" style="margin-top:10px;">
          <input type="text" id="new-folder-name" placeholder="New folder name (e.g. Class 5 Worksheets)" style="flex:1; min-width:160px;" />
          <button class="btn btn-dark" data-action="create-folder" data-parent="${esc(currentParentId)}" ${state.busyFolder ? "disabled" : ""}>${state.busyFolder ? "Creating…" : `+ New Folder ${path.length > 0 ? "here" : ""}`}</button>
        </div>
      ` : ""}
    </div>
  `;
}

function renderTeacherLinksSection(teacher, isPrincipal, canUpload) {
  const links = state.data.links.filter((l) => l.teacherId === teacher.id);
  const canManage = canUpload || isPrincipal;
  return `
    <div class="doc-section">
      <div class="doc-section-head">
        <span style="font-weight:700; font-size:15px;">🔗 Links</span>
        <span class="count">(${links.length})</span>
      </div>
      ${links.length === 0 ? `<div class="doc-empty">No links yet. Paste a Google Doc, Sheet, or any other link below.</div>` : links.map((l) => `
        <div class="doc-row">
          <a href="${esc(l.url)}" target="_blank" rel="noopener" title="${esc(l.url)}">🔗 ${esc(l.title || l.url)}</a>
          ${l.addedBy ? `<span class="date">${esc(l.addedBy)}</span>` : ""}
          ${canManage ? `<button class="del" data-action="remove-link" data-id="${l.id}" title="Remove link">✕</button>` : ""}
        </div>
      `).join("")}

      ${canManage ? `
        <div class="upload-row" style="margin-top:10px;">
          <input type="text" id="new-link-title" placeholder="Title (e.g. Term 2 Marks Sheet)" style="flex:1; min-width:140px;" />
          <input type="url" id="new-link-url" placeholder="Paste link here" style="flex:1; min-width:160px;" />
          <button class="btn btn-dark" data-action="add-link" data-teacher="${teacher.id}" ${state.busyLink ? "disabled" : ""}>${state.busyLink ? "Adding…" : "+ Add Link"}</button>
        </div>
      ` : ""}
    </div>
  `;
}

function renderTeacherServicesSection() {
  return `
    <div class="home-actions" style="margin-bottom:20px;">
      <button class="action-card" data-action="open-form" data-url="${esc(ATTENDANCE_FORM_URL)}" data-title="Attendance">
        <span class="action-icon">📋</span>
        <span class="action-label">Mark Attendance</span>
        <span class="action-sub">Daily class attendance form</span>
      </button>
      <button class="action-card" data-action="open-form" data-url="${esc(TOD_FORM_URL)}" data-title="TOD Report">
        <span class="action-icon">📝</span>
        <span class="action-label">TOD Report</span>
        <span class="action-sub">Teacher on Duty — activities &amp; remarks</span>
      </button>
      <button class="action-card" data-action="open-form" data-url="${esc(LEAVE_FORM_URL)}" data-title="Leave Request">
        <span class="action-icon">🧳</span>
        <span class="action-label">Apply for Leave</span>
        <span class="action-sub">Pending admin approval</span>
      </button>
    </div>
  `;
}

function renderUploadBox() {
  const p = state.pendingUpload;

  if (p) {
    return `
      <div class="upload-box">
        <div class="title">Review before submitting</div>
        <div class="upload-row">
          <div class="upload-field">
            <label>Category</label>
            <select id="staged-category" ${state.busyUpload ? "disabled" : ""}>
              <option value="lessonPlan" ${p.category === "lessonPlan" ? "selected" : ""}>Lesson Plan</option>
              <option value="otherDocuments" ${p.category === "otherDocuments" ? "selected" : ""}>Other Documents</option>
            </select>
          </div>
          <div class="upload-field" id="staged-lp-fields" style="${p.category === "lessonPlan" ? "display:flex; gap:10px;" : "display:none;"}">
            <div>
              <label>Class</label>
              <select id="staged-class" ${state.busyUpload ? "disabled" : ""}>${selectOptionsHtml(CLASS_OPTIONS, p.docClass || "")}</select>
            </div>
            <div>
              <label>Subject</label>
              <select id="staged-subject" ${state.busyUpload ? "disabled" : ""}>${selectOptionsHtml(SUBJECT_OPTIONS, p.docSubject || "")}</select>
            </div>
          </div>
          <div class="upload-field" id="staged-doc-name-field" style="${p.category === "otherDocuments" ? "" : "display:none;"}">
            <label>Document name</label>
            <input type="text" id="staged-doc-name" value="${esc(p.docName || "")}" placeholder="e.g. Term 2 Attendance Sheet" ${state.busyUpload ? "disabled" : ""} />
          </div>
        </div>
        <div class="doc-row" style="margin-top:2px;">
          <span style="flex:1;">📄 ${esc(p.fileName)}</span>
        </div>
        <div class="upload-row" style="margin-top:10px;">
          <button class="btn btn-danger" data-action="cancel-staged-upload" ${state.busyUpload ? "disabled" : ""}>🗑 Remove</button>
          <button class="btn btn-dark" data-action="submit-staged-upload" ${state.busyUpload ? "disabled" : ""}>${state.busyUpload ? "Submitting…" : "✅ Submit"}</button>
        </div>
      </div>
    `;
  }

  return `
    <div class="upload-box">
      <div class="title">Upload a document</div>
      <div class="upload-row">
        <div class="upload-field">
          <label>Category</label>
          <select id="upload-category">
            <option value="lessonPlan">Lesson Plan</option>
            <option value="otherDocuments">Other Documents</option>
          </select>
        </div>
        <div class="upload-field" id="lp-fields" style="display:flex; gap:10px;">
          <div>
            <label>Class</label>
            <select id="upload-class">${selectOptionsHtml(CLASS_OPTIONS, "")}</select>
          </div>
          <div>
            <label>Subject</label>
            <select id="upload-subject">${selectOptionsHtml(SUBJECT_OPTIONS, "")}</select>
          </div>
        </div>
        <div class="upload-field" id="doc-name-field" style="display:none;">
          <label>Document name</label>
          <input type="text" id="upload-doc-name" placeholder="e.g. Term 2 Attendance Sheet" />
        </div>
        <button class="btn btn-dark" id="choose-file-btn">📤 Choose File</button>
        <input type="file" id="upload-file-input" style="display:none;" />
      </div>
    </div>
  `;
}

function docSectionHtml(title, docs, canDelete, showDocName, canComment) {
  return `
    <div class="doc-section">
      <div class="doc-section-head">
        <span style="font-weight:700; font-size:15px;">${title}</span>
        <span class="count">(${docs.length})</span>
      </div>
      ${docs.length === 0 ? `<div class="doc-empty">No files here yet.</div>` : docs.map((d) => `
        <div class="doc-item">
          <div class="doc-row">
            <a href="${d.dataUrl}" download="${esc(d.fileName)}">${showDocName && d.docName ? esc(d.docName) : esc(d.fileName)}</a>
            <span class="date">${fmtDate(d.uploadedAt)}</span>
            ${canDelete ? `<button class="del" data-action="delete-doc" data-id="${d.id}">🗑</button>` : ""}
          </div>
          ${!showDocName && (d.docClass || d.docSubject) ? `<div class="doc-meta">🏫 ${esc(d.docClass || "—")} &nbsp;•&nbsp; 📘 ${esc(d.docSubject || "—")}</div>` : ""}
          ${d.comment ? `<div class="comment-display">💬 ${esc(d.comment)}</div>` : ""}
          ${canComment ? commentEditorHtml(d.id, d.comment) : ""}
        </div>
      `).join("")}
    </div>
  `;
}

function commentEditorHtml(docId, currentComment) {
  return `
    <div class="comment-wrap" data-doc="${docId}">
      <button class="override-btn" data-action="toggle-comment" data-doc="${docId}">
        💬 ${currentComment ? "Edit feedback" : "Add feedback"}
      </button>
      <div class="comment-edit" style="display:none;">
        <textarea data-role="comment-text" rows="2" placeholder="Write feedback for the teacher…">${esc(currentComment || "")}</textarea>
        <div style="display:flex; gap:6px; margin-top:6px;">
          <button class="btn btn-dark" data-action="save-comment" data-doc="${docId}">Save</button>
          <button class="modal-close" data-action="toggle-comment" data-doc="${docId}">✕</button>
        </div>
      </div>
    </div>
  `;
}

// ---------- Modals ----------
function renderModal() {
  const m = state.modal;
  if (!m) return "";
  if (m.type === "addTeacher") return renderAddTeacherModal();
  if (m.type === "teacherLogin") return renderTeacherLoginModal();
  if (m.type === "teacherPin") return renderTeacherPinModal();
  if (m.type === "editSchoolData") return renderEditSchoolDataModal();
  if (m.type === "staffForm") return renderStaffModal();
  if (m.type === "adminPin") return renderAdminPinModal();
  if (m.type === "changePin") return renderChangePinModal();
  if (m.type === "notice") return renderNoticeModal(m.overdueItems, m.feedbackDocs, m.leaveNotices, m.todRemarkNotices);
  if (m.type === "formEmbed") return renderFormEmbedModal(m.url, m.title);
  if (m.type === "externalEmbed") return renderExternalEmbedModal(m.url, m.title);
  if (m.type === "exportRange") return renderExportRangeModal(m.source);
  return "";
}

function renderFormEmbedModal(url, title) {
  // Google Forms accept an "embedded=true" query param for a cleaner iframe view
  const sep = url.includes("?") ? "&" : "?";
  const embedUrl = url.includes("embedded=true") ? url : `${url}${sep}embedded=true`;
  return `
    <div class="modal-overlay" data-action="modal-overlay-close">
      <div class="modal-box form-modal-box" data-stop-close="1">
        <div class="modal-head">
          <div class="modal-title">${esc(title)}</div>
          <button class="modal-close" data-action="close-modal">✕</button>
        </div>
        <div class="form-embed-wrap">
          <iframe src="${esc(embedUrl)}" width="100%" height="640" frameborder="0" marginheight="0" marginwidth="0">Loading…</iframe>
        </div>
        <div style="text-align:center; margin-top:10px;">
          <a href="${esc(url)}" target="_blank" rel="noopener" style="font-size:12.5px; color:#45526b;">Trouble viewing the form? Open it in a new tab ↗</a>
        </div>
      </div>
    </div>
  `;
}

function renderExportRangeModal(source) {
  const { title } = exportSourceRows(source);
  return `
    <div class="modal-overlay" data-action="modal-overlay-close">
      <div class="modal-box" data-stop-close="1" style="max-width:380px;">
        <div class="modal-head">
          <div class="modal-title">Export / Print</div>
          <button class="modal-close" data-action="close-modal">✕</button>
        </div>
        <div class="modal-note" style="margin-bottom:14px;">${esc(title)} — pick a range, or leave both blank for everything.</div>
        <div class="modal-fields">
          <div>
            <label>Quick range</label>
            <div style="display:flex; gap:6px; flex-wrap:wrap;">
              <button class="btn btn-tab btn-sm" data-action="export-range-preset" data-preset="week">This Week</button>
              <button class="btn btn-tab btn-sm" data-action="export-range-preset" data-preset="month">This Month</button>
              <button class="btn btn-tab btn-sm" data-action="export-range-preset" data-preset="all">All Time</button>
            </div>
          </div>
          <div style="display:flex; gap:10px;">
            <div style="flex:1;"><label>From</label><input type="date" id="export-range-from" /></div>
            <div style="flex:1;"><label>To</label><input type="date" id="export-range-to" /></div>
          </div>
        </div>
        <div style="display:flex; gap:8px; margin-top:18px;">
          <button class="btn btn-dark" style="flex:1; justify-content:center;" data-action="export-range-confirm" data-source="${source}" data-mode="csv">⬇️ Export CSV</button>
          <button class="btn btn-tab" style="flex:1; justify-content:center;" data-action="export-range-confirm" data-source="${source}" data-mode="print">🖨️ Print</button>
        </div>
      </div>
    </div>
  `;
}

function renderExternalEmbedModal(url, title) {
  return `
    <div class="modal-overlay" data-action="modal-overlay-close">
      <div class="modal-box fullscreen-embed-box" data-stop-close="1">
        <div class="modal-head">
          <div class="modal-title">${esc(title)}</div>
          <button class="modal-close" data-action="close-modal">✕</button>
        </div>
        <div class="form-embed-wrap">
          <iframe src="${esc(url)}" width="100%" frameborder="0" marginheight="0" marginwidth="0">Loading…</iframe>
        </div>
        <div style="text-align:center; margin-top:10px; flex-shrink:0;">
          <a href="${esc(url)}" target="_blank" rel="noopener" style="font-size:12.5px; color:#45526b;">Blank or not loading? Some sites don't allow this — open it in a new tab instead ↗</a>
        </div>
      </div>
    </div>
  `;
}

function renderAddTeacherModal() {
  const photo = state.modal.photo || null;
  const isEditing = !!state.modal.editingTeacherId;
  return `
    <div class="modal-overlay" data-action="modal-overlay-close">
      <div class="modal-box" data-stop-close="1">
        <div class="modal-head">
          <div class="modal-title">${isEditing ? "Edit Teacher" : "Add Teacher"}</div>
          <button class="modal-close" data-action="close-modal">✕</button>
        </div>
        <div class="photo-picker">
          <label class="photo-circle" for="teacher-photo-input">
            ${photo ? `<img src="${photo}" alt="" />` : `🖼`}
          </label>
          <input id="teacher-photo-input" type="file" accept="image/*" style="display:none;" />
        </div>
        <div class="modal-fields">
          <div><label>Name</label><input id="at-name" placeholder="e.g. Sonam Choden" value="${esc(state.modal.name || "")}" /></div>
          <div><label>Subject / Class</label><input id="at-subject" placeholder="e.g. Class III, Dzongkha" value="${esc(state.modal.subject || "")}" /></div>
          <div><label>Phone Number</label><input id="at-phone" placeholder="e.g. 17123456" value="${esc(state.modal.phone || "")}" /></div>
        </div>
        ${isEditing ? `<div style="font-size:12px; color:#9aa2b1; margin-top:8px;">Changing the name also renames their Google Drive folder, so existing files stay linked.</div>` : ""}
        <button class="btn btn-dark" style="width:100%; justify-content:center; margin-top:18px;" data-action="submit-add-teacher">${isEditing ? "Save Changes" : "Add Teacher"}</button>
      </div>
    </div>
  `;
}

function renderTeacherLoginModal() {
  const teachers = state.data.teachers;
  return `
    <div class="modal-overlay" data-action="modal-overlay-close">
      <div class="modal-box" data-stop-close="1" style="max-width:340px;">
        <div class="modal-head">
          <div class="modal-title">Who are you?</div>
          <button class="modal-close" data-action="close-modal">✕</button>
        </div>
        ${teachers.length === 0 ? `<div style="font-size:13.5px; color:#6B5E45;">No teachers added yet.</div>` : `
          <div class="modal-fields">
            <div>
              <label>Select your name</label>
              <select id="login-teacher-select">
                ${teachers.map((t) => `<option value="${t.id}">${esc(t.name)}</option>`).join("")}
              </select>
            </div>
            ${state.modal.error ? `<div class="modal-error">${esc(state.modal.error)}</div>` : ""}
            <button class="btn btn-dark" style="justify-content:center;" data-action="submit-teacher-login">Continue to my folder</button>
          </div>
        `}
      </div>
    </div>
  `;
}

function renderTeacherPinModal() {
  const teacherId = state.modal.teacherId;
  const teacher = state.data.teachers.find((t) => t.id === teacherId);
  const hasPin = !!state.data.teacherPins[teacherId];
  return `
    <div class="modal-overlay" data-action="modal-overlay-close">
      <div class="modal-box" data-stop-close="1" style="max-width:340px;">
        <div class="modal-head">
          <div class="modal-title">${hasPin ? `Enter PIN` : `Set a PIN`}${teacher ? ` — ${esc(teacher.name)}` : ""}</div>
          <button class="modal-close" data-action="close-modal">✕</button>
        </div>
        ${!hasPin ? `<div class="modal-note">First time logging in as ${teacher ? esc(teacher.name) : "yourself"}. Set a PIN now — you'll need it every time you log in as yourself. Don't share it with other teachers.</div>` : ""}
        <div class="modal-fields">
          <div><label>${hasPin ? "PIN" : "New PIN"}</label><input type="password" inputmode="numeric" id="teacher-pin-input" placeholder="••••" /></div>
          ${!hasPin ? `<div><label>Confirm PIN</label><input type="password" inputmode="numeric" id="teacher-pin-confirm-input" placeholder="••••" /></div>` : ""}
          ${state.modal.error ? `<div class="modal-error">${esc(state.modal.error)}</div>` : ""}
          <button class="btn btn-dark" style="justify-content:center;" data-action="submit-teacher-pin">${hasPin ? "Unlock" : "Set PIN & Continue"}</button>
        </div>
      </div>
    </div>
  `;
}

function renderAdminPinModal() {
  const hasPin = !!state.data.adminPin;
  return `
    <div class="modal-overlay" data-action="modal-overlay-close">
      <div class="modal-box" data-stop-close="1" style="max-width:340px;">
        <div class="modal-head">
          <div class="modal-title">${hasPin ? "Enter Principal PIN" : "Set Up Principal PIN"}</div>
          <button class="modal-close" data-action="close-modal">✕</button>
        </div>
        ${!hasPin ? `<div class="modal-note">This is the first time Admin Mode is being used. Set a PIN now — anyone who knows it can manage the portal (add/remove teachers, view the dashboard). Share it only with whoever should be principal.</div>` : ""}
        <div class="modal-fields">
          <div><label>${hasPin ? "PIN" : "New PIN"}</label><input type="password" inputmode="numeric" id="pin-input" placeholder="••••" /></div>
          ${!hasPin ? `<div><label>Confirm PIN</label><input type="password" inputmode="numeric" id="pin-confirm-input" placeholder="••••" /></div>` : ""}
          ${state.modal.error ? `<div class="modal-error">${esc(state.modal.error)}</div>` : ""}
          <button class="btn btn-dark" style="justify-content:center;" data-action="submit-admin-pin">${hasPin ? "Unlock" : "Set PIN & Continue"}</button>
        </div>
      </div>
    </div>
  `;
}

function renderEditSchoolDataModal() {
  return `
    <div class="modal-overlay" data-action="modal-overlay-close">
      <div class="modal-box" data-stop-close="1" style="max-width:340px;">
        <div class="modal-head">
          <div class="modal-title">Edit School Data</div>
          <button class="modal-close" data-action="close-modal">✕</button>
        </div>
        <div class="modal-fields">
          <div><label>Total Students</label><input type="number" min="0" id="edit-total-students" value="${esc(state.data.totalStudents || "")}" placeholder="e.g. 240" /></div>
        </div>
        <div class="modal-note" style="margin-top:8px;">Teaching Staff and Non-Teaching Staff counts update automatically from the Teacher Directory and Staff Profile — no need to enter those here.</div>
        <button class="btn btn-dark" style="width:100%; justify-content:center; margin-top:14px;" data-action="submit-edit-school-data">Save</button>
      </div>
    </div>
  `;
}

function renderStaffModal() {
  const photo = state.modal.photo || null;
  const isEditing = !!state.modal.editingStaffId;
  return `
    <div class="modal-overlay" data-action="modal-overlay-close">
      <div class="modal-box" data-stop-close="1">
        <div class="modal-head">
          <div class="modal-title">${isEditing ? "Edit Staff" : "Add Staff"}</div>
          <button class="modal-close" data-action="close-modal">✕</button>
        </div>
        <div class="photo-picker">
          <label class="photo-circle" for="teacher-photo-input">
            ${photo ? `<img src="${photo}" alt="" />` : `🖼`}
          </label>
          <input id="teacher-photo-input" type="file" accept="image/*" style="display:none;" />
        </div>
        <div class="modal-fields">
          <div><label>Name</label><input id="staff-name" placeholder="e.g. Pema Lhamo" value="${esc(state.modal.name || "")}" /></div>
          <div><label>Role</label><input id="staff-role" placeholder="e.g. Accountant, Cook, Security Guard" value="${esc(state.modal.role || "")}" /></div>
        </div>
        <button class="btn btn-dark" style="width:100%; justify-content:center; margin-top:18px;" data-action="submit-staff">${isEditing ? "Save Changes" : "Add Staff"}</button>
      </div>
    </div>
  `;
}

function renderChangePinModal() {
  return `
    <div class="modal-overlay" data-action="modal-overlay-close">
      <div class="modal-box" data-stop-close="1" style="max-width:340px;">
        <div class="modal-head">
          <div class="modal-title">Change Principal PIN</div>
          <button class="modal-close" data-action="close-modal">✕</button>
        </div>
        <div class="modal-fields">
          <div><label>Current PIN</label><input type="password" inputmode="numeric" id="cp-old" placeholder="••••" /></div>
          <div><label>New PIN</label><input type="password" inputmode="numeric" id="cp-new" placeholder="••••" /></div>
          <div><label>Confirm New PIN</label><input type="password" inputmode="numeric" id="cp-confirm" placeholder="••••" /></div>
          ${state.modal.error ? `<div class="modal-error">${esc(state.modal.error)}</div>` : ""}
          <button class="btn btn-dark" style="justify-content:center;" data-action="submit-change-pin">Save New PIN</button>
        </div>
      </div>
    </div>
  `;
}

function renderNoticeModal(overdueItems, feedbackDocs, leaveNotices, todRemarkNotices) {
  const hasOverdue = overdueItems && overdueItems.length > 0;
  const hasFeedback = feedbackDocs && feedbackDocs.length > 0;
  const hasLeave = leaveNotices && leaveNotices.length > 0;
  const hasTodRemarks = todRemarkNotices && todRemarkNotices.length > 0;
  return `
    <div class="modal-overlay">
      <div class="modal-box" data-stop-close="1" style="max-width:380px;">
        <div class="modal-head" style="align-items:center;">
          <div style="display:flex; align-items:center; gap:8px;">
            <span style="font-size:20px;">🔔</span>
            <div class="modal-title">Updates for you</div>
          </div>
        </div>
        <div style="display:flex; flex-direction:column; gap:10px; margin-bottom:18px;">
          ${hasOverdue ? overdueItems.map(({ cat, status }) => `
            <div style="background:rgba(244,223,225,0.85); border-radius:9px; padding:10px 12px; font-size:13.5px; color:#7c1d2e;">
              <strong>⚠ ${CATEGORY_LABEL[cat]}</strong> — ${status.count}/${status.required} submitted today
            </div>
          `).join("") : ""}
          ${hasFeedback ? feedbackDocs.map((d) => `
            <div style="background:rgba(223,233,225,0.85); border-radius:9px; padding:10px 12px; font-size:13.5px; color:#1e2733;">
              <strong>💬 Feedback on ${esc(d.docName || d.fileName)}</strong>
              <div style="margin-top:4px;">${esc(d.comment)}</div>
            </div>
          `).join("") : ""}
          ${hasLeave ? leaveNotices.map((n) => `
            <div style="background:${n.status === "approved" ? "rgba(223,233,225,0.85)" : "rgba(244,223,225,0.85)"}; border-radius:9px; padding:10px 12px; font-size:13.5px; color:${n.status === "approved" ? "#1e2733" : "#7c1d2e"};">
              <strong>${n.status === "approved" ? "✅ Leave Approved" : "❌ Leave Not Approved"}</strong>
              <div style="margin-top:4px;">${fmtDate(n.start)} &ndash; ${fmtDate(n.end)}</div>
            </div>
          `).join("") : ""}
          ${hasTodRemarks ? todRemarkNotices.map((r) => `
            <div style="background:rgba(164,131,39,0.14); border-radius:9px; padding:10px 12px; font-size:13.5px; color:#1e2733;">
              <strong>📝 Principal's remark — ${fmtDate(r.date)}</strong>
              <div style="margin-top:4px;">${esc(r.remark)}</div>
            </div>
          `).join("") : ""}
        </div>
        <button class="btn btn-dark" style="width:100%; justify-content:center;" data-action="close-notice">Got it</button>
      </div>
    </div>
  `;
}

// ---------- Boot loader (purely cosmetic — always takes ~1s, independent of actual data load time) ----------
function runBootLoader() {
  const overlay = document.getElementById("boot-loader");
  const percentEl = document.getElementById("boot-percent");
  const barFill = document.getElementById("boot-bar-fill");
  if (!overlay) return;
  const duration = 2000;
  const start = performance.now();
  function tick(now) {
    const elapsed = now - start;
    const pct = Math.min(100, Math.round((elapsed / duration) * 100));
    if (percentEl) percentEl.textContent = pct + "%";
    if (barFill) barFill.style.width = pct + "%";
    if (elapsed < duration) {
      requestAnimationFrame(tick);
    } else {
      overlay.classList.add("boot-loader-hide");
      setTimeout(() => { overlay.style.display = "none"; }, 320); // matches the CSS fade duration
    }
  }
  requestAnimationFrame(tick);
}

// ---------- Event delegation ----------
document.addEventListener("DOMContentLoaded", () => {
  runBootLoader();
  restoreNavState();
  loadData();
  initAudio();

  document.getElementById("app").addEventListener("click", async (e) => {
    const overlay = e.target.closest("[data-action='modal-overlay-close']");
    if (overlay && e.target === overlay) {
      state.modal = null;
      render();
      return;
    }

    const el = e.target.closest("[data-action]");
    if (!el) return;
    const action = el.dataset.action;

    if (action === "logout") return logout();
    if (action === "open-teacher-login") { state.modal = { type: "teacherLogin" }; return render(); }
    if (action === "toggle-admin") return requestAdminMode();
    if (action === "set-view") { state.view = el.dataset.view; return render(); }
    if (action === "open-add-teacher") { state.modal = { type: "addTeacher" }; return render(); }
    if (action === "open-folder") return openFolder(el.dataset.id);
    if (action === "back-to-directory") {
      state.view = state.session ? "folder" : "directory";
      if (!state.session) state.activeTeacherId = null;
      return render();
    }
    if (action === "remove-teacher") {
      const t = state.data.teachers.find((x) => x.id === el.dataset.id);
      if (t && confirm(`Remove ${t.name} and all their documents?`)) await removeTeacher(el.dataset.id);
      return;
    }
    if (action === "delete-doc") return removeDocument(el.dataset.id);
    if (action === "approve-leave") return setLeaveStatus(el.dataset.id, "approved");
    if (action === "reject-leave") return setLeaveStatus(el.dataset.id, "rejected");
    if (action === "toggle-audio") return toggleAudio();

    if (action === "open-form") {
      const url = el.dataset.url;
      if (!url || url.startsWith("PASTE_")) {
        alert("This form link hasn't been set up yet. Paste the Google Form link into ATTENDANCE_FORM_URL / TOD_FORM_URL near the top of script.js.");
        return;
      }
      state.modal = { type: "formEmbed", url, title: el.dataset.title || "Form" };
      return render();
    }

    if (action === "open-external") {
      const url = el.dataset.url;
      if (!url || url.startsWith("PASTE_")) {
        alert("This link hasn't been set up yet. Paste it into TIMETABLE_GENERATOR_URL / EMIS_URL near the top of script.js.");
        return;
      }
      state.modal = { type: "externalEmbed", url, title: el.dataset.title || "" };
      return render();
    }

    if (action === "save-timetable-url") {
      const val = document.getElementById("timetable-url-input").value.trim();
      await saveTimetableUrl(val);
      return;
    }

    if (action === "cancel-staged-upload") {
      state.pendingUpload = null;
      return render();
    }

    if (action === "submit-staged-upload") {
      const p = state.pendingUpload;
      if (!p) return;
      if (p.category === "otherDocuments" && !p.docName.trim()) {
        alert("Please give this document a name first.");
        return;
      }
      if (p.category === "lessonPlan" && (!p.docClass.trim() || !p.docSubject.trim())) {
        alert("Please fill in the Class and Subject first.");
        return;
      }
      state.busyUpload = true;
      render();
      try {
        await addDocument({
          teacherId: state.activeTeacherId,
          category: p.category,
          fileName: p.fileName,
          docName: p.category === "otherDocuments" ? p.docName.trim() : undefined,
          docClass: p.category === "lessonPlan" ? p.docClass.trim() : undefined,
          docSubject: p.category === "lessonPlan" ? p.docSubject.trim() : undefined,
          mimeType: p.mimeType,
          dataUrl: p.dataUrl,
          uploadedAt: new Date().toISOString(),
        });
      } finally {
        state.pendingUpload = null;
        state.busyUpload = false;
        render();
      }
      return;
    }
    if (action === "close-modal") { state.modal = null; return render(); }

    if (action === "export-csv" || action === "print-table") {
      state.modal = { type: "exportRange", source: el.dataset.source };
      return render();
    }
    if (action === "export-range-preset") {
      const preset = el.dataset.preset;
      const fromInput = document.getElementById("export-range-from");
      const toInput = document.getElementById("export-range-to");
      const today = new Date();
      const fmt = (d) => d.toISOString().slice(0, 10);
      if (preset === "all") {
        fromInput.value = "";
        toInput.value = "";
      } else if (preset === "week") {
        const start = new Date(today);
        start.setDate(start.getDate() - 6);
        fromInput.value = fmt(start);
        toInput.value = fmt(today);
      } else if (preset === "month") {
        const start = new Date(today.getFullYear(), today.getMonth(), 1);
        fromInput.value = fmt(start);
        toInput.value = fmt(today);
      }
      return;
    }
    if (action === "export-range-confirm") {
      const source = el.dataset.source;
      const mode = el.dataset.mode;
      const fromStr = document.getElementById("export-range-from").value || "";
      const toStr = document.getElementById("export-range-to").value || "";
      state.modal = null;
      render();
      if (mode === "csv") exportTableCsv(source, fromStr, toStr);
      else printTable(source, fromStr, toStr);
      return;
    }
    if (action === "close-notice") {
      const feedbackDocs = (state.modal && state.modal.feedbackDocs) || [];
      const leaveNotices = (state.modal && state.modal.leaveNotices) || [];
      const todRemarkNotices = (state.modal && state.modal.todRemarkNotices) || [];
      state.modal = null;
      render();
      for (const d of feedbackDocs) await markCommentSeen(d.id);
      for (const n of leaveNotices) await markLeaveSeen(n.id);
      for (const r of todRemarkNotices) await markTodRemarkSeen(r.id);
      return;
    }

    if (action === "open-change-pin") { state.modal = { type: "changePin" }; return render(); }

    if (action === "toggle-override") {
      const wrap = el.closest(".override-wrap");
      const editRow = wrap.querySelector(".override-edit");
      editRow.style.display = editRow.style.display === "none" ? "flex" : "none";
      return;
    }
    if (action === "toggle-comment") {
      const wrap = el.closest(".comment-wrap");
      const editRow = wrap.querySelector(".comment-edit");
      editRow.style.display = editRow.style.display === "none" ? "block" : "none";
      return;
    }
    if (action === "save-comment") {
      const wrap = el.closest(".comment-wrap");
      const text = wrap.querySelector("[data-role='comment-text']").value.trim();
      await saveComment(el.dataset.doc, text);
      return;
    }
    if (action === "toggle-tod-remark") {
      const wrap = el.closest(".comment-wrap");
      const editRow = wrap.querySelector(".comment-edit");
      editRow.style.display = editRow.style.display === "none" ? "block" : "none";
      return;
    }
    if (action === "save-tod-remark") {
      const wrap = el.closest(".comment-wrap");
      const text = wrap.querySelector("[data-role='tod-remark-text']").value.trim();
      await saveTodRemark(el.dataset.id, text);
      return;
    }
    if (action === "create-folder") {
      const input = document.getElementById("new-folder-name");
      const name = input ? input.value.trim() : "";
      if (!name) { alert("Please enter a folder name."); return; }
      const teacher = state.data.teachers.find((t) => t.id === state.activeTeacherId);
      if (!teacher) return;
      await createCustomFolder(teacher.id, teacher.name, name, el.dataset.parent || "");
      return;
    }
    if (action === "remove-custom-folder") { await removeCustomFolder(el.dataset.id); return; }
    if (action === "drive-nav-into") {
      const folder = state.data.customFolders.find((f) => f.id === el.dataset.id);
      if (!folder) return;
      if (!state.driveNav || state.driveNav.teacherId !== state.activeTeacherId) {
        state.driveNav = { teacherId: state.activeTeacherId, path: [] };
      }
      state.driveNav.path.push({ driveFolderId: folder.driveFolderId, name: folder.folderName, url: folder.folderUrl });
      return render();
    }
    if (action === "drive-nav-root") {
      if (state.driveNav) state.driveNav.path = [];
      return render();
    }
    if (action === "drive-nav-crumb") {
      const idx = parseInt(el.dataset.index, 10);
      if (state.driveNav) state.driveNav.path = state.driveNav.path.slice(0, idx + 1);
      return render();
    }
    if (action === "add-link") {
      const titleInput = document.getElementById("new-link-title");
      const urlInput = document.getElementById("new-link-url");
      const title = titleInput ? titleInput.value.trim() : "";
      const url = urlInput ? urlInput.value.trim() : "";
      if (!url) { alert("Please paste a link first."); return; }
      const isPrincipalNow = state.adminMode && !state.session;
      const teacher = state.data.teachers.find((t) => t.id === el.dataset.teacher);
      const addedBy = isPrincipalNow ? "Principal" : (teacher ? teacher.name : "");
      await addResourceLink(el.dataset.teacher, title, url, addedBy);
      return;
    }
    if (action === "remove-link") { await removeResourceLink(el.dataset.id); return; }
    if (action === "save-override") {
      const wrap = el.closest(".override-wrap");
      const dateVal = wrap.querySelector("[data-role='override-date']").value;
      await setOverride(el.dataset.teacher, el.dataset.category, dateVal || null);
      return;
    }
    if (action === "clear-override") {
      await setOverride(el.dataset.teacher, el.dataset.category, null);
      return;
    }
    if (action === "save-lessonplan-schedule") {
      const count = document.getElementById("lp-required-count").value;
      await saveLessonPlanRequiredCount(count);
      return;
    }
    if (action === "add-calendar-date") {
      const val = document.getElementById("od-new-date").value;
      if (!val) { alert("Pick a date first."); return; }
      await addCalendarDueDate(val);
      return;
    }
    if (action === "remove-calendar-date") {
      await removeCalendarDueDate(el.dataset.date);
      return;
    }

    if (action === "open-edit-teacher") {
      const teacher = state.data.teachers.find((t) => t.id === el.dataset.id);
      if (!teacher) return;
      state.modal = {
        type: "addTeacher",
        editingTeacherId: teacher.id,
        name: teacher.name, subject: teacher.subject, phone: teacher.phone, photo: teacher.photo,
      };
      return render();
    }

    if (action === "submit-add-teacher") {
      const name = document.getElementById("at-name").value.trim();
      if (!name) return;
      const subject = document.getElementById("at-subject").value.trim();
      const phone = document.getElementById("at-phone").value.trim();
      const photo = state.modal.photo || null;
      const editingTeacherId = state.modal.editingTeacherId;
      state.modal = null;
      if (editingTeacherId) {
        await updateTeacher(editingTeacherId, { name, subject, phone, photo });
      } else {
        await addTeacher({ name, subject, phone, photo });
      }
      return;
    }

    if (action === "submit-teacher-login") {
      const teacherId = document.getElementById("login-teacher-select").value;
      if (!teacherId) { state.modal.error = "Select your name."; return render(); }
      state.modal = { type: "teacherPin", teacherId };
      return render();
    }

    if (action === "submit-teacher-pin") {
      const teacherId = state.modal.teacherId;
      const teacher = state.data.teachers.find((t) => t.id === teacherId);
      const hasPin = !!state.data.teacherPins[teacherId];
      const pin = document.getElementById("teacher-pin-input").value.replace(/\D/g, "").slice(0, 8);
      if (!hasPin) {
        const confirmPin = document.getElementById("teacher-pin-confirm-input").value.replace(/\D/g, "").slice(0, 8);
        if (pin.length < 4) { state.modal.error = "PIN must be at least 4 digits."; return render(); }
        if (pin !== confirmPin) { state.modal.error = "PINs don't match."; return render(); }
        const ok = await setTeacherPin(teacherId, pin);
        if (!ok) return render();
        return handleTeacherLogin(teacherId);
      } else {
        if (pin !== String(state.data.teacherPins[teacherId])) { state.modal.error = "Incorrect PIN."; return render(); }
        return handleTeacherLogin(teacherId);
      }
    }

    if (action === "reset-teacher-pin") {
      const teacher = state.data.teachers.find((t) => t.id === el.dataset.id);
      if (!teacher) return;
      await resetTeacherPin(teacher.id, teacher.name);
      return;
    }

    if (action === "open-edit-school-data") { state.modal = { type: "editSchoolData" }; return render(); }
    if (action === "submit-edit-school-data") {
      const value = document.getElementById("edit-total-students").value.trim();
      state.modal = null;
      await saveTotalStudents(value);
      return;
    }

    if (action === "open-add-staff") { state.modal = { type: "staffForm" }; return render(); }
    if (action === "open-edit-staff") {
      const s = state.data.staff.find((x) => x.id === el.dataset.id);
      if (!s) return;
      state.modal = { type: "staffForm", editingStaffId: s.id, name: s.name, role: s.role, photo: s.photo };
      return render();
    }
    if (action === "remove-staff") {
      if (!confirm("Remove this staff member from the front page?")) return;
      await removeStaffMember(el.dataset.id);
      return;
    }
    if (action === "submit-staff") {
      const name = document.getElementById("staff-name").value.trim();
      if (!name) return;
      const role = document.getElementById("staff-role").value.trim();
      const photo = state.modal.photo || null;
      const editingStaffId = state.modal.editingStaffId;
      state.modal = null;
      if (editingStaffId) {
        await updateStaffMember(editingStaffId, name, role, photo);
      } else {
        await addStaffMember(name, role, photo);
      }
      return;
    }

    if (action === "submit-admin-pin") {
      const hasPin = !!state.data.adminPin;
      const pin = document.getElementById("pin-input").value.replace(/\D/g, "").slice(0, 8);
      if (!hasPin) {
        const confirmPin = document.getElementById("pin-confirm-input").value.replace(/\D/g, "").slice(0, 8);
        if (pin.length < 4) { state.modal.error = "PIN must be at least 4 digits."; return render(); }
        if (pin !== confirmPin) { state.modal.error = "PINs don't match."; return render(); }
        await setAdminPin(pin);
        state.adminMode = true;
        state.view = "dashboard";
        state.modal = null;
        return render();
      } else {
        if (pin !== String(state.data.adminPin)) { state.modal.error = "Incorrect PIN."; return render(); }
        state.adminMode = true;
        state.view = "dashboard";
        state.modal = null;
        return render();
      }
    }

    if (action === "submit-change-pin") {
      const oldPin = document.getElementById("cp-old").value.replace(/\D/g, "").slice(0, 8);
      const newPin = document.getElementById("cp-new").value.replace(/\D/g, "").slice(0, 8);
      const confirmPin = document.getElementById("cp-confirm").value.replace(/\D/g, "").slice(0, 8);
      if (oldPin !== String(state.data.adminPin)) { state.modal.error = "Current PIN is incorrect."; return render(); }
      if (newPin.length < 4) { state.modal.error = "New PIN must be at least 4 digits."; return render(); }
      if (newPin !== confirmPin) { state.modal.error = "New PINs don't match."; return render(); }
      state.modal = null;
      await setAdminPin(newPin);
      return;
    }
  });

  // Change events (selects, file inputs) — delegated
  document.getElementById("app").addEventListener("change", async (e) => {
    if (e.target.id === "teacher-photo-input") {
      const file = e.target.files[0];
      if (!file) return;
      const dataUrl = await readFileAsDataUrl(file);
      state.modal.photo = dataUrl;
      return render();
    }

    if (e.target.id === "upload-category") {
      const docNameField = document.getElementById("doc-name-field");
      const lpFields = document.getElementById("lp-fields");
      docNameField.style.display = e.target.value === "otherDocuments" ? "block" : "none";
      lpFields.style.display = e.target.value === "lessonPlan" ? "flex" : "none";
      return;
    }

    if (e.target.id === "upload-file-input") {
      const file = e.target.files[0];
      if (!file) return;
      if (file.size > 5 * 1024 * 1024) {
        alert("File is too large. Please keep files under 5MB.");
        e.target.value = "";
        return;
      }
      const category = document.getElementById("upload-category").value;
      const docNameInput = document.getElementById("upload-doc-name");
      const docName = docNameInput ? docNameInput.value.trim() : "";
      const docClass = document.getElementById("upload-class").value.trim();
      const docSubject = document.getElementById("upload-subject").value.trim();
      if (category === "otherDocuments" && !docName) {
        alert("Please give this document a name first.");
        e.target.value = "";
        return;
      }
      if (category === "lessonPlan" && (!docClass || !docSubject)) {
        alert("Please fill in the Class and Subject first.");
        e.target.value = "";
        return;
      }
      // Stage the file for review — it is NOT uploaded yet. The teacher can still
      // edit the name/category, remove it and pick a different file, or submit it.
      const dataUrl = await readFileAsDataUrl(file);
      state.pendingUpload = {
        category,
        docName: category === "otherDocuments" ? docName : "",
        docClass: category === "lessonPlan" ? docClass : "",
        docSubject: category === "lessonPlan" ? docSubject : "",
        fileName: file.name,
        mimeType: file.type,
        dataUrl,
      };
      render();
      return;
    }

    if (e.target.id === "staged-category") {
      if (state.pendingUpload) state.pendingUpload.category = e.target.value;
      return render();
    }
  });

  // Keep the staged document name / class / subject in sync as the teacher edits before submitting
  document.getElementById("app").addEventListener("input", (e) => {
    if (e.target.id === "staged-doc-name" && state.pendingUpload) {
      state.pendingUpload.docName = e.target.value;
    }
    if (e.target.id === "staged-class" && state.pendingUpload) {
      state.pendingUpload.docClass = e.target.value;
    }
    if (e.target.id === "staged-subject" && state.pendingUpload) {
      state.pendingUpload.docSubject = e.target.value;
    }
    if (e.target.id === "directory-search-input") {
      state.directorySearch = e.target.value;
      render();
    }
  });

  // Click on "Choose File" button triggers hidden file input (delegated, rebound each render via id lookup)
  document.getElementById("app").addEventListener("click", (e) => {
    if (e.target.id === "choose-file-btn" || e.target.closest("#choose-file-btn")) {
      const input = document.getElementById("upload-file-input");
      if (input) input.click();
    }
  });

  // Text input tracking for Add Teacher modal (so values survive re-render, e.g. after photo upload)
  document.getElementById("app").addEventListener("input", (e) => {
    if (!state.modal || state.modal.type !== "addTeacher") return;
    if (e.target.id === "at-name") state.modal.name = e.target.value;
    if (e.target.id === "at-subject") state.modal.subject = e.target.value;
    if (e.target.id === "at-phone") state.modal.phone = e.target.value;
  });
});
