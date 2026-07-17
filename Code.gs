/**
 * Kyidsa Primary School — Apps Script Backend
 * -------------------------------------------
 * Paste this whole file into: Extensions > Apps Script (from your Google Sheet)
 * Then deploy as a Web App (Deploy > New deployment > Web app)
 *   - Execute as: Me
 *   - Who has access: Anyone
 * Copy the deployment URL into script.js (BACKEND_URL).
 *
 * Required tabs & exact column headers:
 * Teachers:   ID | Name | Subject | Phone | PhotoURL
 * Uploads:    ID | TeacherID | Category | FileName | DocName | Class | Subject | DriveFileURL | UploadedAt | Comment | CommentSeen
 * Settings:   Key | Value
 *
 * Attendance & TOD Report tabs (read-only, for the dashboard):
 * These come from Google Forms. When you set up the Attendance form and the TOD
 * Report form, choose "Select response destination" > "Select existing spreadsheet"
 * and pick THIS spreadsheet, so the responses land in it as their own tab. Then
 * rename those two tabs to exactly:
 *   "Attendance Responses"
 *   "TOD Responses"
 * (Forms name them "Form Responses 1" / "Form Responses 2" by default — just
 * rename the tab, the form keeps writing to it fine.) Whatever columns your form
 * questions create is fine; this script reads them as-is and hands them to the
 * dashboard table, no column list needs to match here.
 */

const SHEET_TEACHERS = "Teachers";
const SHEET_UPLOADS = "Uploads";
const SHEET_SETTINGS = "Settings";
const SHEET_ATTENDANCE_RESPONSES = "Attendance Responses";
const SHEET_TOD_RESPONSES = "TOD Responses";
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

// Reads a response sheet (Attendance/TOD, populated by a Google Form) if it exists.
// Returns [] if the tab hasn't been created/renamed yet, so the dashboard just shows
// "no responses yet" instead of erroring.
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
  settingsRows.forEach((r) => (settings[r.Key] = r.Value));

  const attendanceResponses = getResponseSheetData(SHEET_ATTENDANCE_RESPONSES);
  const todResponses = getResponseSheetData(SHEET_TOD_RESPONSES);

  const payload = { teachers, uploads, settings, attendanceResponses, todResponses };
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
    if (action === "removeTeacher") return removeTeacher(body);
    if (action === "addDocument") return addDocument(body);
    if (action === "removeDocument") return removeDocument(body);
    if (action === "setSetting") return setSetting(body);
    if (action === "setComment") return setComment(body);
    if (action === "markCommentSeen") return markCommentSeen(body);
    return jsonResponse({ error: "Unknown action: " + action });
  } catch (err) {
    // Surface the real error text + which action triggered it, so it's visible on the website itself
    return jsonResponse({ error: "[" + action + "] " + err.message });
  }
}

// ---------- Actions ----------

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

  appendRow(sheet, {
    ID: id, Name: body.name, Subject: body.subject || "", Phone: body.phone || "", PhotoURL: photoUrl,
  });

  const teacherFolder = getTeacherFolder(body.name);
  getSubFolder(teacherFolder, "Lesson Plans");
  getSubFolder(teacherFolder, "Other Documents");

  invalidateCache();
  return jsonResponse({ success: true, id, photoUrl });
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

function setSetting(body) {
  const sheet = getSheet(SHEET_SETTINGS);
  ensureHeaders(sheet, ["Key", "Value"]);
  const values = sheet.getDataRange().getValues();
  let found = false;
  for (let i = 1; i < values.length; i++) {
    if (values[i][0] === body.key) {
      sheet.getRange(i + 1, 2).setValue(body.value);
      found = true;
      break;
    }
  }
  if (!found) appendRow(sheet, { Key: body.key, Value: body.value });
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
