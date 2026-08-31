import { adminDb } from "./_lib/firebaseAdmin.js";
import { requireUser } from "./_lib/auth.js";

// Pulls Academy interviews directly from the Interview Coordinator App's own
// Firestore project, using a service account scoped to it — the same
// cross-project-read pattern the IOE Admin Portal uses for its own
// ("Intensive"-prefixed) interviews, just filtered here on Academy-prefixed
// templates instead. Also upserts everything into our own `interviews`
// collection (same shape /api/interview-feedback writes), so this doubles as
// a backfill/full-sync for pending & scheduled interviews that haven't had a
// completion pushed yet — the Interviews page renders off that collection
// via a live Firestore listener, not off this response directly.
//
// Requires IC_SA_B64 env var: base64-encoded service account JSON for the
// Interview Coordinator App's Firebase project (ask that team for it).
//
// POST /api/ic-interviews  (sync action — write side effect, so not a GET)

export const config = { maxDuration: 30 };

let icDb = null;
async function getIcDb() {
  if (icDb) return icDb;
  const { initializeApp, cert, getApps } = await import("firebase-admin/app");
  const { getFirestore } = await import("firebase-admin/firestore");
  const existing = getApps().find((a) => a.name === "ic");
  const sa = JSON.parse(Buffer.from(process.env.IC_SA_B64, "base64").toString("utf8"));
  const app = existing || initializeApp({ credential: cert(sa) }, "ic");
  icDb = getFirestore(app);
  return icDb;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  try {
    await requireUser(req);
  } catch (err) {
    return res.status(err.statusCode || 401).json({ ok: false, error: err.message });
  }

  if (!process.env.IC_SA_B64) {
    return res.status(503).json({ ok: false, error: "IC_SA_B64 env var not set in Vercel." });
  }

  try {
    const db = await getIcDb();
    // Was a templateName-prefix range query ("Academy" <= templateName < "Academz"), which
    // relied on every Academy template being named with an "Academy" prefix. The Interview
    // Coordinator App team added a proper programName field per our request (2026-08-31) —
    // exact match on "Academy" pulls every template under that program (Bucket A/B/C,
    // Frontend Development, Programming with Problem Solving (DSA), and anything added
    // later) with nothing to remember to name a certain way.
    const snap = await db
      .collection("interviews")
      .where("programName", "==", "Academy")
      .get();

    const interviews = snap.docs.map((d) => {
      const r = d.data();
      const feedback = r.feedback || {};
      return {
        id: d.id,
        // The actual Candidate ID (Academy's own student UID) — confirmed via a live debug
        // search, 2026-08-28. Trimmed: the source value carries a trailing tab character.
        candidateUid: (r.candidateUid || "").trim(),
        candidateName: r.candidateName || "",
        candidateEmail: r.candidateEmail || "",
        interviewerEmail: r.interviewerEmail || "",
        // Added by the Interview Coordinator App team per our request — the interviewer's
        // display name, replacing email as what's shown in the Name of the Panelist column.
        interviewerName: r.interviewerName || "",
        programName: r.programName || "",
        templateName: r.templateName || "",
        round: r.round || "",
        scheduledDate: r.scheduledDate || "",
        scheduledTime: r.scheduledTime || "",
        status: r.status || "pending_acceptance",
        outcome: feedback.overallRecommendation || "",
        finalVerdict: feedback.finalVerdict ?? null,
        remarks: feedback.comments || "",
        feedbackSubmittedAt: feedback.submittedAt || "",
        completedAt: feedback.submittedAt || r.updatedAt || "",
        updatedAt: r.updatedAt || "",
        // Per-part rubric scores, keyed by domain (e.g. "take_home_assignment_drill_down" ->
        // { cards: [{ <rating fields...>, domain_rating }] }). The App.jsx table builders derive
        // each column's domain/field key from its label the same way the Interview Coordinator
        // App names them (lowercase, strip punctuation, join with "_") — confirmed against a
        // real Bucket B / TR1 submission, 2026-08-13.
        domains: feedback.domains || null,
        // The manually-rated Integrity Score shown in the Interview Coordinator App's own UI —
        // NOT domains.integrity.domain_rating (that's a separate 0-1 average of automated
        // proctoring compliance checks, unrelated despite the similar name). Confirmed via a live
        // debug search of the raw feedback payload, 2026-08-13.
        integrityScore: feedback.integrityScore ?? null,
        // The interview's Google Meet link — a top-level field on the source doc, not inside
        // feedback. It's the only URL present anywhere in the payload (confirmed via a live debug
        // search, 2026-08-13), so it's used for the Interview Recording Link column; the
        // Interview Coordinator App may not distinguish a join link from a post-hoc recording
        // link, so this may be the live meeting link rather than a recording specifically.
        meetLink: r.meetLink || "",
        // Added by the Interview Coordinator App team 2026-08-14, per our request — top-level
        // fields alongside meetLink, confirmed via a live debug search.
        meetingRecordingUrl: r.meetingRecordingUrl || "",
        transcriptUrl: r.transcriptUrl || "",
      };
    });

    const batch = adminDb.batch();
    const syncedAt = new Date().toISOString();
    for (const iv of interviews) {
      batch.set(adminDb.collection("interviews").doc(iv.id), { ...iv, syncedAt }, { merge: true });
    }
    await batch.commit();

    return res.status(200).json({ ok: true, count: interviews.length, syncedAt });
  } catch (err) {
    console.error("ic-interviews error:", err);
    const isQuotaError = /RESOURCE_EXHAUSTED|Quota exceeded/i.test(err.message || "");
    const error = isQuotaError
      ? "Firestore quota/rate limit hit — wait a few minutes and try again."
      : "Failed to sync interviews";
    return res.status(500).json({ ok: false, error });
  }
}
