// ---------- Constants ----------
// PASTE YOUR APPS SCRIPT WEB APP URL HERE (from Deploy > New deployment)
const BACKEND_URL = "https://script.google.com/macros/s/AKfycbwHGK41o0luNY77PDSxbQE8Rb-DxDh_mxnSjnojl4CcADNBXaYwWBbMFUZMKordzGcSfQ/exec";

const CATEGORY_LABEL = { lessonPlan: "Lesson Plan", otherDocuments: "Other Document" };

// Edit these to point at your actual links — shown on the Home page
const PORTFOLIO_LINKS = [
  { label: "School Records (Google Drive)", url: "PASTE_DRIVE_FOLDER_LINK_HERE", icon: "📁" },
  { label: "Master Data Sheet", url: "PASTE_GOOGLE_SHEET_LINK_HERE", icon: "📊" },
  { label: "School Vision & Mission", url: "PASTE_LINK_HERE", icon: "🏫" },
];

// Paste your published Google Form links here.
// Use the form's "Send" > link icon URL (ending in /viewform). The app embeds it
// automatically. Responses land in whatever Google Sheet you attach the form to —
// share that sheet only with the principal to keep it principal-only viewing.
const ATTENDANCE_FORM_URL = "https://forms.gle/zdDsEDyXt71dFQGf8";
const TOD_FORM_URL = "https://forms.gle/9cC3tdPFxaXDSkJi8";

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
};

// ---------- Decorative sky (generated once so it doesn't reshuffle on every render) ----------
function generateStarsHtml(count) {
  let html = "";
  for (let i = 0; i < count; i++) {
    const top = (Math.random() * 92).toFixed(1);
    const left = (Math.random() * 100).toFixed(1);
    const size = (Math.random() * 1.6 + 1).toFixed(1);
    const delay = (Math.random() * 5).toFixed(2);
    const duration = (Math.random() * 2 + 2.5).toFixed(2);
    html += `<span class="star" style="top:${top}%; left:${left}%; width:${size}px; height:${size}px; animation-delay:${delay}s; animation-duration:${duration}s;"></span>`;
  }
  return html;
}
const SKY_STARS_HTML = generateStarsHtml(55);

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

// ---------- Backend communication ----------
async function apiGet() {
  const res = await fetch(BACKEND_URL);
  return res.json();
}

async function apiPost(payload) {
  // Sent as text/plain (no custom headers) to avoid CORS preflight against Apps Script
  const res = await fetch(BACKEND_URL, { method: "POST", body: JSON.stringify(payload) });
  return res.json();
}

