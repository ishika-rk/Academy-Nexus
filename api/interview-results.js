import { adminDb } from "./_lib/firebaseAdmin.js";
import { requireApiKey } from "./_lib/auth.js";

// Called BY the Replit student portal team to read Academy interview results. Read-only — never
// writes to Firestore. One API key covers every template listed in TEMPLATES below; adding a
// template later (e.g. from the separate interview-results table that's planned) means adding an
// entry there, not a new endpoint or key.
//
// Auth: header  x-api-key: <STUDENT_PORTAL_API_KEY>
//
// GET /api/interview-results?template=irp-l1[&candidateId=<Academy UID>][&email=<candidateEmail>][&limit=100][&cursor=<nextCursor>]
//
// Response:
// { "template": "irp-l1", "count": 2, "nextCursor": "<string>" | null, "results": [{ ... }] }
// Every status is returned (completed, scheduled, no_show, cancelled, ...) — clearanceStatus
// carries the raw status through for anything not completed, same as the IRP L1 table in the app.

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

function round2(raw) {
  if (raw === "" || raw === null || raw === undefined) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

// Lookup values arrive however the caller's system holds them — often copied through a
// spreadsheet, which can add spaces or invisible characters (non-breaking/zero-width spaces,
// BOMs) anywhere in the string. Neither a UID nor an email can legitimately contain any of
// these, so all of them are stripped, not just the ends.
const INVISIBLE_OR_SPACE = /[\s\u00A0\u200B-\u200D\uFEFF]/g;
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

// Stored candidateUid values are lowercase UUIDs (checked across every IRP L1 doc, 2026-10-22),
// so only the UUID part is kept and lowercased — same idea as normUid in src/App.jsx.
function cleanUid(v) {
  const raw = String(v).replace(INVISIBLE_OR_SPACE, "");
  const m = raw.match(UUID_RE);
  return m ? m[0].toLowerCase() : raw;
}

// Firestore matching is case-sensitive and stored emails aren't normalized, so both the value as
// sent and its lowercase form are tried. An email stored with different casing or stray spaces
// still won't match — that needs a normalized copy saved at sync time.
function emailVariants(v) {
  const raw = String(v).replace(INVISIBLE_OR_SPACE, "");
  return [...new Set([raw, raw.toLowerCase()])];
}

// Same rule as irpL1ClearanceStatus in src/App.jsx — keep the two in sync.
function irpL1ClearanceStatus(iv) {
  if (iv.status !== "completed") return iv.status || "";
  if (iv.finalVerdict === undefined || iv.finalVerdict === null || iv.finalVerdict === "") return "";
  return Number(iv.finalVerdict) >= 3.5 ? "Cleared" : "Not Cleared";
}

// Public slug -> where that template's results live and how each one is shaped. The slug is ours
// and stays fixed even if the Interview Coordinator App renames the template on their side (only
// `templateName` below would need updating).
const TEMPLATES = {
  "irp-l1": {
    collection: "interviews",
    templateName: "IRP L1 Human Interview",
    emailField: "candidateEmail",
    candidateIdField: "candidateUid",
    // Domain keys confirmed against a real IRP L1 submission, 2026-09-29 — see
    // fillIrpL1RubricColumns / IRP_L1_DOMAIN_KEY_OVERRIDES in src/App.jsx.
    toResult: (iv) => {
      const domains = iv.domains || {};
      return {
        candidateId: (iv.candidateUid || "").trim() || iv.id,
        candidateName: (iv.candidateName || "").trim(),
        interviewDate: iv.scheduledDate || "",
        interviewStartTime: iv.scheduledTime || "",
        part1Avg: round2(domains.take_home_assignment_drill_down?.domain_rating),
        part2Avg: round2(domains.frontend_conceptual_discussion?.domain_rating),
        part3Avg: round2(domains.react_live_coding?.domain_rating),
        communicationRating: round2(domains.communication_skills?.domain_rating),
        finalScore: round2(iv.finalVerdict),
        clearanceStatus: irpL1ClearanceStatus(iv),
      };
    },
  },
};

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-api-key");

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    requireApiKey(req, "STUDENT_PORTAL_API_KEY");
  } catch (err) {
    return res.status(err.statusCode || 401).json({ error: err.message });
  }

  const { template, candidateId, email, cursor } = req.query || {};
  const def = Object.hasOwn(TEMPLATES, template) ? TEMPLATES[template] : null;
  if (!def) {
    return res.status(400).json({
      error: `Unknown or missing template. Valid values: ${Object.keys(TEMPLATES).join(", ")}`,
    });
  }

  const limit = req.query?.limit === undefined ? DEFAULT_LIMIT : Number(req.query.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    return res.status(400).json({ error: `limit must be a whole number from 1 to ${MAX_LIMIT}` });
  }

  try {
    let queryRef = adminDb.collection(def.collection).where("templateName", "==", def.templateName);
    if (candidateId) queryRef = queryRef.where(def.candidateIdField, "==", cleanUid(candidateId));
    if (email) queryRef = queryRef.where(def.emailField, "in", emailVariants(email));
    // Ordered by doc id so the cursor (the last doc id of the previous page) is stable no matter
    // how often a result's fields get updated between page requests.
    queryRef = queryRef.orderBy("__name__").limit(limit + 1);
    if (cursor) queryRef = queryRef.startAfter(String(cursor));

    const snap = await queryRef.get();
    const docs = snap.docs.slice(0, limit);
    const results = docs.map((d) => def.toResult({ ...d.data(), id: d.id }));

    return res.status(200).json({
      template,
      count: results.length,
      nextCursor: snap.docs.length > limit ? docs[docs.length - 1].id : null,
      results,
    });
  } catch (err) {
    console.error("interview-results error:", err);
    return res.status(500).json({ error: "Failed to fetch interview results" });
  }
}
