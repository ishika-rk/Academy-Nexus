import { useState, useEffect, useRef, Fragment } from "react";
import { db, auth, googleProvider } from "./firebase";
import { collection, doc, addDoc, setDoc, updateDoc, deleteDoc, onSnapshot, getDoc } from "firebase/firestore";
import { onAuthStateChanged, signInWithPopup, signOut, createUserWithEmailAndPassword, signInWithEmailAndPassword, updateProfile } from "firebase/auth";

// ─── Seed Data ────────────────────────────────────────────────────────────────

const EXAM_TITLE_PRESETS = ["Placement Online Assessment", "Preliminary Online Assessment", "DSA Assessment", "Offline Placement Exam"];
const TIME_SLOTS = ["9:00 AM – 11:00 AM", "11:00 AM – 1:00 PM", "2:00 PM – 4:00 PM", "4:00 PM – 6:00 PM"];
const BUCKETS = ["New Students Only", "Old Students Only", "Old + New (Mixed)"];
const SECTIONS = ["Aptitude", "Technical", "Domain"];
// For Config Library type filter
const EXAM_TYPES = ["Placement Online Assessment", "Preliminary Online Assessment", "DSA Assessment", "Offline Placement Exam", "Technical Assessment", "Aptitude Test", "Domain Assessment"];
const OFFLINE_EXAM_TYPES = ["Offline Placement Exam"];
const getExamProgramHead = (e) => {
  const prog = e.program || "core-assessments";
  if (prog === "online" || prog === "offline") return prog;
  return OFFLINE_EXAM_TYPES.includes(e.type) ? "offline" : "online";
};

// ─── Roles & Permissions ──────────────────────────────────────────────────────
const PERMISSIONS = {
  super_admin: ["*"],
  admin:       ["exam.read", "exam.notify", "student.read", "student.count", "configs.write", "configs.assessmentLink", "generate", "results.write"],
  poc:         ["exam.read", "exam.write", "exam.notify", "student.read", "student.write", "student.count", "configs.read", "results.write"],
  content:     ["exam.read", "student.count", "configs.write", "generate"],
};
let activePermissions = { ...PERMISSIONS };
function can(role, action) {
  const perms = activePermissions[role] || [];
  return perms.includes("*") || perms.includes(action);
}

// Returns the ISO date string (YYYY-MM-DD) of the Monday of the given date's week.
function getMondayOf(dateStr) {
  const d = new Date(dateStr + "T00:00:00");
  const day = d.getDay(); // 0=Sun, 1=Mon, ..., 6=Sat
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  return d.toISOString().slice(0, 10);
}

// Week number = rank of this date's Mon–Sun week among all weeks that have at least one exam.
// Empty calendar weeks are not counted — so no gaps in week numbering.
function getWeek(dateStr, allExams) {
  if (!dateStr || !allExams || allExams.length === 0) return null;
  const targetMonday = getMondayOf(dateStr);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const uniqueMondays = [...new Set(
    allExams
      .filter(e => e.mainStartDate && (!e.cancelled || new Date(e.mainStartDate + "T00:00:00") < today))
      .map(e => getMondayOf(e.mainStartDate))
  )].sort();
  const idx = uniqueMondays.indexOf(targetMonday);
  return idx === -1 ? null : idx + 1;
}

// Determine batch number for a given exam among all exams in the same week & same type
function _slotStartMinutes(slotStr) {
  if (!slotStr) return 0;
  const m = slotStr.match(/^(\d+):(\d+)\s*(AM|PM)/i);
  if (!m) return 0;
  let h = parseInt(m[1]), min = parseInt(m[2]);
  const ap = m[3].toUpperCase();
  if (ap === "PM" && h !== 12) h += 12;
  if (ap === "AM" && h === 12) h = 0;
  return h * 60 + min;
}

function getBatch(exam, allExams) {
  if (!exam.mainStartDate) return 1;
  const w = getWeek(exam.mainStartDate, allExams);
  const batchToday = new Date(); batchToday.setHours(0, 0, 0, 0);
  const sameWeekSameType = allExams
    .filter(e => e.type === exam.type && e.mainStartDate && (!e.cancelled || new Date(e.mainStartDate + "T00:00:00") < batchToday) && getWeek(e.mainStartDate, allExams) === w)
    .sort((a, b) => {
      const dateDiff = new Date(a.mainStartDate) - new Date(b.mainStartDate);
      if (dateDiff !== 0) return dateDiff;
      return _slotStartMinutes(a.mainSlot) - _slotStartMinutes(b.mainSlot);
    });
  const idx = sameWeekSameType.findIndex(e => e.id === exam.id);
  return idx + 1;
}

// Check which required fields are missing — drives the "incomplete" indicator on cards
function getCompletenessInfo(exam) {
  const missing = [];
  if (!exam.mainTitle)     missing.push("Main title");
  if (!exam.mainStartDate) missing.push("Main start date");
  if (!exam.mainEndDate)   missing.push("Main end date");
  if (!exam.mainSlot)      missing.push("Main time slot");
  if (exam.requireMock !== false) {
    if (!exam.mockTitle)     missing.push("Mock title");
    if (!exam.mockStartDate) missing.push("Mock start date");
    if (!exam.mockEndDate)   missing.push("Mock end date");
    if (!exam.mockSlot)      missing.push("Mock time slot");
  }
  if (exam.type === "Offline Placement Exam" && !exam.cycle) missing.push("Cycle number");
  return { isComplete: missing.length === 0, missing };
}

function _parseSlotEnd(slotStr) {
  let h = 23, m = 59;
  if (slotStr) {
    const match = slotStr.match(/[–-]\s*(\d+):(\d+)\s*(AM|PM)/i);
    if (match) {
      h = parseInt(match[1]);
      m = parseInt(match[2]);
      const period = match[3].toUpperCase();
      if (period === "PM" && h !== 12) h += 12;
      if (period === "AM" && h === 12) h = 0;
    }
  }
  return { h, m };
}

function isExamDatePast(exam) {
  if (!exam.mainEndDate) return false;
  const { h, m } = _parseSlotEnd(exam.mainSlot);
  const end = new Date(`${exam.mainEndDate}T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00`);
  return new Date() > end;
}

// Past + notified = completed. Past + not notified = flagged (not considered). Future = upcoming. Cancelled = cancelled.
function getExamStatus(exam) {
  if (exam.cancelled) return "cancelled";
  if (!isExamDatePast(exam)) return "upcoming";
  return exam.notifiedOps ? "completed" : "flagged";
}

function getMockStatus(exam) {
  if (!exam.mockEndDate) return "upcoming";
  const { h, m } = _parseSlotEnd(exam.mockSlot);
  const end = new Date(`${exam.mockEndDate}T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00`);
  return new Date() > end ? "completed" : "upcoming";
}

function businessDaysUntil(dateStr) {
  if (!dateStr) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const target = new Date(dateStr + "T00:00:00");
  if (target <= today) return 0;
  let count = 0;
  const d = new Date(today);
  while (d < target) {
    d.setDate(d.getDate() + 1);
    const day = d.getDay();
    if (day !== 0 && day !== 6) count++;
  }
  return count;
}

function handleUploadFile(examId, file, uploads, onAddUpload) {
  if (!file) return Promise.resolve();
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = async (e) => {
      const { headers, rows } = parseCSV(e.target.result);
      const existingRows = uploads.filter(u => u.examId === examId).flatMap(u => u.rows);
      const emailKey = headers.find(h => /email/i.test(h));
      const uidKey = headers.find(h => /^uid$/i.test(h));
      const seenE = new Set(existingRows.map(r => emailKey && r[emailKey]).filter(Boolean));
      const seenU = new Set(existingRows.map(r => uidKey && r[uidKey]).filter(Boolean));
      const finalRows = rows.map(row => {
        const em = emailKey && row[emailKey];
        const uid = uidKey && row[uidKey];
        const isDup = (em && seenE.has(em)) || (uid && seenU.has(uid));
        if (em) seenE.add(em);
        if (uid) seenU.add(uid);
        return { ...row, _status: isDup ? "duplicate" : "registered" };
      });
      await onAddUpload({ examId, fileName: file.name, uploadedAt: new Date().toISOString().split("T")[0], headers, rows: finalRows });
      const cleanCount = finalRows.filter(r => r._status !== "duplicate").length;
      const dupCount = finalRows.filter(r => r._status === "duplicate").length;
      resolve({ fileName: file.name, cleanCount, dupCount });
    };
    reader.readAsText(file);
  });
}

// Generate tags based on exam type, date, kind (Mock/Main), batch, cycle
function genTags(exam, allExams) {
  const isPOA = ["Placement Online Assessment", "Preliminary Online Assessment", "DSA Assessment"].includes(exam.type);
  const isOffline = exam.type === "Offline Placement Exam";

  const wMock = getWeek(exam.mainStartDate, allExams);
  const wMain = getWeek(exam.mainStartDate, allExams);
  const batch = getBatch(exam, allExams);
  const batchStr = `B${batch}`;
  const cycle = exam.cycle ? `CYCLE-${exam.cycle}` : null;

  let mockTag = "—";
  let mainTag = "—";

  if (isPOA) {
    mockTag = wMock ? `ACADEMY_PLACEMENT_ELIGIBILITY_MOCK_PRELIMS+DSA_W${wMock}` : "—";
    mainTag = wMain ? `ACADEMY_PLACEMENT_ELIGIBILITY_MAIN_PRELIMS+DSA_${batchStr}_W${wMain}` : "—";
  } else if (isOffline) {
    mockTag = wMock ? `ACADEMY_PLACEMENT_ELIGIBILITY_MOCK_OFFLINEDRIVE_W${wMock}${cycle ? `_${cycle}` : ""}` : "—";
    mainTag = wMain ? `ACADEMY_PLACEMENT_ELIGIBILITY_MAIN_OFFLINEDRIVE_${batchStr}_W${wMain}${cycle ? `_${cycle}` : ""}` : "—";
  } else {
    // Generic fallback for custom exam titles
    const slug = exam.type.toUpperCase().replace(/\s+/g, "_").slice(0, 20);
    mockTag = wMock ? `ACADEMY_${slug}_MOCK_W${wMock}` : "—";
    mainTag = wMain ? `ACADEMY_${slug}_MAIN_${batchStr}_W${wMain}` : "—";
  }

  return { mockTag, mainTag };
}

function fmtDate(d) {
  if (!d) return "—";
  return new Date(d + "T00:00:00").toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
}

function fmtDateRange(start, end) {
  if (!start) return "—";
  if (!end || end === start) return fmtDate(start);
  return `${fmtDate(start)} – ${fmtDate(end)}`;
}

function fmtDateTimeRange(startDate, endDate, slot) {
  const [t1, t2] = slot ? slot.split(" – ") : [];
  const start = startDate ? `${fmtDate(startDate)}${t1 ? `, ${t1}` : ""}` : "—";
  const sameDay = !endDate || endDate === startDate;
  const end = sameDay
    ? (t2 || null)
    : (endDate ? `${fmtDate(endDate)}${t2 ? `, ${t2}` : ""}` : null);
  return end ? `${start} – ${end}` : start;
}

// Returns { startLine, endLine } pairing each date with its time from the slot string.
function timeAgo(iso) {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function friendlyAuthError(code) {
  const map = {
    "auth/invalid-email": "Enter a valid email address.",
    "auth/user-not-found": "No account found with this email.",
    "auth/wrong-password": "Incorrect password.",
    "auth/invalid-credential": "Incorrect email or password.",
    "auth/email-already-in-use": "An account with this email already exists. Try signing in instead.",
    "auth/weak-password": "Password must be at least 6 characters.",
    "auth/too-many-requests": "Too many attempts. Please try again later.",
    "auth/network-request-failed": "Network error. Check your connection and try again.",
    "auth/operation-not-allowed": "Email/password sign-in is not enabled. Contact the super admin.",
    "auth/reregister-wrong-password": "This email is already registered. Enter the same password you used when you first registered.",
  };
  return map[code] || `Something went wrong (${code || "unknown"}). Please try again.`;
}

function fmtDateTimeLines(startDate, endDate, slot) {
  const [t1, t2] = slot ? slot.split(" – ") : [];
  const startLine = startDate ? `${fmtDate(startDate)}${t1 ? `,  ${t1}` : ""}` : "—";
  const sameDay = !endDate || endDate === startDate;
  const endLine = sameDay
    ? (t2 ? t2 : null)
    : (endDate ? `${fmtDate(endDate)}${t2 ? `,  ${t2}` : ""}` : null);
  return { startLine, endLine, sameDay };
}

function parseCSV(text) {
  const lines = text.trim().split(/\r?\n/);
  if (!lines.length) return { headers: [], rows: [] };
  const splitRow = (line) => {
    const result = [];
    let cur = "";
    let inQ = false;
    for (const ch of line) {
      if (ch === '"') inQ = !inQ;
      else if (ch === ',' && !inQ) { result.push(cur.trim()); cur = ""; }
      else cur += ch;
    }
    result.push(cur.trim());
    return result;
  };
  const headers = splitRow(lines[0]);
  const rows = lines.slice(1).filter(l => l.trim()).map(line => {
    const vals = splitRow(line);
    const row = {};
    headers.forEach((h, i) => { row[h] = vals[i] ?? ""; });
    return row;
  });
  return { headers, rows };
}

const INIT_EXAMS = [
  {
    id: 1, type: "Placement Online Assessment",
    requireMock: true,
    mockTitle: "", mainTitle: "",
    mockStartDate: "2026-05-20", mockEndDate: "2026-05-21",
    mainStartDate: "2026-05-23", mainEndDate: "2026-05-24",
    mockSlot: "9:00 AM – 11:00 AM", mainSlot: "2:00 PM – 4:00 PM",
    bucket: "New Students Only", poc: "Riya S.", status: "upcoming", cycle: "",
    mockTagOverride: "", mainTagOverride: ""
  },
  {
    id: 2, type: "Offline Placement Exam",
    requireMock: true,
    mockTitle: "", mainTitle: "",
    mockStartDate: "2026-05-27", mockEndDate: "2026-05-27",
    mainStartDate: "2026-05-30", mainEndDate: "2026-05-31",
    mockSlot: "11:00 AM – 1:00 PM", mainSlot: "2:00 PM – 4:00 PM",
    bucket: "Old + New (Mixed)", poc: "Arjun K.", status: "upcoming", cycle: "9",
    mockTagOverride: "", mainTagOverride: ""
  },
  {
    id: 3, type: "Placement Online Assessment",
    requireMock: true,
    mockTitle: "", mainTitle: "",
    mockStartDate: "2026-04-15", mockEndDate: "2026-04-15",
    mainStartDate: "2026-04-18", mainEndDate: "2026-04-18",
    mockSlot: "9:00 AM – 11:00 AM", mainSlot: "11:00 AM – 1:00 PM",
    bucket: "Old Students Only", poc: "Meena R.", status: "completed", cycle: "",
    mockTagOverride: "", mainTagOverride: ""
  },
];

const INIT_CONFIGS = [
  { id: 1, examType: "Placement Online Assessment", label: "POA Config v3 – Apr 2026", date: "2026-04-18", configLink: "https://platform.example.com/config/poa-v3", notes: "Full 3-section config. Section 1: Aptitude, Section 2: Technical, Section 3: Domain.", sections: ["Aptitude", "Technical", "Domain"], active: true },
  { id: 2, examType: "Placement Online Assessment", label: "POA Config v2 – Feb 2026", date: "2026-02-07", configLink: "https://platform.example.com/config/poa-v2", notes: "Updated domain section only.", sections: ["Aptitude", "Technical", "Domain"], active: false },
  { id: 3, examType: "Offline Placement Exam", label: "Offline Config v1 – Mar 2026", date: "2026-03-14", configLink: "https://platform.example.com/config/offline-v1", notes: "Standard offline drive config.", sections: ["Technical"], active: true },
  { id: 4, examType: "Aptitude Test", label: "APT Config v1 – Jan 2026", date: "2026-01-10", configLink: "https://platform.example.com/config/apt-v1", notes: "Aptitude only.", sections: ["Aptitude"], active: true },
];

const INIT_ASSESSMENTS = [
  { id: 1, examId: 3, label: "ACADEMY_PLACEMENT_ELIGIBILITY_MAIN_PRELIMS_DSA_B1_W17", type: "Main", link: "https://platform.example.com/asst/poa-w17-main", configLink: "https://platform.example.com/config/poa-v2", date: "2026-04-18", students: 118 },
  { id: 2, examId: 3, label: "ACADEMY_PLACEMENT_ELIGIBILITY_MOCK_PRELIMS_DSA_W17", type: "Mock", link: "https://platform.example.com/asst/poa-w17-mock", configLink: "https://platform.example.com/config/poa-v2", date: "2026-04-18", students: 118 },
];

const INIT_UPLOADS = [
  {
    id: 1, examId: 3, fileName: "students_poa_apr2026.csv", uploadedAt: "2026-04-15",
    headers: ["UID", "Name", "Email", "Phone", "YOG"],
    rows: [
      { UID: "N001", Name: "Aisha Patel",  Email: "aisha.p@academy.in",  Phone: "9876543210", YOG: "2026", _status: "registered" },
      { UID: "N002", Name: "Rohan Mehta",  Email: "rohan.m@academy.in",  Phone: "9876543211", YOG: "2026", _status: "registered" },
      { UID: "N003", Name: "Kavya Nair",   Email: "kavya.n@academy.in",  Phone: "9876543212", YOG: "2025", _status: "registered" },
      { UID: "N001", Name: "Aisha Patel",  Email: "aisha.p@academy.in",  Phone: "9876543210", YOG: "2026", _status: "duplicate" },
    ]
  },
  {
    id: 2, examId: 2, fileName: "students_offline_may2026.csv", uploadedAt: "2026-05-20",
    headers: ["UID", "Name", "Email", "Phone", "YOG"],
    rows: [
      { UID: "N004", Name: "Dev Sharma", Email: "dev.s@academy.in", Phone: "9876543213", YOG: "2026", _status: "registered" },
      { UID: "N005", Name: "Priya Rao",  Email: "priya.r@academy.in", Phone: "9876543214", YOG: "2025", _status: "registered" },
    ]
  },
];

// ─── Tracker CSV Import Utilities ─────────────────────────────────────────────
const MONTH_MAP = {
  jan:1,january:1,feb:2,february:2,mar:3,march:3,apr:4,april:4,
  may:5,jun:6,june:6,jul:7,july:7,aug:8,august:8,sep:9,september:9,
  oct:10,october:10,nov:11,november:11,dec:12,december:12
};

function parseRawCSVRows(text) {
  const rows = []; let row = [], field = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i], nx = text[i+1];
    if (inQ) {
      if (ch === '"' && nx === '"') { field += '"'; i++; }
      else if (ch === '"') { inQ = false; }
      else { field += ch === '\n' ? ' ' : ch; }
    } else {
      if (ch === '"') { inQ = true; }
      else if (ch === ',') { row.push(field.trim()); field = ''; }
      else if (ch === '\n') { row.push(field.trim()); rows.push(row); row = []; field = ''; }
      else if (ch !== '\r') { field += ch; }
    }
  }
  if (field || row.length) { row.push(field.trim()); rows.push(row); }
  return rows;
}

function parseDateTimeCell(str, fallbackMonth = null) {
  if (!str || !str.trim()) return { date: null, time: null };
  let s = str.replace(/\|\|/g, ' ').replace(/(\d+)(st|nd|rd|th)\b/gi, '$1').replace(/\s+/g, ' ').trim();
  const tm = s.match(/\b(\d{1,2})(?::(\d{2}))?\s*([AaPp][Mm])\b/);
  let time = null;
  if (tm) {
    time = `${tm[1]}:${tm[2] || '00'} ${tm[3].toUpperCase()}`;
    s = s.replace(tm[0], '').trim();
  }
  let day = null, month = null;
  for (const t of s.split(/[\s,]+/).filter(Boolean)) {
    const n = parseInt(t);
    if (!isNaN(n) && n >= 1 && n <= 31) day = n;
    else { const lc = t.toLowerCase().replace(/[.,]/g, ''); if (MONTH_MAP[lc]) month = MONTH_MAP[lc]; }
  }
  if (!month) month = fallbackMonth;
  if (!day || !month) return { date: null, time };
  const year = month === 12 ? 2025 : 2026;
  return { date: `${year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`, time };
}

function parseTrackerCSV(text) {
  const dataRows = parseRawCSVRows(text).slice(2).filter(r => r[0] && r[0].trim().startsWith('Week'));
  return dataRows.map(r => {
    const domainRaw = (r[4]  || '').trim();
    const domain    = domainRaw.toLowerCase();
    const mode    = (r[10] || '').trim();
    const mTag    = (r[17] || '').trim();
    const xTag    = (r[24] || '').trim();
    const isOffline = mode === 'Offline' || mTag.includes('OFFLINEDRIVE') || xTag.includes('OFFLINEDRIVE');
    const type = isOffline ? 'Offline Placement Exam'
      : domain.includes('prelims+dsa') || domain.includes('placement online assessment') ? 'Placement Online Assessment'
      : domain.includes('dsa') ? 'DSA Assessment'
      : domain.includes('prelims') ? 'Preliminary Online Assessment'
      : 'Placement Online Assessment';

    const mS = parseDateTimeCell(r[13]);
    const mE = parseDateTimeCell(r[14], mS.date ? parseInt(mS.date.split('-')[1]) : null);
    const xS = parseDateTimeCell(r[20]);
    const xE = parseDateTimeCell(r[21], xS.date ? parseInt(xS.date.split('-')[1]) : null);
    const cycleM = (mTag + xTag).match(/CYCLE-(\d+)/i);
    return {
      type,
      requireMock: !!(mS.date),
      mockTitle: (r[12] || '').trim() || 'Mock Assessment',
      mainTitle: (r[19] || '').trim(),
      mockStartDate: mS.date || '', mockEndDate: mE.date || '',
      mainStartDate: xS.date || '', mainEndDate: xE.date || '',
      mockSlot: (mS.time && mE.time) ? `${mS.time} – ${mE.time}` : '',
      mainSlot: (xS.time && xE.time) ? `${xS.time} – ${xE.time}` : '',
      cycle:  cycleM ? cycleM[1] : '',
      mockTagOverride: mTag,
      mainTagOverride: xTag,
      status: 'completed',
      notifiedOps: true,
    };
  });
}

// ─── Design Tokens ────────────────────────────────────────────────────────────
const C = {
  bg: "#f5f4f0",
  surface: "#ffffff",
  surfaceAlt: "#f0ede8",
  border: "#e0dbd2",
  text: "#1a1714",
  muted: "#8a8278",
  accent: "#c8521a",
  accentLight: "#f5ebe3",
  accentDark: "#9c3d10",
  blue: "#1a5fa8",
  blueLight: "#e3edf8",
  green: "#1a7a3f",
  greenLight: "#e3f2eb",
  yellow: "#8a6a00",
  yellowLight: "#faf3d6",
  red: "#a81a2a",
  redLight: "#f8e3e6",
};

// ─── Shared Components ────────────────────────────────────────────────────────

function Badge({ children, color = "gray" }) {
  const map = {
    gray: { bg: C.surfaceAlt, color: C.muted, border: C.border },
    orange: { bg: C.accentLight, color: C.accent, border: "#e8c4a8" },
    blue: { bg: C.blueLight, color: C.blue, border: "#c0d8f0" },
    green: { bg: C.greenLight, color: C.green, border: "#b8e0cc" },
    yellow: { bg: C.yellowLight, color: C.yellow, border: "#e8d888" },
    red: { bg: C.redLight, color: C.red, border: "#f0c0c8" },
  };
  const s = map[color] || map.gray;
  return (
    <span style={{ background: s.bg, color: s.color, border: `1px solid ${s.border}`, borderRadius: 4, padding: "2px 9px", fontSize: 11, fontWeight: 700, letterSpacing: 0.8, textTransform: "uppercase", display: "inline-block" }}>
      {children}
    </span>
  );
}

function Btn({ children, onClick, variant = "primary", size = "md", disabled, icon }) {
  const vars = {
    primary: { bg: C.accent, color: "#fff", border: C.accentDark, hover: C.accentDark },
    secondary: { bg: C.surface, color: C.text, border: C.border },
    ghost: { bg: "transparent", color: C.muted, border: "transparent" },
    blue: { bg: C.blue, color: "#fff", border: "#134d8a" },
    green: { bg: C.green, color: "#fff", border: "#145e30" },
    danger: { bg: C.red, color: "#fff", border: "#8a1520" },
  };
  const v = vars[variant] || vars.primary;
  const pad = size === "sm" ? "5px 12px" : size === "lg" ? "11px 24px" : "8px 18px";
  const fs = size === "sm" ? 12 : size === "lg" ? 15 : 13;
  return (
    <button onClick={onClick} disabled={disabled} style={{
      background: v.bg, color: v.color, border: `1px solid ${v.border}`,
      borderRadius: 7, padding: pad, fontSize: fs, fontWeight: 600,
      cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.45 : 1,
      fontFamily: "inherit", display: "inline-flex", alignItems: "center", gap: 6,
      transition: "all 0.15s", letterSpacing: 0.2
    }}>
      {icon && <span>{icon}</span>}{children}
    </button>
  );
}

function Field({ label, value, onChange, type = "text", options, placeholder, disabled, hint }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
      <label style={{ fontSize: 11, fontWeight: 700, color: C.muted, letterSpacing: 0.8, textTransform: "uppercase" }}>{label}</label>
      {options ? (
        <select value={value} onChange={e => onChange(e.target.value)} disabled={disabled}
          style={{ background: disabled ? C.surfaceAlt : C.surface, border: `1px solid ${C.border}`, borderRadius: 7, padding: "9px 12px", fontSize: 13, color: value ? C.text : C.muted, fontFamily: "inherit", outline: "none", cursor: disabled ? "not-allowed" : "auto" }}>
          <option value="">Select…</option>
          {options.map(o => <option key={o.v || o} value={o.v || o}>{o.l || o}</option>)}
        </select>
      ) : (
        <input type={type} value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder} disabled={disabled}
          style={{ background: disabled ? C.surfaceAlt : C.surface, border: `1px solid ${C.border}`, borderRadius: 7, padding: "9px 12px", fontSize: 13, color: C.text, fontFamily: "inherit", outline: "none" }} />
      )}
      {hint && <span style={{ fontSize: 11, color: C.muted }}>{hint}</span>}
    </div>
  );
}

function TimeSlotField({ label, value, onChange }) {
  const parse = (v) => {
    if (!v) return { sh: "", sm: "00", sp: "AM", eh: "", em: "00", ep: "AM" };
    const m = v.match(/(\d+):(\d+)\s*(AM|PM)\s*[–-]\s*(\d+):(\d+)\s*(AM|PM)/i);
    if (m) return { sh: m[1], sm: m[2], sp: m[3].toUpperCase(), eh: m[4], em: m[5], ep: m[6].toUpperCase() };
    return { sh: "", sm: "00", sp: "AM", eh: "", em: "00", ep: "AM" };
  };

  const init = parse(value);
  const [sh, setSh] = useState(init.sh);
  const [sm, setSm] = useState(init.sm);
  const [sp, setSp] = useState(init.sp);
  const [eh, setEh] = useState(init.eh);
  const [em, setEm] = useState(init.em);
  const [ep, setEp] = useState(init.ep);

  const toMin = (h, m, p) => {
    let hr = parseInt(h) || 0;
    if (p === "PM" && hr !== 12) hr += 12;
    if (p === "AM" && hr === 12) hr = 0;
    return hr * 60 + (parseInt(m) || 0);
  };

  const fromMin = (total) => {
    total = ((total % 1440) + 1440) % 1440;
    const hr = Math.floor(total / 60);
    const min = total % 60;
    const p = hr >= 12 ? "PM" : "AM";
    let h12 = hr % 12;
    if (h12 === 0) h12 = 12;
    return { h: String(h12), m: String(min).padStart(2, "0"), p };
  };

  const build = (sh, sm, sp, eh, em, ep) =>
    sh ? `${sh}:${sm} ${sp} – ${eh}:${em} ${ep}` : "";

  const updateStart = (nsh, nsm, nsp) => {
    setSh(nsh); setSm(nsm); setSp(nsp);
    onChange(build(nsh, nsm, nsp, eh, em, ep));
  };

  const updateEnd = (neh, nem, nep) => {
    setEh(neh); setEm(nem); setEp(nep);
    onChange(build(sh, sm, sp, neh, nem, nep));
  };

  const inStyle = { width: 48, background: C.surface, border: `1px solid ${C.border}`, borderRadius: 7, padding: "8px 0", fontSize: 14, fontFamily: "inherit", textAlign: "center", outline: "none", color: C.text };

  const PBtn = ({ active, label, onClick }) => (
    <button type="button" onClick={onClick} style={{
      background: active ? C.accent : C.surfaceAlt, color: active ? "#fff" : C.muted,
      border: `1px solid ${active ? C.accent : C.border}`,
      borderRadius: 6, padding: "7px 11px", fontSize: 11, fontWeight: 700,
      cursor: "pointer", fontFamily: "inherit", transition: "all 0.15s"
    }}>{label}</button>
  );

  const TimeRow = ({ h, m, p, onH, onM, onP }) => (
    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
      <input type="text" value={h} onChange={e => onH(e.target.value.replace(/\D/g, "").slice(0, 2))} placeholder="9" maxLength={2} style={inStyle} />
      <span style={{ fontWeight: 800, color: C.muted, fontSize: 16 }}>:</span>
      <input type="text" value={m} onChange={e => onM(e.target.value.replace(/\D/g, "").slice(0, 2))} placeholder="00" maxLength={2} style={inStyle} />
      <PBtn active={p === "AM"} label="AM" onClick={() => onP("AM")} />
      <PBtn active={p === "PM"} label="PM" onClick={() => onP("PM")} />
    </div>
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
      <label style={{ fontSize: 11, fontWeight: 700, color: C.muted, letterSpacing: 0.8, textTransform: "uppercase" }}>{label}</label>
      <div style={{ background: C.surfaceAlt, border: `1px solid ${C.border}`, borderRadius: 8, padding: "10px 12px", display: "flex", flexDirection: "column", gap: 10 }}>
        <div>
          <div style={{ fontSize: 10, color: C.muted, fontWeight: 700, letterSpacing: 0.6, marginBottom: 6 }}>START TIME</div>
          <TimeRow h={sh} m={sm} p={sp} onH={v => updateStart(v, sm, sp)} onM={v => updateStart(sh, v, sp)} onP={v => updateStart(sh, sm, v)} />
        </div>
        <div>
          <div style={{ fontSize: 10, color: C.muted, fontWeight: 700, letterSpacing: 0.6, marginBottom: 6 }}>END TIME <span style={{ color: C.accent, fontWeight: 600, fontSize: 9 }}>· auto +1 hr, editable</span></div>
          <TimeRow h={eh} m={em} p={ep} onH={v => updateEnd(v, em, ep)} onM={v => updateEnd(eh, v, ep)} onP={v => updateEnd(eh, em, v)} />
        </div>
      </div>
    </div>
  );
}

