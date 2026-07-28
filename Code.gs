/**
 * Kyidsa Primary School — Apps Script Backend
 * -------------------------------------------
 * Paste this whole file into: Extensions > Apps Script (from your Google Sheet)
 * Then deploy as a Web App (Deploy > New deployment > Web app)
 *   - Execute as: Me
 *   - Who has access: Anyone
 * Copy the deployment URL into script.js (BACKEND_URL).
 *
 * IMPORTANT — after pasting this in, you MUST publish a new deployment version
 * for the live site to actually run it:
 *   Deploy > Manage deployments > (pencil icon on your existing deployment)
 *   > Version: New version > Deploy
 * Just saving the code here does NOT update the live .../exec URL by itself.
 *
 * Required tabs & exact column headers:
 * Teachers:   ID | Name | Subject | Phone | PhotoURL
 * Uploads:    ID | TeacherID | Category | FileName | DocName | Class | Subject | DriveFileURL | UploadedAt | Comment | CommentSeen
 * Settings:   Key | Value
 *
 * Attendance, TOD Report & Leave Request tabs (read-only, for the dashboard):
 * These come from Google Forms. When you set up the Attendance form, the TOD
 * Report form, and the Leave Request form, choose "Select response destination" >
 * "Select existing spreadsheet" and pick THIS spreadsheet, so the responses land
 * in it as their own tab. Then rename those tabs to exactly:
 *   "Attendance Responses"
 *   "TOD Responses"
 *   "Leave Requests"
 * (Google Forms names new response tabs "Form Responses 1" / "2" / "3" by
 * default — you have to manually rename the tab yourself; the form keeps
 * writing to it fine after renaming.) Whatever columns your form questions
 * create is fine; this script reads them as-is and hands them to the dashboard
 * table, no fixed column list needs to match here.
 *
 * For the Leave Request form specifically, the dashboard looks for questions whose
 * wording contains: "Name", "Start", "End", and (optionally) "Reason" — e.g.
 * "Teacher Name", "Leave Start Date", "Leave End Date", "Reason for Leave". Use the
 * Form's "Date" question type for the two date questions so they sort/compare
 * correctly. Approve/reject decisions are NOT written into this sheet — they're
 * stored in the Settings tab instead, so the Form can keep appending new rows
 * without ever conflicting with an admin decision.
 *
 * "Folders" and "Links" tabs are created automatically the first time they're
 * needed — no manual setup required. "Folders" logs custom Drive subfolders a
 * teacher creates from their dashboard (these can be nested arbitrarily deep —
 * a folder inside a folder inside a folder, etc. — tracked via ParentFolderId).
 * "Links" logs pasted title+URL resources (e.g. a Google Doc/Sheet link),
 * addable by either the teacher or the Principal.
 *
 * If you already had the Folders tab from before nesting was added, and it
 * already has rows in it, ensureHeaders won't retroactively add the two new
 * columns to a non-empty sheet — just manually add "ParentFolderId" and
 * "DriveFolderId" as extra header cells in row 1 (any position is fine). Existing
 * rows can be left blank in those columns; they'll just be treated as top-level.
 *
 * Every teacher's Drive folder is shared as "anyone with the link can edit" so
 * they can work directly in it (create/edit Docs & Sheets in place). This is set
 * automatically for new teachers. If you're adding this feature to a school that
 * already has teachers/folders, run backfillFolderSharing() once manually from
 * this editor (function dropdown at the top > select it > Run) to retroactively
 * share their existing folders too.
 *
 * Optional profile fields — Teachers and NonTeachingStaff tabs can optionally
 * have these extra columns: Gender | Qualification | Major | EmployeeID |
 * DateJoined | Email (NonTeachingStaff also: Phone). These are NOT required —
 * addTeacher/updateTeacher/addStaff/updateStaff all write to them only if the
 * column already exists in that tab, so nothing breaks if you skip this. To
 * actually use them, just add whichever column headers you want to row 1 of
 * the Teachers and/or NonTeachingStaff tab, spelled exactly as above.
 *
 * Scheduled Uploads — a teacher can stage a document now with a future date
 * (e.g. plan a whole week of lesson plans, one per day) instead of submitting
 * immediately. The file sits in a "Scheduled Uploads" holding folder inside
 * their Drive folder until that date arrives, at which point it's moved into
 * the real Lesson Plans/Other Documents folder and logged in Uploads — same as
 * any normal submission. This requires ONE manual one-time step: run
 * setupScheduledUploadsTrigger() once from this editor (function dropdown at
 * the top > select it > Run) to create the daily trigger that checks for due
 * uploads. Safe to re-run if needed — it won't create duplicate triggers.
 */

