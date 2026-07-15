/**
 * Kyidsa Primary School — Apps Script Backend
 * -------------------------------------------
 * Paste this whole file into: Extensions > Apps Script (from your Google Sheet)
 * Then deploy as a Web App (Deploy > New deployment > Web app)
 *   - Execute as: Me
 *   - Who has access: Anyone
 * Copy the deployment URL into script.js (BACKEND_URL).
 */

const SHEET_TEACHERS = "Teachers";
const SHEET_UPLOADS = "Uploads";
const SHEET_SETTINGS = "Settings";
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

function appendRow(sheet, headers, obj) {
  const row = headers.map((h) => (obj[h] !== undefined ? obj[h] : ""));
  sheet.appendRow(row);
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

function doGet(e) {
  ensureHeaders(getSheet(SHEET_TEACHERS), ["ID", "Name", "Subject", "Phone", "PhotoURL"]);
  ensureHeaders(getSheet(SHEET_UPLOADS), ["ID", "TeacherID", "Category", "FileName", "DocName", "DriveFileURL", "UploadedAt"]);
  ensureHeaders(getSheet(SHEET_SETTINGS), ["Key", "Value"]);

  const teachers = sheetToObjects(getSheet(SHEET_TEACHERS));
  const uploads = sheetToObjects(getSheet(SHEET_UPLOADS));
  const settingsRows = sheetToObjects(getSheet(SHEET_SETTINGS));
  const settings = {};
  settingsRows.forEach((r) => (settings[r.Key] = r.Value));

  return jsonResponse({ teachers, uploads, settings });
}

function doPost(e) {
  const body = JSON.parse(e.postData.contents);
  const action = body.action;

  try {
    if (action === "addTeacher") return addTeacher(body);
    if (action === "removeTeacher") return removeTeacher(body);
    if (action === "addDocument") return addDocument(body);
    if (action === "removeDocument") return removeDocument(body);
    if (action === "setSetting") return setSetting(body);
    return jsonResponse({ error: "Unknown action" });
  } catch (err) {
    return jsonResponse({ error: err.message });
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
    photoUrl = "https://drive.google.com/uc?export=view&id=" + file.getId();
  }

  appendRow(sheet, ["ID", "Name", "Subject", "Phone", "PhotoURL"], {
    ID: id, Name: body.name, Subject: body.subject || "", Phone: body.phone || "", PhotoURL: photoUrl,
  });

  // Pre-create the folder structure right away
  const teacherFolder = getTeacherFolder(body.name);
  getSubFolder(teacherFolder, "Lesson Plans");
  getSubFolder(teacherFolder, "Other Documents");

  return jsonResponse({ success: true, id });
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
  // Remove their upload records too (Drive folder is left intact for archival)
  const uploadsSheet = getSheet(SHEET_UPLOADS);
  const uploadValues = uploadsSheet.getDataRange().getValues();
  for (let i = uploadValues.length - 1; i >= 1; i--) {
    if (uploadValues[i][1] === body.teacherId) uploadsSheet.deleteRow(i + 1);
  }
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
  appendRow(sheet, ["ID", "TeacherID", "Category", "FileName", "DocName", "DriveFileURL", "UploadedAt"], {
    ID: id,
    TeacherID: body.teacherId,
    Category: body.category,
    FileName: body.fileName,
    DocName: body.docName || "",
    DriveFileURL: fileUrl,
    UploadedAt: new Date().toISOString(),
  });

  return jsonResponse({ success: true, id, fileUrl });
}

function removeDocument(body) {
  const sheet = getSheet(SHEET_UPLOADS);
  const values = sheet.getDataRange().getValues();
  for (let i = 1; i < values.length; i++) {
    if (values[i][0] === body.docId) {
      // Optionally also trash the Drive file:
      // DriveApp.getFileById(extractIdFromUrl(values[i][5])).setTrashed(true);
      sheet.deleteRow(i + 1);
      break;
    }
  }
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
  if (!found) appendRow(sheet, ["Key", "Value"], { Key: body.key, Value: body.value });
  return jsonResponse({ success: true });
}