function AssessmentDateTimeField({ startDate, endDate, slot, onStartDate, onEndDate, onSlot }) {
  const parse = (v) => {
    if (!v) return { sh: "", sm: "00", sp: "AM", eh: "", em: "00", ep: "AM" };
    const m = v.match(/(\d+):(\d+)\s*(AM|PM)\s*[–-]\s*(\d+):(\d+)\s*(AM|PM)/i);
    if (m) return { sh: m[1], sm: m[2], sp: m[3].toUpperCase(), eh: m[4], em: m[5], ep: m[6].toUpperCase() };
    return { sh: "", sm: "00", sp: "AM", eh: "", em: "00", ep: "AM" };
  };

  const init = parse(slot);
  const [sh, setSh] = useState(init.sh);
  const [sm, setSm] = useState(init.sm);
  const [sp, setSp] = useState(init.sp);
  const [eh, setEh] = useState(init.eh);
  const [em, setEm] = useState(init.em);
  const [ep, setEp] = useState(init.ep);

  const toMin = (h, m, p) => {
    let hr = parseInt(h) || 0;
    if (p === "PM" && hr !== 12) hr += 12;
    if (p === "AM" && hr === 12) hr = 0;
    return hr * 60 + (parseInt(m) || 0);
  };

  const fromMin = (total) => {
    total = ((total % 1440) + 1440) % 1440;
    const hr = Math.floor(total / 60);
    const min = total % 60;
    const p = hr >= 12 ? "PM" : "AM";
    let h12 = hr % 12;
    if (h12 === 0) h12 = 12;
    return { h: String(h12), m: String(min).padStart(2, "0"), p };
  };

  const build = (sh, sm, sp, eh, em, ep) => sh ? `${sh}:${sm} ${sp} – ${eh}:${em} ${ep}` : "";

  const updateStart = (nsh, nsm, nsp) => {
    setSh(nsh); setSm(nsm); setSp(nsp);
    onSlot(build(nsh, nsm, nsp, eh, em, ep));
  };

  const updateEnd = (neh, nem, nep) => {
    setEh(neh); setEm(nem); setEp(nep);
    onSlot(build(sh, sm, sp, neh, nem, nep));
  };

  const inStyle = { width: 44, background: C.surface, border: `1px solid ${C.border}`, borderRadius: 7, padding: "8px 0", fontSize: 13, fontFamily: "inherit", textAlign: "center", outline: "none", color: C.text };
  const dateStyle = { flex: 1, background: C.surface, border: `1px solid ${C.border}`, borderRadius: 7, padding: "8px 10px", fontSize: 13, color: C.text, fontFamily: "inherit", outline: "none" };
  const pbtn = (active, label, onClick) => (
    <button type="button" onClick={onClick} style={{
      background: active ? C.accent : C.surface, color: active ? "#fff" : C.muted,
      border: `1px solid ${active ? C.accent : C.border}`,
      borderRadius: 6, padding: "7px 10px", fontSize: 11, fontWeight: 700,
      cursor: "pointer", fontFamily: "inherit", transition: "all 0.15s"
    }}>{label}</button>
  );

  const today = new Date().toISOString().slice(0, 10);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div>
        <div style={{ fontSize: 10, color: C.muted, fontWeight: 700, letterSpacing: 0.6, marginBottom: 6 }}>START DATE & TIME</div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <input type="date" value={startDate} min={today} onChange={e => onStartDate(e.target.value)} style={dateStyle} />
          <input type="text" value={sh} onChange={e => updateStart(e.target.value.replace(/\D/g, "").slice(0, 2), sm, sp)} placeholder="9" maxLength={2} style={inStyle} />
          <span style={{ fontWeight: 800, color: C.muted, fontSize: 15 }}>:</span>
          <input type="text" value={sm} onChange={e => updateStart(sh, e.target.value.replace(/\D/g, "").slice(0, 2), sp)} placeholder="00" maxLength={2} style={inStyle} />
          {pbtn(sp === "AM", "AM", () => updateStart(sh, sm, "AM"))}
          {pbtn(sp === "PM", "PM", () => updateStart(sh, sm, "PM"))}
        </div>
      </div>
      <div>
        <div style={{ fontSize: 10, color: C.muted, fontWeight: 700, letterSpacing: 0.6, marginBottom: 6 }}>END DATE & TIME</div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <input type="date" value={endDate} min={today} onChange={e => onEndDate(e.target.value)} style={dateStyle} />
          <input type="text" value={eh} onChange={e => updateEnd(e.target.value.replace(/\D/g, "").slice(0, 2), em, ep)} placeholder="9" maxLength={2} style={inStyle} />
          <span style={{ fontWeight: 800, color: C.muted, fontSize: 15 }}>:</span>
          <input type="text" value={em} onChange={e => updateEnd(eh, e.target.value.replace(/\D/g, "").slice(0, 2), ep)} placeholder="00" maxLength={2} style={inStyle} />
          {pbtn(ep === "AM", "AM", () => updateEnd(eh, em, "AM"))}
          {pbtn(ep === "PM", "PM", () => updateEnd(eh, em, "PM"))}
        </div>
      </div>
    </div>
  );
}

function Card({ children, style = {}, onClick }) {
  return (
    <div onClick={onClick} style={{
      background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12,
      padding: 20, ...style, cursor: onClick ? "pointer" : "default"
    }}>{children}</div>
  );
}

function Modal({ title, children, onClose, width = 560 }) {
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(26,23,20,0.55)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}>
      <div style={{ background: C.surface, borderRadius: 16, border: `1px solid ${C.border}`, width: "100%", maxWidth: width, maxHeight: "90vh", overflow: "auto", boxShadow: "0 24px 64px rgba(0,0,0,0.18)" }}>
        <div style={{ padding: "20px 24px", borderBottom: `1px solid ${C.border}`, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span style={{ fontWeight: 800, fontSize: 16, color: C.text }}>{title}</span>
          <button onClick={onClose} style={{ background: "none", border: "none", fontSize: 20, cursor: "pointer", color: C.muted, lineHeight: 1 }}>×</button>
        </div>
        <div style={{ padding: 24 }}>{children}</div>
      </div>
    </div>
  );
}

function Divider() { return <div style={{ borderTop: `1px solid ${C.border}`, margin: "16px 0" }} />; }