function backendToState(raw) {
  const teachers = (raw.teachers || []).map((t) => ({
    id: t.ID, name: t.Name, subject: t.Subject, phone: t.Phone, photo: t.PhotoURL || null,
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
  Object.keys(settings).forEach((k) => {
    if (k.startsWith("override_") && settings[k]) {
      const rest = k.slice("override_".length);
      const idx = rest.lastIndexOf("_");
      const teacherId = rest.slice(0, idx);
      const category = rest.slice(idx + 1);
      overrides[`${teacherId}:${category}`] = settings[k];
    }
  });

  return {
    teachers, documents, schedules, overrides,
    adminPin: settings.adminPin || null,
  };
}

// ---------- Persistence ----------
async function loadData() {
  try {
    const raw = await apiGet();
    state.data = backendToState(raw);
    state.saveError = "";
  } catch (e) {
    state.saveError = "Could not connect to the backend. Check BACKEND_URL in script.js.";
  } finally {
    state.loaded = true;
    render();
  }
}

async function refreshData() {
  try {
    const raw = await apiGet();
    state.data = backendToState(raw);
    state.saveError = "";
  } catch (e) {
    state.saveError = "Could not save. Please check your connection and try again.";
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
  const res = await apiPost({ action: "setSetting", key, value: JSON.stringify(schedule) });
  if (res && res.success) {
    state.data.schedules[category] = schedule;
    state.saveError = "";
  } else {
    state.saveError = "Could not update schedule. Please try again.";
  }
  render();
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
  const res = await apiPost({ action: "setSetting", key, value: dateStr || "" });
  if (res && res.success) {
    const overrideKey = `${teacherId}:${category}`;
    if (dateStr) state.data.overrides[overrideKey] = dateStr;
    else delete state.data.overrides[overrideKey];
    state.saveError = "";
  } else {
    state.saveError = "Could not save due date. Please try again.";
  }
  render();
  showToast(res && res.success ? (dateStr ? "Custom due date set" : "Custom due date cleared") : "Failed to save");
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
  const res = await apiPost({ action: "setComment", docId, comment: commentText });
  if (res && res.success) {
    const doc = state.data.documents.find((d) => d.id === docId);
    if (doc) {
      doc.comment = commentText;
      doc.commentSeen = false;
    }
    state.saveError = "";
  } else {
    state.saveError = "Could not save feedback: " + (res && res.error ? res.error : "unknown error, please try again.");
  }
  render();
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
  const lpStatus = getStatus(state.data, teacherId, "lessonPlan", state.today);
  const feedbackDocs = state.data.documents.filter((d) => d.teacherId === teacherId && d.comment && !d.commentSeen);
  openFolder(teacherId);
  const overdueItems = lpStatus.overdue ? [{ cat: "lessonPlan", status: lpStatus }] : [];
  if (overdueItems.length > 0 || feedbackDocs.length > 0) {
    state.modal = { type: "notice", overdueItems, feedbackDocs };
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

  app.innerHTML = `
    <header class="top">
      <div class="header-inner">
        <div>
          <div class="school-name serif">Kyidsa Primary School</div>
          <div class="school-sub">${state.session ? `Signed in as ${esc(activeTeacher?.name || "")}` : "Teacher Records &amp; Directory"}</div>
        </div>
        <div style="display:flex; gap:8px; flex-wrap:wrap;">
          ${state.session
            ? `<button class="btn btn-ghost" data-action="logout">↩ Log out</button>`
            : `
              <button class="btn btn-ghost" data-action="set-view" data-view="home">🏠 Home</button>
              <button class="btn btn-ghost" data-action="open-teacher-login">🔓 I'm a Teacher</button>
              <button class="btn ${state.adminMode ? "btn-accent" : "btn-ghost"}" data-action="toggle-admin">🛡 ${state.adminMode ? "Admin Mode: On" : "Admin Mode"}</button>
            `}
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
  const teachers = state.data.teachers;
  return `
    <div class="section-head">
      <h2 class="serif" style="font-size:20px; margin:0; color:#4A3B22;">Teachers</h2>
      ${state.adminMode ? `<button class="btn btn-dark" data-action="open-add-teacher">➕ Add Teacher</button>` : ""}
    </div>
    ${teachers.length === 0 ? renderEmptyState() : `<div class="grid">${teachers.map(renderTeacherCard).join("")}</div>`}
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

function renderHome() {
  return `
    <div class="sky-hero">
      <div class="sky-stars">${SKY_STARS_HTML}</div>
      <div class="moon"></div>
      <div class="cloud cloud-1"></div>
      <div class="cloud cloud-2"></div>
      <div class="cloud cloud-3"></div>
      <div class="sky-content">
        <h2 class="serif" style="font-size:24px; margin:0 0 6px;">Kyidsa Primary School Portal</h2>
        <div style="font-size:13.5px; color:#c7d0e6; margin-bottom:20px;">Everything the school needs, in one place.</div>
        <button class="btn btn-ghost" data-action="set-view" data-view="directory">👩‍🏫 Go to Teacher Directory</button>
      </div>
    </div>

    <div class="home-actions">
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
    </div>

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

function renderTeacherCard(t) {
  const docCount = state.data.documents.filter((d) => d.teacherId === t.id).length;
  return `
    <div class="card">
      <div class="ring"><div class="avatar">${t.photo ? `<img src="${t.photo}" alt="${esc(t.name)}" />` : `<span class="avatar-letter">${esc((t.name || "?")[0])}</span>`}</div></div>
      <div style="text-align:center;">
        <div class="card-name">${esc(t.name)}</div>
        <div class="card-subject">${esc(t.subject || "")}</div>
      </div>
      <div class="card-doccount">${docCount} document${docCount === 1 ? "" : "s"}</div>
      <div class="card-actions">
        ${t.phone ? `<a href="tel:${esc(t.phone)}" class="btn btn-accent">📞 Call</a>` : ""}
        <button class="btn btn-dark" data-action="open-folder" data-id="${t.id}">📁 Folder</button>
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

function renderDashboard() {
  const data = state.data;
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

    <div class="doc-section" style="margin-top:22px;">
      <div class="doc-section-head"><span>Attendance &amp; TOD Reports</span></div>
      <div style="font-size:13px; color:#45526b; padding:2px 2px 10px;">
        These are now collected through the Google Forms linked on the Home page. Open the response spreadsheet
        attached to each form (share it only with yourself) to review them — set the form links in
        <code>ATTENDANCE_FORM_URL</code> and <code>TOD_FORM_URL</code> near the top of script.js.
      </div>
    </div>
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
  const documents = state.data.documents.filter((d) => d.teacherId === teacher.id);
  const isPrincipal = state.adminMode && !state.session;
  const canUpload = !!state.session && state.session.teacherId === teacher.id;
  const showBack = !state.session;

  const byNewest = (a, b) => (new Date(a.uploadedAt) < new Date(b.uploadedAt) ? 1 : -1);
  const lessonPlans = documents.filter((d) => d.category === "lessonPlan").sort(byNewest);
  const otherDocs = documents.filter((d) => d.category === "otherDocuments").sort(byNewest);

  const lpStatus = getStatus(state.data, teacher.id, "lessonPlan", state.today);
  const odStatus = getStatus(state.data, teacher.id, "otherDocuments", state.today);

  return `
    ${showBack ? `<button class="btn btn-plain" data-action="back-to-directory">⬅ Back to directory</button>` : ""}

    <div class="folder-header">
      <div class="ring"><div class="avatar" style="width:64px;height:64px;">${teacher.photo ? `<img src="${teacher.photo}" alt="${esc(teacher.name)}" />` : `<span class="avatar-letter">${esc((teacher.name || "?")[0])}</span>`}</div></div>
      <div style="flex:1; min-width:160px;">
        <div class="folder-name">${esc(teacher.name)}</div>
        <div class="folder-subject">${esc(teacher.subject || "")}</div>
      </div>
      ${teacher.phone ? `<a href="tel:${esc(teacher.phone)}" class="btn btn-accent">📞 Call ${esc(teacher.phone)}</a>` : ""}
      ${isPrincipal ? `<button class="btn btn-danger" data-action="remove-teacher" data-id="${teacher.id}">🗑 Remove</button>` : ""}
    </div>

    <div class="status-row">
      <div><span class="label">${CATEGORY_LABEL.lessonPlan}:</span>${lessonPlanPillHtml(lpStatus)}</div>
      <div><span class="label">${CATEGORY_LABEL.otherDocuments}:</span>${otherDocsPillHtml(odStatus)}</div>
    </div>

    ${canUpload ? renderUploadBox() : ""}

    ${docSectionHtml("Lesson Plans", lessonPlans, isPrincipal, false)}
    ${docSectionHtml("Other Documents", otherDocs, isPrincipal, true)}
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
              <input type="text" id="staged-class" value="${esc(p.docClass || "")}" placeholder="e.g. Class III" ${state.busyUpload ? "disabled" : ""} />
            </div>
            <div>
              <label>Subject</label>
              <input type="text" id="staged-subject" value="${esc(p.docSubject || "")}" placeholder="e.g. Dzongkha" ${state.busyUpload ? "disabled" : ""} />
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
            <input type="text" id="upload-class" placeholder="e.g. Class III" />
          </div>
          <div>
            <label>Subject</label>
            <input type="text" id="upload-subject" placeholder="e.g. Dzongkha" />
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

function docSectionHtml(title, docs, canDelete, showDocName) {
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
          ${canDelete ? commentEditorHtml(d.id, d.comment) : ""}
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
  if (m.type === "adminPin") return renderAdminPinModal();
  if (m.type === "changePin") return renderChangePinModal();
  if (m.type === "notice") return renderNoticeModal(m.overdueItems, m.feedbackDocs);
  if (m.type === "formEmbed") return renderFormEmbedModal(m.url, m.title);
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

function renderAddTeacherModal() {
  const photo = state.modal.photo || null;
  return `
    <div class="modal-overlay" data-action="modal-overlay-close">
      <div class="modal-box" data-stop-close="1">
        <div class="modal-head">
          <div class="modal-title">Add Teacher</div>
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
        <button class="btn btn-dark" style="width:100%; justify-content:center; margin-top:18px;" data-action="submit-add-teacher">Add Teacher</button>
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

function renderNoticeModal(overdueItems, feedbackDocs) {
  const hasOverdue = overdueItems && overdueItems.length > 0;
  const hasFeedback = feedbackDocs && feedbackDocs.length > 0;
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
        </div>
        <button class="btn btn-dark" style="width:100%; justify-content:center;" data-action="close-notice">Got it</button>
      </div>
    </div>
  `;
}

// ---------- Event delegation ----------
document.addEventListener("DOMContentLoaded", () => {
  loadData();

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

    if (action === "open-form") {
      const url = el.dataset.url;
      if (!url || url.startsWith("PASTE_")) {
        alert("This form link hasn't been set up yet. Paste the Google Form link into ATTENDANCE_FORM_URL / TOD_FORM_URL near the top of script.js.");
        return;
      }
      state.modal = { type: "formEmbed", url, title: el.dataset.title || "Form" };
      return render();
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

    if (action === "close-notice") {
      const feedbackDocs = (state.modal && state.modal.feedbackDocs) || [];
      state.modal = null;
      render();
      for (const d of feedbackDocs) await markCommentSeen(d.id);
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

    if (action === "submit-add-teacher") {
      const name = document.getElementById("at-name").value.trim();
      if (!name) return;
      const subject = document.getElementById("at-subject").value.trim();
      const phone = document.getElementById("at-phone").value.trim();
      const photo = state.modal.photo || null;
      state.modal = null;
      await addTeacher({ name, subject, phone, photo });
      return;
    }

    if (action === "submit-teacher-login") {
      const teacherId = document.getElementById("login-teacher-select").value;
      if (!teacherId) { state.modal.error = "Select your name."; return render(); }
      return handleTeacherLogin(teacherId);
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
        state.modal = null;
        return render();
      } else {
        if (pin !== String(state.data.adminPin)) { state.modal.error = "Incorrect PIN."; return render(); }
        state.adminMode = true;
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
