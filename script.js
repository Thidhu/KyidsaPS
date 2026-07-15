// ---------- Constants ----------
// PASTE YOUR APPS SCRIPT WEB APP URL HERE (from Deploy > New deployment)
const BACKEND_URL = "https://script.google.com/macros/s/AKfycbxNO55TNKEu2y1UFVUkz1tT5XE8_W-0muIJyv7kLCSjjIPypMQTF2Cg96WwO-yBFxWrDg/exec";

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const CATEGORY_LABEL = { lessonPlan: "Lesson Plan", otherDocuments: "Other Document" };

function emptyData() {
  return {
    teachers: [],
    documents: [],
    schedules: {
      lessonPlan: { type: "weekly", weekday: 1 },
      otherDocuments: { type: "monthly", dayOfMonth: 28 },
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
  view: "directory", // directory | dashboard | folder
  activeTeacherId: null,
  session: null, // { teacherId }
  modal: null, // { type, ...props }
  toast: null,
  saveError: "",
  today: new Date(),
  busyUpload: false,
  pendingUpload: null, // { category, docName, fileName, mimeType, dataUrl } — staged, not yet submitted
};

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

function computeRecurringDues(schedule, today) {
  if (!schedule || schedule.type === "none") return { mostRecentDue: null, nextDue: null };
  const t = startOfDay(today);
  if (schedule.type === "weekly") {
    const target = schedule.weekday ?? 1;
    const diffToday = (t.getDay() - target + 7) % 7;
    const mostRecentDue = new Date(t);
    mostRecentDue.setDate(t.getDate() - diffToday);
    const nextDue = new Date(mostRecentDue);
    nextDue.setDate(mostRecentDue.getDate() + 7);
    return { mostRecentDue, nextDue };
  }
  if (schedule.type === "monthly") {
    const dom = Math.min(schedule.dayOfMonth ?? 28, 28);
    let mostRecentDue = new Date(t.getFullYear(), t.getMonth(), dom);
    if (mostRecentDue > t) mostRecentDue = new Date(t.getFullYear(), t.getMonth() - 1, dom);
    const nextDue = new Date(mostRecentDue);
    nextDue.setMonth(nextDue.getMonth() + 1);
    return { mostRecentDue, nextDue };
  }
  return { mostRecentDue: null, nextDue: null };
}

function latestUploadDate(documents, teacherId, category) {
  const docs = documents.filter((d) => d.teacherId === teacherId && d.category === category);
  if (docs.length === 0) return null;
  return docs.reduce((max, d) => (new Date(d.uploadedAt) > max ? new Date(d.uploadedAt) : max), new Date(docs[0].uploadedAt));
}

function getStatus(data, teacherId, category, today) {
  const overrideKey = `${teacherId}:${category}`;
  const customDueStr = data.overrides[overrideKey];
  const last = latestUploadDate(data.documents, teacherId, category);
  const t = startOfDay(today);

  if (customDueStr) {
    const customDue = startOfDay(new Date(customDueStr));
    const overdue = t >= customDue && (!last || last < customDue);
    return { overdue, dueDate: customDue, source: "custom", lastUpload: last };
  }

  const { mostRecentDue, nextDue } = computeRecurringDues(data.schedules[category], today);
  if (!mostRecentDue) return { overdue: false, dueDate: null, source: null, lastUpload: last };
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
    docName: u.DocName || undefined, dataUrl: u.DriveFileURL, uploadedAt: u.UploadedAt,
  }));

  const settings = raw.settings || {};
  const schedules = {
    lessonPlan: settings.schedule_lessonPlan ? JSON.parse(settings.schedule_lessonPlan) : { type: "weekly", weekday: 1 },
    otherDocuments: settings.schedule_otherDocuments ? JSON.parse(settings.schedule_otherDocuments) : { type: "monthly", dayOfMonth: 28 },
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
    mimeType: doc.mimeType,
    fileBase64: doc.dataUrl,
  });
  if (res && res.success) {
    state.data.documents.push({
      id: res.id, teacherId: doc.teacherId, category: doc.category, fileName: doc.fileName,
      docName: doc.docName, dataUrl: res.fileUrl, uploadedAt: doc.uploadedAt,
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

// ---------- Navigation ----------
function openFolder(teacherId) {
  state.activeTeacherId = teacherId;
  state.view = "folder";
  render();
}

function handleTeacherLogin(teacherId) {
  state.session = { teacherId };
  state.modal = null;
  const pending = ["lessonPlan", "otherDocuments"]
    .map((cat) => ({ cat, status: getStatus(state.data, teacherId, cat, state.today) }))
    .filter((x) => x.status.overdue);
  openFolder(teacherId);
  if (pending.length > 0) {
    state.modal = { type: "reminder", items: pending };
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
              <button class="btn btn-ghost" data-action="open-teacher-login">🔓 I'm a Teacher</button>
              <button class="btn ${state.adminMode ? "btn-accent" : "btn-ghost"}" data-action="toggle-admin">🛡 ${state.adminMode ? "Admin Mode: On" : "Admin Mode"}</button>
            `}
        </div>
      </div>
    </header>
    <main>
      ${state.saveError ? `<div class="error-banner">${esc(state.saveError)}</div>` : ""}
      ${state.adminMode && !state.session && state.view !== "folder" ? renderTabs() : ""}
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

function statusPillHtml(status) {
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
        <td>${statusPillHtml(lp)}${overrideEditorHtml(t.id, "lessonPlan", data.overrides[`${t.id}:lessonPlan`])}</td>
        <td>${statusPillHtml(od)}${overrideEditorHtml(t.id, "otherDocuments", data.overrides[`${t.id}:otherDocuments`])}</td>
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
      ${scheduleEditorHtml("lessonPlan", state.data.schedules.lessonPlan)}
      ${scheduleEditorHtml("otherDocuments", state.data.schedules.otherDocuments)}
    </div>

    <div class="dash-table-wrap">
      <table>
        <thead><tr><th>Teacher</th><th>Lesson Plan</th><th>Other Documents</th><th></th></tr></thead>
        <tbody>
          ${data.teachers.length === 0 ? `<tr><td colspan="4" style="color:#9A8F72; text-align:center; padding:20px;">No teachers yet.</td></tr>` : rows}
        </tbody>
      </table>
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

function scheduleEditorHtml(category, schedule) {
  const type = schedule.type;
  return `
    <div class="schedule-box" data-category="${category}">
      <div class="title">${CATEGORY_LABEL[category]} schedule</div>
      <div class="schedule-row">
        <div class="schedule-field">
          <label>Recurrence</label>
          <select data-role="schedule-type" data-category="${category}">
            <option value="none" ${type === "none" ? "selected" : ""}>None</option>
            <option value="weekly" ${type === "weekly" ? "selected" : ""}>Weekly</option>
            <option value="monthly" ${type === "monthly" ? "selected" : ""}>Monthly</option>
          </select>
        </div>
        <div class="schedule-field" data-only="weekly" style="${type === "weekly" ? "" : "display:none;"}">
          <label>Day</label>
          <select data-role="schedule-weekday" data-category="${category}">
            ${WEEKDAYS.map((d, i) => `<option value="${i}" ${schedule.weekday === i ? "selected" : ""}>${d}</option>`).join("")}
          </select>
        </div>
        <div class="schedule-field" data-only="monthly" style="${type === "monthly" ? "" : "display:none;"}">
          <label>Day of month</label>
          <input type="number" min="1" max="28" data-role="schedule-dom" data-category="${category}" value="${schedule.dayOfMonth ?? 28}" />
        </div>
        <button class="btn btn-dark" data-action="save-schedule" data-category="${category}">Save</button>
      </div>
    </div>
  `;
}

function renderFolder(teacher) {
  const documents = state.data.documents.filter((d) => d.teacherId === teacher.id);
  const isPrincipal = state.adminMode && !state.session;
  const canUpload = !!state.session && state.session.teacherId === teacher.id;
  const showBack = !state.session;

  const lessonPlans = documents.filter((d) => d.category === "lessonPlan");
  const otherDocs = documents.filter((d) => d.category === "otherDocuments");

  const statuses = ["lessonPlan", "otherDocuments"].map((cat) => ({ cat, status: getStatus(state.data, teacher.id, cat, state.today) }));

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
      ${statuses.map(({ cat, status }) => `<div><span class="label">${CATEGORY_LABEL[cat]}:</span>${statusPillHtml(status)}</div>`).join("")}
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
          <button class="btn btn-dark" data-action="submit-staged-upload" ${state.busyUpload ? "disabled" : ""}>${state.busyUpload ? "Submitting…" : "✅ Submit to folder"}</button>
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
        <div class="doc-row">
          <a href="${d.dataUrl}" download="${esc(d.fileName)}">${showDocName && d.docName ? esc(d.docName) : esc(d.fileName)}</a>
          <span class="date">${fmtDate(d.uploadedAt)}</span>
          ${canDelete ? `<button class="del" data-action="delete-doc" data-id="${d.id}">🗑</button>` : ""}
        </div>
      `).join("")}
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
  if (m.type === "reminder") return renderReminderModal(m.items);
  return "";
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

function renderReminderModal(items) {
  return `
    <div class="modal-overlay" data-action="modal-overlay-close">
      <div class="modal-box" data-stop-close="1" style="max-width:360px;">
        <div class="modal-head" style="align-items:center;">
          <div style="display:flex; align-items:center; gap:8px;">
            <span style="font-size:20px;">⚠️</span>
            <div class="modal-title">You have pending submissions</div>
          </div>
        </div>
        <div style="display:flex; flex-direction:column; gap:10px; margin-bottom:18px;">
          ${items.map(({ cat, status }) => `
            <div style="background:#F6D9D3; border-radius:9px; padding:10px 12px; font-size:13.5px; color:#7A2E2E;">
              <strong>${CATEGORY_LABEL[cat]}</strong> — due ${fmtDate(status.dueDate)}
            </div>
          `).join("")}
        </div>
        <button class="btn btn-dark" style="width:100%; justify-content:center;" data-action="close-modal">Got it</button>
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
      state.busyUpload = true;
      render();
      try {
        await addDocument({
          teacherId: state.activeTeacherId,
          category: p.category,
          fileName: p.fileName,
          docName: p.category === "otherDocuments" ? p.docName.trim() : undefined,
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
    if (action === "open-change-pin") { state.modal = { type: "changePin" }; return render(); }

    if (action === "toggle-override") {
      const wrap = el.closest(".override-wrap");
      const editRow = wrap.querySelector(".override-edit");
      editRow.style.display = editRow.style.display === "none" ? "flex" : "none";
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
    if (action === "save-schedule") {
      const box = el.closest(".schedule-box");
      const category = el.dataset.category;
      const type = box.querySelector("[data-role='schedule-type']").value;
      if (type === "weekly") {
        const weekday = Number(box.querySelector("[data-role='schedule-weekday']").value);
        await updateSchedule(category, { type, weekday });
      } else if (type === "monthly") {
        const dayOfMonth = Number(box.querySelector("[data-role='schedule-dom']").value);
        await updateSchedule(category, { type, dayOfMonth });
      } else {
        await updateSchedule(category, { type: "none" });
      }
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
        if (pin !== state.data.adminPin) { state.modal.error = "Incorrect PIN."; return render(); }
        state.adminMode = true;
        state.modal = null;
        return render();
      }
    }

    if (action === "submit-change-pin") {
      const oldPin = document.getElementById("cp-old").value.replace(/\D/g, "").slice(0, 8);
      const newPin = document.getElementById("cp-new").value.replace(/\D/g, "").slice(0, 8);
      const confirmPin = document.getElementById("cp-confirm").value.replace(/\D/g, "").slice(0, 8);
      if (oldPin !== state.data.adminPin) { state.modal.error = "Current PIN is incorrect."; return render(); }
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
      docNameField.style.display = e.target.value === "otherDocuments" ? "block" : "none";
      return;
    }

    if (e.target.dataset.role === "schedule-type") {
      const box = e.target.closest(".schedule-box");
      const type = e.target.value;
      box.querySelector("[data-only='weekly']").style.display = type === "weekly" ? "block" : "none";
      box.querySelector("[data-only='monthly']").style.display = type === "monthly" ? "block" : "none";
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
      if (category === "otherDocuments" && !docName) {
        alert("Please give this document a name first.");
        e.target.value = "";
        return;
      }
      // Stage the file for review — it is NOT uploaded yet. The teacher can still
      // edit the name/category, remove it and pick a different file, or submit it.
      const dataUrl = await readFileAsDataUrl(file);
      state.pendingUpload = {
        category,
        docName: category === "otherDocuments" ? docName : "",
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

  // Keep the staged document name in sync as the teacher edits it before submitting
  document.getElementById("app").addEventListener("input", (e) => {
    if (e.target.id === "staged-doc-name" && state.pendingUpload) {
      state.pendingUpload.docName = e.target.value;
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