const SHEET_TEACHERS = "Teachers";
const SHEET_UPLOADS = "Uploads";
const SHEET_SETTINGS = "Settings";
const SHEET_ATTENDANCE_RESPONSES = "Attendance Responses";
const SHEET_TOD_RESPONSES = "TOD Responses";
const SHEET_LEAVE_RESPONSES = "Leave Requests";
const SHEET_FOLDERS = "Folders"; // custom Drive subfolders a teacher creates from their dashboard
const SHEET_LINKS = "Links"; // pasted title+URL resource links, per teacher
const SHEET_SCHEDULED_UPLOADS = "ScheduledUploads"; // lesson plans/documents staged now, submitted automatically on a future date
const SHEET_STAFF = "NonTeachingStaff"; // shown on the public front page alongside Teaching Staff
const PARENT_FOLDER_NAME = "Kyidsa Primary School Records";

function getSS() {
  return SpreadsheetApp.getActiveSpreadsheet();
}

function getSheet(name) {
  const ss = getSS();
  let sheet = ss.getSheetByName(name);
  if (!sheet) sheet = ss.insertSheet(name);
  return sheet;
}

function getParentFolder() {
  const folders = DriveApp.getFoldersByName(PARENT_FOLDER_NAME);
  if (folders.hasNext()) return folders.next();
  return DriveApp.createFolder(PARENT_FOLDER_NAME);
}

function getTeacherFolder(teacherName) {
  const parent = getParentFolder();
  const existing = parent.getFoldersByName(teacherName);
  let teacherFolder;
  if (existing.hasNext()) {
    teacherFolder = existing.next();
  } else {
    teacherFolder = parent.createFolder(teacherName);
  }
  return teacherFolder;
}

// Run this ONCE manually (select "backfillFolderSharing" in the function dropdown
// at the top of the Apps Script editor, then click Run) after adding the Google
// Drive folder feature. It retroactively shares every existing teacher's Drive
// folder as "anyone with the link can edit" — new teachers get this automatically
// going forward via getTeacherFolderUrl() below, but folders created before this
// feature existed need this one-time pass.
function backfillFolderSharing() {
  const parent = getParentFolder();
  const folders = parent.getFolders();
  let count = 0;
  while (folders.hasNext()) {
    const f = folders.next();
    try {
      f.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.EDIT);
      count++;
    } catch (err) {
      Logger.log("Could not share folder '" + f.getName() + "': " + err.message);
    }
  }
  Logger.log("Shared " + count + " teacher folder(s).");
}

// Ensures a teacher's Drive folder is shared "anyone with the link can edit" and
// returns its URL. Cheap enough to call per-teacher on each (cache-cold) load —
// Drive is idempotent about re-applying the same sharing setting.
function getTeacherFolderUrl(teacherName) {
  const folder = getTeacherFolder(teacherName);
  try {
    folder.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.EDIT);
  } catch (err) {
    // sharing can occasionally fail (e.g. domain policy) — still return the URL,
    // the owner can share it manually if needed
  }
  return folder.getUrl();
}

function getSubFolder(teacherFolder, subName) {
  const existing = teacherFolder.getFoldersByName(subName);
  if (existing.hasNext()) return existing.next();
  return teacherFolder.createFolder(subName);
}

function sheetToObjects(sheet) {
  const values = sheet.getDataRange().getValues();
  if (values.length < 2) return [];
  const headers = values[0];
  const rows = values.slice(1);
  return rows
    .filter((r) => r.some((cell) => cell !== "" && cell !== null))
    .map((r) => {
      const obj = {};
      headers.forEach((h, i) => (obj[h] = r[i]));
      return obj;
    });
}

// Reads a response sheet (Attendance/TOD/Leave, populated by a Google Form) if it
// exists. Returns [] if the tab hasn't been created/renamed yet, so the dashboard
// just shows "no responses yet" instead of erroring.
function getResponseSheetData(sheetName) {
  const sheet = getSS().getSheetByName(sheetName);
  if (!sheet) return [];
  return sheetToObjects(sheet);
}

// Reads the sheet's ACTUAL header row and maps obj properties by header name.
function appendRow(sheet, obj) {
  const lastCol = Math.max(sheet.getLastColumn(), 1);
  const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  const row = headers.map((h) => (obj[h] !== undefined ? obj[h] : ""));
  sheet.appendRow(row);
}

// Returns { idx: {...}, missing: [...] } — 0-based column index for each requested header,
// or -1 if not found. `missing` lists any header names that weren't present.
function getHeaderMap(sheet, headerNames) {
  const lastCol = Math.max(sheet.getLastColumn(), 1);
  const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map((h) => String(h).trim());
  const idx = {};
  const missing = [];
  headerNames.forEach((name) => {
    const i = headers.indexOf(name);
    idx[name] = i;
    if (i === -1) missing.push(name);
  });
  return { idx, missing };
}

function ensureHeaders(sheet, headers) {
  const firstRow = sheet.getRange(1, 1, 1, headers.length).getValues()[0];
  const isEmpty = firstRow.every((c) => c === "" || c === null);
  if (isEmpty) sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
}