function ImportCSVModal({ onClose, onImport }) {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState('');
  const [importing, setImporting] = useState(false);
  const [done, setDone] = useState(false);

  const handleFile = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const parsed = parseTrackerCSV(ev.target.result);
        if (!parsed.length) { setError('No valid rows found. Make sure this is the Master Tracker CSV.'); return; }
        setRows(parsed); setError('');
      } catch (err) { setError('Failed to parse: ' + err.message); }
    };
    reader.readAsText(file);
  };

  const handleImport = async () => {
    setImporting(true);
    try { await onImport(rows); setDone(true); }
    catch (err) { setError('Import failed: ' + err.message); setImporting(false); }
  };

  return (
    <Modal title="Import Assessments from CSV" onClose={onClose} width={720}>
      {done ? (
        <div style={{ textAlign: 'center', padding: '32px 0' }}>
          <div style={{ fontSize: 40, marginBottom: 12 }}>✅</div>
          <div style={{ fontSize: 18, fontWeight: 800, color: C.text, marginBottom: 8 }}>{rows.length} assessments imported!</div>
          <div style={{ color: C.muted, fontSize: 13, marginBottom: 24 }}>All records saved to Firestore. Week numbers will now be correct.</div>
          <Btn onClick={onClose}>Close</Btn>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          <div style={{ background: C.blueLight, border: `1px solid #c0d8f0`, borderRadius: 10, padding: '12px 16px', fontSize: 13, color: C.blue }}>
            Upload the <b>Academy Placements Master Tracker CSV</b>. Each row becomes one exam. Existing tags are preserved as overrides.
          </div>
          <div>
            <label style={{ fontSize: 10, fontWeight: 700, color: C.muted, letterSpacing: 0.8 }}>SELECT CSV FILE</label>
            <input type="file" accept=".csv" onChange={handleFile} style={{ display: 'block', marginTop: 8, fontSize: 13, color: C.text }} />
          </div>
          {error && <div style={{ background: '#fff0f0', border: '1px solid #f0c0c8', borderRadius: 8, padding: '10px 14px', color: C.red, fontSize: 13 }}>{error}</div>}
          {rows && (
            <>
              <div style={{ background: C.surfaceAlt, borderRadius: 10, border: `1px solid ${C.border}`, overflow: 'hidden' }}>
                <div style={{ padding: '10px 16px', borderBottom: `1px solid ${C.border}`, display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span style={{ fontWeight: 700, fontSize: 13, color: C.text }}>{rows.length} rows parsed</span>
                  <span style={{ fontSize: 12, color: C.muted }}>— showing first 5</span>
                </div>
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
                    <thead>
                      <tr style={{ background: C.surface }}>
                        {['Type','Main Start','Main End','Mock Start','Main Tag'].map(h => (
                          <th key={h} style={{ padding: '8px 10px', textAlign: 'left', fontWeight: 700, color: C.muted, borderBottom: `1px solid ${C.border}`, whiteSpace: 'nowrap' }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {rows.slice(0, 5).map((r, i) => (
                        <tr key={i} style={{ borderBottom: `1px solid ${C.border}` }}>
                          <td style={{ padding: '7px 10px', whiteSpace: 'nowrap' }}>{r.type === 'Offline Placement Exam' ? 'Offline' : 'POA'}</td>
                          <td style={{ padding: '7px 10px', whiteSpace: 'nowrap' }}>{r.mainStartDate || '—'}</td>
                          <td style={{ padding: '7px 10px', whiteSpace: 'nowrap' }}>{r.mainEndDate || '—'}</td>
                          <td style={{ padding: '7px 10px', whiteSpace: 'nowrap' }}>{r.mockStartDate || '—'}</td>
                          <td style={{ padding: '7px 10px', fontFamily: 'monospace', color: C.accentDark, fontSize: 10, maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.mainTagOverride || '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
              <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
                <Btn variant="secondary" onClick={onClose}>Cancel</Btn>
                <Btn onClick={handleImport} disabled={importing}>
                  {importing ? 'Importing…' : `Import all ${rows.length} assessments`}
                </Btn>
              </div>
            </>
          )}
        </div>
      )}
    </Modal>
  );
}

function LinkChip({ url, label }) {
  return (
    <a href={url} target="_blank" rel="noreferrer" style={{ display: "inline-flex", alignItems: "center", gap: 5, background: C.blueLight, color: C.blue, border: `1px solid #c0d8f0`, borderRadius: 6, padding: "4px 10px", fontSize: 12, fontWeight: 600, textDecoration: "none" }}>
      🔗 {label}
    </a>
  );
}

function EmptyState({ icon, title, sub }) {
  return (
    <div style={{ textAlign: "center", padding: "48px 24px", color: C.muted }}>
      <div style={{ fontSize: 40, marginBottom: 12 }}>{icon}</div>
      <div style={{ fontSize: 16, fontWeight: 700, color: C.text, marginBottom: 6 }}>{title}</div>
      <div style={{ fontSize: 13 }}>{sub}</div>
    </div>
  );
}

// ─── Page: Exam Details ───────────────────────────────────────────────────────

// Exam Title field: preset chips + free-type input
function ExamTitleField({ value, onChange }) {
  const [custom, setCustom] = useState(!EXAM_TITLE_PRESETS.includes(value) && value !== "");
  const isPreset = EXAM_TITLE_PRESETS.includes(value);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <label style={{ fontSize: 11, fontWeight: 700, color: C.muted, letterSpacing: 0.8, textTransform: "uppercase" }}>Exam Title</label>
      {/* Preset chips */}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {EXAM_TITLE_PRESETS.map(p => (
          <button key={p} type="button" onClick={() => { onChange(p); setCustom(false); }} style={{
            background: value === p && !custom ? C.accent : C.surfaceAlt,
            color: value === p && !custom ? "#fff" : C.text,
            border: `1px solid ${value === p && !custom ? C.accent : C.border}`,
            borderRadius: 7, padding: "7px 14px", fontSize: 13, fontWeight: 600,
            cursor: "pointer", fontFamily: "inherit", transition: "all 0.15s"
          }}>{p}</button>
        ))}
        <button type="button" onClick={() => { setCustom(true); if (isPreset) onChange(""); }} style={{
          background: custom ? C.accentLight : C.surfaceAlt,
          color: custom ? C.accentDark : C.muted,
          border: `1px solid ${custom ? C.accent : C.border}`,
          borderRadius: 7, padding: "7px 14px", fontSize: 13, fontWeight: 600,
          cursor: "pointer", fontFamily: "inherit", transition: "all 0.15s"
        }}>✏️ Custom…</button>
      </div>
      {/* Free-type input shown when custom selected */}
      {custom && (
        <input
          autoFocus
          type="text" value={isPreset ? "" : value} onChange={e => onChange(e.target.value)}
          placeholder="Type exam title…"
          style={{ background: C.surface, border: `1px solid ${C.accent}`, borderRadius: 7, padding: "9px 12px", fontSize: 13, color: C.text, fontFamily: "inherit", outline: "none" }}
        />
      )}
    </div>
  );
}

function ExamDetailsPage({ exams, onSaveExam, onDeleteExam, onUndoDelete, onNotify, onCancelExam, uploads, onAddUpload, onDeleteUpload, role, notifications, onAddNotification, onMarkNotifRead, onMarkAllNotifsRead, currentUserEmail }) {
  const [showModal, setShowModal] = useState(false);
  const [editing, setEditing] = useState(null);
  const [originalForm, setOriginalForm] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [deletedExam, setDeletedExam] = useState(null);
  const [savedExam, setSavedExam] = useState(null);
  const [notifying, setNotifying] = useState(false);
  const [notifySent, setNotifySent] = useState(false);
  const [confirmNotify, setConfirmNotify] = useState(null);
  const [confirmCancel, setConfirmCancel] = useState(null);
  const [programTab, setProgramTab] = useState("online");
  const PROGRAMS = [
    { id: "online",  label: "Online" },
    { id: "offline", label: "Offline" },
  ];
  const emptyForm = { type: "", requireMock: true, mockTitle: "", mainTitle: "", mockStartDate: "", mockEndDate: "", mainStartDate: "", mainEndDate: "", mockSlot: "", mainSlot: "", cycle: "", program: "online" };
  const [form, setForm] = useState(emptyForm);
  const [filter, setFilter] = useState("all");
  const [filterCategory, setFilterCategory] = useState("");
  const [filterDateStart, setFilterDateStart] = useState("");
  const [filterDateEnd, setFilterDateEnd] = useState("");
  const [filterCompleteness, setFilterCompleteness] = useState("");
  const [sortOrder, setSortOrder] = useState("desc");
  const [filterNotified, setFilterNotified] = useState("");
  const [expanded, setExpanded] = useState({});
  const [page, setPage] = useState(1);
  const [pendingStudentFile, setPendingStudentFile] = useState(null);
  const [confirmDeleteUpload, setConfirmDeleteUpload] = useState(null);
  const [deletedUpload, setDeletedUpload] = useState(null);
  const [uploadedResult, setUploadedResult] = useState(null);
  const [studentViewModal, setStudentViewModal] = useState(null);
  const [studentViewTab, setStudentViewTab] = useState("all");
  const [studentViewPage, setStudentViewPage] = useState(1);
  const [studentViewSearch, setStudentViewSearch] = useState("");
  const fileRefs = useRef({});
  const modalFileRef = useRef(null);
  const notifRef = useRef(null);
  const [showNotifs, setShowNotifs] = useState(false);
  const [highlightedExamId, setHighlightedExamId] = useState(null);

  useEffect(() => { setPage(1); }, [filter, filterCategory, filterDateStart, filterDateEnd, filterCompleteness, filterNotified, sortOrder, programTab]);

  useEffect(() => {
    if (!showNotifs) return;
    const handler = (e) => { if (notifRef.current && !notifRef.current.contains(e.target)) setShowNotifs(false); };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [showNotifs]);

  const [showImport, setShowImport] = useState(false);

  const openNew = () => { setForm({ ...emptyForm, program: programTab }); setEditing(null); setOriginalForm(null); setPendingStudentFile(null); setShowModal(true); };
  const openEdit = (ex) => { setForm({ ...emptyForm, ...ex }); setEditing(ex.id); setOriginalForm({ ...emptyForm, ...ex }); setPendingStudentFile(null); setShowModal(true); };

  const handleImportCSV = async (rows) => {
    await Promise.all(rows.map(r => addDoc(collection(db, "exams"), r)));
  };

  // Used for week/batch preview in the form
  const previewExam = { ...form, id: editing || -1 };
  const previewAllExams = editing
    ? exams.map(e => e.id === editing ? previewExam : e)
    : [...exams, previewExam];

  const save = async () => {
    const isEdit = !!editing;
    const contentRelevantChanged = isEdit && originalForm && (
      form.type !== originalForm.type ||
      form.mockStartDate !== originalForm.mockStartDate ||
      form.mockEndDate !== originalForm.mockEndDate ||
      form.mockSlot !== originalForm.mockSlot ||
      form.mainStartDate !== originalForm.mainStartDate ||
      form.mainEndDate !== originalForm.mainEndDate ||
      form.mainSlot !== originalForm.mainSlot
    );
    const savedId = await onSaveExam(form, editing);
    if (pendingStudentFile) {
      const r = await handleUploadFile(savedId, pendingStudentFile, uploads, onAddUpload);
      setPendingStudentFile(null);
      if (r) setUploadedResult(r);
    }
    setShowModal(false);
    setSavedExam({ ...form, id: savedId, _isEdit: isEdit, _notifyContent: !isEdit || contentRelevantChanged });
    setNotifySent(false);
    await onAddNotification({
      type: isEdit ? "exam_updated" : "exam_added",
      examId: savedId,
      examType: form.type,
      summary: isEdit ? `Exam details updated: ${form.type}` : `New exam requested: ${form.type}`,
      createdAt: new Date().toISOString(),
      createdBy: currentUserEmail || "",
      read: false,
    });
  };

  const clearFilters = () => { setFilterCategory(""); setFilterDateStart(""); setFilterDateEnd(""); setFilterCompleteness(""); setFilterNotified(""); };
  const hasFilters = filterCategory || filterDateStart || filterDateEnd || filterCompleteness || filterNotified;

  const navigateToExam = (examId) => {
    const exam = exams.find(e => e.id === examId);
    if (!exam) { setShowNotifs(false); return; }
    const targetProgram = getExamProgramHead(exam);
    const allInProgram = exams
      .filter(e => getExamProgramHead(e) === targetProgram)
      .sort((a, b) => {
        const diff = (a.mainStartDate || "").localeCompare(b.mainStartDate || "");
        return sortOrder === "asc" ? diff : -diff;
      });
    const idx = allInProgram.findIndex(e => e.id === examId);
    const targetPage = idx >= 0 ? Math.ceil((idx + 1) / PAGE_SIZE) : 1;
    setProgramTab(targetProgram);
    setFilter("all");
    clearFilters();
    setPage(targetPage);
    setExpanded(prev => ({ ...prev, [examId]: true }));
    setHighlightedExamId(examId);
    setShowNotifs(false);
    setTimeout(() => setHighlightedExamId(null), 3000);
  };

  useEffect(() => {
    if (!highlightedExamId) return;
    const timer = setTimeout(() => {
      const el = document.getElementById(`exam-row-${highlightedExamId}`);
      if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 80);
    return () => clearTimeout(timer);
  }, [highlightedExamId]);

  // Unique exam categories derived from actual data, scoped to current tab
  const examCategories = [...new Set(exams.filter(e => getExamProgramHead(e) === programTab).map(e => e.type).filter(Boolean))];

  const filtered = exams.filter(e => {
    if (getExamProgramHead(e) !== programTab) return false;
    if (filter !== "all" && getExamStatus(e) !== filter) return false;
    if (filterCategory && e.type !== filterCategory) return false;
    if (filterDateStart && !(e.mainStartDate && e.mainStartDate >= filterDateStart)) return false;
    if (filterDateEnd && !(e.mainStartDate && e.mainStartDate <= filterDateEnd)) return false;
    if (filterCompleteness) {
      const { isComplete } = getCompletenessInfo(e);
      if (filterCompleteness === "complete" && !isComplete) return false;
      if (filterCompleteness === "incomplete" && isComplete) return false;
    }
    if (filterNotified) {
      if (filterNotified === "notified" && !e.notifiedOps) return false;
      if (filterNotified === "not-notified" && e.notifiedOps) return false;
    }
    return true;
  }).sort((a, b) => {
    const da = a.mainStartDate || "", db2 = b.mainStartDate || "";
    const dateDiff = da.localeCompare(db2);
    if (dateDiff !== 0) return sortOrder === "asc" ? dateDiff : -dateDiff;
    const timeDiff = _slotStartMinutes(a.mainSlot) - _slotStartMinutes(b.mainSlot);
    return sortOrder === "asc" ? timeDiff : -timeDiff;
  });

  const PAGE_SIZE = 10;
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const paginated = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  const statusColor = { upcoming: "blue", completed: "green", flagged: "gray", cancelled: "red" };

  const isPOA = ["Placement Online Assessment", "Preliminary Online Assessment", "DSA Assessment"].includes(form.type);
  const isOffline = form.type === "Offline Placement Exam";
  const needsCycle = isOffline;

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 20 }}>
        <div>
          <h1 style={{ fontSize: 24, fontWeight: 900, color: C.text, margin: 0 }}>Exam Details</h1>
          <p style={{ color: C.muted, fontSize: 13, marginTop: 4 }}>All scheduled assessments. POC updates details here.</p>
        </div>
        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          {(role === "admin" || role === "content" || role === "super_admin") && (() => {
            const unreadCount = (notifications || []).filter(n => !n.read).length;
            const notifTypeMap = {
              exam_added:          { color: C.green,   bg: "#dcfce7", label: "New Request" },
              exam_updated:        { color: C.blue,    bg: C.blueLight, label: "Updated" },
              exam_cancelled:      { color: "#d97706", bg: "#fef3c7", label: "Cancelled" },
              exam_deleted:        { color: C.red,     bg: "#fee2e2", label: "Deleted" },
              config_link_updated: { color: "#7c3aed", bg: "#f5f3ff", label: "Config Updated" },
              config_link_reminder:{ color: "#d97706", bg: "#fef3c7", label: "Config Reminder" },
            };
            return (
              <div ref={notifRef} style={{ position: "relative" }}>
                <button
                  onClick={() => setShowNotifs(s => { if (!s) (notifications || []).filter(n => !n.read).forEach(n => onMarkNotifRead(n.id)); return !s; })}
                  style={{ position: "relative", background: showNotifs ? C.accentLight : C.surface, border: `1.5px solid ${showNotifs ? C.accent : C.border}`, borderRadius: 10, padding: "8px 11px", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={showNotifs ? C.accent : C.text} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>
                  {unreadCount > 0 && (
                    <span style={{ position: "absolute", top: -5, right: -5, background: "#ef4444", color: "#fff", borderRadius: "50%", width: 18, height: 18, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10, fontWeight: 800, border: "2px solid #fff" }}>
                      {unreadCount > 9 ? "9+" : unreadCount}
                    </span>
                  )}
                </button>
                {showNotifs && (
                  <div style={{ position: "absolute", right: 0, top: "calc(100% + 8px)", width: 380, background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12, boxShadow: "0 8px 32px rgba(0,0,0,0.12)", zIndex: 500, overflow: "hidden" }}>
                    <div style={{ padding: "13px 16px", borderBottom: `1px solid ${C.border}`, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      <span style={{ fontWeight: 800, fontSize: 14, color: C.text }}>Notifications</span>
                      {(notifications || []).length > 0 && <button onClick={onMarkAllNotifsRead} style={{ background: "none", border: "none", fontSize: 11, fontWeight: 700, color: C.accent, cursor: "pointer", fontFamily: "inherit", padding: 0 }}>Mark all read</button>}
                    </div>
                    <div style={{ maxHeight: 420, overflowY: "auto" }}>
                      {!(notifications || []).length ? (
                        <div style={{ padding: "36px 16px", textAlign: "center", color: C.muted, fontSize: 13 }}>No notifications yet</div>
                      ) : (notifications || []).map((n, i) => {
                        const tc = notifTypeMap[n.type] || { color: C.muted, bg: C.surfaceAlt, label: "Update" };
                        const isLast = i === notifications.length - 1;
                        return (
                          <div key={n.id} onClick={() => n.examId && navigateToExam(n.examId)} style={{ padding: "12px 16px", borderBottom: isLast ? "none" : `1px solid ${C.border}`, background: "#fff", display: "flex", gap: 12, alignItems: "flex-start", cursor: n.examId ? "pointer" : "default" }}>
                            <div style={{ width: 34, height: 34, borderRadius: "50%", background: tc.bg, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                              {n.type === "exam_added"          && <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke={tc.color} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="12" x2="16" y2="12"/></svg>}
                              {n.type === "exam_updated"        && <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke={tc.color} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>}
                              {n.type === "exam_cancelled"      && <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke={tc.color} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>}
                              {n.type === "exam_deleted"        && <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke={tc.color} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/></svg>}
                              {n.type === "config_link_updated" && <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke={tc.color} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>}
                              {n.type === "config_link_reminder"&& <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke={tc.color} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>}
                            </div>
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div style={{ fontSize: 12, fontWeight: 600, color: C.text, marginBottom: 4, lineHeight: 1.4 }}>{n.summary}</div>
                              <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                                <span style={{ fontSize: 10, fontWeight: 700, color: tc.color, background: tc.bg, borderRadius: 4, padding: "2px 6px" }}>{tc.label}</span>
                                <span style={{ fontSize: 11, color: C.muted }}>{timeAgo(n.createdAt)}</span>
                                {n.createdBy && <span style={{ fontSize: 11, color: C.muted }}>by {n.createdBy.split("@")[0]}</span>}
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
            );
          })()}
          {can(role, "exam.write") && (
            <div style={{ display: 'flex', gap: 10 }}>
              <Btn variant="secondary" size="lg" onClick={() => setShowImport(true)}>Import CSV</Btn>
              <Btn onClick={openNew} icon="+" size="lg">Add Exam</Btn>
            </div>
          )}
        </div>
      </div>

      {/* Program tabs */}
      <div style={{ display: "flex", gap: 2, marginBottom: 24, borderBottom: `2px solid ${C.border}` }}>
        {PROGRAMS.map(p => (
          <button key={p.id} onClick={() => { setProgramTab(p.id); setFilterCategory(""); }} style={{
            background: "none", border: "none", borderBottom: `2px solid ${programTab === p.id ? C.accent : "transparent"}`,
            marginBottom: -2, padding: "8px 20px", fontSize: 13, fontWeight: 700, cursor: "pointer",
            color: programTab === p.id ? C.accent : C.muted, fontFamily: "inherit", transition: "all 0.15s",
          }}>{p.label}</button>
        ))}
      </div>

      {showImport && <ImportCSVModal onClose={() => setShowImport(false)} onImport={handleImportCSV} />}

      {/* Status tabs — reset category filter when switching to offline since it has one type */}
      <div style={{ display: "flex", gap: 4, marginBottom: 14, background: C.surfaceAlt, borderRadius: 8, padding: 4, width: "fit-content", border: `1px solid ${C.border}` }}>
        {["all", "upcoming", "completed", "cancelled"].map(f => (
          <button key={f} onClick={() => setFilter(f)} style={{
            background: filter === f ? C.surface : "transparent", border: "none",
            borderRadius: 6, padding: "6px 16px", fontSize: 12, fontWeight: 700, cursor: "pointer",
            color: filter === f ? C.text : C.muted, textTransform: "capitalize", fontFamily: "inherit",
            boxShadow: filter === f ? "0 1px 3px rgba(0,0,0,0.08)" : "none"
          }}>{f}</button>
        ))}
      </div>

      {/* Horizontal filter bar */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 20, flexWrap: "wrap", background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10, padding: "12px 16px" }}>
        {/* Exam Category — only on Online tab (Offline has a single type) */}
        {programTab === "online" && <>
          <select value={filterCategory} onChange={e => setFilterCategory(e.target.value)} style={{ background: filterCategory ? "#eff6ff" : C.surface, border: `1.5px solid ${filterCategory ? "#3b82f6" : C.border}`, borderRadius: 7, padding: "7px 12px", fontSize: 13, color: filterCategory ? "#1d4ed8" : C.muted, fontFamily: "inherit", outline: "none", cursor: "pointer", minWidth: 210, fontWeight: filterCategory ? 700 : 400 }}>
            <option value="">All Exam Categories</option>
            {examCategories.map(cat => <option key={cat} value={cat}>{cat}</option>)}
          </select>
          <div style={{ width: 1, height: 28, background: C.border }} />
        </>}

        {/* Date range */}
        {(() => {
          const dateActive = filterDateStart || filterDateEnd;
          const activeInputStyle = { background: "#eff6ff", border: "1.5px solid #3b82f6", borderRadius: 7, padding: "7px 10px", fontSize: 13, color: "#1d4ed8", fontFamily: "inherit", outline: "none", fontWeight: 700 };
          const inactiveInputStyle = { background: C.surface, border: `1px solid ${C.border}`, borderRadius: 7, padding: "7px 10px", fontSize: 13, color: C.muted, fontFamily: "inherit", outline: "none" };
          return (
            <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 8px", borderRadius: 8, background: dateActive ? "#eff6ff" : "transparent", border: `1.5px solid ${dateActive ? "#3b82f6" : "transparent"}` }}>
              <span style={{ fontSize: 11, fontWeight: 700, color: dateActive ? "#1d4ed8" : C.muted, whiteSpace: "nowrap" }}>DATE</span>
              <input type="date" value={filterDateStart} onChange={e => setFilterDateStart(e.target.value)} style={filterDateStart ? activeInputStyle : inactiveInputStyle} />
              <span style={{ color: dateActive ? "#1d4ed8" : C.muted, fontSize: 13 }}>–</span>
              <input type="date" value={filterDateEnd} onChange={e => setFilterDateEnd(e.target.value)} style={filterDateEnd ? activeInputStyle : inactiveInputStyle} />
            </div>
          );
        })()}

        <div style={{ width: 1, height: 28, background: C.border }} />

        {/* Details Status */}
        <select value={filterCompleteness} onChange={e => setFilterCompleteness(e.target.value)} style={{ background: filterCompleteness ? "#eff6ff" : C.surface, border: `1.5px solid ${filterCompleteness ? "#3b82f6" : C.border}`, borderRadius: 7, padding: "7px 12px", fontSize: 13, color: filterCompleteness ? "#1d4ed8" : C.muted, fontFamily: "inherit", outline: "none", cursor: "pointer", fontWeight: filterCompleteness ? 700 : 400 }}>
          <option value="">Details — All</option>
          <option value="complete">Details Fully Filled</option>
          <option value="incomplete">Details Incomplete</option>
        </select>

        <div style={{ width: 1, height: 28, background: C.border }} />

        {/* Notification status */}
        <select value={filterNotified} onChange={e => setFilterNotified(e.target.value)} style={{ background: filterNotified ? "#eff6ff" : C.surface, border: `1.5px solid ${filterNotified ? "#3b82f6" : C.border}`, borderRadius: 7, padding: "7px 12px", fontSize: 13, color: filterNotified ? "#1d4ed8" : C.muted, fontFamily: "inherit", outline: "none", cursor: "pointer", fontWeight: filterNotified ? 700 : 400 }}>
          <option value="">All Notification Status</option>
          <option value="notified">Notified</option>
          <option value="not-notified">Not Notified</option>
        </select>

        <div style={{ width: 1, height: 28, background: C.border }} />

        {/* Sort order */}
        <div style={{ display: "flex", background: C.surfaceAlt, borderRadius: 7, border: `1px solid ${C.border}`, overflow: "hidden" }}>
          {[["desc", "Newest First"], ["asc", "Oldest First"]].map(([val, label]) => (
            <button key={val} onClick={() => setSortOrder(val)} style={{
              background: sortOrder === val ? C.accent : "transparent",
              color: sortOrder === val ? "#fff" : C.muted,
              border: "none", padding: "7px 14px", fontSize: 12, fontWeight: 700,
              cursor: "pointer", fontFamily: "inherit", whiteSpace: "nowrap"
            }}>{label}</button>
          ))}
        </div>

        {hasFilters && (
          <button onClick={clearFilters} style={{ background: "#fee2e2", border: "1.5px solid #fca5a5", borderRadius: 7, padding: "7px 14px", fontSize: 12, fontWeight: 700, color: "#dc2626", cursor: "pointer", fontFamily: "inherit", whiteSpace: "nowrap" }}>Clear filters</button>
        )}
      </div>

      {filtered.length === 0 ? (
        <EmptyState icon="📋" title="No exams yet" sub="Click 'Add Exam' to schedule your first assessment." />
      ) : (
        <div style={{ border: `1px solid ${C.border}`, borderRadius: 10, overflow: "hidden" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ background: C.surfaceAlt }}>
                <th style={{ width: 4, padding: 0 }} />
                <th style={{ width: 28, padding: 0 }} />
                {["Exam", "W / B", "Mock", "Main", "Status", "Details", "Notified", "Students", ""].map(h => (
                  <th key={h} style={{ padding: "10px 14px", textAlign: "left", fontSize: 11, fontWeight: 700, color: C.muted, letterSpacing: 0.8, textTransform: "uppercase", borderBottom: `1px solid ${C.border}`, whiteSpace: "nowrap" }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {paginated.map((ex, i) => {
                const wMain = getWeek(ex.mainStartDate, exams);
                const batch = getBatch(ex, exams);
                const { isComplete, missing } = getCompletenessInfo(ex);
                const amber = "#d97706";
                const examStatus = getExamStatus(ex);
                const isFlagged = examStatus === "flagged";
                const isCancelled = examStatus === "cancelled";
                const bizDays = businessDaysUntil(ex.mainStartDate);
                const urgentNotify = !ex.notifiedOps && isComplete && !isFlagged && !isCancelled && bizDays !== null && bizDays <= 7 && bizDays >= 0;
                const stripeColor = isCancelled ? "#f87171" : isFlagged ? "#cbd5e1" : urgentNotify ? "#ef4444" : isComplete ? C.green : amber;
                const isOpen = expanded[ex.id];
                const isLast = i === paginated.length - 1;
                const bdr = (isLast && !isOpen) ? "none" : `1px solid ${C.border}`;
                const tdS = { padding: "10px 14px", borderBottom: bdr, verticalAlign: "middle" };
                const dim = isFlagged || isCancelled;

                return (
                  <Fragment key={ex.id}>
                    <tr id={`exam-row-${ex.id}`} onClick={() => setExpanded(p => ({ ...p, [ex.id]: !p[ex.id] }))} style={{ cursor: "pointer", background: highlightedExamId === ex.id ? "#fef3c7" : isCancelled ? "#fff5f5" : "#fff", transition: "background 1.5s ease" }}>
                      <td style={{ width: 4, padding: 0, background: stripeColor, borderBottom: bdr }} />
                      <td style={{ ...tdS, width: 28, padding: "10px 6px", textAlign: "center" }}>
                        <svg width="10" height="10" viewBox="0 0 10 10" fill="none" style={{ transform: isOpen ? "rotate(90deg)" : "rotate(0deg)", transition: "transform 0.15s", display: "block", margin: "0 auto" }}>
                          <path d="M3 1l4 4-4 4" stroke={C.muted} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                      </td>
                      <td style={{ ...tdS, fontWeight: 700, opacity: dim ? 0.55 : 1 }}>{ex.type}</td>
                      <td style={{ ...tdS, opacity: dim ? 0.55 : 1 }}>
                        <div style={{ display: "flex", gap: 4 }}>
                          {!isCancelled && wMain && <Badge color="orange">W{wMain}</Badge>}
                          {!isCancelled && <Badge color="blue">B{batch}</Badge>}
                          {ex.cycle && <Badge color="yellow">C{ex.cycle}</Badge>}
                        </div>
                      </td>
                      <td style={{ ...tdS, opacity: dim ? 0.55 : 1 }}>
                        {ex.requireMock !== false
                          ? <>{(() => { const { startLine, endLine, sameDay } = fmtDateTimeLines(ex.mockStartDate, ex.mockEndDate, ex.mockSlot); return sameDay ? <div style={{ fontSize: 12 }}>{startLine}{endLine ? ` – ${endLine}` : ""}</div> : <><div style={{ fontSize: 12 }}>{startLine}</div><div style={{ fontSize: 11, color: C.muted }}>→ {endLine}</div></>; })()}</>
                          : <span style={{ color: C.muted, fontSize: 12 }}>—</span>}
                      </td>
                      <td style={{ ...tdS, opacity: dim ? 0.55 : 1 }}>
                        {(() => { const { startLine, endLine, sameDay } = fmtDateTimeLines(ex.mainStartDate, ex.mainEndDate, ex.mainSlot); return sameDay ? <div style={{ fontSize: 12 }}>{startLine}{endLine ? ` – ${endLine}` : ""}</div> : <><div style={{ fontSize: 12 }}>{startLine}</div><div style={{ fontSize: 11, color: C.muted }}>→ {endLine}</div></>; })()}
                      </td>
                      <td style={tdS}><Badge color={statusColor[examStatus] || "gray"}>{examStatus}</Badge></td>
                      <td style={tdS}>
                        {isComplete
                          ? <span title="All details complete" style={{ color: C.green, fontWeight: 800, fontSize: 15 }}>✓</span>
                          : <span title={`Missing: ${missing.join(", ")}`} style={{ color: amber, fontWeight: 700, cursor: "help", fontSize: 12 }}>⚠ {missing.length}</span>}
                      </td>
                      <td style={tdS} onClick={e => e.stopPropagation()}>
                        {ex.notifiedOps
                          ? <span style={{ fontSize: 11, fontWeight: 700, color: "#1d4ed8" }}>✓ Sent</span>
                          : can(role, "exam.notify") && isComplete && !isFlagged && !isCancelled
                            ? <button onClick={() => setConfirmNotify(ex)} style={{ background: urgentNotify ? "#ef4444" : C.accent, color: "#fff", border: "none", borderRadius: 6, padding: "4px 10px", fontSize: 11, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>{urgentNotify ? "Notify Now!" : "Notify"}</button>
                            : <span style={{ color: C.muted, fontSize: 12 }}>—</span>}
                      </td>
                      <td style={tdS} onClick={e => e.stopPropagation()}>
                        {(() => {
                          const examUploads = uploads ? uploads.filter(u => u.examId === ex.id) : [];
                          const uniqueCount = examUploads.flatMap(u => u.rows).filter(r => r._status !== "duplicate").length;
                          return uniqueCount > 0
                            ? (can(role, "student.read") || can(role, "student.write"))
                              ? <button onClick={e => { e.stopPropagation(); setStudentViewModal(ex); setStudentViewTab("all"); setStudentViewPage(1); setStudentViewSearch(""); }} style={{ background: "none", border: "none", padding: 0, cursor: "pointer", fontFamily: "inherit", display: "flex", alignItems: "center", gap: 5 }}>
                                  <span style={{ fontWeight: 700, color: C.green, fontSize: 12 }}>{uniqueCount}</span>
                                  <span style={{ fontSize: 11, color: C.accent, fontWeight: 700 }}>View</span>
                                </button>
                              : <span style={{ fontWeight: 700, color: C.green, fontSize: 12 }}>{uniqueCount}</span>
                            : can(role, "student.write")
                              ? <button onClick={e => { e.stopPropagation(); setExpanded(p => ({ ...p, [ex.id]: true })); }} style={{ background: "none", border: "none", padding: 0, cursor: "pointer", fontFamily: "inherit", fontSize: 12, fontWeight: 600, color: C.accent }}>+ Add</button>
                              : <span style={{ color: C.muted, fontSize: 12 }}>—</span>;
                        })()}
                      </td>
                      <td style={{ ...tdS, textAlign: "right" }} onClick={e => e.stopPropagation()}>
                        {can(role, "exam.write") && <Btn size="sm" variant="secondary" onClick={() => openEdit(ex)}>Edit</Btn>}
                      </td>
                    </tr>
                    {isOpen && (
                      <tr>
                        <td colSpan={11} style={{ padding: 0, borderBottom: isLast ? "none" : `1px solid ${C.border}` }}>
                          <div style={{ padding: "14px 24px 16px 28px", background: C.surfaceAlt, borderTop: `1px solid ${C.border}` }}>
                            {/* Auto-generated tags */}
                            {(() => {
                              const { mockTag, mainTag } = genTags(ex, exams);
                              const hasMock = ex.requireMock !== false;
                              return (
                                <div style={{ display: "grid", gridTemplateColumns: hasMock ? "1fr 1fr" : "1fr", gap: 12, marginBottom: 12 }}>
                                  {hasMock && (
                                    <div>
                                      <div style={{ fontSize: 10, fontWeight: 700, color: C.muted, letterSpacing: 0.8, textTransform: "uppercase", marginBottom: 4 }}>Mock Tag</div>
                                      <div style={{ fontFamily: "monospace", fontSize: 11, color: C.text, background: "#f1f5f9", border: `1px solid ${C.border}`, borderRadius: 5, padding: "5px 8px", wordBreak: "break-all" }}>{mockTag}</div>
                                    </div>
                                  )}
                                  <div>
                                    <div style={{ fontSize: 10, fontWeight: 700, color: C.muted, letterSpacing: 0.8, textTransform: "uppercase", marginBottom: 4 }}>Main Tag</div>
                                    <div style={{ fontFamily: "monospace", fontSize: 11, color: C.text, background: "#f1f5f9", border: `1px solid ${C.border}`, borderRadius: 5, padding: "5px 8px", wordBreak: "break-all" }}>{mainTag}</div>
                                  </div>
                                </div>
                              );
                            })()}
                            {!isComplete && (
                              <div style={{ marginBottom: 12 }}>
                                <div style={{ fontSize: 10, fontWeight: 700, color: "#d97706", letterSpacing: 0.8, textTransform: "uppercase", marginBottom: 5 }}>Missing fields — edit to complete</div>
                                <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                                  {missing.map(m => <span key={m} style={{ fontSize: 11, fontWeight: 600, color: "#92400e", background: "#fef3c7", border: "1px solid #fcd34d", borderRadius: 4, padding: "3px 8px" }}>{m}</span>)}
                                </div>
                              </div>
                            )}
                            {isFlagged && (
                              <div style={{ fontSize: 11, color: C.muted, marginBottom: 10, display: "flex", alignItems: "center", gap: 5 }}>
                                <svg width="11" height="11" viewBox="0 0 24 24" fill="none"><path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1zM4 22v-7" stroke={C.muted} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
                                Flagged — Ops team was not notified before the exam.
                              </div>
                            )}
                            {urgentNotify && (
                              <div style={{ fontSize: 11, color: "#b91c1c", marginBottom: 10, display: "flex", alignItems: "center", gap: 5 }}>
                                <svg width="11" height="11" viewBox="0 0 24 24" fill="none"><path d="M12 2L2 20h20L12 2z" fill="#ef4444"/><path d="M12 9v4M12 16.5v.5" stroke="#fff" strokeWidth="2" strokeLinecap="round"/></svg>
                                Exam starts in {bizDays} working day{bizDays === 1 ? "" : "s"} — notify before it begins.
                              </div>
                            )}
                            {/* Student Data section */}
                            {can(role, "student.write") && (() => {
                              const examUploads = uploads ? uploads.filter(u => u.examId === ex.id) : [];
                              const clean = examUploads.flatMap(u => u.rows).filter(r => r._status !== "duplicate");
                              return (
                                <div style={{ borderTop: `1px solid ${C.border}`, marginTop: 12, paddingTop: 12, marginBottom: 12 }}>
                                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
                                    <div style={{ fontSize: 10, fontWeight: 700, color: C.muted, letterSpacing: 0.8, textTransform: "uppercase" }}>Student Data</div>
                                    {examUploads.length > 0 && (
                                      <button onClick={() => { setStudentViewModal(ex); setStudentViewTab("all"); setStudentViewPage(1); setStudentViewSearch(""); }} style={{ background: "none", border: "none", color: C.accent, fontSize: 11, fontWeight: 700, cursor: "pointer", fontFamily: "inherit", padding: 0 }}>
                                        View full data ({clean.length} students) →
                                      </button>
                                    )}
                                  </div>
                                  {examUploads.length > 0 && (
                                    <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 8 }}>
                                      {examUploads.map(u => {
                                        const uClean = u.rows.filter(r => r._status !== "duplicate").length;
                                        const uDupes = u.rows.filter(r => r._status === "duplicate").length;
                                        return (
                                          <div key={u.id} style={{ display: "inline-flex", alignItems: "center", gap: 6, background: C.surface, border: `1px solid ${C.border}`, borderRadius: 6, padding: "3px 8px 3px 10px", fontSize: 11, color: C.muted }}>
                                            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
                                            <span>{u.fileName}</span>
                                            <span style={{ color: C.green, fontWeight: 700 }}>{uClean}</span>
                                            {uDupes > 0 && <span style={{ color: C.red, fontWeight: 700 }}>· {uDupes} dup</span>}
                                            <span>· {fmtDate(u.uploadedAt)}</span>
                                            <button onClick={e => { e.stopPropagation(); setConfirmDeleteUpload(u); }} style={{ background: "#fee2e2", border: "1px solid #fca5a5", borderRadius: 4, cursor: "pointer", color: "#dc2626", display: "flex", alignItems: "center", padding: "2px 5px", marginLeft: 2 }} title="Delete this upload">
                                              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/></svg>
                                            </button>
                                          </div>
                                        );
                                      })}
                                    </div>
                                  )}
                                  <div style={{ display: "flex", gap: 8 }}>
                                    <input type="file" accept=".csv" ref={el => fileRefs.current[ex.id] = el} style={{ display: "none" }}
                                      onChange={e => { const f = e.target.files[0]; e.target.value = ""; handleUploadFile(ex.id, f, uploads, onAddUpload).then(r => r && setUploadedResult(r)); }} />
                                    <Btn variant="secondary" size="sm" onClick={e => { e.stopPropagation(); fileRefs.current[ex.id]?.click(); }}>Upload CSV</Btn>
                                    <Btn variant="secondary" size="sm" onClick={e => e.stopPropagation()}>Source from Database</Btn>
                                  </div>
                                </div>
                              );
                            })()}
                            {can(role, "exam.write") && (
                              <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                                {!isCancelled
                                  ? <Btn variant="secondary" size="sm" onClick={() => setConfirmCancel({ exam: ex, action: "cancel" })}>Cancel Exam</Btn>
                                  : <Btn variant="secondary" size="sm" onClick={() => setConfirmCancel({ exam: ex, action: "uncancel" })}>Restore</Btn>}
                                <Btn variant="danger" size="sm" onClick={() => setConfirmDelete(ex)}>Delete</Btn>
                              </div>
                            )}
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {totalPages > 1 && (
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 16, padding: "0 2px" }}>
          <span style={{ fontSize: 12, color: C.muted }}>
            {(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, filtered.length)} of {filtered.length} exams
          </span>
          <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
            <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page === 1} style={{ border: `1px solid ${C.border}`, background: page === 1 ? C.surfaceAlt : "#fff", color: page === 1 ? C.muted : C.text, borderRadius: 6, padding: "5px 12px", fontSize: 12, fontWeight: 600, cursor: page === 1 ? "default" : "pointer", fontFamily: "inherit" }}>← Prev</button>
            {Array.from({ length: totalPages }, (_, i) => i + 1).map(n => (
              <button key={n} onClick={() => setPage(n)} style={{ border: `1px solid ${n === page ? C.accent : C.border}`, background: n === page ? C.accent : "#fff", color: n === page ? "#fff" : C.text, borderRadius: 6, padding: "5px 10px", fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "inherit", minWidth: 32 }}>{n}</button>
            ))}
            <button onClick={() => setPage(p => Math.min(totalPages, p + 1))} disabled={page === totalPages} style={{ border: `1px solid ${C.border}`, background: page === totalPages ? C.surfaceAlt : "#fff", color: page === totalPages ? C.muted : C.text, borderRadius: 6, padding: "5px 12px", fontSize: 12, fontWeight: 600, cursor: page === totalPages ? "default" : "pointer", fontFamily: "inherit" }}>Next →</button>
          </div>
        </div>
      )}


      {savedExam && (
        <Modal title="" onClose={() => setSavedExam(null)} width={500}>
          <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>

            {/* Header */}
            <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
              <div style={{ width: 52, height: 52, borderRadius: "50%", background: C.greenLight, border: `2px solid #a8d5b8`, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                <svg width="26" height="26" viewBox="0 0 24 24" fill="none"><path d="M5 13l4 4L19 7" stroke={C.green} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
              </div>
              <div>
                <div style={{ fontWeight: 900, fontSize: 18, color: C.text }}>Exam Saved!</div>
                <div style={{ fontSize: 13, color: C.muted, marginTop: 2 }}>{savedExam.type}</div>
              </div>
            </div>

            {/* Completeness status */}
            {(() => {
              const { isComplete, missing } = getCompletenessInfo(savedExam);
              return isComplete ? (
                <div style={{ display: "inline-flex", alignItems: "center", gap: 6, background: C.greenLight, border: `1px solid #a8d5b8`, borderRadius: 7, padding: "6px 12px" }}>
                  <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><circle cx="6" cy="6" r="6" fill={C.green}/><path d="M3.5 6l1.8 1.8 3.2-3.6" stroke="#fff" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
                  <span style={{ fontSize: 12, fontWeight: 700, color: C.green }}>All details complete</span>
                </div>
              ) : (
                <div style={{ background: "#fffbeb", border: `1px solid #fcd34d`, borderRadius: 8, padding: "8px 12px" }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: "#d97706", marginBottom: 5 }}>⚠ {missing.length} field{missing.length > 1 ? "s" : ""} still missing — you can edit later to complete</div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                    {missing.map(m => <span key={m} style={{ fontSize: 10, fontWeight: 600, color: "#92400e", background: "#fef3c7", border: "1px solid #fcd34d", borderRadius: 4, padding: "2px 6px" }}>{m}</span>)}
                  </div>
                </div>
              );
            })()}

            {/* Exam details summary */}
            <div style={{ background: C.surfaceAlt, border: `1px solid ${C.border}`, borderRadius: 10, padding: 16 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: C.muted, letterSpacing: 0.8, textTransform: "uppercase", marginBottom: 10 }}>Exam Summary</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {savedExam.requireMock !== false && (
                  <div style={{ display: "flex", gap: 10, fontSize: 12 }}>
                    <span style={{ color: C.muted, fontWeight: 700, minWidth: 52, fontSize: 11 }}>🧪 Mock</span>
                    <span style={{ color: C.text }}>{savedExam.mockTitle || <span style={{ color: C.muted, fontStyle: "italic" }}>No title</span>} &nbsp;·&nbsp; {fmtDateRange(savedExam.mockStartDate, savedExam.mockEndDate)} &nbsp;·&nbsp; {savedExam.mockSlot || <span style={{ color: C.muted, fontStyle: "italic" }}>No time</span>}</span>
                  </div>
                )}
                <div style={{ display: "flex", gap: 10, fontSize: 12 }}>
                  <span style={{ color: C.muted, fontWeight: 700, minWidth: 52, fontSize: 11 }}>🚀 Main</span>
                  <span style={{ color: C.text }}>{savedExam.mainTitle || <span style={{ color: C.muted, fontStyle: "italic" }}>No title</span>} &nbsp;·&nbsp; {fmtDateRange(savedExam.mainStartDate, savedExam.mainEndDate)} &nbsp;·&nbsp; {savedExam.mainSlot || <span style={{ color: C.muted, fontStyle: "italic" }}>No time</span>}</span>
                </div>
              </div>
            </div>

            {/* Notify section */}
            <div style={{ borderTop: `1px solid ${C.border}`, paddingTop: 4 }}>
              {notifySent ? (
                <div style={{ display: "flex", alignItems: "center", gap: 12, background: C.greenLight, border: `1px solid #a8d5b8`, borderRadius: 10, padding: 14, marginBottom: 16 }}>
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="12" fill={C.green}/><path d="M5 13l4 4L19 7" stroke="#fff" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
                  <div>
                    <div style={{ fontWeight: 700, fontSize: 13, color: C.green }}>Notified!</div>
                    <div style={{ fontSize: 11, color: C.muted, marginTop: 2 }}>Relevant teams have been informed.</div>
                  </div>
                </div>
              ) : (
                <div style={{ marginBottom: 0 }}>
                  <div style={{ fontWeight: 700, fontSize: 13, color: C.text, marginBottom: 3 }}>Notify Changes</div>
                  <div style={{ fontSize: 12, color: C.muted, marginBottom: 14 }}>
                    Send a notification for this exam to the relevant teams.
                  </div>
                  <div style={{ display: "flex", gap: 10 }}>
                    <button
                      onClick={async () => { setNotifying(true); await onNotify(savedExam.id, savedExam._notifyContent); setNotifying(false); setNotifySent(true); }}
                      disabled={notifying}
                      style={{ flex: 1, background: C.accent, color: "#fff", border: "none", borderRadius: 8, padding: "11px 0", fontSize: 13, fontWeight: 700, cursor: notifying ? "not-allowed" : "pointer", opacity: notifying ? 0.7 : 1, fontFamily: "inherit" }}
                    >{notifying ? "Sending…" : "Notify Now"}</button>
                    <button
                      onClick={() => setSavedExam(null)}
                      style={{ flex: 1, background: C.surface, color: C.text, border: `1px solid ${C.border}`, borderRadius: 8, padding: "11px 0", fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}
                    >Notify Later</button>
                  </div>
                </div>
              )}
              {notifySent && <Btn onClick={() => setSavedExam(null)} size="lg" style={{ width: "100%", marginTop: 4 }}>Done</Btn>}
            </div>

          </div>
        </Modal>
      )}

      {confirmNotify && (
        <Modal title="Send Notification" onClose={() => setConfirmNotify(null)} width={420}>
          <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
            <div>
              <div style={{ fontWeight: 700, fontSize: 15, color: C.text, marginBottom: 6 }}>{confirmNotify.type}</div>
              <div style={{ fontSize: 13, color: C.muted }}>This will send a notification to the relevant teams about this exam. Are you sure you want to proceed?</div>
            </div>
            <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
              <Btn variant="secondary" onClick={() => setConfirmNotify(null)}>Cancel</Btn>
              <Btn onClick={async () => { await onNotify(confirmNotify.id, true); setConfirmNotify(null); }}>Yes, Notify</Btn>
            </div>
          </div>
        </Modal>
      )}

      {confirmCancel && (
        <Modal title={confirmCancel.action === "cancel" ? "Cancel Exam" : "Restore Exam"} onClose={() => setConfirmCancel(null)} width={420}>
          <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
            <div>
              <div style={{ fontWeight: 700, fontSize: 15, color: C.text, marginBottom: 6 }}>{confirmCancel.exam.type}</div>
              <div style={{ fontSize: 13, color: C.muted }}>
                {confirmCancel.action === "cancel"
                  ? "This will mark the exam as cancelled. Week and batch numbers will be recalculated excluding this exam."
                  : "This will restore the exam and include it in week and batch calculations again."}
              </div>
            </div>
            <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
              <Btn variant="secondary" onClick={() => setConfirmCancel(null)}>Back</Btn>
              <Btn variant={confirmCancel.action === "cancel" ? "danger" : "primary"} onClick={async () => { const { exam, action } = confirmCancel; await onCancelExam(exam.id, action === "cancel"); setConfirmCancel(null); if (action === "cancel") await onAddNotification({ type: "exam_cancelled", examId: exam.id, examType: exam.type, summary: `Exam cancelled: ${exam.type}`, createdAt: new Date().toISOString(), createdBy: currentUserEmail || "", read: false }); }}>
                {confirmCancel.action === "cancel" ? "Yes, Cancel Exam" : "Yes, Restore Exam"}
              </Btn>
            </div>
          </div>
        </Modal>
      )}


      {confirmDeleteUpload && (
        <Modal title="Delete Student Data" onClose={() => setConfirmDeleteUpload(null)} width={420}>
          <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
            <div>
              <div style={{ fontWeight: 700, fontSize: 14, color: C.text, marginBottom: 4 }}>{confirmDeleteUpload.fileName}</div>
              <div style={{ fontSize: 13, color: C.muted }}>{confirmDeleteUpload.rows.filter(r => r._status !== "duplicate").length} students · uploaded {fmtDate(confirmDeleteUpload.uploadedAt)}</div>
              <div style={{ fontSize: 13, color: C.muted, marginTop: 8 }}>This will permanently remove this upload and all its student records. This cannot be undone.</div>
            </div>
            <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
              <Btn variant="secondary" onClick={() => setConfirmDeleteUpload(null)}>Cancel</Btn>
              <Btn variant="danger" onClick={() => { const u = confirmDeleteUpload; onDeleteUpload && onDeleteUpload(u.id); setConfirmDeleteUpload(null); setDeletedUpload(u); }}>Delete Upload</Btn>
            </div>
          </div>
        </Modal>
      )}

      {deletedUpload && (
        <Modal title="" onClose={() => setDeletedUpload(null)} width={400}>
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
              <div style={{ width: 48, height: 48, borderRadius: "50%", background: "#fef2f2", border: "1.5px solid #fca5a5", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6" stroke="#ef4444" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
              </div>
              <div>
                <div style={{ fontWeight: 900, fontSize: 17, color: C.text }}>Upload Deleted</div>
                <div style={{ fontSize: 12, color: C.muted, marginTop: 3 }}>{deletedUpload.fileName}</div>
              </div>
            </div>
            <div style={{ background: C.surfaceAlt, border: `1px solid ${C.border}`, borderRadius: 8, padding: "10px 14px", display: "flex", gap: 20, fontSize: 12 }}>
              <div><span style={{ color: C.muted }}>Students removed </span><span style={{ fontWeight: 700, color: C.text }}>{deletedUpload.rows.filter(r => r._status !== "duplicate").length}</span></div>
              <div><span style={{ color: C.muted }}>Uploaded on </span><span style={{ fontWeight: 700, color: C.text }}>{fmtDate(deletedUpload.uploadedAt)}</span></div>
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end" }}>
              <Btn onClick={() => setDeletedUpload(null)}>Done</Btn>
            </div>
          </div>
        </Modal>
      )}

      {uploadedResult && (
        <Modal title="" onClose={() => setUploadedResult(null)} width={400}>
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
              <div style={{ width: 48, height: 48, borderRadius: "50%", background: C.greenLight, border: `2px solid #a8d5b8`, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none"><path d="M5 13l4 4L19 7" stroke={C.green} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
              </div>
              <div>
                <div style={{ fontWeight: 900, fontSize: 17, color: C.text }}>Upload Successful</div>
                <div style={{ fontSize: 12, color: C.muted, marginTop: 3 }}>{uploadedResult.fileName}</div>
              </div>
            </div>
            <div style={{ background: C.surfaceAlt, border: `1px solid ${C.border}`, borderRadius: 8, padding: "12px 16px", display: "flex", gap: 28, fontSize: 13 }}>
              <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                <span style={{ fontSize: 10, fontWeight: 700, color: C.muted, letterSpacing: 0.8, textTransform: "uppercase" }}>Students added</span>
                <span style={{ fontWeight: 800, fontSize: 20, color: C.green }}>{uploadedResult.cleanCount}</span>
              </div>
              {uploadedResult.dupCount > 0 && (
                <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                  <span style={{ fontSize: 10, fontWeight: 700, color: C.muted, letterSpacing: 0.8, textTransform: "uppercase" }}>Duplicates skipped</span>
                  <span style={{ fontWeight: 800, fontSize: 20, color: C.red }}>{uploadedResult.dupCount}</span>
                </div>
              )}
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end" }}>
              <Btn onClick={() => setUploadedResult(null)}>Done</Btn>
            </div>
          </div>
        </Modal>
      )}

      {confirmDelete && (
        <Modal title="Delete Exam" onClose={() => setConfirmDelete(null)} width={420}>
          <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
            <div>
              <div style={{ fontWeight: 700, fontSize: 15, color: C.text, marginBottom: 6 }}>{confirmDelete.type}</div>
              <div style={{ fontSize: 13, color: C.muted }}>This will permanently delete the exam and cannot be undone.</div>
            </div>
            <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
              <Btn variant="secondary" onClick={() => setConfirmDelete(null)}>Cancel</Btn>
              <Btn variant="danger" onClick={async () => { const exam = confirmDelete; await onDeleteExam(exam.id); setConfirmDelete(null); setDeletedExam(exam); await onAddNotification({ type: "exam_deleted", examId: exam.id, examType: exam.type, summary: `Exam deleted: ${exam.type}`, createdAt: new Date().toISOString(), createdBy: currentUserEmail || "", read: false }); }}>Delete Exam</Btn>
            </div>
          </div>
        </Modal>
      )}

      {deletedExam && (
        <Modal title="" onClose={() => setDeletedExam(null)} width={480}>
          <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
              <div style={{ width: 48, height: 48, borderRadius: "50%", background: "#fef2f2", border: "1.5px solid #fca5a5", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6" stroke="#ef4444" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
              </div>
              <div>
                <div style={{ fontWeight: 900, fontSize: 18, color: C.text }}>Exam Deleted</div>
                <div style={{ fontSize: 13, color: C.muted, marginTop: 2 }}>{deletedExam.type}</div>
              </div>
            </div>

            <div style={{ background: C.surfaceAlt, border: `1px solid ${C.border}`, borderRadius: 10, padding: 16 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: C.muted, letterSpacing: 0.8, textTransform: "uppercase", marginBottom: 10 }}>Deleted Exam Details</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {deletedExam.requireMock !== false && (
                  <div style={{ display: "flex", gap: 10, fontSize: 12 }}>
                    <span style={{ color: C.muted, fontWeight: 700, minWidth: 52, fontSize: 11 }}>Mock</span>
                    <span style={{ color: C.text }}>{deletedExam.mockTitle || <span style={{ color: C.muted, fontStyle: "italic" }}>No title</span>} &nbsp;·&nbsp; {fmtDateRange(deletedExam.mockStartDate, deletedExam.mockEndDate)} &nbsp;·&nbsp; {deletedExam.mockSlot || <span style={{ color: C.muted, fontStyle: "italic" }}>No time</span>}</span>
                  </div>
                )}
                <div style={{ display: "flex", gap: 10, fontSize: 12 }}>
                  <span style={{ color: C.muted, fontWeight: 700, minWidth: 52, fontSize: 11 }}>Main</span>
                  <span style={{ color: C.text }}>{deletedExam.mainTitle || <span style={{ color: C.muted, fontStyle: "italic" }}>No title</span>} &nbsp;·&nbsp; {fmtDateRange(deletedExam.mainStartDate, deletedExam.mainEndDate)} &nbsp;·&nbsp; {deletedExam.mainSlot || <span style={{ color: C.muted, fontStyle: "italic" }}>No time</span>}</span>
                </div>
              </div>
            </div>

            {/* Ops notification — auto-fired on delete */}
            <div style={{ display: "flex", alignItems: "center", gap: 10, background: C.greenLight, border: `1px solid #a8d5b8`, borderRadius: 8, padding: "10px 14px" }}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="12" fill={C.green}/><path d="M5 13l4 4L19 7" stroke="#fff" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
              <span style={{ fontSize: 12, fontWeight: 600, color: C.green }}>Ops team notified of this deletion</span>
            </div>

            <div style={{ display: "flex", gap: 10 }}>
              <button
                onClick={async () => { await onUndoDelete(deletedExam); setDeletedExam(null); }}
                style={{ flex: 1, background: C.surface, border: `1.5px solid ${C.border}`, borderRadius: 8, padding: "11px 0", fontSize: 13, fontWeight: 700, cursor: "pointer", color: C.text, fontFamily: "inherit" }}
              >Undo Delete</button>
              <button
                onClick={() => setDeletedExam(null)}
                style={{ flex: 1, background: C.accent, border: "none", borderRadius: 8, padding: "11px 0", fontSize: 13, fontWeight: 700, cursor: "pointer", color: "#fff", fontFamily: "inherit" }}
              >Done</button>
            </div>
          </div>
        </Modal>
      )}

      {studentViewModal && (() => {
        const svmUploads = uploads ? uploads.filter(u => u.examId === studentViewModal.id) : [];
        const allHeaders = [...new Set(svmUploads.flatMap(u => u.headers))];
        const allRows = svmUploads.flatMap(u => u.rows);
        const clean = allRows.filter(r => r._status !== "duplicate");
        const dupes = allRows.filter(r => r._status === "duplicate");
        const tabRows = studentViewTab === "all" ? allRows : studentViewTab === "clean" ? clean : dupes;
        const searchTerm = studentViewSearch.trim().toLowerCase();
        const shown = searchTerm ? tabRows.filter(r => String(r.UID || r.uid || "").toLowerCase().includes(searchTerm)) : tabRows;
        const PAGE_SIZE = 20;
        const totalPages = Math.max(1, Math.ceil(shown.length / PAGE_SIZE));
        const pageRows = shown.slice((studentViewPage - 1) * PAGE_SIZE, studentViewPage * PAGE_SIZE);
        const svmThS = { padding: "10px 14px", textAlign: "left", fontSize: 11, fontWeight: 700, color: C.muted, letterSpacing: 0.8, textTransform: "uppercase", borderBottom: `1px solid ${C.border}`, whiteSpace: "nowrap", background: C.surfaceAlt };
        const svmTdS = { padding: "9px 14px", fontSize: 12, color: C.text, borderBottom: `1px solid ${C.border}` };
        const exportCSV = () => {
          const exportRows = tabRows;
          const csvLines = [
            ["#", ...allHeaders, "Status"].join(","),
            ...exportRows.map((row, i) => [
              i + 1,
              ...allHeaders.map(h => { const v = String(row[h] || ""); return v.includes(",") || v.includes('"') || v.includes("\n") ? `"${v.replace(/"/g, '""')}"` : v; }),
              row._status
            ].join(","))
          ];
          const blob = new Blob([csvLines.join("\n")], { type: "text/csv" });
          const url = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = url;
          a.download = `${studentViewModal.type}_${studentViewTab}_students.csv`.replace(/\s+/g, "_");
          a.click();
          URL.revokeObjectURL(url);
        };
        return (
          <Modal title={`Student Data — ${studentViewModal.type}`} onClose={() => setStudentViewModal(null)} width={1000}>
            <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <div style={{ display: "flex", gap: 16, fontSize: 12, color: C.muted }}>
                  <span><b style={{ color: C.green }}>{clean.length}</b> students</span>
                  {dupes.length > 0 && <span><b style={{ color: C.red }}>{dupes.length}</b> duplicates</span>}
                  {svmUploads.length > 0 && <span>{svmUploads.length} upload{svmUploads.length !== 1 ? "s" : ""}</span>}
                </div>
                <button onClick={exportCSV} disabled={tabRows.length === 0} style={{ display: "flex", alignItems: "center", gap: 6, background: tabRows.length === 0 ? C.surfaceAlt : C.surface, border: `1.5px solid ${tabRows.length === 0 ? C.border : C.accent}`, borderRadius: 7, padding: "6px 14px", fontSize: 12, fontWeight: 700, cursor: tabRows.length === 0 ? "not-allowed" : "pointer", color: tabRows.length === 0 ? C.muted : C.accent, fontFamily: "inherit" }}>
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                  Export CSV
                </button>
              </div>
              <div style={{ display: "flex", gap: 0, borderBottom: `2px solid ${C.border}` }}>
                {[["all", "All", allRows.length], ["clean", "Clean", clean.length], ["duplicates", "Duplicates", dupes.length]].map(([key, label, count]) => (
                  <button key={key} onClick={() => { setStudentViewTab(key); setStudentViewPage(1); }} style={{
                    background: "none", border: "none",
                    borderBottom: `2px solid ${studentViewTab === key ? C.accent : "transparent"}`,
                    marginBottom: -2, padding: "8px 16px", fontSize: 13, fontWeight: studentViewTab === key ? 700 : 400,
                    cursor: "pointer", color: studentViewTab === key ? C.accent : C.muted,
                    fontFamily: "inherit", display: "flex", alignItems: "center", gap: 6
                  }}>
                    {label}
                    <span style={{ background: studentViewTab === key ? C.accent : C.border, color: studentViewTab === key ? "#fff" : C.muted, borderRadius: 10, padding: "1px 7px", fontSize: 10, fontWeight: 700 }}>{count}</span>
                  </button>
                ))}
              </div>
              <div style={{ position: "relative" }}>
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke={studentViewSearch ? C.accent : C.muted} strokeWidth="2.2" style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", pointerEvents: "none" }}><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
                <input
                  type="text"
                  placeholder="Search by UID…"
                  value={studentViewSearch}
                  onChange={e => { setStudentViewSearch(e.target.value); setStudentViewPage(1); }}
                  style={{ width: "100%", boxSizing: "border-box", paddingLeft: 32, paddingRight: studentViewSearch ? 32 : 12, paddingTop: 8, paddingBottom: 8, fontSize: 13, border: `1.5px solid ${studentViewSearch ? C.accent : C.border}`, borderRadius: 8, outline: "none", fontFamily: "inherit", color: C.text, background: studentViewSearch ? "#eff6ff" : C.surface }}
                />
                {studentViewSearch && (
                  <button onClick={() => { setStudentViewSearch(""); setStudentViewPage(1); }} style={{ position: "absolute", right: 8, top: "50%", transform: "translateY(-50%)", background: "none", border: "none", cursor: "pointer", color: C.muted, fontSize: 16, lineHeight: 1, padding: 0 }}>×</button>
                )}
              </div>
              {shown.length === 0 ? (
                <div style={{ textAlign: "center", color: C.muted, fontSize: 13, padding: "32px 0" }}>{searchTerm ? `No students found matching "${studentViewSearch}".` : "No records in this view."}</div>
              ) : (
                <div style={{ border: `1px solid ${C.border}`, borderRadius: 10, overflowX: "auto" }}>
                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                    <thead>
                      <tr>
                        <th style={svmThS}>#</th>
                        {allHeaders.map(h => <th key={h} style={svmThS}>{h}</th>)}
                        <th style={svmThS}>Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {pageRows.map((row, i) => (
                        <tr key={i} style={{ background: row._status === "duplicate" ? C.redLight : i % 2 === 0 ? "#fff" : C.surfaceAlt }}>
                          <td style={{ ...svmTdS, color: C.muted }}>{(studentViewPage - 1) * PAGE_SIZE + i + 1}</td>
                          {allHeaders.map(h => <td key={h} style={svmTdS}>{row[h] || "—"}</td>)}
                          <td style={svmTdS}><Badge color={row._status === "duplicate" ? "red" : "green"}>{row._status}</Badge></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {totalPages > 1 && (
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", fontSize: 12, color: C.muted }}>
                  <span>{(studentViewPage - 1) * PAGE_SIZE + 1}–{Math.min(studentViewPage * PAGE_SIZE, shown.length)} of {shown.length}</span>
                  <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
                    <button onClick={() => setStudentViewPage(p => Math.max(1, p - 1))} disabled={studentViewPage === 1}
                      style={{ background: C.surfaceAlt, border: `1px solid ${C.border}`, borderRadius: 6, padding: "5px 12px", fontSize: 12, fontWeight: 700, cursor: studentViewPage === 1 ? "not-allowed" : "pointer", color: studentViewPage === 1 ? C.muted : C.text, fontFamily: "inherit" }}>
                      ← Prev
                    </button>
                    {Array.from({ length: totalPages }, (_, idx) => idx + 1).filter(p => p === 1 || p === totalPages || Math.abs(p - studentViewPage) <= 1).map((p, idx, arr) => (
                      <Fragment key={p}>
                        {idx > 0 && arr[idx - 1] !== p - 1 && <span style={{ padding: "0 4px" }}>…</span>}
                        <button onClick={() => setStudentViewPage(p)} style={{
                          background: p === studentViewPage ? C.accent : C.surfaceAlt,
                          color: p === studentViewPage ? "#fff" : C.text,
                          border: `1px solid ${p === studentViewPage ? C.accent : C.border}`,
                          borderRadius: 6, padding: "5px 10px", fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "inherit", minWidth: 32
                        }}>{p}</button>
                      </Fragment>
                    ))}
                    <button onClick={() => setStudentViewPage(p => Math.min(totalPages, p + 1))} disabled={studentViewPage === totalPages}
                      style={{ background: C.surfaceAlt, border: `1px solid ${C.border}`, borderRadius: 6, padding: "5px 12px", fontSize: 12, fontWeight: 700, cursor: studentViewPage === totalPages ? "not-allowed" : "pointer", color: studentViewPage === totalPages ? C.muted : C.text, fontFamily: "inherit" }}>
                      Next →
                    </button>
                  </div>
                </div>
              )}
            </div>
          </Modal>
        );
      })()}

      {showModal && (
        <Modal title={editing ? "Edit Exam" : "Add New Exam"} onClose={() => setShowModal(false)} width={660}>
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>

            {/* Exam Title */}
            <ExamTitleField value={form.type} onChange={v => setForm({ ...form, type: v })} />

            <Divider />

            {/* Dates + Times — stacked per assessment */}
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>

              {/* Mock Assessment */}
              <div style={{ background: C.surfaceAlt, borderRadius: 10, border: `1px solid ${C.border}` }}>
                {/* Mock header with toggle */}
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "14px 16px", borderBottom: form.requireMock ? `1px solid ${C.border}` : "none" }}>
                  <span style={{ fontSize: 11, fontWeight: 800, color: C.muted, letterSpacing: 0.8, textTransform: "uppercase" }}>🧪 Mock Assessment</span>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ fontSize: 11, color: form.requireMock ? C.accent : C.muted, fontWeight: 600 }}>
                      {form.requireMock ? "Required" : "Not Required"}
                    </span>
                    <div
                      onClick={() => setForm({ ...form, requireMock: !form.requireMock })}
                      style={{ width: 40, height: 22, borderRadius: 11, background: form.requireMock ? C.accent : "#d0d0d0", cursor: "pointer", position: "relative", transition: "background 0.2s", flexShrink: 0 }}
                    >
                      <div style={{ position: "absolute", top: 3, left: form.requireMock ? 21 : 3, width: 16, height: 16, borderRadius: "50%", background: "#fff", transition: "left 0.2s", boxShadow: "0 1px 3px rgba(0,0,0,0.2)" }} />
                    </div>
                  </div>
                </div>
                {/* Mock fields — hidden when not required */}
                {form.requireMock && (
                  <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 12 }}>
                    <Field label="Mock Assessment Title" value={form.mockTitle} onChange={v => setForm({ ...form, mockTitle: v })} placeholder="e.g. Mock Test – Round 1" />
                    <AssessmentDateTimeField
                      startDate={form.mockStartDate}
                      endDate={form.mockEndDate}
                      slot={form.mockSlot}
                      onStartDate={v => setForm({ ...form, mockStartDate: v })}
                      onEndDate={v => setForm({ ...form, mockEndDate: v })}
                      onSlot={v => setForm({ ...form, mockSlot: v })}
                    />
                  </div>
                )}
              </div>

              {/* Main Assessment */}
              <div style={{ background: C.surfaceAlt, borderRadius: 10, border: `1px solid ${C.border}` }}>
                <div style={{ padding: "14px 16px", borderBottom: `1px solid ${C.border}` }}>
                  <span style={{ fontSize: 11, fontWeight: 800, color: C.muted, letterSpacing: 0.8, textTransform: "uppercase" }}>🚀 Main Assessment</span>
                </div>
                <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 12 }}>
                  <Field label="Main Assessment Title" value={form.mainTitle} onChange={v => setForm({ ...form, mainTitle: v })} placeholder="e.g. Final Assessment – Batch 1" />
                  <AssessmentDateTimeField
                    startDate={form.mainStartDate}
                    endDate={form.mainEndDate}
                    slot={form.mainSlot}
                    onStartDate={v => setForm({ ...form, mainStartDate: v })}
                    onEndDate={v => setForm({ ...form, mainEndDate: v })}
                    onSlot={v => setForm({ ...form, mainSlot: v })}
                  />
                </div>
              </div>

            </div>

            {/* Week + Batch preview */}
            {(form.mockStartDate || form.mainStartDate) && form.type && (
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                {form.mockStartDate && <div style={{ background: C.accentLight, borderRadius: 8, padding: "8px 14px", display: "flex", gap: 6, alignItems: "center" }}>
                  <span style={{ fontSize: 10, color: C.muted, fontWeight: 700, letterSpacing: 0.8 }}>MOCK WEEK</span>
                  <span style={{ fontWeight: 800, color: C.accent }}>W{getWeek(form.mainStartDate, previewAllExams)}</span>
                </div>}
                {form.mainStartDate && <div style={{ background: C.accentLight, borderRadius: 8, padding: "8px 14px", display: "flex", gap: 6, alignItems: "center" }}>
                  <span style={{ fontSize: 10, color: C.muted, fontWeight: 700, letterSpacing: 0.8 }}>MAIN WEEK</span>
                  <span style={{ fontWeight: 800, color: C.accent }}>W{getWeek(form.mainStartDate, previewAllExams)}</span>
                </div>}
                {form.mainStartDate && <div style={{ background: C.blueLight, borderRadius: 8, padding: "8px 14px", display: "flex", gap: 6, alignItems: "center" }}>
                  <span style={{ fontSize: 10, color: C.muted, fontWeight: 700, letterSpacing: 0.8 }}>BATCH</span>
                  <span style={{ fontWeight: 800, color: C.blue }}>B{getBatch(previewExam, previewAllExams)}</span>
                  <span style={{ fontSize: 10, color: C.muted }}>(auto by date order in week)</span>
                </div>}
              </div>
            )}

            {/* Cycle (only for Offline) */}
            {needsCycle && (
              <Field label="Cycle Number" value={form.cycle} onChange={v => setForm({ ...form, cycle: v })} placeholder="e.g. 9" />
            )}

            <Divider />

            {/* Student Data */}
            <div>
              <div style={{ fontSize: 11, fontWeight: 700, color: C.muted, letterSpacing: 0.8, textTransform: "uppercase", marginBottom: 10 }}>Student Data</div>
              {editing ? (
                <>
                  {uploads && uploads.filter(u => u.examId === editing).length > 0 && (
                    <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 8 }}>
                      {uploads.filter(u => u.examId === editing).map(u => {
                        const uClean = u.rows.filter(r => r._status !== "duplicate").length;
                        return (
                          <div key={u.id} style={{ display: "inline-flex", alignItems: "center", gap: 6, background: C.surfaceAlt, border: `1px solid ${C.border}`, borderRadius: 6, padding: "3px 8px 3px 10px", fontSize: 11, color: C.muted }}>
                            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
                            <span>{u.fileName}</span>
                            <span style={{ color: C.green, fontWeight: 700 }}>{uClean} students</span>
                            <button onClick={() => setConfirmDeleteUpload(u)} style={{ background: "#fee2e2", border: "1px solid #fca5a5", borderRadius: 4, cursor: "pointer", color: "#dc2626", display: "flex", alignItems: "center", padding: "2px 5px", marginLeft: 2 }} title="Delete this upload">
                              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/></svg>
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  )}
                  <input type="file" accept=".csv" ref={modalFileRef} style={{ display: "none" }}
                    onChange={e => { const f = e.target.files[0]; e.target.value = ""; handleUploadFile(editing, f, uploads, onAddUpload).then(r => r && setUploadedResult(r)); }} />
                  <div style={{ display: "flex", gap: 8 }}>
                    <Btn variant="secondary" size="sm" onClick={() => modalFileRef.current?.click()}>Upload CSV</Btn>
                    <Btn variant="secondary" size="sm">Source from Database</Btn>
                  </div>
                </>
              ) : (
                <>
                  {pendingStudentFile ? (
                    <div style={{ display: "inline-flex", alignItems: "center", gap: 8, background: C.surfaceAlt, border: `1px solid ${C.border}`, borderRadius: 6, padding: "4px 10px", fontSize: 11, color: C.muted, marginBottom: 8 }}>
                      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
                      <span>{pendingStudentFile.name}</span>
                      <button onClick={() => setPendingStudentFile(null)} style={{ background: "none", border: "none", cursor: "pointer", color: C.muted, fontSize: 14, lineHeight: 1, padding: "0 2px" }}>×</button>
                    </div>
                  ) : null}
                  <input type="file" accept=".csv" ref={modalFileRef} style={{ display: "none" }}
                    onChange={e => { setPendingStudentFile(e.target.files[0]); e.target.value = ""; }} />
                  <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                    <Btn variant="secondary" size="sm" onClick={() => modalFileRef.current?.click()}>Upload CSV</Btn>
                    <Btn variant="secondary" size="sm">Source from Database</Btn>
                    {pendingStudentFile && <span style={{ fontSize: 11, color: C.muted }}>Will upload after exam is saved</span>}
                  </div>
                </>
              )}
            </div>

            <Divider />
            <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
              <Btn variant="secondary" onClick={() => setShowModal(false)}>Cancel</Btn>
              <Btn onClick={save} disabled={!form.type || !form.mainStartDate}>Save Exam</Btn>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ─── Page: Student Data ───────────────────────────────────────────────────────

function StudentDataPage({ exams, uploads, onAddUpload, onDeleteUpload }) {
  const [expanded, setExpanded] = useState({});
  const [tabs, setTabs] = useState({});
  const fileRefs = useRef({});
  const [programTab, setProgramTab] = useState("online");
  const PROGRAMS = [
    { id: "online",  label: "Online" },
    { id: "offline", label: "Offline" },
  ];

  const [filterStatus, setFilterStatus] = useState("all");
  const [filterCategory, setFilterCategory] = useState("");
  const [filterDateStart, setFilterDateStart] = useState("");
  const [filterDateEnd, setFilterDateEnd] = useState("");
  const [sortOrder, setSortOrder] = useState("desc");
  const [confirmDeleteData, setConfirmDeleteData] = useState(null);

  const toggle = (id) => setExpanded(p => ({ ...p, [id]: !p[id] }));
  const getTab = (id) => tabs[id] || "all";
  const setTab = (id, t) => setTabs(p => ({ ...p, [id]: t }));

  const handleUpload = (examId, file) => {
    handleUploadFile(examId, file, uploads, onAddUpload).then(() => {
      setExpanded(p => ({ ...p, [examId]: true }));
    });
  };

  const thS = { padding: "10px 14px", textAlign: "left", fontSize: 11, fontWeight: 700, color: C.muted, letterSpacing: 0.8, textTransform: "uppercase", borderBottom: `1px solid ${C.border}`, whiteSpace: "nowrap", background: C.surfaceAlt };
  const tdS = { padding: "9px 14px", fontSize: 12, color: C.text };

  const totalStudents = uploads.reduce((a, u) => a + u.rows.filter(r => r._status !== "duplicate").length, 0);
  const totalDupes = uploads.reduce((a, u) => a + u.rows.filter(r => r._status === "duplicate").length, 0);

  const programExams = exams.filter(e => getExamProgramHead(e) === programTab);
  const examCategories = [...new Set(programExams.map(e => e.type).filter(Boolean))];
  const hasFilters = filterStatus !== "all" || filterCategory || filterDateStart || filterDateEnd;
  const clearSdFilters = () => { setFilterStatus("all"); setFilterCategory(""); setFilterDateStart(""); setFilterDateEnd(""); };

  const filteredExams = programExams.filter(e => {
    if (filterStatus !== "all" && getExamStatus(e) !== filterStatus) return false;
    if (filterCategory && e.type !== filterCategory) return false;
    if (filterDateStart && !(e.mainStartDate && e.mainStartDate >= filterDateStart)) return false;
    if (filterDateEnd && !(e.mainStartDate && e.mainStartDate <= filterDateEnd)) return false;
    return true;
  }).sort((a, b) => {
    const da = a.mainStartDate || "", db2 = b.mainStartDate || "";
    return sortOrder === "asc" ? da.localeCompare(db2) : db2.localeCompare(da);
  });

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 20 }}>
        <div>
          <h1 style={{ fontSize: 24, fontWeight: 900, color: C.text, margin: 0 }}>Student Data</h1>
          <p style={{ color: C.muted, fontSize: 13, marginTop: 4 }}>Storehouse of all student data. Upload CSVs per exam — all columns are preserved, duplicates auto-flagged.</p>
        </div>
      </div>

      {/* Program tabs */}
      <div style={{ display: "flex", gap: 2, marginBottom: 24, borderBottom: `2px solid ${C.border}` }}>
        {PROGRAMS.map(p => (
          <button key={p.id} onClick={() => setProgramTab(p.id)} style={{
            background: "none", border: "none", borderBottom: `2px solid ${programTab === p.id ? C.accent : "transparent"}`,
            marginBottom: -2, padding: "8px 20px", fontSize: 13, fontWeight: 700, cursor: "pointer",
            color: programTab === p.id ? C.accent : C.muted, fontFamily: "inherit", transition: "all 0.15s",
          }}>{p.label}</button>
        ))}
      </div>

      {/* Status tabs */}
          <div style={{ display: "flex", gap: 4, marginBottom: 14, background: C.surfaceAlt, borderRadius: 8, padding: 4, width: "fit-content", border: `1px solid ${C.border}` }}>
            {["all", "upcoming", "completed", "cancelled"].map(f => (
              <button key={f} onClick={() => setFilterStatus(f)} style={{
                background: filterStatus === f ? C.surface : "transparent", border: "none",
                borderRadius: 6, padding: "6px 16px", fontSize: 12, fontWeight: 700, cursor: "pointer",
                color: filterStatus === f ? C.text : C.muted, textTransform: "capitalize", fontFamily: "inherit",
                boxShadow: filterStatus === f ? "0 1px 3px rgba(0,0,0,0.08)" : "none"
              }}>{f}</button>
            ))}
          </div>

          {/* Filter bar */}
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 20, flexWrap: "wrap", background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10, padding: "12px 16px" }}>
            <select value={filterCategory} onChange={e => setFilterCategory(e.target.value)} style={{ background: filterCategory ? "#eff6ff" : C.surface, border: `1.5px solid ${filterCategory ? "#3b82f6" : C.border}`, borderRadius: 7, padding: "7px 12px", fontSize: 13, color: filterCategory ? "#1d4ed8" : C.muted, fontFamily: "inherit", outline: "none", cursor: "pointer", minWidth: 210, fontWeight: filterCategory ? 700 : 400 }}>
              <option value="">All Exam Categories</option>
              {examCategories.map(cat => <option key={cat} value={cat}>{cat}</option>)}
            </select>

            <div style={{ width: 1, height: 28, background: C.border }} />

            {(() => {
              const dateActive = filterDateStart || filterDateEnd;
              const activeInputStyle = { background: "#eff6ff", border: "1.5px solid #3b82f6", borderRadius: 7, padding: "7px 10px", fontSize: 13, color: "#1d4ed8", fontFamily: "inherit", outline: "none", fontWeight: 700 };
              const inactiveInputStyle = { background: C.surface, border: `1px solid ${C.border}`, borderRadius: 7, padding: "7px 10px", fontSize: 13, color: C.muted, fontFamily: "inherit", outline: "none" };
              return (
                <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 8px", borderRadius: 8, background: dateActive ? "#eff6ff" : "transparent", border: `1.5px solid ${dateActive ? "#3b82f6" : "transparent"}` }}>
                  <span style={{ fontSize: 11, fontWeight: 700, color: dateActive ? "#1d4ed8" : C.muted, whiteSpace: "nowrap" }}>DATE</span>
                  <input type="date" value={filterDateStart} onChange={e => setFilterDateStart(e.target.value)} style={filterDateStart ? activeInputStyle : inactiveInputStyle} />
                  <span style={{ color: dateActive ? "#1d4ed8" : C.muted, fontSize: 13 }}>–</span>
                  <input type="date" value={filterDateEnd} onChange={e => setFilterDateEnd(e.target.value)} style={filterDateEnd ? activeInputStyle : inactiveInputStyle} />
                </div>
              );
            })()}

            <div style={{ width: 1, height: 28, background: C.border }} />

            {/* Sort order */}
            <div style={{ display: "flex", background: C.surfaceAlt, borderRadius: 7, border: `1px solid ${C.border}`, overflow: "hidden" }}>
              {[["desc", "Newest First"], ["asc", "Oldest First"]].map(([val, label]) => (
                <button key={val} onClick={() => setSortOrder(val)} style={{
                  background: sortOrder === val ? C.accent : "transparent",
                  color: sortOrder === val ? "#fff" : C.muted,
                  border: "none", padding: "7px 14px", fontSize: 12, fontWeight: 700,
                  cursor: "pointer", fontFamily: "inherit", whiteSpace: "nowrap"
                }}>{label}</button>
              ))}
            </div>

            {hasFilters && (
              <button onClick={clearSdFilters} style={{ background: "none", border: "none", color: C.red, fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "inherit", marginLeft: "auto", whiteSpace: "nowrap" }}>✕ Clear Filters</button>
            )}
          </div>

          {programExams.length === 0 ? (
            <EmptyState icon="📋" title="No exams found" sub="Add exams in Exam Details first, then upload student data here." />
          ) : filteredExams.length === 0 ? (
            <EmptyState icon="🔍" title="No exams match filters" sub="Try clearing filters to see all exams." />
          ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          {filteredExams.map(exam => {
            const examUploads = uploads.filter(u => u.examId === exam.id);
            const allHeaders = [...new Set(examUploads.flatMap(u => u.headers))];
            const allRows = examUploads.flatMap(u => u.rows);
            const clean = allRows.filter(r => r._status !== "duplicate");
            const dupes = allRows.filter(r => r._status === "duplicate");
            const isOpen = expanded[exam.id];
            const curTab = getTab(exam.id);
            const shown = curTab === "all" ? allRows : curTab === "clean" ? clean : dupes;
            const week = getWeek(exam.mainStartDate, exams);
            const batch = getBatch(exam, exams);
            const isCancelled = getExamStatus(exam) === "cancelled";

            return (
              <Card key={exam.id}>
                {/* Row: exam info + actions */}
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 16 }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 4, flexWrap: "wrap" }}>
                      <Badge color={getExamStatus(exam) === "completed" ? "green" : getExamStatus(exam) === "cancelled" ? "red" : "blue"}>{getExamStatus(exam)}</Badge>
                      {!isCancelled && week && <Badge color="orange">W{week}</Badge>}
                      {!isCancelled && <Badge color="blue">B{batch}</Badge>}
                      {exam.cycle && <Badge color="yellow">Cycle {exam.cycle}</Badge>}
                      <span style={{ fontWeight: 800, fontSize: 15, color: C.text }}>{exam.type}</span>
                    </div>
                    <div style={{ color: C.muted, fontSize: 12 }}>
                      Main: {fmtDateRange(exam.mainStartDate, exam.mainEndDate)}
                      {allRows.length > 0 && <>
                        <span style={{ margin: "0 6px" }}>·</span>
                        <span style={{ color: C.green, fontWeight: 700 }}>{clean.length} students</span>
                        {dupes.length > 0 && <span style={{ color: C.red, fontWeight: 700 }}> · {dupes.length} duplicates</span>}
                      </>}
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: 8, alignItems: "center", flexShrink: 0 }}>
                    <input type="file" accept=".csv" ref={el => fileRefs.current[exam.id] = el} style={{ display: "none" }}
                      onChange={e => { handleUpload(exam.id, e.target.files[0]); e.target.value = ""; }} />
                    <Btn variant="primary" size="sm" icon="⬆" onClick={() => fileRefs.current[exam.id]?.click()}>Upload CSV</Btn>
                    <Btn variant="secondary" size="sm" icon={<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/></svg>}>Source from Database</Btn>
                    {allRows.length > 0 && (
                      <>
                        <Btn variant="secondary" size="sm" onClick={() => toggle(exam.id)}>
                          {isOpen ? "▲ Collapse" : "▼ View"}
                        </Btn>
                        <button onClick={() => setConfirmDeleteData(exam)} title="Delete all student data for this exam" style={{ background: "none", border: `1px solid ${C.border}`, borderRadius: 7, padding: "5px 8px", cursor: "pointer", color: C.red, display: "flex", alignItems: "center" }}>
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/></svg>
                        </button>
                      </>
                    )}
                  </div>
                </div>

                {/* Upload chips */}
                {examUploads.length > 0 && (
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 10 }}>
                    {examUploads.map(u => (
                      <div key={u.id} style={{ display: "inline-flex", alignItems: "center", gap: 6, background: C.surfaceAlt, border: `1px solid ${C.border}`, borderRadius: 6, padding: "3px 8px 3px 10px", fontSize: 11, color: C.muted }}>
                        📄 {u.fileName} · {u.rows.length} rows · {fmtDate(u.uploadedAt)}
                        <button onClick={() => onDeleteUpload(u.id)} style={{ background: "none", border: "none", cursor: "pointer", color: C.muted, fontSize: 14, lineHeight: 1, padding: "0 2px" }}>×</button>
                      </div>
                    ))}
                  </div>
                )}

                {/* Collapsible table */}
                {isOpen && (
                  <div style={{ marginTop: 14 }}>
                    <div style={{ display: "flex", gap: 4, marginBottom: 12, borderBottom: `2px solid ${C.border}` }}>
                      {["all", "clean", "duplicates"].map(t => (
                        <button key={t} onClick={() => setTab(exam.id, t)} style={{
                          background: "none", border: "none",
                          borderBottom: curTab === t ? `2px solid ${C.accent}` : "2px solid transparent",
                          padding: "6px 14px", fontSize: 12, fontWeight: curTab === t ? 700 : 400,
                          cursor: "pointer", color: curTab === t ? C.accent : C.muted,
                          fontFamily: "inherit", marginBottom: -2, textTransform: "capitalize"
                        }}>
                          {t}
                          {t === "duplicates" && dupes.length > 0 && (
                            <span style={{ background: C.red, color: "#fff", borderRadius: 10, padding: "1px 6px", fontSize: 10, marginLeft: 4 }}>{dupes.length}</span>
                          )}
                        </button>
                      ))}
                      <span style={{ marginLeft: "auto", fontSize: 11, color: C.muted, alignSelf: "center" }}>{shown.length} record{shown.length !== 1 ? "s" : ""}</span>
                    </div>

                    {shown.length === 0 ? (
                      <EmptyState icon="✅" title="No records" sub="No students in this view." />
                    ) : (
                      <div style={{ border: `1px solid ${C.border}`, borderRadius: 10, overflowX: "auto" }}>
                        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                          <thead>
                            <tr>
                              <th style={thS}>#</th>
                              {allHeaders.map(h => <th key={h} style={thS}>{h}</th>)}
                              <th style={thS}>Status</th>
                            </tr>
                          </thead>
                          <tbody>
                            {shown.map((row, i) => (
                              <tr key={i} style={{ background: row._status === "duplicate" ? C.redLight : i % 2 === 0 ? "#fff" : C.surfaceAlt }}>
                                <td style={{ ...tdS, color: C.muted, borderBottom: `1px solid ${C.border}` }}>{i + 1}</td>
                                {allHeaders.map(h => (
                                  <td key={h} style={{ ...tdS, borderBottom: `1px solid ${C.border}` }}>{row[h] || "—"}</td>
                                ))}
                                <td style={{ ...tdS, borderBottom: `1px solid ${C.border}` }}>
                                  <Badge color={row._status === "duplicate" ? "red" : "green"}>{row._status}</Badge>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                )}
              </Card>
            );
          })}
        </div>
          )}

      {confirmDeleteData && (
        <Modal title="Delete Student Data" onClose={() => setConfirmDeleteData(null)} width={420}>
          <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
            <div>
              <div style={{ fontWeight: 700, fontSize: 15, color: C.text, marginBottom: 6 }}>{confirmDeleteData.type}</div>
              <div style={{ fontSize: 13, color: C.muted }}>This will permanently delete all uploaded student data for this exam. This cannot be undone.</div>
            </div>
            <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
              <Btn variant="secondary" onClick={() => setConfirmDeleteData(null)}>Cancel</Btn>
              <Btn variant="danger" onClick={async () => {
                const toDelete = uploads.filter(u => u.examId === confirmDeleteData.id);
                await Promise.all(toDelete.map(u => onDeleteUpload(u.id)));
                setConfirmDeleteData(null);
              }}>Delete All Data</Btn>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ─── Page: Config Library ─────────────────────────────────────────────────────

function CopyLinkCell({ url, copiedUrl, onCopy }) {
  if (!url) return <span style={{ color: C.muted, fontSize: 11 }}>—</span>;
  const copied = copiedUrl === url;
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6, maxWidth: "100%" }}>
      <a href={url} target="_blank" rel="noreferrer" title={url} style={{ color: C.blue, fontSize: 11, textDecoration: "underline", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0, flex: 1 }}>
        {url}
      </a>
      <button onClick={() => onCopy(url)} title="Copy URL" style={{ background: "none", border: "none", cursor: "pointer", color: copied ? C.green : C.muted, padding: 0, display: "inline-flex", alignItems: "center", flexShrink: 0 }}>
        {copied
          ? <svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M3 8l3 3 7-7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
          : <svg width="13" height="13" viewBox="0 0 16 16" fill="none"><rect x="5" y="5" width="8" height="8" rx="1.5" stroke="currentColor" strokeWidth="1.4"/><path d="M3 11V3h8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/></svg>
        }
      </button>
    </span>
  );
}

function ConfigLibraryPage({ configEntries, onSaveConfigEntry, onUpdateConfigEntry, onDeleteConfigEntry, exams, role, notifications, onAddNotification, onMarkNotifRead, onMarkAllNotifsRead, currentUserEmail }) {
  const [programTab, setProgramTab] = useState("online");
  const [showModal, setShowModal] = useState(false);
  const [editingEntry, setEditingEntry] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [copiedUrl, setCopiedUrl] = useState(null);
  const [pickedConfigLinks, setPickedConfigLinks] = useState({});
  const [showNotifs, setShowNotifs] = useState(false);
  const [modalExamLocked, setModalExamLocked] = useState(false);
  const [configPage, setConfigPage] = useState(1);
  const CONFIG_PAGE_SIZE = 10;
  const [showImportModal, setShowImportModal] = useState(false);
  const [importStatus, setImportStatus] = useState(null); // null | "importing" | { added, updated, errors }
  const [showTrackerModal, setShowTrackerModal] = useState(false);
  const [trackerStatus, setTrackerStatus] = useState(null);
  const [trackerPreview, setTrackerPreview] = useState(null); // parsed rows before import
  const notifRef = useRef(null);
  const fileInputRef = useRef(null);
  const trackerFileInputRef = useRef(null);

  const emptyPair = { assessmentLink: "", configLink: "" };
  const emptyForm = { examId: "", mock: [{ ...emptyPair }], main: [{ ...emptyPair }] };
  const [form, setForm] = useState(emptyForm);

  const PROGRAMS = [{ id: "online", label: "Online" }, { id: "offline", label: "Offline" }];
  useEffect(() => { setConfigPage(1); }, [programTab]);

  const tabExams = exams.filter(e => getExamProgramHead(e) === programTab);

  // Every exam in this tab gets a row; entry may be null if no config exists yet
  const tabRows = tabExams
    .map(exam => ({ exam, entry: (configEntries || []).find(ce => ce.examId === exam.id) || null }))
    .sort((a, b) => (b.exam.mainStartDate || "").localeCompare(a.exam.mainStartDate || ""));

  // Normalize legacy data formats to arrays
  const normPairs = (data) => {
    if (Array.isArray(data)) return data.length ? data : [{ ...emptyPair }];
    if (data?.assessmentLink !== undefined) return [{ assessmentLink: data.assessmentLink || "", configLink: data.configLink || "" }];
    const pairs = [];
    if (data?.assessmentLink1) pairs.push({ assessmentLink: data.assessmentLink1, configLink: data.configLink1 || "" });
    if (data?.assessmentLink2) pairs.push({ assessmentLink: data.assessmentLink2, configLink: data.configLink2 || "" });
    return pairs.length ? pairs : [{ ...emptyPair }];
  };

  const copyUrl = (url) => { navigator.clipboard.writeText(url).then(() => { setCopiedUrl(url); setTimeout(() => setCopiedUrl(null), 1500); }); };

  const updatePair = (kind, j, field, val) => { const pairs = form[kind].map((p, idx) => idx === j ? { ...p, [field]: val } : p); setForm({ ...form, [kind]: pairs }); };
  const addPair   = (kind) => setForm({ ...form, [kind]: [...form[kind], { ...emptyPair }] });
  const removePair = (kind, j) => { const pairs = form[kind].filter((_, idx) => idx !== j); setForm({ ...form, [kind]: pairs.length ? pairs : [{ ...emptyPair }] }); };

  useEffect(() => {
    const handler = (e) => { if (notifRef.current && !notifRef.current.contains(e.target)) setShowNotifs(false); };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const downloadTemplate = () => {
    const allTabRows = tabExams
      .map(exam => ({ exam, entry: (configEntries || []).find(ce => ce.examId === exam.id) || null }))
      .sort((a, b) => (b.exam.mainStartDate || "").localeCompare(a.exam.mainStartDate || ""));
    const headers = ["Exam", "Date", "Week", "Batch", "Mock Assessment Link", "Mock Config Link", "Main Assessment Link", "Main Config Link"];
    const rows = allTabRows.map(({ exam, entry }) => {
      const mp = entry ? normPairs(entry.mock) : [];
      const np = entry ? normPairs(entry.main) : [];
      const week = getWeek(exam.mainStartDate, exams);
      const batch = getBatch(exam, exams);
      return [exam.type, exam.mainStartDate, week ? `W${week}` : "", batch ? `B${batch}` : "", mp[0]?.assessmentLink || "", mp[0]?.configLink || "", np[0]?.assessmentLink || "", np[0]?.configLink || ""];
    });
    const csv = [headers, ...rows].map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    a.download = `config-library-${programTab}-${new Date().toISOString().split("T")[0]}.csv`;
    a.click();
  };

  const importCSV = async (file) => {
    setImportStatus("importing");
    try {
      const text = await file.text();
      const [, ...dataRows] = parseCSV(text); // skip header row
      // Group by exam name+date key — multiple rows with same exam become additional pairs
      const byKey = {};
      for (const row of dataRows) {
        const [examName, examDate, , , mockAssLink, mockConfLink, mainAssLink, mainConfLink] = row;
        if (!examName || !examDate) continue;
        const key = `${examName}||${examDate}`;
        if (!byKey[key]) byKey[key] = { examName, examDate, mock: [], main: [] };
        const hasMock = mockAssLink || mockConfLink;
        const hasMain = mainAssLink || mainConfLink;
        if (hasMock) byKey[key].mock.push({ assessmentLink: mockAssLink || "", configLink: mockConfLink || "" });
        if (hasMain) byKey[key].main.push({ assessmentLink: mainAssLink || "", configLink: mainConfLink || "" });
      }
      let added = 0, updated = 0, errors = 0;
      for (const data of Object.values(byKey)) {
        const matchedExam = exams.find(e => e.type === data.examName && e.mainStartDate === data.examDate);
        if (!matchedExam) { errors++; continue; }
        const examId = matchedExam.id;
        // Content role: preserve existing assessment links they're not allowed to change
        if (!can(role, "configs.assessmentLink")) {
          const existing = (configEntries || []).find(ce => ce.examId === examId);
          const existingMock = existing ? normPairs(existing.mock) : [];
          const existingMain = existing ? normPairs(existing.main) : [];
          data.mock = data.mock.map((p, i) => ({ assessmentLink: existingMock[i]?.assessmentLink || "", configLink: p.configLink }));
          data.main = data.main.map((p, i) => ({ assessmentLink: existingMain[i]?.assessmentLink || "", configLink: p.configLink }));
        }
        if (!data.mock.length) data.mock = [{ assessmentLink: "", configLink: "" }];
        if (!data.main.length) data.main = [{ assessmentLink: "", configLink: "" }];
        try {
          const existing = (configEntries || []).find(ce => ce.examId === examId);
          if (existing) { await onUpdateConfigEntry(existing.id, { examId, mock: data.mock, main: data.main }); updated++; }
          else { await onSaveConfigEntry({ examId, mock: data.mock, main: data.main }); added++; }
        } catch { errors++; }
      }
      setImportStatus({ added, updated, errors });
    } catch {
      setImportStatus({ added: 0, updated: 0, errors: 1 });
    }
  };

  const parseTrackerFile = async (file) => {
    const text = await file.text();
    // Auto-detect delimiter: tab vs comma
    const firstLine = text.split("\n")[0];
    const tabCount   = (firstLine.match(/\t/g) || []).length;
    const commaCount = (firstLine.match(/,/g)  || []).length;
    const delim = tabCount > commaCount ? "\t" : ",";

    const parseLine = (line) => {
      if (delim === "\t") return line.split("\t").map(s => s.trim().replace(/^"|"$/g, ""));
      // comma: use full CSV parser
      const result = []; let cur = ""; let inQ = false;
      for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === '"') { if (inQ && line[i+1] === '"') { cur += '"'; i++; } else inQ = !inQ; }
        else if (ch === ',' && !inQ) { result.push(cur.trim()); cur = ""; }
        else cur += ch;
      }
      result.push(cur.trim());
      return result;
    };

    const allRows = text.trim().split(/\r?\n/).map(parseLine);

    // Auto-detect header row — find the row containing "Assessment Date" or "Assessment Week"
    let headerIdx = 0;
    for (let i = 0; i < Math.min(6, allRows.length); i++) {
      if (allRows[i].some(c => c.trim() === "Assessment Date" || c.trim() === "Assessment Week")) {
        headerIdx = i; break;
      }
    }
    const headerRow = allRows[headerIdx];
    const dataRows  = allRows.slice(headerIdx + 1);
    const colIdx = {};
    headerRow.forEach((h, i) => { colIdx[h.trim().replace(/[\n\r"]/g, "")] = i; });
    const get = (row, name, fallback) => row[colIdx[name] ?? fallback]?.trim() || "";

    const DOMAIN_MAP = {
      "prelims":     "Preliminary Online Assessment",
      "dsa":         "DSA Assessment",
      "prelims+dsa": "Placement Online Assessment",
      "offline":     "Offline Placement Exam",
    };
    const MONTHS = { jan:"01",feb:"02",mar:"03",apr:"04",may:"05",jun:"06",jul:"07",aug:"08",sep:"09",oct:"10",nov:"11",dec:"12" };
    const normDate = (s) => {
      if (!s) return "";
      s = s.trim();
      if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
      // DD/MM/YYYY or DD-MM-YYYY
      const dmy = s.match(/^(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{4})$/);
      if (dmy) return `${dmy[3]}-${dmy[2].padStart(2,"0")}-${dmy[1].padStart(2,"0")}`;
      // "Dec 27, 2025 ..." or "Dec 27 2025" (with optional time after)
      const mdy = s.match(/^([A-Za-z]{3})\s+(\d{1,2}),?\s+(\d{4})/);
      if (mdy) { const m = MONTHS[mdy[1].toLowerCase()]; if (m) return `${mdy[3]}-${m}-${mdy[2].padStart(2,"0")}`; }
      // "Dec 27" (no year) → partial match marker
      const md = s.match(/^([A-Za-z]{3})\s+(\d{1,2})$/);
      if (md) { const m = MONTHS[md[1].toLowerCase()]; if (m) return `partial:${m}-${md[2].padStart(2,"0")}`; }
      const d = new Date(s);
      return isNaN(d) ? s : d.toISOString().split("T")[0];
    };
    const normDomain = (s) => s.toLowerCase().replace(/\s+/g, "").replace(/[^a-z+]/g, "");

    const rows = [];
    for (const row of dataRows) {
      if (row.length < 5) continue;
      const rawDate  = get(row, "Assessment Date", 2);
      const domain   = get(row, "Domain", 4);
      const mockAss  = get(row, "Mock Assessment Link", 15);
      const mockConf = get(row, "Mock Config Link", 16);
      const mainAss  = get(row, "Main Assessment Link", 22);
      const mainConf = get(row, "Main Config Link", 23);
      if (!rawDate && !domain) continue;

      // Pass full Main Assessment Start Date string — mdy regex handles "Dec 27, 2025 9:00 AM"
      const rawMainDate = get(row, "Main Assessment Start Date & Time", 20);
      const dateStr     = normDate(rawDate) || normDate(rawMainDate);
      const isPartial   = dateStr.startsWith("partial:");
      const partialMD   = isPartial ? dateStr.slice(8) : null; // "MM-DD"
      const date        = isPartial ? partialMD : dateStr;
      const mappedType  = DOMAIN_MAP[normDomain(domain)];
      const hasLinks    = !!(mockAss || mockConf || mainAss || mainConf);

      // Match by date + domain; partial dates match by "-MM-DD" suffix across any year
      const byDate = isPartial
        ? exams.filter(e => e.mainStartDate && e.mainStartDate.endsWith("-" + partialMD))
        : exams.filter(e => e.mainStartDate === date);
      const byType = mappedType ? byDate.filter(e => e.type === mappedType) : byDate;
      const matchedExam = (byType.length >= 1 ? byType[0] : null) || (byDate.length === 1 ? byDate[0] : null);

      rows.push({ rawDate, date, domain, mappedType: mappedType || "—", hasLinks, matchedExam: matchedExam || null, mockAss, mockConf, mainAss, mainConf });
    }
    return rows;
  };

  const importTracker = async (rows) => {
    setTrackerStatus("importing");
    let added = 0, updated = 0, errors = 0, skipped = 0;
    for (const r of rows) {
      if (!r.hasLinks) { skipped++; continue; }
      if (!r.matchedExam) { errors++; continue; }
      const mock = [{ assessmentLink: r.mockAss, configLink: r.mockConf }];
      const main = [{ assessmentLink: r.mainAss, configLink: r.mainConf }];
      if (!can(role, "configs.assessmentLink")) {
        const ex = (configEntries || []).find(ce => ce.examId === r.matchedExam.id);
        const exMock = ex ? normPairs(ex.mock) : [];
        const exMain = ex ? normPairs(ex.main) : [];
        mock[0].assessmentLink = exMock[0]?.assessmentLink || "";
        main[0].assessmentLink = exMain[0]?.assessmentLink || "";
      }
      try {
        const existing = (configEntries || []).find(ce => ce.examId === r.matchedExam.id);
        if (existing) { await onUpdateConfigEntry(existing.id, { examId: r.matchedExam.id, mock, main }); updated++; }
        else { await onSaveConfigEntry({ examId: r.matchedExam.id, mock, main }); added++; }
      } catch { errors++; }
    }
    setTrackerStatus({ added, updated, errors, skipped });
    setTrackerPreview(null);
  };

  const openAdd  = (examId = "") => { setForm({ ...emptyForm, examId }); setEditingEntry(null); setModalExamLocked(!!examId); setShowModal(true); };
  const openEdit = (entry) => { setForm({ examId: entry.examId, mock: normPairs(entry.mock), main: normPairs(entry.main) }); setEditingEntry(entry); setModalExamLocked(true); setShowModal(true); };
  const closeModal = () => { setShowModal(false); setForm(emptyForm); setEditingEntry(null); setPickedConfigLinks({}); setModalExamLocked(false); };

  // All distinct config links from existing entries — for the "pick from existing" picker in the modal
  const existingConfigLinks = (configEntries || []).flatMap(entry => {
    if (entry.id === editingEntry?.id) return [];
    const exam = exams.find(e => e.id === entry.examId);
    const examLabel = exam ? `${exam.type} — ${fmtDate(exam.mainStartDate)}` : "Unknown";
    const mp = normPairs(entry.mock);
    const np = normPairs(entry.main);
    return [
      ...mp.filter(p => p.configLink).map((p, j) => ({ label: `${examLabel} · Mock${mp.length > 1 ? ` P${j+1}` : ""}`, url: p.configLink })),
      ...np.filter(p => p.configLink).map((p, j) => ({ label: `${examLabel} · Main${np.length > 1 ? ` P${j+1}` : ""}`, url: p.configLink })),
    ];
  });

  const save = async () => {
    if (editingEntry) { await onUpdateConfigEntry(editingEntry.id, form); }
    else { await onSaveConfigEntry(form); }
    // Notify admin when content team adds/updates a config link
    const hasConfigLink = [...form.mock, ...form.main].some(p => p.configLink);
    if (role === "content" && hasConfigLink) {
      const exam = exams.find(e => e.id === form.examId);
      const examLabel = exam ? `${exam.type} — ${fmtDate(exam.mainStartDate)}` : form.examId;
      await onAddNotification({
        type: "config_link_updated",
        examId: form.examId,
        summary: `Config link ${editingEntry ? "updated" : "added"} for ${examLabel}`,
        createdAt: new Date().toISOString(),
        createdBy: currentUserEmail,
        read: false,
      });
    }
    closeModal();
  };

  const thBase = { fontSize: 10, fontWeight: 700, letterSpacing: 0.8, textTransform: "uppercase", border: `1px solid ${C.border}`, whiteSpace: "nowrap" };
  const subThBase = { fontSize: 10, fontWeight: 600, color: C.muted, letterSpacing: 0.5, textTransform: "uppercase", border: `1px solid ${C.border}`, whiteSpace: "nowrap" };

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 24 }}>
        <h1 style={{ fontSize: 24, fontWeight: 900, color: C.text, margin: 0 }}>Config Library</h1>
        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          {(role === "admin" || role === "content" || role === "super_admin") && (() => {
            const configNotifs = (notifications || []).filter(n => n.type === "config_link_updated" || n.type === "config_link_reminder");
            const unreadCount = configNotifs.filter(n => !n.read).length;
            const notifTypeMap = {
              config_link_updated:  { color: "#7c3aed", bg: "#f5f3ff", label: "Config Updated" },
              config_link_reminder: { color: "#d97706", bg: "#fef3c7", label: "Config Reminder" },
            };
            return (
              <div ref={notifRef} style={{ position: "relative" }}>
                <button
                  onClick={() => setShowNotifs(s => { if (!s) configNotifs.filter(n => !n.read).forEach(n => onMarkNotifRead(n.id)); return !s; })}
                  style={{ position: "relative", background: showNotifs ? C.accentLight : C.surface, border: `1.5px solid ${showNotifs ? C.accent : C.border}`, borderRadius: 10, padding: "8px 11px", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={showNotifs ? C.accent : C.text} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>
                  {unreadCount > 0 && (
                    <span style={{ position: "absolute", top: -5, right: -5, background: "#ef4444", color: "#fff", borderRadius: "50%", width: 18, height: 18, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10, fontWeight: 800, border: "2px solid #fff" }}>
                      {unreadCount > 9 ? "9+" : unreadCount}
                    </span>
                  )}
                </button>
                {showNotifs && (
                  <div style={{ position: "absolute", right: 0, top: "calc(100% + 8px)", width: 380, background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12, boxShadow: "0 8px 32px rgba(0,0,0,0.12)", zIndex: 500, overflow: "hidden" }}>
                    <div style={{ padding: "13px 16px", borderBottom: `1px solid ${C.border}`, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      <span style={{ fontWeight: 800, fontSize: 14, color: C.text }}>Config Notifications</span>
                      {configNotifs.length > 0 && <button onClick={() => configNotifs.filter(n => !n.read).forEach(n => onMarkNotifRead(n.id))} style={{ background: "none", border: "none", fontSize: 11, fontWeight: 700, color: C.accent, cursor: "pointer", fontFamily: "inherit", padding: 0 }}>Mark all read</button>}
                    </div>
                    <div style={{ maxHeight: 420, overflowY: "auto" }}>
                      {!configNotifs.length ? (
                        <div style={{ padding: "36px 16px", textAlign: "center", color: C.muted, fontSize: 13 }}>No notifications yet</div>
                      ) : configNotifs.map((n, i) => {
                        const tc = notifTypeMap[n.type] || { color: C.muted, bg: C.surfaceAlt, label: "Update" };
                        return (
                          <div key={n.id} style={{ padding: "12px 16px", borderBottom: i < configNotifs.length - 1 ? `1px solid ${C.border}` : "none", background: n.read ? C.surface : "#fafaf9", display: "flex", gap: 12, alignItems: "flex-start" }}>
                            <div style={{ width: 34, height: 34, borderRadius: "50%", background: tc.bg, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                              {n.type === "config_link_updated"  && <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke={tc.color} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>}
                              {n.type === "config_link_reminder" && <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke={tc.color} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>}
                            </div>
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div style={{ fontSize: 12, fontWeight: 600, color: C.text, marginBottom: 4, lineHeight: 1.4 }}>{n.summary}</div>
                              <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                                <span style={{ fontSize: 10, fontWeight: 700, color: tc.color, background: tc.bg, borderRadius: 4, padding: "2px 6px" }}>{tc.label}</span>
                                <span style={{ fontSize: 11, color: C.muted }}>{timeAgo(n.createdAt)}</span>
                                {n.createdBy && <span style={{ fontSize: 11, color: C.muted }}>by {n.createdBy.split("@")[0]}</span>}
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
            );
          })()}
          {can(role, "configs.write") && (
            <>
              <button onClick={downloadTemplate} title="Download CSV template" style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 9, padding: "8px 14px", fontSize: 12, fontWeight: 600, color: C.text, cursor: "pointer", fontFamily: "inherit", display: "inline-flex", alignItems: "center", gap: 6 }}>
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M8 2v8M5 7l3 3 3-3M3 12h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
                Template
              </button>
              <button onClick={() => { setImportStatus(null); setShowImportModal(true); }} title="Import CSV" style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 9, padding: "8px 14px", fontSize: 12, fontWeight: 600, color: C.text, cursor: "pointer", fontFamily: "inherit", display: "inline-flex", alignItems: "center", gap: 6 }}>
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M8 10V2M5 5l3-3 3 3M3 12h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
                Import CSV
              </button>
              <button onClick={() => { setTrackerStatus(null); setShowTrackerModal(true); }} title="Import from master tracker" style={{ background: "#fefce8", border: `1px solid #fde68a`, borderRadius: 9, padding: "8px 14px", fontSize: 12, fontWeight: 600, color: "#92400e", cursor: "pointer", fontFamily: "inherit", display: "inline-flex", alignItems: "center", gap: 6 }}>
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M2 3h12v10H2zM2 6h12M5 3v10" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/></svg>
                Import Tracker
              </button>
            </>
          )}
        </div>
      </div>

      <div style={{ display: "flex", gap: 2, marginBottom: 24, borderBottom: `2px solid ${C.border}` }}>
        {PROGRAMS.map(p => (
          <button key={p.id} onClick={() => setProgramTab(p.id)} style={{ background: "none", border: "none", borderBottom: `2px solid ${programTab === p.id ? C.accent : "transparent"}`, marginBottom: -2, padding: "8px 20px", fontSize: 13, fontWeight: 700, cursor: "pointer", color: programTab === p.id ? C.accent : C.muted, fontFamily: "inherit", transition: "all 0.15s" }}>{p.label}</button>
        ))}
      </div>

      {tabRows.length === 0 ? (
        <EmptyState icon="📋" title="No exams yet" sub="Add exams in Exam Details — they'll appear here automatically." />
      ) : (() => {
        const totalPages = Math.ceil(tabRows.length / CONFIG_PAGE_SIZE);
        const pageRows = tabRows.slice((configPage - 1) * CONFIG_PAGE_SIZE, configPage * CONFIG_PAGE_SIZE);
        return (<>
        <div style={{ border: `1px solid ${C.border}`, borderRadius: 10, overflow: "hidden" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12, tableLayout: "fixed" }}>
            <colgroup>
              <col style={{ width: 155 }} />
              <col /><col /><col /><col />
              <col style={{ width: 48 }} />
            </colgroup>
            <thead>
              <tr style={{ background: C.surfaceAlt }}>
                <th rowSpan={2} style={{ ...thBase, width: "1px", padding: "6px 12px", textAlign: "left", color: C.muted }}>Exam</th>
                <th colSpan={2} style={{ ...thBase, padding: "6px 12px", textAlign: "center", color: "#2563eb", background: "#eff6ff" }}>Mock</th>
                <th colSpan={2} style={{ ...thBase, padding: "6px 12px", textAlign: "center", color: "#c2410c", background: "#fff7ed" }}>Main</th>
                <th rowSpan={2} style={{ width: "1px", border: `1px solid ${C.border}` }} />
              </tr>
              <tr style={{ background: C.surfaceAlt }}>
                {[["Assessment Link","#eff6ff"],["Config Link","#eff6ff"],["Assessment Link","#fff7ed"],["Config Link","#fff7ed"]].map(([h, bg], idx) => (
                  <th key={idx} style={{ ...subThBase, padding: "5px 12px", textAlign: "left", background: bg }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {pageRows.map(({ exam, entry }, i) => {
                const week = getWeek(exam.mainStartDate, exams);
                const batch = getBatch(exam, exams);
                const mockPairs = entry ? normPairs(entry.mock) : [];
                const mainPairs = entry ? normPairs(entry.main) : [];
                const numRows = Math.max(mockPairs.length, mainPairs.length, 1);
                const bg = i % 2 === 0 ? "#fff" : C.surfaceAlt;
                const cell = { verticalAlign: "middle", background: bg, border: `1px solid ${C.border}`, padding: "5px 12px" };
                return Array.from({ length: numRows }, (_, j) => (
                  <tr key={(entry?.id || exam.id) + "-" + j}>
                    {j === 0 && (
                      <td rowSpan={numRows} style={{ ...cell }}>
                        <div style={{ fontWeight: 700, color: C.text, fontSize: 12 }}>{exam.type}</div>
                        <div style={{ color: C.muted, fontSize: 10, marginTop: 2 }}>{[week && `W${week}`, batch && `B${batch}`, fmtDate(exam.mainStartDate)].filter(Boolean).join(" · ")}</div>
                      </td>
                    )}
                    <td style={cell}><CopyLinkCell url={mockPairs[j]?.assessmentLink} copiedUrl={copiedUrl} onCopy={copyUrl} /></td>
                    <td style={cell}><CopyLinkCell url={mockPairs[j]?.configLink} copiedUrl={copiedUrl} onCopy={copyUrl} /></td>
                    <td style={cell}><CopyLinkCell url={mainPairs[j]?.assessmentLink} copiedUrl={copiedUrl} onCopy={copyUrl} /></td>
                    <td style={cell}><CopyLinkCell url={mainPairs[j]?.configLink} copiedUrl={copiedUrl} onCopy={copyUrl} /></td>
                    {j === 0 && (
                      <td rowSpan={numRows} style={{ ...cell, textAlign: "center", whiteSpace: "nowrap" }}>
                        {can(role, "configs.write") && (
                          <div style={{ display: "flex", gap: 2, justifyContent: "center" }}>
                            <button
                              onClick={() => entry ? openEdit(entry) : openAdd(exam.id)}
                              title={entry ? "Edit" : "Add links"}
                              style={{ background: "none", border: "none", cursor: "pointer", color: entry ? C.muted : C.accent, padding: 4, display: "inline-flex", alignItems: "center", borderRadius: 4 }}
                            >
                              <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M11.5 2.5a1.414 1.414 0 0 1 2 2L5 13H3v-2L11.5 2.5Z" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/></svg>
                            </button>
                            {entry && (
                              <button onClick={() => setConfirmDelete(entry)} title="Delete" style={{ background: "none", border: "none", cursor: "pointer", color: C.muted, padding: 4, display: "inline-flex", alignItems: "center", borderRadius: 4 }}>
                                <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M3 4h10M6 4V3h4v1M5 4l.5 8h5l.5-8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/></svg>
                              </button>
                            )}
                          </div>
                        )}
                      </td>
                    )}
                  </tr>
                ));
              })}
            </tbody>
          </table>
        </div>
        {totalPages > 1 && (
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 14, padding: "0 2px" }}>
            <span style={{ fontSize: 12, color: C.muted }}>
              {(configPage - 1) * CONFIG_PAGE_SIZE + 1}–{Math.min(configPage * CONFIG_PAGE_SIZE, tabRows.length)} of {tabRows.length}
            </span>
            <div style={{ display: "flex", gap: 6 }}>
              <button onClick={() => setConfigPage(p => Math.max(1, p - 1))} disabled={configPage === 1}
                style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 7, padding: "5px 14px", fontSize: 12, fontWeight: 600, cursor: configPage === 1 ? "not-allowed" : "pointer", color: configPage === 1 ? C.muted : C.text, fontFamily: "inherit" }}>
                ← Prev
              </button>
              {Array.from({ length: totalPages }, (_, k) => k + 1).map(pg => (
                <button key={pg} onClick={() => setConfigPage(pg)}
                  style={{ background: pg === configPage ? C.accent : C.surface, border: `1px solid ${pg === configPage ? C.accent : C.border}`, borderRadius: 7, padding: "5px 11px", fontSize: 12, fontWeight: 600, cursor: "pointer", color: pg === configPage ? "#fff" : C.text, fontFamily: "inherit" }}>
                  {pg}
                </button>
              ))}
              <button onClick={() => setConfigPage(p => Math.min(totalPages, p + 1))} disabled={configPage === totalPages}
                style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 7, padding: "5px 14px", fontSize: 12, fontWeight: 600, cursor: configPage === totalPages ? "not-allowed" : "pointer", color: configPage === totalPages ? C.muted : C.text, fontFamily: "inherit" }}>
                Next →
              </button>
            </div>
          </div>
        )}
        </>);
      })()}

      {showModal && (
        <Modal title={editingEntry ? "Edit Config Entry" : "Add Config Entry"} onClose={closeModal}>
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <Field label="Exam" value={form.examId} onChange={v => setForm({ ...form, examId: v })}
              options={tabExams.map(e => ({ v: e.id, l: `${e.type} — ${fmtDate(e.mainStartDate)}` }))}
              disabled={modalExamLocked} />

            {/* Mock pairs */}
            <div style={{ background: "#eff6ff", border: "1px solid #bfdbfe", borderRadius: 8, padding: "14px 16px" }}>
              <div style={{ fontSize: 10, fontWeight: 800, color: "#2563eb", letterSpacing: 1, textTransform: "uppercase", marginBottom: 12 }}>Mock</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                {form.mock.map((pair, j) => (
                  <div key={j} style={{ display: "flex", flexDirection: "column", gap: 8, paddingBottom: j < form.mock.length - 1 ? 12 : 0, borderBottom: j < form.mock.length - 1 ? `1px solid #bfdbfe` : "none" }}>
                    {form.mock.length > 1 && <div style={{ fontSize: 10, color: "#2563eb", fontWeight: 700 }}>Pair {j + 1}</div>}
                    <Field label="Assessment Link" value={pair.assessmentLink} onChange={v => updatePair("mock", j, "assessmentLink", v)} disabled={!can(role, "configs.assessmentLink")} />
                    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                      <Field label="Config Link" value={pair.configLink} onChange={v => updatePair("mock", j, "configLink", v)} />
                      {existingConfigLinks.length > 0 && (
                        <select value={pickedConfigLinks[`mock-${j}`] || ""}
                          onChange={e => setPickedConfigLinks(prev => ({ ...prev, [`mock-${j}`]: e.target.value }))}
                          style={{ border: `1px solid #93c5fd`, borderRadius: 6, padding: "5px 8px", fontSize: 11, color: "#2563eb", background: "transparent", cursor: "pointer", fontFamily: "inherit", outline: "none" }}>
                          <option value="">— view config link from existing —</option>
                          {existingConfigLinks.map((c, idx) => <option key={idx} value={c.url}>{c.label}</option>)}
                        </select>
                      )}
                      {pickedConfigLinks[`mock-${j}`] && (
                        <div style={{ display: "flex", alignItems: "center", gap: 6, background: "#dbeafe", border: "1px solid #93c5fd", borderRadius: 6, padding: "5px 10px" }}>
                          <a href={pickedConfigLinks[`mock-${j}`]} target="_blank" rel="noreferrer" style={{ color: "#1d4ed8", fontSize: 11, textDecoration: "underline", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>{pickedConfigLinks[`mock-${j}`]}</a>
                          <CopyLinkCell url={pickedConfigLinks[`mock-${j}`]} copiedUrl={copiedUrl} onCopy={copyUrl} />
                        </div>
                      )}
                    </div>
                    {form.mock.length > 1 && <button onClick={() => removePair("mock", j)} style={{ alignSelf: "flex-start", background: "none", border: "none", cursor: "pointer", color: C.red, fontSize: 11, fontWeight: 600, padding: 0, fontFamily: "inherit" }}>Remove</button>}
                  </div>
                ))}
                <button onClick={() => addPair("mock")} style={{ alignSelf: "flex-start", background: "none", border: `1px dashed #93c5fd`, borderRadius: 6, cursor: "pointer", color: "#2563eb", fontSize: 11, fontWeight: 600, padding: "5px 12px", fontFamily: "inherit" }}>+ Add Pair</button>
              </div>
            </div>

            {/* Main pairs */}
            <div style={{ background: "#fff7ed", border: "1px solid #fed7aa", borderRadius: 8, padding: "14px 16px" }}>
              <div style={{ fontSize: 10, fontWeight: 800, color: "#c2410c", letterSpacing: 1, textTransform: "uppercase", marginBottom: 12 }}>Main</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                {form.main.map((pair, j) => (
                  <div key={j} style={{ display: "flex", flexDirection: "column", gap: 8, paddingBottom: j < form.main.length - 1 ? 12 : 0, borderBottom: j < form.main.length - 1 ? `1px solid #fed7aa` : "none" }}>
                    {form.main.length > 1 && <div style={{ fontSize: 10, color: "#c2410c", fontWeight: 700 }}>Pair {j + 1}</div>}
                    <Field label="Assessment Link" value={pair.assessmentLink} onChange={v => updatePair("main", j, "assessmentLink", v)} disabled={!can(role, "configs.assessmentLink")} />
                    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                      <Field label="Config Link" value={pair.configLink} onChange={v => updatePair("main", j, "configLink", v)} />
                      {existingConfigLinks.length > 0 && (
                        <select value={pickedConfigLinks[`main-${j}`] || ""}
                          onChange={e => setPickedConfigLinks(prev => ({ ...prev, [`main-${j}`]: e.target.value }))}
                          style={{ border: `1px solid #fb923c`, borderRadius: 6, padding: "5px 8px", fontSize: 11, color: "#c2410c", background: "transparent", cursor: "pointer", fontFamily: "inherit", outline: "none" }}>
                          <option value="">— view config link from existing —</option>
                          {existingConfigLinks.map((c, idx) => <option key={idx} value={c.url}>{c.label}</option>)}
                        </select>
                      )}
                      {pickedConfigLinks[`main-${j}`] && (
                        <div style={{ display: "flex", alignItems: "center", gap: 6, background: "#ffedd5", border: "1px solid #fb923c", borderRadius: 6, padding: "5px 10px" }}>
                          <a href={pickedConfigLinks[`main-${j}`]} target="_blank" rel="noreferrer" style={{ color: "#9a3412", fontSize: 11, textDecoration: "underline", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>{pickedConfigLinks[`main-${j}`]}</a>
                          <CopyLinkCell url={pickedConfigLinks[`main-${j}`]} copiedUrl={copiedUrl} onCopy={copyUrl} />
                        </div>
                      )}
                    </div>
                    {form.main.length > 1 && <button onClick={() => removePair("main", j)} style={{ alignSelf: "flex-start", background: "none", border: "none", cursor: "pointer", color: C.red, fontSize: 11, fontWeight: 600, padding: 0, fontFamily: "inherit" }}>Remove</button>}
                  </div>
                ))}
                <button onClick={() => addPair("main")} style={{ alignSelf: "flex-start", background: "none", border: `1px dashed #fb923c`, borderRadius: 6, cursor: "pointer", color: "#c2410c", fontSize: 11, fontWeight: 600, padding: "5px 12px", fontFamily: "inherit" }}>+ Add Pair</button>
              </div>
            </div>

            <Divider />
            <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
              <Btn variant="secondary" onClick={closeModal}>Cancel</Btn>
              <Btn onClick={save} disabled={!form.examId}>{editingEntry ? "Save Changes" : "Save Entry"}</Btn>
            </div>
          </div>
        </Modal>
      )}

      {confirmDelete && (() => {
        const exam = exams.find(e => e.id === confirmDelete.examId);
        return (
          <Modal title="Delete Entry" onClose={() => setConfirmDelete(null)}>
            <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              <p style={{ margin: 0, color: C.text, fontSize: 14 }}>Delete the config entry for <strong>{exam?.type}</strong> ({fmtDate(exam?.mainStartDate)})? This cannot be undone.</p>
              <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
                <Btn variant="secondary" onClick={() => setConfirmDelete(null)}>Cancel</Btn>
                <Btn variant="danger" onClick={async () => { await onDeleteConfigEntry(confirmDelete.id); setConfirmDelete(null); }}>Delete</Btn>
              </div>
            </div>
          </Modal>
        );
      })()}

      {/* Import Master Tracker modal */}
      {showTrackerModal && (
        <Modal title="Import from Master Tracker" onClose={() => { setShowTrackerModal(false); setTrackerStatus(null); setTrackerPreview(null); }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <div style={{ background: "#fefce8", border: `1px solid #fde68a`, borderRadius: 8, padding: "12px 14px", fontSize: 12, color: "#92400e", lineHeight: 1.7 }}>
              Reads your master tracker CSV and extracts links from:<br />
              <strong>Mock Assessment Link · Mock Config Link · Main Assessment Link · Main Config Link</strong><br />
              Each row is matched to an exam using <strong>Assessment Week + Batch Number + Assessment Date + Domain</strong>.<br />
              Domain mapping: Prelims → Preliminary Online · DSA → DSA · Prelims+DSA → Placement Online · Offline → Offline Placement.
            </div>

            {trackerStatus === null && !trackerPreview && (
              <>
                <input ref={trackerFileInputRef} type="file" accept=".csv,.tsv,text/csv,text/plain" style={{ display: "none" }}
                  onChange={async e => {
                    const f = e.target.files[0]; e.target.value = "";
                    if (!f) return;
                    try { const rows = await parseTrackerFile(f); setTrackerPreview(rows.length ? rows : []); }
                    catch (err) { setTrackerPreview({ error: String(err) }); }
                  }} />
                <div
                  onClick={() => trackerFileInputRef.current?.click()}
                  style={{ border: `2px dashed #fde68a`, borderRadius: 10, padding: "32px 20px", textAlign: "center", cursor: "pointer", color: C.muted, fontSize: 13 }}
                  onDragOver={e => e.preventDefault()}
                  onDrop={async e => {
                    e.preventDefault(); const f = e.dataTransfer.files[0]; if (!f) return;
                    try { const rows = await parseTrackerFile(f); setTrackerPreview(rows.length ? rows : []); }
                    catch (err) { setTrackerPreview({ error: String(err) }); }
                  }}
                >
                  <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke={C.muted} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ marginBottom: 8 }}><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
                  <div style={{ fontWeight: 600, color: C.text, marginBottom: 4 }}>Drop tracker CSV here or click to browse</div>
                  <div style={{ fontSize: 11 }}>Only .csv files · Assessment Date column required for matching</div>
                </div>
              </>
            )}

            {trackerStatus === null && trackerPreview && !Array.isArray(trackerPreview) && (
              <div style={{ background: "#fee2e2", border: "1px solid #fca5a5", borderRadius: 8, padding: "12px 14px", fontSize: 12, color: C.red }}>
                <strong>Parse error:</strong> {trackerPreview.error}<br />
                <span style={{ color: C.muted }}>Make sure the file is a CSV or TSV exported from your tracker.</span>
              </div>
            )}

            {trackerStatus === null && Array.isArray(trackerPreview) && (() => {
              const withLinks = trackerPreview.filter(r => r.hasLinks);
              const matched   = withLinks.filter(r => r.matchedExam);
              const unmatched = withLinks.filter(r => !r.matchedExam);
              return (
                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  <div style={{ fontSize: 12, color: C.muted }}>
                    Found <strong style={{ color: C.text }}>{withLinks.length}</strong> rows with links —&nbsp;
                    <strong style={{ color: C.green }}>{matched.length}</strong> matched,&nbsp;
                    <strong style={{ color: unmatched.length ? C.red : C.muted }}>{unmatched.length}</strong> unmatched.
                  </div>
                  <div style={{ maxHeight: 260, overflowY: "auto", border: `1px solid ${C.border}`, borderRadius: 8 }}>
                    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11, tableLayout: "fixed" }}>
                      <colgroup>
                        <col style={{ width: 70 }} />
                        <col style={{ width: 90 }} />
                        <col style={{ width: 80 }} />
                        <col />
                        <col />
                      </colgroup>
                      <thead>
                        <tr style={{ background: C.surfaceAlt }}>
                          {["Raw Date", "Parsed Date", "Domain", "Mapped Type", "Matched Exam"].map(h => (
                            <th key={h} style={{ padding: "5px 8px", textAlign: "left", fontWeight: 700, color: C.muted, borderBottom: `1px solid ${C.border}` }}>{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {withLinks.map((r, i) => (
                          <tr key={i} style={{ background: r.matchedExam ? (i%2===0?"#fff":C.surfaceAlt) : "#fef2f2" }}>
                            <td style={{ padding: "4px 8px", borderBottom: `1px solid ${C.border}` }}>{r.rawDate}</td>
                            <td style={{ padding: "4px 8px", borderBottom: `1px solid ${C.border}`, color: r.date !== r.rawDate ? C.blue : C.text }}>{r.date || "—"}</td>
                            <td style={{ padding: "4px 8px", borderBottom: `1px solid ${C.border}` }}>{r.domain}</td>
                            <td style={{ padding: "4px 8px", borderBottom: `1px solid ${C.border}`, color: r.mappedType === "—" ? C.red : C.text }}>{r.mappedType}</td>
                            <td style={{ padding: "4px 8px", borderBottom: `1px solid ${C.border}`, color: r.matchedExam ? C.green : C.red, fontWeight: 600 }}>
                              {r.matchedExam ? `${r.matchedExam.type} (${r.matchedExam.mainStartDate})` : "No match"}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
                    <Btn variant="secondary" onClick={() => setTrackerPreview(null)}>Back</Btn>
                    <Btn onClick={() => importTracker(trackerPreview)} disabled={!matched.length}>
                      Import {matched.length} matched row{matched.length !== 1 ? "s" : ""}
                    </Btn>
                  </div>
                </div>
              );
            })()}

            {trackerStatus === "importing" && (
              <div style={{ textAlign: "center", padding: "28px 0", color: C.muted, fontSize: 13 }}>
                <div style={{ marginBottom: 8, fontWeight: 600, color: C.text }}>Importing…</div>
                Reading tracker and writing entries, please wait.
              </div>
            )}

            {trackerStatus && trackerStatus !== "importing" && (
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                <div style={{ background: trackerStatus.errors > 0 ? "#fef3c7" : "#dcfce7", border: `1px solid ${trackerStatus.errors > 0 ? "#fde68a" : "#86efac"}`, borderRadius: 8, padding: "12px 16px", fontSize: 13 }}>
                  <div style={{ fontWeight: 700, color: C.text, marginBottom: 6 }}>Import complete</div>
                  <div style={{ color: C.muted, lineHeight: 1.8 }}>
                    <span style={{ color: C.green, fontWeight: 700 }}>{trackerStatus.added}</span> entries created &nbsp;·&nbsp;
                    <span style={{ color: C.blue, fontWeight: 700 }}>{trackerStatus.updated}</span> entries updated &nbsp;·&nbsp;
                    <span style={{ color: C.muted, fontWeight: 700 }}>{trackerStatus.skipped}</span> rows skipped (no links)
                    {trackerStatus.errors > 0 && <> &nbsp;·&nbsp; <span style={{ color: C.red, fontWeight: 700 }}>{trackerStatus.errors}</span> rows couldn't be matched to an exam</>}
                  </div>
                </div>
                <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
                  <Btn variant="secondary" onClick={() => setTrackerStatus(null)}>Import Another</Btn>
                  <Btn onClick={() => { setShowTrackerModal(false); setTrackerStatus(null); }}>Done</Btn>
                </div>
              </div>
            )}
          </div>
        </Modal>
      )}

      {/* Import CSV modal */}
      {showImportModal && (
        <Modal title="Import Config Links from CSV" onClose={() => { setShowImportModal(false); setImportStatus(null); }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <div style={{ background: C.surfaceAlt, border: `1px solid ${C.border}`, borderRadius: 8, padding: "12px 14px", fontSize: 12, color: C.muted, lineHeight: 1.7 }}>
              <div style={{ fontWeight: 700, color: C.text, marginBottom: 4 }}>How it works</div>
              1. Click <strong>Template</strong> to download a pre-filled CSV with all {programTab} exam rows.<br />
              2. Open in Excel or Google Sheets, fill in the link columns, save as CSV.<br />
              3. Upload the filled CSV here — existing entries will be updated, new ones created.
            </div>

            {importStatus === null && (
              <>
                <input ref={fileInputRef} type="file" accept=".csv,text/csv" style={{ display: "none" }}
                  onChange={e => { if (e.target.files[0]) importCSV(e.target.files[0]); e.target.value = ""; }} />
                <div
                  onClick={() => fileInputRef.current?.click()}
                  style={{ border: `2px dashed ${C.border}`, borderRadius: 10, padding: "32px 20px", textAlign: "center", cursor: "pointer", color: C.muted, fontSize: 13, transition: "border-color 0.15s" }}
                  onDragOver={e => e.preventDefault()}
                  onDrop={e => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) importCSV(f); }}
                >
                  <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke={C.muted} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ marginBottom: 8 }}><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
                  <div style={{ fontWeight: 600, color: C.text, marginBottom: 4 }}>Drop CSV here or click to browse</div>
                  <div style={{ fontSize: 11 }}>Only .csv files are accepted</div>
                </div>
              </>
            )}

            {importStatus === "importing" && (
              <div style={{ textAlign: "center", padding: "28px 0", color: C.muted, fontSize: 13 }}>
                <div style={{ marginBottom: 8, fontWeight: 600, color: C.text }}>Importing…</div>
                Writing entries to database, please wait.
              </div>
            )}

            {importStatus && importStatus !== "importing" && (
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                <div style={{ background: importStatus.errors > 0 ? "#fef3c7" : "#dcfce7", border: `1px solid ${importStatus.errors > 0 ? "#fde68a" : "#86efac"}`, borderRadius: 8, padding: "12px 16px", fontSize: 13 }}>
                  <div style={{ fontWeight: 700, color: C.text, marginBottom: 6 }}>Import complete</div>
                  <div style={{ color: C.muted, lineHeight: 1.8 }}>
                    <span style={{ color: C.green, fontWeight: 700 }}>{importStatus.added}</span> entries created &nbsp;·&nbsp;
                    <span style={{ color: C.blue, fontWeight: 700 }}>{importStatus.updated}</span> entries updated
                    {importStatus.errors > 0 && <> &nbsp;·&nbsp; <span style={{ color: C.red, fontWeight: 700 }}>{importStatus.errors}</span> rows skipped (unrecognised exam ID)</>}
                  </div>
                </div>
                <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
                  <Btn variant="secondary" onClick={() => setImportStatus(null)}>Import Another</Btn>
                  <Btn onClick={() => { setShowImportModal(false); setImportStatus(null); }}>Done</Btn>
                </div>
              </div>
            )}
          </div>
        </Modal>
      )}
    </div>
  );
}

// ─── Page: Results ─────────────────────────────────────────────────────────────

const RESULTS_CSV_HEADERS = ["Student ID", "Student Name", "Exam", "Program", "Score", "Status", "Eligible For Offline", "Bucket"];
const RESULTS_HEADER_MAP = {
  studentId: ["student id", "studentid", "id"],
  name:      ["student name", "name"],
  examName:  ["exam", "exam name"],
  program:   ["program"],
  score:     ["score"],
  status:    ["status"],
  eligible:  ["eligible for offline", "eligible for interview", "eligible"],
  bucket:    ["bucket"],
};
function getCol(row, field) {
  const names = RESULTS_HEADER_MAP[field];
  for (const h of Object.keys(row)) {
    if (names.includes(h.trim().toLowerCase())) return (row[h] || "").trim();
  }
  return "";
}
function normalizeBucket(raw) {
  const m = raw.trim().toUpperCase().match(/[ABC]$/);
  return m ? m[0] : "";
}

function ResultsPage({ results, onSaveResult, onUpdateResult, onDeleteResult, onSendToInterview, role }) {
  const [programTab, setProgramTab] = useState("online");
  const [resultsPage, setResultsPage] = useState(1);
  const RESULTS_PAGE_SIZE = 10;
  const [showImportModal, setShowImportModal] = useState(false);
  const [importStatus, setImportStatus] = useState(null); // null | "importing" | { added, updated, errors }
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(null);
  const fileInputRef = useRef(null);

  const PROGRAMS = [{ id: "online", label: "Online" }, { id: "offline", label: "Offline" }];
  useEffect(() => { setResultsPage(1); setSelectedIds(new Set()); }, [programTab]);

  const tabResults = (results || [])
    .filter(r => (r.program || "online") === programTab)
    .sort((a, b) => (b.importedAt || "").localeCompare(a.importedAt || ""));

  const downloadTemplate = () => {
    const csv = [RESULTS_CSV_HEADERS].map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    a.download = `results-template-${programTab}.csv`;
    a.click();
  };

  const importCSV = async (file) => {
    setImportStatus("importing");
    try {
      const text = await file.text();
      const { rows } = parseCSV(text);
      let added = 0, updated = 0, errors = 0;
      for (const row of rows) {
        const studentId = getCol(row, "studentId");
        const examName = getCol(row, "examName");
        if (!studentId || !examName) { errors++; continue; }
        const programRaw = getCol(row, "program").toLowerCase();
        const program = programRaw.startsWith("off") ? "offline" : "online";
        const eligibleRaw = getCol(row, "eligible").toLowerCase();
        const data = {
          studentId,
          name: getCol(row, "name"),
          examName,
          program,
          score: getCol(row, "score"),
          status: getCol(row, "status"),
          eligible: ["yes", "true", "1", "y"].includes(eligibleRaw),
          bucket: program === "offline" ? normalizeBucket(getCol(row, "bucket")) : "",
        };
        try {
          const existing = (results || []).find(r => r.studentId === studentId && r.examName === examName);
          if (existing) { await onUpdateResult(existing.id, data); updated++; }
          else { await onSaveResult(data); added++; }
        } catch { errors++; }
      }
      setImportStatus({ added, updated, errors });
    } catch {
      setImportStatus({ added: 0, updated: 0, errors: 1 });
    }
  };

  const toggleSelect = (id) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const sendSelected = async () => {
    setSending(true);
    setSendError(null);
    try {
      const students = tabResults
        .filter(r => selectedIds.has(r.id))
        .map(r => ({ resultId: r.id, studentId: r.studentId, name: r.name, examId: r.id, examName: r.examName, program: r.program, score: r.score, bucket: r.bucket || "" }));
      await onSendToInterview(students);
      setSelectedIds(new Set());
    } catch (err) {
      setSendError(err.message);
    } finally {
      setSending(false);
    }
  };

  const interviewStatusBadge = (status) => {
    if (status === "sent") return <Badge color="blue">Sent</Badge>;
    if (status === "completed") return <Badge color="green">Completed</Badge>;
    return <Badge color="gray">Not Sent</Badge>;
  };

  const thBase = { fontSize: 10, fontWeight: 700, letterSpacing: 0.8, textTransform: "uppercase", border: `1px solid ${C.border}`, whiteSpace: "nowrap", padding: "6px 12px", textAlign: "left", color: C.muted };

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 24 }}>
        <h1 style={{ fontSize: 24, fontWeight: 900, color: C.text, margin: 0 }}>Results</h1>
        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          {selectedIds.size > 0 && (
            <Btn variant="blue" onClick={sendSelected} disabled={sending}>
              {sending ? "Sending…" : `Send to Interview (${selectedIds.size})`}
            </Btn>
          )}
          {can(role, "results.write") && (
            <>
              <button onClick={downloadTemplate} title="Download CSV template" style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 9, padding: "8px 14px", fontSize: 12, fontWeight: 600, color: C.text, cursor: "pointer", fontFamily: "inherit", display: "inline-flex", alignItems: "center", gap: 6 }}>
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M8 2v8M5 7l3 3 3-3M3 12h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
                Template
              </button>
              <button onClick={() => { setImportStatus(null); setShowImportModal(true); }} title="Import CSV" style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 9, padding: "8px 14px", fontSize: 12, fontWeight: 600, color: C.text, cursor: "pointer", fontFamily: "inherit", display: "inline-flex", alignItems: "center", gap: 6 }}>
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M8 10V2M5 5l3-3 3 3M3 12h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
                Import CSV
              </button>
            </>
          )}
        </div>
      </div>

      {sendError && (
        <div style={{ marginBottom: 16, fontSize: 12, color: C.red, background: C.redLight, border: "1px solid #fca5a5", borderRadius: 7, padding: "10px 14px" }}>{sendError}</div>
      )}

      <div style={{ display: "flex", gap: 2, marginBottom: 24, borderBottom: `2px solid ${C.border}` }}>
        {PROGRAMS.map(p => (
          <button key={p.id} onClick={() => setProgramTab(p.id)} style={{ background: "none", border: "none", borderBottom: `2px solid ${programTab === p.id ? C.accent : "transparent"}`, marginBottom: -2, padding: "8px 20px", fontSize: 13, fontWeight: 700, cursor: "pointer", color: programTab === p.id ? C.accent : C.muted, fontFamily: "inherit", transition: "all 0.15s" }}>{p.label}</button>
        ))}
      </div>

      {tabResults.length === 0 ? (
        <EmptyState icon="🏆" title="No results yet" sub="Import results from the Looker Studio dashboard export to get started." />
      ) : (() => {
        const totalPages = Math.ceil(tabResults.length / RESULTS_PAGE_SIZE);
        const pageRows = tabResults.slice((resultsPage - 1) * RESULTS_PAGE_SIZE, resultsPage * RESULTS_PAGE_SIZE);
        return (<>
        <div style={{ border: `1px solid ${C.border}`, borderRadius: 10, overflow: "hidden" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
            <thead>
              <tr style={{ background: C.surfaceAlt }}>
                <th style={{ ...thBase, width: "1px" }} />
                <th style={thBase}>Student</th>
                <th style={thBase}>Exam</th>
                <th style={thBase}>Score</th>
                <th style={thBase}>Status</th>
                <th style={thBase}>{programTab === "offline" ? "Bucket" : "Eligible for Offline"}</th>
                <th style={thBase}>Interview</th>
                {can(role, "results.write") && <th style={{ ...thBase, width: "1px" }} />}
              </tr>
            </thead>
            <tbody>
              {pageRows.map((r, i) => {
                const bg = i % 2 === 0 ? "#fff" : C.surfaceAlt;
                const cell = { verticalAlign: "middle", background: bg, border: `1px solid ${C.border}`, padding: "8px 12px" };
                const canSelect = programTab === "offline" && !!r.bucket && r.interviewStatus !== "sent" && r.interviewStatus !== "completed";
                return (
                  <tr key={r.id}>
                    <td style={cell}>
                      {canSelect && can(role, "results.write") && (
                        <input type="checkbox" checked={selectedIds.has(r.id)} onChange={() => toggleSelect(r.id)} />
                      )}
                    </td>
                    <td style={cell}>
                      <div style={{ fontWeight: 700, color: C.text }}>{r.name || "—"}</div>
                      <div style={{ fontSize: 11, color: C.muted }}>{r.studentId}</div>
                    </td>
                    <td style={cell}>{r.examName}</td>
                    <td style={cell}>{r.score || "—"}</td>
                    <td style={cell}>{r.status || "—"}</td>
                    <td style={cell}>{programTab === "offline"
                      ? (r.bucket ? <Badge color="blue">Bucket {r.bucket}</Badge> : <Badge color="gray">—</Badge>)
                      : (r.eligible ? <Badge color="green">Yes</Badge> : <Badge color="gray">No</Badge>)}</td>
                    <td style={cell}>{interviewStatusBadge(r.interviewStatus)}</td>
                    {can(role, "results.write") && (
                      <td style={cell}>
                        <button onClick={() => setConfirmDelete(r)} title="Delete" style={{ background: "none", border: "none", cursor: "pointer", padding: 4, display: "flex", color: C.muted }}>
                          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>
                        </button>
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {totalPages > 1 && (
          <div style={{ display: "flex", justifyContent: "center", gap: 8, marginTop: 16 }}>
            <Btn variant="secondary" size="sm" onClick={() => setResultsPage(p => Math.max(1, p - 1))} disabled={resultsPage === 1}>Prev</Btn>
            <span style={{ fontSize: 12, color: C.muted, display: "flex", alignItems: "center", padding: "0 8px" }}>Page {resultsPage} of {totalPages}</span>
            <Btn variant="secondary" size="sm" onClick={() => setResultsPage(p => Math.min(totalPages, p + 1))} disabled={resultsPage === totalPages}>Next</Btn>
          </div>
        )}
        </>);
      })()}

      {showImportModal && (
        <Modal title="Import Results from CSV" onClose={() => { setShowImportModal(false); setImportStatus(null); }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <div style={{ background: C.surfaceAlt, border: `1px solid ${C.border}`, borderRadius: 8, padding: "12px 14px", fontSize: 12, color: C.muted, lineHeight: 1.7 }}>
              <div style={{ fontWeight: 700, color: C.text, marginBottom: 4 }}>How it works</div>
              1. Click <strong>Template</strong> to download the expected CSV column headers.<br />
              2. Export the consolidated results from the Academy Data Studio dashboard and match these columns. For Online rows, "Eligible For Offline" marks progression to the Offline assessment. For Offline rows, "Bucket" (A/B/C) is what gets shared with the Interview Coordinator App.<br />
              3. Upload the CSV here — existing rows (matched by Student ID + Exam) are updated, new ones are created.
            </div>

            {importStatus === null && (
              <>
                <input ref={fileInputRef} type="file" accept=".csv,text/csv" style={{ display: "none" }}
                  onChange={e => { if (e.target.files[0]) importCSV(e.target.files[0]); e.target.value = ""; }} />
                <div
                  onClick={() => fileInputRef.current?.click()}
                  style={{ border: `2px dashed ${C.border}`, borderRadius: 10, padding: "32px 20px", textAlign: "center", cursor: "pointer", color: C.muted, fontSize: 13, transition: "border-color 0.15s" }}
                  onDragOver={e => e.preventDefault()}
                  onDrop={e => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) importCSV(f); }}
                >
                  <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke={C.muted} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ marginBottom: 8 }}><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
                  <div style={{ fontWeight: 600, color: C.text, marginBottom: 4 }}>Drop CSV here or click to browse</div>
                  <div style={{ fontSize: 11 }}>Only .csv files are accepted</div>
                </div>
              </>
            )}

            {importStatus === "importing" && (
              <div style={{ textAlign: "center", padding: "28px 0", color: C.muted, fontSize: 13 }}>
                <div style={{ marginBottom: 8, fontWeight: 600, color: C.text }}>Importing…</div>
                Writing results to database, please wait.
              </div>
            )}

            {importStatus && importStatus !== "importing" && (
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                <div style={{ background: importStatus.errors > 0 ? "#fef3c7" : "#dcfce7", border: `1px solid ${importStatus.errors > 0 ? "#fde68a" : "#86efac"}`, borderRadius: 8, padding: "12px 16px", fontSize: 13 }}>
                  <div style={{ fontWeight: 700, color: C.text, marginBottom: 6 }}>Import complete</div>
                  <div style={{ color: C.muted, lineHeight: 1.8 }}>
                    <span style={{ color: C.green, fontWeight: 700 }}>{importStatus.added}</span> results created &nbsp;·&nbsp;
                    <span style={{ color: C.blue, fontWeight: 700 }}>{importStatus.updated}</span> results updated
                    {importStatus.errors > 0 && <> &nbsp;·&nbsp; <span style={{ color: C.red, fontWeight: 700 }}>{importStatus.errors}</span> rows skipped (missing Student ID or Exam)</>}
                  </div>
                </div>
                <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
                  <Btn variant="secondary" onClick={() => setImportStatus(null)}>Import Another</Btn>
                  <Btn onClick={() => { setShowImportModal(false); setImportStatus(null); }}>Done</Btn>
                </div>
              </div>
            )}
          </div>
        </Modal>
      )}

      {confirmDelete && (
        <Modal title="Delete Result" onClose={() => setConfirmDelete(null)} width={420}>
          <div style={{ fontSize: 13, color: C.text, marginBottom: 20, lineHeight: 1.6 }}>
            Delete the result for <strong>{confirmDelete.name || confirmDelete.studentId}</strong> — {confirmDelete.examName}? This cannot be undone.
          </div>
          <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
            <Btn variant="secondary" onClick={() => setConfirmDelete(null)}>Cancel</Btn>
            <Btn variant="danger" onClick={async () => { await onDeleteResult(confirmDelete.id); setConfirmDelete(null); }}>Delete</Btn>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ─── Page: Interviews ──────────────────────────────────────────────────────────
// Header/tab structure only — no table or data wiring yet, pending decisions
// on what interview data gets shown and where it's sourced from.

const INTERVIEW_BUCKETS = [
  { id: "A", label: "Bucket A", subheaders: ["NxtMock", "TR1", "TR2"] },
  { id: "B", label: "Bucket B", subheaders: ["TR1", "TR2"] },
  { id: "C", label: "Bucket C", subheaders: [] },
];

function InterviewsPage() {
  const [bucketTab, setBucketTab] = useState("A");
  const [subTab, setSubTab] = useState("NxtMock");
  const activeBucket = INTERVIEW_BUCKETS.find(b => b.id === bucketTab);

  const selectBucket = (id) => {
    setBucketTab(id);
    setSubTab(INTERVIEW_BUCKETS.find(b => b.id === id).subheaders[0] || "");
  };

  return (
    <div>
      <div style={{ marginBottom: 24 }}>
        <h1 style={{ fontSize: 24, fontWeight: 900, color: C.text, margin: 0 }}>Interviews</h1>
      </div>

      <div style={{ display: "flex", gap: 2, marginBottom: activeBucket.subheaders.length ? 12 : 24, borderBottom: `2px solid ${C.border}` }}>
        {INTERVIEW_BUCKETS.map(b => (
          <button key={b.id} onClick={() => selectBucket(b.id)} style={{ background: "none", border: "none", borderBottom: `2px solid ${bucketTab === b.id ? C.accent : "transparent"}`, marginBottom: -2, padding: "8px 20px", fontSize: 13, fontWeight: 700, cursor: "pointer", color: bucketTab === b.id ? C.accent : C.muted, fontFamily: "inherit", transition: "all 0.15s" }}>{b.label}</button>
        ))}
      </div>

      {activeBucket.subheaders.length > 0 && (
        <div style={{ display: "flex", gap: 8, marginBottom: 24 }}>
          {activeBucket.subheaders.map(s => (
            <button key={s} onClick={() => setSubTab(s)} style={{ background: subTab === s ? C.accentLight : C.surface, border: `1px solid ${subTab === s ? C.accent : C.border}`, borderRadius: 7, padding: "5px 14px", fontSize: 12, fontWeight: 700, cursor: "pointer", color: subTab === s ? C.accent : C.muted, fontFamily: "inherit" }}>{s}</button>
          ))}
        </div>
      )}

      <EmptyState icon="🎤" title={`${activeBucket.label}${subTab ? ` – ${subTab}` : ""}`} sub="No data yet." />
    </div>
  );
}

// ─── Page: Assessment Generation ──────────────────────────────────────────────

function StepBadge({ n }) {
  return <div style={{ width: 24, height: 24, background: C.accent, borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", color: "#fff", fontSize: 12, fontWeight: 800, flexShrink: 0 }}>{n}</div>;
}

function LinkRow({ label, url, isLast, copiedUrl, onCopy }) {
  const copied = copiedUrl === url;
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, padding: "6px 0", borderBottom: isLast ? "none" : `1px solid ${C.border}` }}>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 10, color: C.muted, fontWeight: 700, letterSpacing: 0.6, textTransform: "uppercase" }}>{label}</div>
        <div style={{ fontSize: 12, color: C.text, fontWeight: 600, wordBreak: "break-all", marginTop: 2 }}>{url}</div>
      </div>
      <div style={{ display: "flex", gap: 6, alignItems: "center", flexShrink: 0 }}>
        <button onClick={() => onCopy(url)} title="Copy" style={{ background: "none", border: "none", cursor: "pointer", color: copied ? C.green : C.muted, padding: 4, display: "inline-flex" }}>
          {copied
            ? <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M3 8l3 3 7-7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
            : <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><rect x="5" y="5" width="8" height="8" rx="1.5" stroke="currentColor" strokeWidth="1.4"/><path d="M3 11V3h8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/></svg>}
        </button>
        <LinkChip url={url} label="Open" />
      </div>
    </div>
  );
}

function normConfigPairs(data) {
  if (Array.isArray(data)) return data.length ? data : [{ assessmentLink: "", configLink: "" }];
  if (data?.assessmentLink !== undefined) return [{ assessmentLink: data.assessmentLink || "", configLink: data.configLink || "" }];
  return [{ assessmentLink: "", configLink: "" }];
}

const genSlug = (s) => (s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");

function AssessmentGenPage({ exams, configEntries, uploads, assessments, onAddAssessment, onUpdateAssessment }) {
  const [selectedExamId, setSelectedExamId] = useState("");
  const [kind, setKind] = useState("Mock");
  const [cloneKey, setCloneKey] = useState("");
  const [cloneStatus, setCloneStatus] = useState("idle"); // idle | cloning | cloned
  const [clonedConfigLink, setClonedConfigLink] = useState("");
  const [publishStatus, setPublishStatus] = useState("idle"); // idle | publishing | published
  const [published, setPublished] = useState(null);
  const [inviteStatus, setInviteStatus] = useState("idle"); // idle | inviting | invited
  const [copiedUrl, setCopiedUrl] = useState(null);
  const [currentAssessmentId, setCurrentAssessmentId] = useState(null);

  const cloneTimer = useRef(null);
  const publishTimer = useRef(null);
  const inviteTimer = useRef(null);
  useEffect(() => () => { clearTimeout(cloneTimer.current); clearTimeout(publishTimer.current); clearTimeout(inviteTimer.current); }, []);

  const exam = exams.find(e => e.id === selectedExamId);
  const kindKey = kind === "Mock" ? "mock" : "main";

  const { mockTag, mainTag } = exam ? genTags(exam, exams) : { mockTag: "—", mainTag: "—" };
  const tag = exam ? (kind === "Mock" ? (exam.mockTagOverride || mockTag) : (exam.mainTagOverride || mainTag)) : "—";
  const slot = exam ? (kind === "Mock" ? exam.mockSlot : exam.mainSlot) : "—";
  const slotDisplay = exam
    ? fmtDateTimeRange(kind === "Mock" ? exam.mockStartDate : exam.mainStartDate, kind === "Mock" ? exam.mockEndDate : exam.mainEndDate, slot)
    : "—";

  const examStudents = (uploads || []).filter(u => u.examId === selectedExamId).flatMap(u => u.rows.filter(r => r._status !== "duplicate"));

  // Step 2: every exam of the same type with a config link on file for this Mock/Main kind — either
  // from a previous published assessment, or one the Content Team has already dropped in the Config Library.
  const cloneCandidates = exam ? exams
    .filter(e => e.type === exam.type)
    .flatMap(e => {
      const entry = (configEntries || []).find(ce => ce.examId === e.id);
      if (!entry) return [];
      return normConfigPairs(entry[kindKey])
        .map((p, idx) => ({ p, idx }))
        .filter(({ p }) => p.configLink)
        .map(({ p, idx }) => ({
          key: `${e.id}::${idx}`,
          examId: e.id,
          pairIndex: idx,
          title: kind === "Mock" ? (e.mockTitle || e.type) : (e.mainTitle || e.type),
          date: kind === "Mock" ? e.mockStartDate : e.mainStartDate,
          configLink: p.configLink,
          assessmentLink: p.assessmentLink,
        }));
    })
    .sort((a, b) => (b.date || "").localeCompare(a.date || "")) : [];

  const cloneSource = cloneCandidates.find(c => c.key === cloneKey) || null;

  // Read-only preview of what Publish would do to the Config Library, once the real save is wired up.
  const configEntry = (configEntries || []).find(ce => ce.examId === selectedExamId);
  const willReplace = !!(cloneSource && cloneSource.examId === selectedExamId && !cloneSource.assessmentLink && configEntry);

  // Label for "✓ Cloned from …" — from the live selection, or from the saved record when resuming a pending invite.
  const clonedFromLabel = cloneSource
    ? { title: cloneSource.title, date: cloneSource.date }
    : (published?.sourceTitle ? { title: published.sourceTitle, date: published.sourceDate } : null);

  // Published assessments that still need students invited — surfaced so a POC can come back and finish later.
  const pendingInvites = (assessments || []).filter(a => !a.invited && a.id !== currentAssessmentId);

  const resetDownstream = () => {
    clearTimeout(cloneTimer.current); clearTimeout(publishTimer.current); clearTimeout(inviteTimer.current);
    setCloneKey(""); setCloneStatus("idle"); setClonedConfigLink("");
    setPublishStatus("idle"); setPublished(null); setInviteStatus("idle"); setCurrentAssessmentId(null);
  };

  const onSelectExam = (v) => { setSelectedExamId(v); resetDownstream(); };
  const onSelectKind = (k) => { setKind(k); resetDownstream(); };
  const changeSource = () => { clearTimeout(cloneTimer.current); setCloneStatus("idle"); setClonedConfigLink(""); setPublishStatus("idle"); setPublished(null); setCurrentAssessmentId(null); setInviteStatus("idle"); };
  const copyUrl = (url) => { if (!url) return; navigator.clipboard?.writeText(url); setCopiedUrl(url); setTimeout(() => setCopiedUrl(null), 1500); };

  const doClone = () => {
    if (!cloneSource) return;
    setCloneStatus("cloning");
    cloneTimer.current = setTimeout(() => {
      setClonedConfigLink(`https://platform.example.com/config/${genSlug(tag)}-clone`);
      setCloneStatus("cloned");
    }, 900);
  };

  const doPublish = () => {
    if (cloneStatus !== "cloned") return;
    setPublishStatus("publishing");
    publishTimer.current = setTimeout(async () => {
      const record = {
        examId: selectedExamId,
        examType: exam.type,
        kind,
        tag,
        assessmentLink: `https://platform.example.com/asst/${genSlug(tag)}`,
        configLink: clonedConfigLink,
        sourceTitle: cloneSource?.title || "",
        sourceDate: cloneSource?.date || "",
        replaced: willReplace,
        invited: false,
        publishedAt: new Date().toISOString(),
      };
      const id = await onAddAssessment(record);
      setCurrentAssessmentId(id);
      setPublished({ assessmentLink: record.assessmentLink, configLink: record.configLink, label: tag, replaced: willReplace, sourceTitle: record.sourceTitle, sourceDate: record.sourceDate });
      setPublishStatus("published");
    }, 900);
  };

  const doInvite = () => {
    setInviteStatus("inviting");
    inviteTimer.current = setTimeout(async () => {
      if (currentAssessmentId) await onUpdateAssessment(currentAssessmentId, { invited: true, invitedAt: new Date().toISOString() });
      setInviteStatus("invited");
    }, 900);
  };

  const resumePending = (a) => {
    resetDownstream();
    setSelectedExamId(a.examId);
    setKind(a.kind);
    setCloneStatus("cloned");
    setClonedConfigLink(a.configLink);
    setPublishStatus("published");
    setPublished({ assessmentLink: a.assessmentLink, configLink: a.configLink, label: a.tag, replaced: a.replaced, sourceTitle: a.sourceTitle, sourceDate: a.sourceDate });
    setCurrentAssessmentId(a.id);
    setInviteStatus("idle");
  };

  return (
    <div>
      <div style={{ marginBottom: 6 }}>
        <h1 style={{ fontSize: 18, fontWeight: 900, color: C.text, margin: 0 }}>Assessment Generation</h1>
        <p style={{ color: C.muted, fontSize: 11, marginTop: 2 }}>Select exam → clone a config → auto-filled details → publish → invite students.</p>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>

          {/* Yet to Invite — published assessments still waiting on student invites */}
          {pendingInvites.length > 0 && (
            <Card style={{ padding: 10, background: C.yellowLight, border: "1px solid #e8d888" }}>
              <div style={{ fontWeight: 800, fontSize: 13, color: C.text, marginBottom: 6 }}>
                ⚠️ Yet to Invite ({pendingInvites.length})
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {pendingInvites.map(a => (
                  <div key={a.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, background: C.surface, borderRadius: 8, padding: "6px 10px" }}>
                    <span style={{ fontSize: 12, color: C.text, fontWeight: 600 }}>{a.examType} · {a.kind}</span>
                    <Btn variant="blue" size="sm" onClick={() => resumePending(a)}>Invite Students</Btn>
                  </div>
                ))}
              </div>
            </Card>
          )}

          {/* Step 1: Select Exam */}
          <Card style={{ padding: 10 }}>
            <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 6 }}>
              <StepBadge n={1} />
              <span style={{ fontWeight: 800, fontSize: 13 }}>Select Exam & Type</span>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 12, alignItems: "flex-end" }}>
              <Field value={selectedExamId} onChange={onSelectExam}
                options={exams.filter(e => getExamStatus(e) === "upcoming").map(e => {
                  const w = getWeek(e.mainStartDate, exams);
                  const b = getBatch(e, exams);
                  return { v: e.id, l: `${e.type}${w ? ` — W${w}` : ""}${b ? ` · B${b}` : ""}` };
                })} />
              <div style={{ display: "flex", gap: 4, background: C.surfaceAlt, borderRadius: 8, padding: 4, border: `1px solid ${C.border}` }}>
                {["Mock", "Main"].map(k => (
                  <button key={k} onClick={() => onSelectKind(k)} style={{
                    background: kind === k ? C.surface : "transparent", border: "none",
                    borderRadius: 6, padding: "7px 18px", fontWeight: kind === k ? 700 : 400, cursor: "pointer",
                    color: kind === k ? C.text : C.muted, fontFamily: "inherit", fontSize: 13,
                    boxShadow: kind === k ? "0 1px 3px rgba(0,0,0,0.08)" : "none"
                  }}>{k}</button>
                ))}
              </div>
            </div>
            {exam && (
              <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "4px 16px", marginTop: 6, paddingTop: 6, borderTop: `1px solid ${C.border}`, fontSize: 12 }}>
                <span style={{ color: C.muted }}>Slot: <strong style={{ color: C.text }}>{slotDisplay}</strong></span>
                <span style={{ color: C.muted }}>Students: <strong style={{ color: C.blue }}>{examStudents.length}</strong></span>
                <span style={{ color: C.muted, fontFamily: "monospace", fontSize: 10 }} title={tag}>{tag}</span>
              </div>
            )}
          </Card>

          {/* Step 2: Clone a Config Link (clone + auto-fill combined) */}
          {exam && (
            <Card style={{ padding: 10 }}>
              <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 6 }}>
                <StepBadge n={2} />
                <span style={{ fontWeight: 800, fontSize: 13 }}>Clone a Config Link</span>
              </div>

              {cloneStatus === "cloned" ? (
                <>
                  <div style={{ display: "flex", gap: 10, alignItems: "center", justifyContent: "space-between", background: C.greenLight, border: "1px solid #b8e0cc", borderRadius: 8, padding: "6px 12px", marginBottom: 6 }}>
                    <div style={{ fontSize: 13 }}>
                      <span style={{ color: C.green, fontWeight: 700 }}>✓ Cloned from </span>
                      <span style={{ fontWeight: 700, color: C.text }}>{clonedFromLabel?.title} — {fmtDate(clonedFromLabel?.date)}</span>
                    </div>
                    <Btn variant="ghost" size="sm" onClick={changeSource}>Change</Btn>
                  </div>
                  {publishStatus !== "published" && (
                    <div style={{ display: "flex", gap: 10, alignItems: "center", background: C.surfaceAlt, borderRadius: 8, padding: "6px 12px", marginBottom: 6 }}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 10, color: C.muted, fontWeight: 700, letterSpacing: 0.8 }}>CLONED CONFIG LINK</div>
                        <div style={{ fontWeight: 700, color: C.text, marginTop: 2, fontSize: 12, wordBreak: "break-all" }}>{clonedConfigLink}</div>
                      </div>
                      <LinkChip url={clonedConfigLink} label="Open" />
                    </div>
                  )}
                  <Badge color="green">✓ Title, Tag & Time Slot Auto-filled</Badge>
                </>
              ) : (
                <>
                  {cloneCandidates.length === 0 ? (
                    <div style={{ color: C.muted, fontSize: 12, padding: "4px 0" }}>No {kind} config links found for this exam type in the Config Library yet.</div>
                  ) : (
                    <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                      <div style={{ flex: 1 }}>
                        <Field value={cloneKey} onChange={setCloneKey}
                          options={cloneCandidates.map(c => ({
                            v: c.key,
                            l: `${c.title} — ${fmtDate(c.date)}${c.examId === selectedExamId ? " · this exam" : ""} · ${c.assessmentLink ? "Published" : "Awaiting publish"}`
                          }))} />
                      </div>
                      {cloneSource && (
                        <a href={cloneSource.configLink} target="_blank" rel="noreferrer" title="View config link"
                          style={{ display: "inline-flex", alignItems: "center", color: C.blue, flexShrink: 0 }}>
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/><path d="M15 3h6v6M10 14L21 3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
                        </a>
                      )}
                    </div>
                  )}
                  <div style={{ marginTop: 6 }}>
                    <Btn variant="primary" onClick={doClone} disabled={!cloneSource || cloneStatus === "cloning"}>
                      {cloneStatus === "cloning" ? "⏳ Cloning…" : "🧬 Clone Assessment"}
                    </Btn>
                  </div>
                </>
              )}
            </Card>
          )}

          {/* Publish — a quick action, not a numbered step */}
          {exam && cloneStatus === "cloned" && (
            publishStatus !== "published" ? (
              <div style={{ display: "flex", justifyContent: "center" }}>
                <Btn variant="green" onClick={doPublish} disabled={publishStatus === "publishing"}>
                  {publishStatus === "publishing" ? "⏳ Publishing…" : "🚀 Publish Assessment"}
                </Btn>
              </div>
            ) : (
              <div style={{ background: C.greenLight, border: "1px solid #b8e0cc", borderRadius: 10, padding: 10 }}>
                <div style={{ marginBottom: 6 }}>
                  <div style={{ fontWeight: 900, fontSize: 13, color: C.green }}>✅ Published!</div>
                  <div style={{ color: C.text, fontWeight: 700, fontSize: 12 }}>{exam?.type} · {kind}</div>
                </div>
                <div style={{ background: C.surface, borderRadius: 8, padding: "0 12px" }}>
                  <LinkRow label="Assessment Link" url={published.assessmentLink} copiedUrl={copiedUrl} onCopy={copyUrl} />
                  <LinkRow label="Config Link" url={published.configLink} isLast copiedUrl={copiedUrl} onCopy={copyUrl} />
                </div>
              </div>
            )
          )}

          {/* Step 3: Invite Students */}
          {publishStatus === "published" && (
            <Card style={{ padding: 10 }}>
              <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 6 }}>
                <StepBadge n={3} />
                <span style={{ fontWeight: 800, fontSize: 13, color: C.text }}>Invite Students</span>
              </div>
              {inviteStatus !== "invited" ? (
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, flexWrap: "wrap" }}>
                  <div style={{ fontSize: 12, color: C.muted }}>
                    {examStudents.length > 0 ? `${examStudents.length} student${examStudents.length === 1 ? "" : "s"} matched for this exam.` : "No student data uploaded for this exam yet."}
                  </div>
                  <Btn variant="blue" onClick={doInvite} disabled={inviteStatus === "inviting" || examStudents.length === 0}>
                    {inviteStatus === "inviting" ? "⏳ Inviting…" : "📨 Invite Students"}
                  </Btn>
                </div>
              ) : (
                <div style={{ fontWeight: 800, color: C.green, fontSize: 13 }}>✅ Invited — {examStudents.length} students</div>
              )}
            </Card>
          )}
      </div>
    </div>
  );
}

// ─── Page: Team & Roles ───────────────────────────────────────────────────────

const ROLE_OPTIONS = [
  { value: "super_admin", label: "Super Admin",  desc: "Full access to everything" },
  { value: "admin",       label: "Admin",         desc: "Manage exams, view student data, configs, generate" },
  { value: "poc",         label: "POC",           desc: "Raise exam requests, upload student data, view configs" },
  { value: "content",     label: "Content Team",  desc: "View exams, manage configs, generate assessments" },
];

const PERMISSION_ROWS = [
  { group: "Exams",      action: "exam.read",    label: "View exams" },
  { group: "Exams",      action: "exam.write",   label: "Add / edit / delete exams" },
  { group: "Exams",      action: "exam.notify",  label: "Send exam notifications" },
  { group: "Students",   action: "student.read",  label: "View student data" },
  { group: "Students",   action: "student.write", label: "Upload student data" },
  { group: "Students",   action: "student.count", label: "View student count" },
  { group: "Configs",    action: "configs.read",           label: "View configs" },
  { group: "Configs",    action: "configs.write",          label: "Add / edit configs" },
  { group: "Configs",    action: "configs.assessmentLink", label: "Edit assessment links in Config Library" },
  { group: "Generation", action: "generate",      label: "Generate assessments" },
  { group: "Results",    action: "results.write", label: "Import results / send to interview" },
  { group: "Admin",      action: "team",          label: "Manage team & roles", superAdminOnly: true },
];

function TeamRolesPage({ rolesList, onSetRole, onRemoveRole, currentUserEmail, livePerms, onUpdatePerm, isSuperAdmin, accessRequests = [], onApproveRequest, onRejectRequest }) {
  const [email, setEmail] = useState("");
  const [selectedRole, setSelectedRole] = useState("poc");
  const [confirmRemove, setConfirmRemove] = useState(null);
  const [editingEmail, setEditingEmail] = useState(null);
  const [editingRole, setEditingRole] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [approvingEmail, setApprovingEmail] = useState(null);
  const [approveRole, setApproveRole] = useState("poc");

  const handleAdd = async () => {
    const trimmed = email.trim().toLowerCase();
    if (!trimmed) { setError("Enter an email address."); return; }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) { setError("Enter a valid email address."); return; }
    if (rolesList.find(r => r.email === trimmed)) { setError("This email already has a role assigned."); return; }
    setSaving(true);
    await onSetRole(trimmed, selectedRole);
    setEmail(""); setSaving(false); setError("");
  };

  const handleUpdateRole = async (em, role) => {
    await onSetRole(em, role);
    setEditingEmail(null);
  };

  const roleInfo = (r) => ROLE_OPTIONS.find(o => o.value === r);

  const roleColors = {
    super_admin: { bg: "#fdf2ff", border: "#d8b4fe", text: "#7e22ce" },
    admin:       { bg: "#eff6ff", border: "#93c5fd", text: "#1d4ed8" },
    poc:         { bg: "#f0fdf4", border: "#86efac", text: "#166534" },
    content:     { bg: "#fff7ed", border: "#fdba74", text: "#c2410c" },
  };

  return (
    <div>
      <div style={{ marginBottom: 28 }}>
        <h1 style={{ fontSize: 24, fontWeight: 900, color: C.text, margin: 0 }}>Team & Roles</h1>
        <p style={{ color: C.muted, fontSize: 13, marginTop: 4 }}>Manage who has access to Academy Nexus and what they can do.</p>
      </div>

      {/* Pending access requests */}
      {isSuperAdmin && accessRequests.filter(r => r.status === "pending").length > 0 && (
        <div style={{ border: `1px solid #fde68a`, borderRadius: 12, overflow: "hidden", marginBottom: 28 }}>
          <div style={{ padding: "12px 16px", background: C.yellowLight, borderBottom: `1px solid #fde68a`, display: "flex", alignItems: "center", gap: 8 }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M12 9v4M12 17h.01M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" stroke={C.yellow} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
            <span style={{ fontSize: 12, fontWeight: 700, color: C.yellow, letterSpacing: 0.3 }}>Pending Access Requests</span>
            <span style={{ fontSize: 11, background: C.yellow, color: "#fff", borderRadius: 10, padding: "1px 8px", marginLeft: 2, fontWeight: 700 }}>{accessRequests.filter(r => r.status === "pending").length}</span>
          </div>
          {accessRequests.filter(r => r.status === "pending").map((req, i, arr) => (
            <div key={req.email} style={{ padding: "14px 16px", borderBottom: i < arr.length - 1 ? `1px solid ${C.border}` : "none", display: "flex", alignItems: "center", gap: 12, background: "#fff" }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 700, fontSize: 13, color: C.text }}>{req.name}</div>
                <div style={{ fontSize: 12, color: C.muted, marginTop: 1 }}>{req.email}</div>
                <div style={{ fontSize: 11, color: C.muted, marginTop: 2 }}>
                  Requested as: <strong>{ROLE_OPTIONS.find(o => o.value === req.team)?.label || req.team}</strong> · {timeAgo(req.requestedAt)}
                </div>
              </div>
              {approvingEmail === req.email ? (
                <div style={{ display: "flex", gap: 8, alignItems: "center", flexShrink: 0 }}>
                  <select value={approveRole} onChange={e => setApproveRole(e.target.value)} style={{ border: `1.5px solid ${C.border}`, borderRadius: 7, padding: "6px 10px", fontSize: 12, fontFamily: "inherit", color: C.text, background: C.surface, outline: "none" }}>
                    {ROLE_OPTIONS.filter(o => o.value !== "super_admin").map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                  <Btn size="sm" variant="green" onClick={async () => { await onApproveRequest(req.email, approveRole); setApprovingEmail(null); }}>Confirm</Btn>
                  <Btn size="sm" variant="secondary" onClick={() => setApprovingEmail(null)}>Cancel</Btn>
                </div>
              ) : (
                <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
                  <Btn size="sm" variant="green" onClick={() => { setApprovingEmail(req.email); setApproveRole(req.team || "poc"); }}>Approve</Btn>
                  <button onClick={() => onRejectRequest(req.email)} style={{ background: "#fee2e2", border: "1px solid #fca5a5", borderRadius: 6, padding: "4px 10px", fontSize: 11, fontWeight: 700, color: "#dc2626", cursor: "pointer", fontFamily: "inherit" }}>Reject</button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Permissions matrix */}
      <div style={{ border: `1px solid ${C.border}`, borderRadius: 10, overflow: "hidden", marginBottom: 28 }}>
        {isSuperAdmin && (
          <div style={{ padding: "8px 16px", background: C.accentLight, borderBottom: `1px solid ${C.border}`, fontSize: 11, color: C.accent, fontWeight: 600, display: "flex", alignItems: "center", gap: 6 }}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" stroke={C.accent} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" stroke={C.accent} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
            Click any cell to grant or revoke a permission for that role
          </div>
        )}
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
          <thead>
            <tr style={{ background: C.surfaceAlt }}>
              <th style={{ padding: "10px 16px", textAlign: "left", fontSize: 11, fontWeight: 700, color: C.muted, letterSpacing: 0.8, textTransform: "uppercase", borderBottom: `1px solid ${C.border}`, width: "42%" }}>Permission</th>
              {ROLE_OPTIONS.map(o => {
                const c = roleColors[o.value] || {};
                return (
                  <th key={o.value} style={{ padding: "10px 14px", textAlign: "center", borderBottom: `1px solid ${C.border}` }}>
                    <span style={{ fontSize: 11, fontWeight: 800, color: c.text, background: c.bg, border: `1px solid ${c.border}`, borderRadius: 5, padding: "3px 8px", display: "inline-block" }}>{o.label}</span>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {PERMISSION_ROWS.map((row, i) => {
              const isFirstInGroup = i === 0 || PERMISSION_ROWS[i - 1].group !== row.group;
              const isLast = i === PERMISSION_ROWS.length - 1;
              const showTopBorder = isFirstInGroup && i !== 0;
              return (
                <tr key={row.action} style={{ background: "#fff" }}>
                  <td style={{ padding: "9px 16px", borderBottom: isLast ? "none" : `1px solid ${C.border}`, borderTop: showTopBorder ? `1px solid ${C.border}` : "none" }}>
                    {isFirstInGroup && (
                      <div style={{ fontSize: 10, fontWeight: 700, color: C.muted, letterSpacing: 0.6, textTransform: "uppercase", marginBottom: 2 }}>{row.group}</div>
                    )}
                    <div style={{ fontSize: 12, color: C.text, fontWeight: 500 }}>{row.label}</div>
                  </td>
                  {ROLE_OPTIONS.map(o => {
                    const rolePerms = livePerms[o.value] || [];
                    const allowed = row.superAdminOnly
                      ? o.value === "super_admin"
                      : rolePerms.includes("*") || rolePerms.includes(row.action);
                    const isEditable = isSuperAdmin && !row.superAdminOnly && o.value !== "super_admin";
                    const checkIcon = <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="8" fill="#dcfce7"/><path d="M4.5 8.5l2.5 2.5 4.5-5" stroke="#16a34a" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/></svg>;
                    const crossIcon = <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="8" fill="#f1f5f9"/><path d="M5.5 5.5l5 5M10.5 5.5l-5 5" stroke="#94a3b8" strokeWidth="1.8" strokeLinecap="round"/></svg>;
                    return (
                      <td key={o.value} style={{ padding: "9px 14px", textAlign: "center", borderBottom: isLast ? "none" : `1px solid ${C.border}`, borderTop: showTopBorder ? `1px solid ${C.border}` : "none" }}>
                        {isEditable ? (
                          <button
                            onClick={() => onUpdatePerm(o.value, row.action, !allowed)}
                            title={allowed ? "Click to revoke" : "Click to grant"}
                            style={{ background: "none", border: "none", cursor: "pointer", padding: 3, borderRadius: 6, display: "inline-flex", alignItems: "center", justifyContent: "center" }}
                          >
                            {allowed ? checkIcon : crossIcon}
                          </button>
                        ) : (
                          allowed ? checkIcon : crossIcon
                        )}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Add member */}
      <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12, padding: "18px 20px", marginBottom: 24 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 12 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: C.muted, letterSpacing: 0.8, textTransform: "uppercase" }}>Add Team Member</div>
          <div style={{ fontSize: 11, color: C.muted }}>User must sign in with Google — no password required.</div>
        </div>
        <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
          <div style={{ flex: 1 }}>
            <input
              value={email} onChange={e => { setEmail(e.target.value); setError(""); }}
              onKeyDown={e => e.key === "Enter" && handleAdd()}
              placeholder="name@nxtwave.tech"
              style={{ width: "100%", border: `1.5px solid ${error ? C.red : C.border}`, borderRadius: 8, padding: "9px 12px", fontSize: 13, fontFamily: "inherit", outline: "none", boxSizing: "border-box", color: C.text, background: C.surface }}
            />
            {error && <div style={{ fontSize: 11, color: C.red, marginTop: 4 }}>{error}</div>}
          </div>
          <select value={selectedRole} onChange={e => setSelectedRole(e.target.value)} style={{ border: `1.5px solid ${C.border}`, borderRadius: 8, padding: "9px 12px", fontSize: 13, fontFamily: "inherit", color: C.text, background: C.surface, outline: "none", cursor: "pointer", minWidth: 150 }}>
            {ROLE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
          <Btn onClick={handleAdd} disabled={saving}>{saving ? "Saving…" : "Add"}</Btn>
        </div>
      </div>

      {/* Members table */}
      {rolesList.length === 0 ? (
        <EmptyState icon="👥" title="No team members yet" sub="Add an email above to grant access." />
      ) : (
        <div style={{ border: `1px solid ${C.border}`, borderRadius: 10, overflow: "hidden" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ background: C.surfaceAlt }}>
                {["Member", "Role", ""].map((h, i) => (
                  <th key={i} style={{ padding: "10px 16px", textAlign: "left", fontSize: 11, fontWeight: 700, color: C.muted, letterSpacing: 0.8, textTransform: "uppercase", borderBottom: `1px solid ${C.border}` }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rolesList.map((r, i) => {
                const c = roleColors[r.role] || {};
                const info = roleInfo(r.role);
                const isLast = i === rolesList.length - 1;
                const bdr = isLast ? "none" : `1px solid ${C.border}`;
                const isSelf = r.email === currentUserEmail;
                return (
                  <tr key={r.email} style={{ background: "#fff" }}>
                    <td style={{ padding: "12px 16px", borderBottom: bdr }}>
                      <div style={{ fontWeight: 600, color: C.text }}>{r.email}</div>
                      {isSelf && <div style={{ fontSize: 10, color: C.muted, marginTop: 2 }}>You</div>}
                    </td>
                    <td style={{ padding: "12px 16px", borderBottom: bdr }}>
                      {editingEmail === r.email ? (
                        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                          <select value={editingRole} onChange={e => setEditingRole(e.target.value)} style={{ border: `1.5px solid ${C.border}`, borderRadius: 7, padding: "6px 10px", fontSize: 12, fontFamily: "inherit", color: C.text, background: C.surface, outline: "none" }}>
                            {ROLE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                          </select>
                          <Btn size="sm" onClick={() => handleUpdateRole(r.email, editingRole)}>Save</Btn>
                          <Btn size="sm" variant="secondary" onClick={() => setEditingEmail(null)}>Cancel</Btn>
                        </div>
                      ) : (
                        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                          <span style={{ fontSize: 11, fontWeight: 700, color: c.text, background: c.bg, border: `1px solid ${c.border}`, borderRadius: 5, padding: "3px 8px" }}>{info?.label || r.role}</span>
                          {!isSelf && <button onClick={() => { setEditingEmail(r.email); setEditingRole(r.role); }} style={{ background: "none", border: "none", color: C.muted, fontSize: 11, cursor: "pointer", fontFamily: "inherit", padding: 0, fontWeight: 600 }}>Change</button>}
                        </div>
                      )}
                    </td>
                    <td style={{ padding: "12px 16px", borderBottom: bdr, textAlign: "right" }}>
                      {!isSelf && (
                        <button onClick={() => setConfirmRemove(r)} style={{ background: "#fee2e2", border: "1px solid #fca5a5", borderRadius: 6, padding: "4px 10px", fontSize: 11, fontWeight: 700, color: "#dc2626", cursor: "pointer", fontFamily: "inherit" }}>Remove</button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {confirmRemove && (
        <Modal title="Remove Access" onClose={() => setConfirmRemove(null)} width={400}>
          <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
            <div>
              <div style={{ fontWeight: 700, fontSize: 14, color: C.text, marginBottom: 4 }}>{confirmRemove.email}</div>
              <div style={{ fontSize: 13, color: C.muted }}>This will remove their access to Academy Nexus immediately. They will see the "Access not assigned" screen on next login.</div>
            </div>
            <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
              <Btn variant="secondary" onClick={() => setConfirmRemove(null)}>Cancel</Btn>
              <Btn variant="danger" onClick={async () => { await onRemoveRole(confirmRemove.email); setConfirmRemove(null); }}>Remove Access</Btn>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ─── Login Page ───────────────────────────────────────────────────────────────
function LoginPage({ onSignIn, onRegister, onGoogleSignIn }) {
  const [tab, setTab] = useState("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [regEmail, setRegEmail] = useState("");
  const [team, setTeam] = useState("poc");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [submitted, setSubmitted] = useState(false);

  const handleSignIn = async (e) => {
    e.preventDefault();
    setError(""); setLoading(true);
    try { await onSignIn(email.trim(), password); }
    catch (err) { setError(friendlyAuthError(err.code)); setLoading(false); }
  };

  const handleRegister = async (e) => {
    e.preventDefault();
    setError(""); setLoading(true);
    try {
      await onRegister(name.trim(), regEmail.trim().toLowerCase(), team);
      setSubmitted(true);
    } catch (err) {
      setError(friendlyAuthError(err.code));
    } finally {
      setLoading(false);
    }
  };

  const inputStyle = { width: "100%", border: `1.5px solid ${C.border}`, borderRadius: 8, padding: "10px 12px", fontSize: 13, fontFamily: "inherit", outline: "none", color: C.text, background: C.surface, boxSizing: "border-box" };
  const labelStyle = { fontSize: 11, fontWeight: 700, color: C.muted, letterSpacing: 0.8, textTransform: "uppercase", display: "block", marginBottom: 5 };

  return (
    <div style={{ minHeight: "100vh", background: C.bg, fontFamily: "'Sora', 'Segoe UI', sans-serif", display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
      <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 16, padding: "40px 36px", width: "100%", maxWidth: 420, boxShadow: "0 4px 24px rgba(0,0,0,0.07)" }}>
        <div style={{ textAlign: "center", marginBottom: 28 }}>
          <div style={{ width: 48, height: 48, background: C.accent, borderRadius: 12, display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 14px", fontWeight: 900, fontSize: 18, color: "#fff", letterSpacing: -0.5 }}>AN</div>
          <div style={{ fontWeight: 900, fontSize: 20, color: C.text, marginBottom: 4 }}>Academy Nexus</div>
          <div style={{ fontSize: 12, color: C.muted, fontWeight: 600, letterSpacing: 0.5, textTransform: "uppercase" }}>Assessment Administration</div>
        </div>

        <div style={{ display: "flex", background: C.surfaceAlt, borderRadius: 10, padding: 4, marginBottom: 24 }}>
          {[["signin", "Sign In"], ["register", "Register"]].map(([id, label]) => (
            <button key={id} onClick={() => { setTab(id); setError(""); setSubmitted(false); }} style={{
              flex: 1, padding: "8px 0", borderRadius: 7, border: "none", fontFamily: "inherit",
              fontWeight: 700, fontSize: 13, cursor: "pointer",
              background: tab === id ? C.surface : "transparent",
              color: tab === id ? C.text : C.muted,
              boxShadow: tab === id ? "0 1px 4px rgba(0,0,0,0.08)" : "none",
              transition: "all 0.15s",
            }}>{label}</button>
          ))}
        </div>

        {tab === "signin" && (
          <form onSubmit={handleSignIn} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <div><label style={labelStyle}>Email</label><input type="email" value={email} onChange={e => setEmail(e.target.value)} required placeholder="you@nxtwave.tech" style={inputStyle} /></div>
            <div><label style={labelStyle}>Password</label><input type="password" value={password} onChange={e => setPassword(e.target.value)} required placeholder="••••••••" style={inputStyle} /></div>
            {error && <div style={{ fontSize: 12, color: C.red, background: C.redLight, border: "1px solid #fca5a5", borderRadius: 7, padding: "8px 12px" }}>{error}</div>}
            <button type="submit" disabled={loading} style={{ background: C.accent, color: "#fff", border: "none", borderRadius: 9, padding: "11px 20px", fontSize: 14, fontWeight: 700, cursor: loading ? "not-allowed" : "pointer", fontFamily: "inherit", opacity: loading ? 0.7 : 1, transition: "opacity 0.15s" }}>{loading ? "Signing in…" : "Sign In"}</button>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <div style={{ flex: 1, height: 1, background: C.border }} />
              <span style={{ fontSize: 11, fontWeight: 600, color: C.muted }}>or</span>
              <div style={{ flex: 1, height: 1, background: C.border }} />
            </div>
            <button type="button" onClick={onGoogleSignIn} style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 10, background: "#fff", border: `1.5px solid ${C.border}`, borderRadius: 9, padding: "10px 20px", fontSize: 13, fontWeight: 700, color: C.text, cursor: "pointer", fontFamily: "inherit", boxShadow: "0 1px 3px rgba(0,0,0,0.06)" }}>
              <svg width="16" height="16" viewBox="0 0 48 48"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.18 1.48-4.97 2.31-8.16 2.31-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>
              Sign in with Google
            </button>
          </form>
        )}

        {tab === "register" && !submitted && (
          <form onSubmit={handleRegister} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <div><label style={labelStyle}>Full Name</label><input type="text" value={name} onChange={e => setName(e.target.value)} required placeholder="Your name" style={inputStyle} /></div>
            <div><label style={labelStyle}>Email</label><input type="email" value={regEmail} onChange={e => setRegEmail(e.target.value)} required placeholder="you@nxtwave.tech" style={inputStyle} /></div>
            <div>
              <label style={labelStyle}>Team</label>
              <select value={team} onChange={e => setTeam(e.target.value)} style={{ ...inputStyle, cursor: "pointer" }}>
                <option value="poc">POC Team</option>
                <option value="admin">Admin</option>
                <option value="content">Content Team</option>
              </select>
            </div>
            {error && <div style={{ fontSize: 12, color: C.red, background: C.redLight, border: "1px solid #fca5a5", borderRadius: 7, padding: "8px 12px" }}>{error}</div>}
            <button type="submit" disabled={loading} style={{ background: C.accent, color: "#fff", border: "none", borderRadius: 9, padding: "11px 20px", fontSize: 14, fontWeight: 700, cursor: loading ? "not-allowed" : "pointer", fontFamily: "inherit", opacity: loading ? 0.7 : 1, transition: "opacity 0.15s" }}>{loading ? "Submitting…" : "Request Access"}</button>
          </form>
        )}

        {tab === "register" && submitted && (
          <div style={{ textAlign: "center", padding: "8px 0" }}>
            <div style={{ width: 52, height: 52, background: C.greenLight, borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 16px", color: C.green, fontSize: 22, fontWeight: 900 }}>✓</div>
            <div style={{ fontWeight: 800, fontSize: 16, color: C.text, marginBottom: 8 }}>Request Submitted!</div>
            <div style={{ fontSize: 13, color: C.muted, lineHeight: 1.6, marginBottom: 20 }}>Your request has been sent to the admin. Sign in now and wait on the next screen — you'll get access <strong>automatically</strong> the moment your request is approved.</div>
            <button onClick={() => { setTab("signin"); setEmail(regEmail); setSubmitted(false); }} style={{ background: C.accent, color: "#fff", border: "none", borderRadius: 9, padding: "10px 24px", fontSize: 13, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>Sign In Now</button>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── App Shell ────────────────────────────────────────────────────────────────

const NAV = [
  { id: "exams",    label: "Exam Details",         icon: "📋" },
  { id: "configs",  label: "Config Library",        icon: "🗂️" },
  { id: "generate", label: "Assessment Generation", icon: "🚀" },
  { id: "results",  label: "Results",               icon: "🏆" },
  { id: "interviews", label: "Interviews",          icon: "🎤" },
  { id: "team",     label: "Team & Roles",          icon: "🔑" },
];

export default function App() {
  const [page, setPage] = useState("exams");
  const [exams, setExams] = useState([]);
  const [uploads, setUploads] = useState([]);
  const [configEntries, setConfigEntries] = useState([]);
  const [publishedAssessments, setPublishedAssessments] = useState([]);
  const [results, setResults] = useState([]);
  const [rolesList, setRolesList] = useState([]);
  const [livePerms, setLivePerms] = useState(PERMISSIONS);
  const [notifications, setNotifications] = useState([]);
  const [accessRequests, setAccessRequests] = useState([]);
  const [currentUser, setCurrentUser] = useState(undefined); // undefined=loading, null=signed out

  useEffect(() => {
    return onAuthStateChanged(auth, async (firebaseUser) => {
      if (!firebaseUser) { setCurrentUser(null); return; }
      const roleDoc = await getDoc(doc(db, "roles", firebaseUser.email));
      const role = roleDoc.exists() ? roleDoc.data().role : null;
      setCurrentUser({ email: firebaseUser.email, displayName: firebaseUser.displayName, photoURL: firebaseUser.photoURL, role });
    });
  }, []);

  const handleSignIn = () => signInWithPopup(auth, googleProvider);
  const handleSignOut = () => signOut(auth);
  const handleEmailSignIn = async (email, password) => {
    try {
      await signInWithEmailAndPassword(auth, email, password);
    } catch (err) {
      if (err.code === "auth/invalid-credential" || err.code === "auth/user-not-found") {
        // First sign-in after approval — create the Firebase Auth account
        try {
          const cred = await createUserWithEmailAndPassword(auth, email, password);
          const reqDoc = await getDoc(doc(db, "accessRequests", email));
          if (reqDoc.exists() && reqDoc.data().name) {
            await updateProfile(cred.user, { displayName: reqDoc.data().name });
          }
        } catch (createErr) {
          if (createErr.code === "auth/email-already-in-use") {
            throw { code: "auth/invalid-credential" }; // account exists but wrong password
          }
          throw createErr;
        }
      } else {
        throw err;
      }
    }
  };
  const handleRegister = async (name, email, team) => {
    await setDoc(doc(db, "accessRequests", email), { name, email, team, requestedAt: new Date().toISOString(), status: "pending" });
  };

  useEffect(() => {
    const unsubs = [
      onSnapshot(collection(db, "exams"), snap =>
        setExams(snap.docs.map(d => ({ id: d.id, ...d.data() })))
      ),
      onSnapshot(collection(db, "uploads"), snap =>
        setUploads(snap.docs.map(d => ({ id: d.id, ...d.data() })))
      ),
      onSnapshot(collection(db, "configEntries"), snap =>
        setConfigEntries(snap.docs.map(d => ({ id: d.id, ...d.data() })))
      ),
      onSnapshot(collection(db, "assessments"), snap =>
        setPublishedAssessments(snap.docs.map(d => ({ id: d.id, ...d.data() })))
      ),
      onSnapshot(collection(db, "results"), snap =>
        setResults(snap.docs.map(d => ({ id: d.id, ...d.data() })))
      ),
      onSnapshot(collection(db, "roles"), snap =>
        setRolesList(snap.docs.map(d => ({ email: d.id, ...d.data() })))
      ),
      onSnapshot(collection(db, "notifications"), snap =>
        setNotifications(snap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)))
      ),
      onSnapshot(collection(db, "accessRequests"), snap =>
        setAccessRequests(snap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => new Date(b.requestedAt) - new Date(a.requestedAt)))
      ),
      onSnapshot(doc(db, "settings", "permissions"), snap => {
        const data = snap.exists() ? snap.data() : PERMISSIONS;
        activePermissions = data;
        setLivePerms(data);
        if (!snap.exists()) setDoc(doc(db, "settings", "permissions"), PERMISSIONS);
      }),
    ];
    return () => unsubs.forEach(u => u());
  }, []);

  // When admin grants a role to a pending user who's already signed in, update currentUser without requiring a page reload
  useEffect(() => {
    if (!currentUser || currentUser.role) return;
    const found = rolesList.find(r => r.email === currentUser.email);
    if (found) setCurrentUser(prev => ({ ...prev, role: found.role }));
  }, [rolesList, currentUser]);

  // Keep a ref so the reminder effect can read current notifications without it being a dependency
  const notificationsRef = useRef([]);
  useEffect(() => { notificationsRef.current = notifications; }, [notifications]);

  // Auto-generate "config link needed" reminders for exams 4 days away that are missing config links
  useEffect(() => {
    if (!exams.length || !configEntries) return;
    const today = new Date(); today.setHours(0, 0, 0, 0);
    for (const exam of exams) {
      if (exam.cancelled) continue;
      const examDate = new Date(exam.mainStartDate + "T00:00:00");
      const daysAway = Math.round((examDate - today) / (1000 * 60 * 60 * 24));
      if (daysAway !== 4) continue;
      const entry = configEntries.find(ce => ce.examId === exam.id);
      const mockPairs = Array.isArray(entry?.mock) ? entry.mock : [];
      const mainPairs = Array.isArray(entry?.main) ? entry.main : [];
      const hasMockConfig = mockPairs.some(p => p.configLink);
      const hasMainConfig = mainPairs.some(p => p.configLink);
      if (hasMockConfig && hasMainConfig) continue;
      if (notificationsRef.current.some(n => n.type === "config_link_reminder" && n.examId === exam.id)) continue;
      addDoc(collection(db, "notifications"), {
        type: "config_link_reminder",
        examId: exam.id,
        summary: `Config link needed: ${exam.type} exam is in 4 days (${fmtDate(exam.mainStartDate)})`,
        createdAt: new Date().toISOString(),
        read: false,
      });
    }
  }, [exams, configEntries]);

  const onSaveExam = async (form, editingId) => {
    if (editingId) {
      await updateDoc(doc(db, "exams", editingId), { ...form, notifiedOps: false, notifiedContent: false, notifiedAt: null });
      return editingId;
    } else {
      const ref = await addDoc(collection(db, "exams"), { ...form, status: "upcoming" });
      return ref.id;
    }
  };

  const onToggleExamStatus = async (exam) => {
    await updateDoc(doc(db, "exams", exam.id), {
      status: exam.status === "completed" ? "upcoming" : "completed",
    });
  };

  const onAddUpload = async (uploadData) => {
    await addDoc(collection(db, "uploads"), uploadData);
  };

  const onDeleteUpload = async (id) => {
    await deleteDoc(doc(db, "uploads", id));
  };

  const onDeleteExam = async (id) => {
    await deleteDoc(doc(db, "exams", id));
  };

  const onUndoDelete = async (exam) => {
    const { id, ...data } = exam;
    await setDoc(doc(db, "exams", id), data);
  };

  const onCancelExam = async (examId, cancelled) => {
    await updateDoc(doc(db, "exams", examId), { cancelled });
  };

  const onNotify = async (examId, notifyContent = false) => {
    if (examId) {
      try {
        await updateDoc(doc(db, "exams", examId), {
          notifiedOps: true,
          notifiedAt: new Date().toISOString(),
          ...(notifyContent ? { notifiedContent: true } : {}),
        });
      } catch (e) {
        // Firestore update failed — notification still considered sent in UI
      }
    }
  };

  const onSaveConfigEntry = async (form) => {
    await addDoc(collection(db, "configEntries"), { ...form, createdAt: new Date().toISOString() });
  };

  const onUpdateConfigEntry = async (id, form) => {
    await updateDoc(doc(db, "configEntries", id), { ...form });
  };

  const onDeleteConfigEntry = async (id) => {
    await deleteDoc(doc(db, "configEntries", id));
  };

  const onAddAssessment = async (data) => {
    const ref = await addDoc(collection(db, "assessments"), data);
    return ref.id;
  };

  const onUpdateAssessment = async (id, data) => {
    await updateDoc(doc(db, "assessments", id), data);
  };

  const onSaveResult = async (data) => {
    await addDoc(collection(db, "results"), { ...data, interviewStatus: "not_sent", importedAt: new Date().toISOString() });
  };
  const onUpdateResult = async (id, data) => {
    await updateDoc(doc(db, "results", id), data);
  };
  const onDeleteResult = async (id) => {
    await deleteDoc(doc(db, "results", id));
  };
  const onSendToInterview = async (students) => {
    const idToken = await auth.currentUser.getIdToken();
    const res = await fetch("/api/send-to-interview", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${idToken}` },
      body: JSON.stringify({ students }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Failed to send students to interview");
    return data;
  };

  const onSetRole = async (email, role) => {
    await setDoc(doc(db, "roles", email), { role });
  };
  const onRemoveRole = async (email) => {
    await deleteDoc(doc(db, "roles", email));
    await deleteDoc(doc(db, "accessRequests", email));
  };
  const onApproveRequest = async (email, role) => {
    await setDoc(doc(db, "roles", email), { role });
    await updateDoc(doc(db, "accessRequests", email), { status: "approved" });
  };
  const onRejectRequest = async (email) => {
    await updateDoc(doc(db, "accessRequests", email), { status: "rejected" });
  };
  const onUpdatePerm = async (targetRole, action, grant) => {
    const current = (livePerms[targetRole] || []).filter(a => a !== action);
    const updated = grant ? [...current, action] : current;
    await setDoc(doc(db, "settings", "permissions"), { ...livePerms, [targetRole]: updated });
  };
  const onAddNotification = async (data) => {
    await addDoc(collection(db, "notifications"), data);
  };
  const onMarkNotifRead = async (id) => {
    await updateDoc(doc(db, "notifications", id), { read: true });
  };
  const onMarkAllNotifsRead = async () => {
    await Promise.all(notifications.filter(n => !n.read).map(n => updateDoc(doc(db, "notifications", n.id), { read: true })));
  };

  const upcomingCount = exams.filter(e => getExamStatus(e) === "upcoming").length;
  const role = currentUser?.role;
  const visibleNav = NAV.filter(n => {
    if (n.id === "generate") return can(role, "generate");
    if (n.id === "team")     return role === "super_admin";
    return true;
  });

  if (currentUser === undefined) {
    return (
      <div style={{ minHeight: "100vh", background: C.bg, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "'Sora', 'Segoe UI', sans-serif" }}>
        <div style={{ width: 32, height: 32, border: `3px solid ${C.accent}`, borderTopColor: "transparent", borderRadius: "50%", animation: "spin 0.8s linear infinite" }} />
      </div>
    );
  }

  if (!currentUser) {
    return <LoginPage onSignIn={handleEmailSignIn} onRegister={handleRegister} onGoogleSignIn={handleSignIn} />;
  }

  if (!role) {
    const accessReq = accessRequests.find(r => r.email === currentUser.email);
    const isPending = accessReq?.status === "pending";
    const isRejected = accessReq?.status === "rejected";
    return (
      <div style={{ minHeight: "100vh", background: C.bg, fontFamily: "'Sora', 'Segoe UI', sans-serif", display: "flex", alignItems: "center", justifyContent: "center" }}>
        <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 16, padding: "40px", textAlign: "center", width: 400, maxWidth: "calc(100vw - 40px)" }}>
          {isPending ? (
            <>
              <div style={{ width: 56, height: 56, background: C.yellowLight, borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 18px", fontSize: 26 }}>⏳</div>
              <div style={{ fontWeight: 800, fontSize: 18, color: C.text, marginBottom: 8 }}>Awaiting Approval</div>
              <div style={{ fontSize: 13, color: C.muted, marginBottom: 6, lineHeight: 1.6 }}>
                Hi <strong>{accessReq.name}</strong>, your request as <strong>{ROLE_OPTIONS.find(o => o.value === accessReq.team)?.label || accessReq.team}</strong> is pending.
              </div>
              <div style={{ fontSize: 12, color: C.muted, marginBottom: 24 }}>An admin will review your request shortly. This page will update automatically once you're approved — no need to refresh.</div>
            </>
          ) : isRejected ? (
            <>
              <div style={{ width: 56, height: 56, background: C.redLight, borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 18px", fontSize: 24, color: C.red, fontWeight: 900 }}>✕</div>
              <div style={{ fontWeight: 800, fontSize: 18, color: C.text, marginBottom: 8 }}>Request Not Approved</div>
              <div style={{ fontSize: 13, color: C.muted, marginBottom: 24, lineHeight: 1.6 }}>Your access request was not approved. Contact an admin if you think this is a mistake.</div>
            </>
          ) : (
            <>
              <div style={{ fontSize: 36, marginBottom: 18 }}>🔒</div>
              <div style={{ fontWeight: 800, fontSize: 18, color: C.text, marginBottom: 8 }}>Access Not Assigned</div>
              <div style={{ fontSize: 13, color: C.muted, marginBottom: 24, lineHeight: 1.6 }}>Your account <strong>{currentUser.email}</strong> has not been assigned a role yet. Contact your admin to get access.</div>
            </>
          )}
          <button onClick={handleSignOut} style={{ background: "none", border: `1px solid ${C.border}`, borderRadius: 8, padding: "8px 20px", fontSize: 13, fontWeight: 600, color: C.muted, cursor: "pointer", fontFamily: "inherit" }}>Sign out</button>
        </div>
      </div>
    );
  }

  return (
    <div style={{ minHeight: "100vh", background: C.bg, fontFamily: "'Sora', 'Segoe UI', sans-serif", color: C.text, display: "flex" }}>
      {/* Left sidebar */}
      <div style={{ width: 230, background: C.surface, borderRight: `1px solid ${C.border}`, display: "flex", flexDirection: "column", position: "fixed", top: 0, left: 0, height: "100vh", zIndex: 100 }}>
        {/* Logo */}
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "20px 18px", borderBottom: `1px solid ${C.border}` }}>
          <div style={{ width: 32, height: 32, background: C.accent, borderRadius: 8, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 16, flexShrink: 0 }}>🎯</div>
          <div>
            <div style={{ fontWeight: 900, fontSize: 13, letterSpacing: -0.3 }}>Academy Nexus</div>
            <div style={{ fontSize: 10, color: C.muted, fontWeight: 600, letterSpacing: 0.5 }}>ASSESSMENT PLATFORM</div>
          </div>
        </div>

        {/* Nav items */}
        <nav style={{ padding: "12px 10px", flex: 1, display: "flex", flexDirection: "column", gap: 2 }}>
          {visibleNav.map(n => (
            <button key={n.id} onClick={() => setPage(n.id)} style={{
              width: "100%", display: "flex", alignItems: "center", gap: 10,
              background: page === n.id ? C.accentLight : "transparent",
              border: "none", borderRadius: 8,
              padding: "10px 14px", fontSize: 13, fontWeight: page === n.id ? 700 : 500,
              color: page === n.id ? C.accent : C.muted, cursor: "pointer", fontFamily: "inherit",
              textAlign: "left", transition: "all 0.15s"
            }}>
              <span style={{ fontSize: 16 }}>{n.icon}</span>
              <span style={{ flex: 1 }}>{n.label}</span>
              {n.id === "exams" && upcomingCount > 0 && (
                <span style={{ background: C.accent, color: "#fff", borderRadius: 10, padding: "1px 7px", fontSize: 10, fontWeight: 800 }}>{upcomingCount}</span>
              )}
            </button>
          ))}
        </nav>

        {/* User info + sign out */}
        <div style={{ padding: "14px 16px", borderTop: `1px solid ${C.border}` }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
            {currentUser.photoURL
              ? <img src={currentUser.photoURL} style={{ width: 28, height: 28, borderRadius: "50%", flexShrink: 0 }} />
              : <div style={{ width: 28, height: 28, background: C.accentLight, borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, color: C.accent, fontWeight: 800, flexShrink: 0 }}>{(currentUser.displayName?.[0] || currentUser.email?.[0] || "?").toUpperCase()}</div>}
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: C.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{currentUser.displayName || currentUser.email}</div>
              <div style={{ fontSize: 10, color: C.muted, fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.5 }}>{role.replace("_", " ")}</div>
            </div>
          </div>
          <button onClick={handleSignOut} style={{ width: "100%", background: "none", border: `1px solid ${C.border}`, borderRadius: 7, padding: "6px", fontSize: 11, fontWeight: 600, color: C.muted, cursor: "pointer", fontFamily: "inherit" }}>Sign out</button>
        </div>
      </div>

      {/* Main content */}
      <div style={{ marginLeft: 230, flex: 1, minWidth: 0 }}>
        <div style={{ padding: "32px 32px" }}>
          {page === "exams" && <ExamDetailsPage exams={exams} onSaveExam={onSaveExam} onDeleteExam={onDeleteExam} onUndoDelete={onUndoDelete} onNotify={onNotify} onCancelExam={onCancelExam} uploads={uploads} onAddUpload={onAddUpload} onDeleteUpload={onDeleteUpload} role={role} notifications={notifications} onAddNotification={onAddNotification} onMarkNotifRead={onMarkNotifRead} onMarkAllNotifsRead={onMarkAllNotifsRead} currentUserEmail={currentUser?.email} />}
          {page === "configs" && <ConfigLibraryPage configEntries={configEntries} onSaveConfigEntry={onSaveConfigEntry} onUpdateConfigEntry={onUpdateConfigEntry} onDeleteConfigEntry={onDeleteConfigEntry} exams={exams} role={role} notifications={notifications} onAddNotification={onAddNotification} onMarkNotifRead={onMarkNotifRead} onMarkAllNotifsRead={onMarkAllNotifsRead} currentUserEmail={currentUser?.email} />}
          {page === "generate" && <AssessmentGenPage exams={exams} configEntries={configEntries} uploads={uploads} assessments={publishedAssessments} onAddAssessment={onAddAssessment} onUpdateAssessment={onUpdateAssessment} />}
          {page === "results" && <ResultsPage results={results} onSaveResult={onSaveResult} onUpdateResult={onUpdateResult} onDeleteResult={onDeleteResult} onSendToInterview={onSendToInterview} role={role} />}
          {page === "interviews" && <InterviewsPage />}
          {page === "team" && <TeamRolesPage rolesList={rolesList} onSetRole={onSetRole} onRemoveRole={onRemoveRole} currentUserEmail={currentUser?.email} livePerms={livePerms} onUpdatePerm={onUpdatePerm} isSuperAdmin={role === "super_admin"} accessRequests={accessRequests} onApproveRequest={onApproveRequest} onRejectRequest={onRejectRequest} />}
        </div>
      </div>
    </div>
  );
}