function jsonResponse(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function uid() {
  return Utilities.getUuid();
}

// ---------- Main entry points ----------

const CACHE_KEY = "kyidsa_data_v1";
const CACHE_SECONDS = 20; // short TTL — writes below explicitly clear this so edits still show up right away

function doGet(e) {
  const cache = CacheService.getScriptCache();
  const cached = cache.get(CACHE_KEY);
  if (cached) {
    return ContentService.createTextOutput(cached).setMimeType(ContentService.MimeType.JSON);
  }

  ensureHeaders(getSheet(SHEET_TEACHERS), ["ID", "Name", "Subject", "Phone", "PhotoURL"]);
  ensureHeaders(getSheet(SHEET_UPLOADS), ["ID", "TeacherID", "Category", "FileName", "DocName", "Class", "Subject", "DriveFileURL", "UploadedAt", "Comment", "CommentSeen"]);
  ensureHeaders(getSheet(SHEET_SETTINGS), ["Key", "Value"]);

  const teachers = sheetToObjects(getSheet(SHEET_TEACHERS));
  const uploads = sheetToObjects(getSheet(SHEET_UPLOADS));
  const settingsRows = sheetToObjects(getSheet(SHEET_SETTINGS));
  const settings = {};
  settingsRows.forEach((r) => {
    settings[r.Key] = r.Value === undefined || r.Value === null ? "" : String(r.Value);
  });

  const attendanceResponses = getResponseSheetData(SHEET_ATTENDANCE_RESPONSES);
  const todResponses = getResponseSheetData(SHEET_TOD_RESPONSES);
  const leaveResponses = getResponseSheetData(SHEET_LEAVE_RESPONSES);

  ensureHeaders(getSheet(SHEET_FOLDERS), ["ID", "TeacherID", "ParentFolderId", "FolderName", "DriveFolderURL", "DriveFolderId", "CreatedAt"]);
  ensureHeaders(getSheet(SHEET_LINKS), ["ID", "TeacherID", "Title", "URL", "AddedBy", "CreatedAt"]);
  ensureHeaders(getSheet(SHEET_STAFF), ["ID", "Name", "Role", "PhotoURL"]);
  ensureHeaders(getSheet(SHEET_SCHEDULED_UPLOADS), ["ID", "TeacherID", "Category", "FileName", "DocName", "Class", "Subject", "DriveFileId", "ScheduledDate", "Status", "CreatedAt"]);
  const customFolders = sheetToObjects(getSheet(SHEET_FOLDERS));
  const links = sheetToObjects(getSheet(SHEET_LINKS));
  const staff = sheetToObjects(getSheet(SHEET_STAFF));
  const scheduledUploads = sheetToObjects(getSheet(SHEET_SCHEDULED_UPLOADS)).filter((r) => r.Status !== "submitted");

  const teacherFolderUrls = {};
  teachers.forEach((t) => {
    try {
      teacherFolderUrls[t.ID] = getTeacherFolderUrl(t.Name);
    } catch (err) {
      teacherFolderUrls[t.ID] = "";
    }
  });

  const payload = { teachers, uploads, settings, attendanceResponses, todResponses, leaveResponses, customFolders, links, teacherFolderUrls, staff, scheduledUploads };
  const json = JSON.stringify(payload);
  try {
    cache.put(CACHE_KEY, json, CACHE_SECONDS);
  } catch (err) {
    // Payload too large for the 100KB cache limit — fine, just skip caching this time.
  }
  return jsonResponse(payload);
}

// Call this at the end of anything that changes sheet data, so the next load is fresh
// instead of waiting out the cache TTL.
function invalidateCache() {
  try {
    CacheService.getScriptCache().remove(CACHE_KEY);
  } catch (err) {
    // ignore
  }
}

function doPost(e) {
  let body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    return jsonResponse({ error: "Could not parse request: " + err.message });
  }

  const action = body.action;
  try {
    if (action === "addTeacher") return addTeacher(body);
    if (action === "updateTeacher") return updateTeacher(body);
    if (action === "removeTeacher") return removeTeacher(body);
    if (action === "addDocument") return addDocument(body);
    if (action === "removeDocument") return removeDocument(body);
    if (action === "setSetting") return setSetting(body);
    if (action === "setComment") return setComment(body);
    if (action === "markCommentSeen") return markCommentSeen(body);
    if (action === "createFolder") return createFolder(body);
    if (action === "removeFolderRecord") return removeFolderRecord(body);
    if (action === "addLink") return addLink(body);
    if (action === "removeLink") return removeLink(body);
    if (action === "addStaff") return addStaff(body);
    if (action === "updateStaff") return updateStaff(body);
    if (action === "removeStaff") return removeStaff(body);
    if (action === "scheduleUpload") return scheduleUpload(body);
    if (action === "cancelScheduledUpload") return cancelScheduledUpload(body);
    if (action === "rescheduleUpload") return rescheduleUpload(body);
    return jsonResponse({ error: "Unknown action: " + action });
  } catch (err) {
    // Surface the real error text + which action triggered it, so it's visible on the website itself
    return jsonResponse({ error: "[" + action + "] " + err.message });
  }
}

// ---------- Actions ----------

// Writes to a column only if it actually exists in the sheet's header row — lets
// new optional fields (Gender, Qualification, etc.) work immediately for sheets
// that already have those columns, without erroring out for ones that don't yet.
function trySetColumn(sheet, allHeaders, rowIndex, columnName, value) {
  const idx = allHeaders.indexOf(columnName);
  if (idx === -1) return;
  sheet.getRange(rowIndex + 1, idx + 1).setValue(value);
}

function addTeacher(body) {
  const sheet = getSheet(SHEET_TEACHERS);
  ensureHeaders(sheet, ["ID", "Name", "Subject", "Phone", "PhotoURL"]);
  const id = uid();

  let photoUrl = "";
  if (body.photoBase64) {
    const teacherFolder = getTeacherFolder(body.name);
    const blob = Utilities.newBlob(Utilities.base64Decode(body.photoBase64.split(",")[1]), body.photoMime || "image/jpeg", "photo");
    const file = teacherFolder.createFile(blob);
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    photoUrl = "https://drive.google.com/thumbnail?id=" + file.getId() + "&sz=w400";
  }

  // Gender/Qualification/Major/EmployeeID/DateJoined/Email are optional extra
  // columns — appendRow silently ignores any of these that aren't in the sheet
  // yet, so this works whether or not you've added them to the Teachers tab.
  appendRow(sheet, {
    ID: id, Name: body.name, Subject: body.subject || "", Phone: body.phone || "", PhotoURL: photoUrl,
    Gender: body.gender || "", Qualification: body.qualification || "", Major: body.major || "",
    EmployeeID: body.employeeId || "", DateJoined: body.dateJoined || "", Email: body.email || "",
  });

  const teacherFolder = getTeacherFolder(body.name);
  getSubFolder(teacherFolder, "Lesson Plans");
  getSubFolder(teacherFolder, "Other Documents");

  invalidateCache();
  return jsonResponse({ success: true, id, photoUrl });
}

// Lets the Principal correct a teacher's name/subject/phone/photo after the fact.
// The one tricky part: the Drive folder is looked up BY NAME elsewhere in this
// file (getTeacherFolder), so if the name changes, we rename the actual Drive
// folder to match — otherwise a brand-new (empty) folder would silently get
// created under the new name on their next upload, orphaning all their existing files.
function updateTeacher(body) {
  const sheet = getSheet(SHEET_TEACHERS);
  const { idx, missing } = getHeaderMap(sheet, ["ID", "Name", "Subject", "Phone", "PhotoURL"]);
  if (missing.length > 0) {
    return jsonResponse({ error: "Teachers tab is missing column(s): " + missing.join(", ") + ". Check exact spelling/capitalization." });
  }

  const newName = String(body.name || "").trim();
  if (!newName) return jsonResponse({ error: "Name is required." });

  const values = sheet.getDataRange().getValues();
  let rowIndex = -1;
  let oldName = "";
  for (let i = 1; i < values.length; i++) {
    if (values[i][idx.ID] === body.teacherId) {
      rowIndex = i;
      oldName = values[i][idx.Name];
      break;
    }
  }
  if (rowIndex === -1) return jsonResponse({ error: "Teacher not found." });

  if (newName !== oldName) {
    try {
      getTeacherFolder(oldName).setName(newName);
    } catch (err) {
      // If this fails, the record still updates — a fresh folder just gets
      // created under the new name on their next upload instead of reusing the old one.
    }
  }

  let photoUrl = values[rowIndex][idx.PhotoURL] || "";
  if (body.photoBase64) {
    const teacherFolder = getTeacherFolder(newName);
    const blob = Utilities.newBlob(Utilities.base64Decode(body.photoBase64.split(",")[1]), body.photoMime || "image/jpeg", "photo");
    const file = teacherFolder.createFile(blob);
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    photoUrl = "https://drive.google.com/thumbnail?id=" + file.getId() + "&sz=w400";
  }

  sheet.getRange(rowIndex + 1, idx.Name + 1).setValue(newName);
  sheet.getRange(rowIndex + 1, idx.Subject + 1).setValue(body.subject || "");
  sheet.getRange(rowIndex + 1, idx.Phone + 1).setValue(body.phone || "");
  sheet.getRange(rowIndex + 1, idx.PhotoURL + 1).setValue(photoUrl);

  // These are optional extra columns — written only if the Teachers tab actually
  // has them (see trySetColumn), so this doesn't break for sheets that don't yet.
  const allHeaders = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  trySetColumn(sheet, allHeaders, rowIndex, "Gender", body.gender || "");
  trySetColumn(sheet, allHeaders, rowIndex, "Qualification", body.qualification || "");
  trySetColumn(sheet, allHeaders, rowIndex, "Major", body.major || "");
  trySetColumn(sheet, allHeaders, rowIndex, "EmployeeID", body.employeeId || "");
  trySetColumn(sheet, allHeaders, rowIndex, "DateJoined", body.dateJoined || "");
  trySetColumn(sheet, allHeaders, rowIndex, "Email", body.email || "");

  // Uploads/Folders/Links all reference the stable TeacherID, not the name, so
  // they stay correctly linked automatically — only the Drive folder rename above
  // was needed since that lookup happens by name.

  invalidateCache();
  return jsonResponse({ success: true, photoUrl });
}

function removeTeacher(body) {
  const sheet = getSheet(SHEET_TEACHERS);
  const values = sheet.getDataRange().getValues();
  for (let i = 1; i < values.length; i++) {
    if (values[i][0] === body.teacherId) {
      sheet.deleteRow(i + 1);
      break;
    }
  }
  const uploadsSheet = getSheet(SHEET_UPLOADS);
  const uploadValues = uploadsSheet.getDataRange().getValues();
  for (let i = uploadValues.length - 1; i >= 1; i--) {
    if (uploadValues[i][1] === body.teacherId) uploadsSheet.deleteRow(i + 1);
  }
  invalidateCache();
  return jsonResponse({ success: true });
}

function addDocument(body) {
  const teacherFolder = getTeacherFolder(body.teacherName);
  const subFolderName = body.category === "otherDocuments" ? "Other Documents" : "Lesson Plans";
  const subFolder = getSubFolder(teacherFolder, subFolderName);

  const base64Data = body.fileBase64.split(",")[1];
  const blob = Utilities.newBlob(Utilities.base64Decode(base64Data), body.mimeType || "application/octet-stream", body.fileName);
  const file = subFolder.createFile(blob);
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  const fileUrl = file.getUrl();

  const sheet = getSheet(SHEET_UPLOADS);
  const id = uid();
  appendRow(sheet, {
    ID: id,
    TeacherID: body.teacherId,
    Category: body.category,
    FileName: body.fileName,
    DocName: body.docName || "",
    Class: body.class || "",
    Subject: body.subject || "",
    DriveFileURL: fileUrl,
    UploadedAt: new Date().toISOString(),
    Comment: "",
    CommentSeen: "true",
  });

  invalidateCache();
  return jsonResponse({ success: true, id, fileUrl });
}

function removeDocument(body) {
  const sheet = getSheet(SHEET_UPLOADS);
  const values = sheet.getDataRange().getValues();
  for (let i = 1; i < values.length; i++) {
    if (values[i][0] === body.docId) {
      sheet.deleteRow(i + 1);
      break;
    }
  }
  invalidateCache();
  return jsonResponse({ success: true });
}

// ---------- Scheduled Uploads (stage a document now, it lands in the real folder
// automatically on a future date, via a daily time-driven trigger) ----------

// Files park here (inside the teacher's own Drive folder) until their scheduled
// date arrives, at which point processScheduledUploads() moves them into the
// real Lesson Plans / Other Documents folder.
function getScheduledHoldingFolder(teacherFolder) {
  return getSubFolder(teacherFolder, "Scheduled Uploads");
}

function scheduleUpload(body) {
  if (!body.scheduledDate) return jsonResponse({ error: "A scheduled date is required." });

  const teacherFolder = getTeacherFolder(body.teacherName);
  const holdingFolder = getScheduledHoldingFolder(teacherFolder);

  const base64Data = body.fileBase64.split(",")[1];
  const blob = Utilities.newBlob(Utilities.base64Decode(base64Data), body.mimeType || "application/octet-stream", body.fileName);
  const file = holdingFolder.createFile(blob);
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);

  const sheet = getSheet(SHEET_SCHEDULED_UPLOADS);
  ensureHeaders(sheet, ["ID", "TeacherID", "Category", "FileName", "DocName", "Class", "Subject", "DriveFileId", "ScheduledDate", "Status", "CreatedAt"]);
  const id = uid();
  appendRow(sheet, {
    ID: id,
    TeacherID: body.teacherId,
    Category: body.category,
    FileName: body.fileName,
    DocName: body.docName || "",
    Class: body.class || "",
    Subject: body.subject || "",
    DriveFileId: file.getId(),
    ScheduledDate: body.scheduledDate, // "YYYY-MM-DD"
    Status: "pending",
    CreatedAt: new Date().toISOString(),
  });

  invalidateCache();
  return jsonResponse({ success: true, id });
}

// Cancelling deletes the held file too (unlike real submissions, which we never
// auto-delete) — a cancelled scheduled upload was never actually submitted, so
// there's nothing worth keeping around; the teacher can just stage it again.
function cancelScheduledUpload(body) {
  const sheet = getSheet(SHEET_SCHEDULED_UPLOADS);
  const values = sheet.getDataRange().getValues();
  for (let i = 1; i < values.length; i++) {
    if (values[i][0] === body.scheduleId) {
      const driveFileId = values[i][7]; // DriveFileId column
      try {
        if (driveFileId) DriveApp.getFileById(driveFileId).setTrashed(true);
      } catch (err) {
        // file may already be gone — fine, still remove the tracking row
      }
      sheet.deleteRow(i + 1);
      break;
    }
  }
  invalidateCache();
  return jsonResponse({ success: true });
}

function rescheduleUpload(body) {
  const sheet = getSheet(SHEET_SCHEDULED_UPLOADS);
  const { idx, missing } = getHeaderMap(sheet, ["ID", "ScheduledDate"]);
  if (missing.length > 0) return jsonResponse({ error: "ScheduledUploads tab is missing column(s): " + missing.join(", ") });
  const values = sheet.getDataRange().getValues();
  for (let i = 1; i < values.length; i++) {
    if (values[i][idx.ID] === body.scheduleId) {
      sheet.getRange(i + 1, idx.ScheduledDate + 1).setValue(body.scheduledDate);
      invalidateCache();
      return jsonResponse({ success: true });
    }
  }
  return jsonResponse({ error: "Scheduled upload not found." });
}

// Runs automatically once a day (see setupScheduledUploadsTrigger below). Finds
// every "pending" scheduled upload whose date has arrived, moves its file into
// the real Lesson Plans / Other Documents folder, and logs it in Uploads exactly
// like a normal submission — from that point it's indistinguishable from one.
function processScheduledUploads() {
  const sheet = getSheet(SHEET_SCHEDULED_UPLOADS);
  const { idx, missing } = getHeaderMap(sheet, ["ID", "TeacherID", "Category", "FileName", "DocName", "Class", "Subject", "DriveFileId", "ScheduledDate", "Status"]);
  if (missing.length > 0) return; // sheet not set up yet — nothing to do

  const values = sheet.getDataRange().getValues();
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // Cache TeacherID -> Name so we can find each teacher's Drive folder without
  // re-reading the Teachers sheet for every single scheduled row.
  const teachersSheet = getSheet(SHEET_TEACHERS);
  const teacherRows = sheetToObjects(teachersSheet);
  const teacherNameById = {};
  teacherRows.forEach((t) => { teacherNameById[t.ID] = t.Name; });

  for (let i = 1; i < values.length; i++) {
    const status = values[i][idx.Status];
    if (status !== "pending") continue;

    const scheduledDate = new Date(values[i][idx.ScheduledDate]);
    scheduledDate.setHours(0, 0, 0, 0);
    if (isNaN(scheduledDate.getTime()) || scheduledDate > today) continue; // not due yet

    try {
      const teacherId = values[i][idx.TeacherID];
      const teacherName = teacherNameById[teacherId];
      if (!teacherName) continue; // teacher was removed — skip, leave row as-is for manual review

      const category = values[i][idx.Category];
      const fileName = values[i][idx.FileName];
      const docName = values[i][idx.DocName];
      const cls = values[i][idx.Class];
      const subject = values[i][idx.Subject];
      const driveFileId = values[i][idx.DriveFileId];

      const file = DriveApp.getFileById(driveFileId);
      const teacherFolder = getTeacherFolder(teacherName);
      const targetFolder = getSubFolder(teacherFolder, category === "otherDocuments" ? "Other Documents" : "Lesson Plans");
      const holdingFolder = getScheduledHoldingFolder(teacherFolder);

      targetFolder.addFile(file);
      holdingFolder.removeFile(file);

      const uploadsSheet = getSheet(SHEET_UPLOADS);
      appendRow(uploadsSheet, {
        ID: uid(),
        TeacherID: teacherId,
        Category: category,
        FileName: fileName,
        DocName: docName || "",
        Class: cls || "",
        Subject: subject || "",
        DriveFileURL: file.getUrl(),
        UploadedAt: new Date().toISOString(),
        Comment: "",
        CommentSeen: "true",
      });

      sheet.getRange(i + 1, idx.Status + 1).setValue("submitted");
    } catch (err) {
      Logger.log("processScheduledUploads failed for row " + (i + 1) + ": " + err.message);
      // leave this row as "pending" so it's retried on the next run rather than lost
    }
  }

  invalidateCache();
}

// Run this ONCE manually (function dropdown at the top of this editor > select
// "setupScheduledUploadsTrigger" > Run) to make processScheduledUploads() run
// automatically every day. Safe to re-run — it clears any previous copy of this
// trigger first, so re-running never creates duplicates.
function setupScheduledUploadsTrigger() {
  ScriptApp.getProjectTriggers().forEach((t) => {
    if (t.getHandlerFunction() === "processScheduledUploads") ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger("processScheduledUploads")
    .timeBased()
    .everyDays(1)
    .atHour(6) // runs once daily, sometime in the 6-7am window (Apps Script doesn't guarantee the exact minute)
    .create();
}

function setSetting(body) {
  const sheet = getSheet(SHEET_SETTINGS);
  ensureHeaders(sheet, ["Key", "Value"]);
  const values = sheet.getDataRange().getValues();
  let found = false;
  for (let i = 1; i < values.length; i++) {
    if (values[i][0] === body.key) {
      const cell = sheet.getRange(i + 1, 2);
      cell.setNumberFormat("@"); // plain text — stops Sheets auto-converting digit-only values (e.g. a PIN) into a Number
      cell.setValue(String(body.value));
      found = true;
      break;
    }
  }
  if (!found) {
    const newRow = sheet.getLastRow() + 1;
    sheet.getRange(newRow, 1).setValue(body.key);
    const valueCell = sheet.getRange(newRow, 2);
    valueCell.setNumberFormat("@");
    valueCell.setValue(String(body.value));
  }
  invalidateCache();
  return jsonResponse({ success: true });
}

function setComment(body) {
  const sheet = getSheet(SHEET_UPLOADS);
  const { idx, missing } = getHeaderMap(sheet, ["ID", "Comment", "CommentSeen"]);
  if (missing.length > 0) {
    return jsonResponse({ error: "Uploads tab is missing column(s): " + missing.join(", ") + ". Check exact spelling/capitalization." });
  }
  const values = sheet.getDataRange().getValues();
  let found = false;
  for (let i = 1; i < values.length; i++) {
    if (values[i][idx.ID] === body.docId) {
      sheet.getRange(i + 1, idx.Comment + 1).setValue(body.comment || "");
      sheet.getRange(i + 1, idx.CommentSeen + 1).setValue("false");
      found = true;
      break;
    }
  }
  if (!found) return jsonResponse({ error: "No document found with ID: " + body.docId });
  invalidateCache();
  return jsonResponse({ success: true });
}

function markCommentSeen(body) {
  const sheet = getSheet(SHEET_UPLOADS);
  const { idx, missing } = getHeaderMap(sheet, ["ID", "CommentSeen"]);
  if (missing.length > 0) return jsonResponse({ success: true }); // nothing to mark if columns don't exist
  const values = sheet.getDataRange().getValues();
  for (let i = 1; i < values.length; i++) {
    if (values[i][idx.ID] === body.docId) {
      sheet.getRange(i + 1, idx.CommentSeen + 1).setValue("true");
      break;
    }
  }
  invalidateCache();
  return jsonResponse({ success: true });
}

// Creates (or reuses, if one by this name already exists) a subfolder inside the
// teacher's Drive folder, shares it the same way, and logs it in the Folders sheet
// so it shows up on both the teacher's own dashboard and the Principal's view of
// their folder — exactly like Lesson Plans / Other Documents already do.
function createFolder(body) {
  const folderName = String(body.folderName || "").trim();
  if (!folderName) return jsonResponse({ error: "Folder name is required." });

  let parentFolder;
  if (body.parentFolderId) {
    try {
      parentFolder = DriveApp.getFolderById(body.parentFolderId);
    } catch (err) {
      return jsonResponse({ error: "Could not find the parent folder — it may have been deleted or renamed directly in Drive." });
    }
  } else {
    parentFolder = getTeacherFolder(body.teacherName);
  }

  const existing = parentFolder.getFoldersByName(folderName);
  const folder = existing.hasNext() ? existing.next() : parentFolder.createFolder(folderName);
  try {
    folder.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.EDIT);
  } catch (err) {
    // ignore — folder still gets created/logged even if sharing fails
  }

  const sheet = getSheet(SHEET_FOLDERS);
  ensureHeaders(sheet, ["ID", "TeacherID", "ParentFolderId", "FolderName", "DriveFolderURL", "DriveFolderId", "CreatedAt"]);
  const id = uid();
  const folderUrl = folder.getUrl();
  const folderId = folder.getId();
  appendRow(sheet, {
    ID: id, TeacherID: body.teacherId, ParentFolderId: body.parentFolderId || "",
    FolderName: folderName, DriveFolderURL: folderUrl, DriveFolderId: folderId,
    CreatedAt: new Date().toISOString(),
  });

  invalidateCache();
  return jsonResponse({ success: true, id, folderUrl, folderId });
}

// Removes the tracking row only — deliberately does NOT delete the actual Drive
// folder (or its contents), so this can't accidentally destroy someone's work.
// If the folder itself should go, that's done manually in Drive.
function removeFolderRecord(body) {
  const sheet = getSheet(SHEET_FOLDERS);
  const values = sheet.getDataRange().getValues();
  for (let i = 1; i < values.length; i++) {
    if (values[i][0] === body.folderId) {
      sheet.deleteRow(i + 1);
      break;
    }
  }
  invalidateCache();
  return jsonResponse({ success: true });
}

function addLink(body) {
  const url = String(body.url || "").trim();
  if (!url) return jsonResponse({ error: "A URL is required." });

  const sheet = getSheet(SHEET_LINKS);
  ensureHeaders(sheet, ["ID", "TeacherID", "Title", "URL", "AddedBy", "CreatedAt"]);
  const id = uid();
  appendRow(sheet, {
    ID: id,
    TeacherID: body.teacherId,
    Title: (body.title || "").trim() || url,
    URL: url,
    AddedBy: body.addedBy || "",
    CreatedAt: new Date().toISOString(),
  });

  invalidateCache();
  return jsonResponse({ success: true, id });
}

function removeLink(body) {
  const sheet = getSheet(SHEET_LINKS);
  const values = sheet.getDataRange().getValues();
  for (let i = 1; i < values.length; i++) {
    if (values[i][0] === body.linkId) {
      sheet.deleteRow(i + 1);
      break;
    }
  }
  invalidateCache();
  return jsonResponse({ success: true });
}

// ---------- Non-Teaching Staff (front-page roster — name/role/photo only, no folders/uploads) ----------
function getStaffPhotosFolder() {
  const parent = getParentFolder();
  const existing = parent.getFoldersByName("Staff Photos");
  return existing.hasNext() ? existing.next() : parent.createFolder("Staff Photos");
}

function addStaff(body) {
  const name = String(body.name || "").trim();
  if (!name) return jsonResponse({ error: "Name is required." });

  let photoUrl = "";
  if (body.photoBase64) {
    const folder = getStaffPhotosFolder();
    const blob = Utilities.newBlob(Utilities.base64Decode(body.photoBase64.split(",")[1]), body.photoMime || "image/jpeg", "photo");
    const file = folder.createFile(blob);
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    photoUrl = "https://drive.google.com/thumbnail?id=" + file.getId() + "&sz=w400";
  }

  const sheet = getSheet(SHEET_STAFF);
  ensureHeaders(sheet, ["ID", "Name", "Role", "PhotoURL"]);
  const id = uid();
  appendRow(sheet, {
    ID: id, Name: name, Role: body.role || "", PhotoURL: photoUrl,
    Gender: body.gender || "", Qualification: body.qualification || "", Major: body.major || "",
    EmployeeID: body.employeeId || "", DateJoined: body.dateJoined || "", Phone: body.phone || "", Email: body.email || "",
  });

  invalidateCache();
  return jsonResponse({ success: true, id, photoUrl });
}

function updateStaff(body) {
  const sheet = getSheet(SHEET_STAFF);
  const { idx, missing } = getHeaderMap(sheet, ["ID", "Name", "Role", "PhotoURL"]);
  if (missing.length > 0) {
    return jsonResponse({ error: "NonTeachingStaff tab is missing column(s): " + missing.join(", ") });
  }
  const values = sheet.getDataRange().getValues();
  let rowIndex = -1;
  for (let i = 1; i < values.length; i++) {
    if (values[i][idx.ID] === body.staffId) { rowIndex = i; break; }
  }
  if (rowIndex === -1) return jsonResponse({ error: "Staff member not found." });

  const name = String(body.name || "").trim();
  if (!name) return jsonResponse({ error: "Name is required." });

  let photoUrl = values[rowIndex][idx.PhotoURL] || "";
  if (body.photoBase64) {
    const folder = getStaffPhotosFolder();
    const blob = Utilities.newBlob(Utilities.base64Decode(body.photoBase64.split(",")[1]), body.photoMime || "image/jpeg", "photo");
    const file = folder.createFile(blob);
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    photoUrl = "https://drive.google.com/thumbnail?id=" + file.getId() + "&sz=w400";
  }

  sheet.getRange(rowIndex + 1, idx.Name + 1).setValue(name);
  sheet.getRange(rowIndex + 1, idx.Role + 1).setValue(body.role || "");
  sheet.getRange(rowIndex + 1, idx.PhotoURL + 1).setValue(photoUrl);

  const allHeaders = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  trySetColumn(sheet, allHeaders, rowIndex, "Gender", body.gender || "");
  trySetColumn(sheet, allHeaders, rowIndex, "Qualification", body.qualification || "");
  trySetColumn(sheet, allHeaders, rowIndex, "Major", body.major || "");
  trySetColumn(sheet, allHeaders, rowIndex, "EmployeeID", body.employeeId || "");
  trySetColumn(sheet, allHeaders, rowIndex, "DateJoined", body.dateJoined || "");
  trySetColumn(sheet, allHeaders, rowIndex, "Phone", body.phone || "");
  trySetColumn(sheet, allHeaders, rowIndex, "Email", body.email || "");

  invalidateCache();
  return jsonResponse({ success: true, photoUrl });
}

function removeStaff(body) {
  const sheet = getSheet(SHEET_STAFF);
  const values = sheet.getDataRange().getValues();
  for (let i = 1; i < values.length; i++) {
    if (values[i][0] === body.staffId) {
      sheet.deleteRow(i + 1);
      break;
    }
  }
  invalidateCache();
  return jsonResponse({ success: true });
}
