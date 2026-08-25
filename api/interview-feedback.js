import { adminDb } from "./_lib/firebaseAdmin.js";
import { requireApiKey } from "./_lib/auth.js";

// Called BY the Interview Coordinator App the moment an Academy interview's
// status/feedback changes (in particular, when it's marked "completed") —
// gives near-instant reflection here instead of waiting on the next manual
// sync. Writes into the same `interviews` collection /api/ic-interviews
// backfills, keyed by the Interview Coordinator App's own interview id, so
// the two sources merge cleanly and the Interviews page's live Firestore
// listener picks this up immediately.
//
// Auth: header  x-api-key: <INTERVIEW_FEEDBACK_API_KEY>
//
// Expected JSON body (same shape /api/ic-interviews maps interviews to):
// {
//   "interviewId": "Interview Coordinator App's interview doc id",
//   "candidateName": "string", "candidateEmail": "string",
//   "interviewerEmail": "string", "interviewerName": "string",
//   "templateName": "string", "round": "string",
//   "status": "pending_acceptance" | "scheduled" | "completed" | "no_show" | "cancelled",
//   "outcome": "string (feedback.overallRecommendation)",
//   "finalVerdict": number | null,
//   "remarks": "string (feedback.comments)",
//   "scheduledDate": "YYYY-MM-DD", "scheduledTime": "string",
//   "completedAt": "ISO 8601 date string",
//   "updatedAt": "ISO 8601 date string"
// }
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-api-key");

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    requireApiKey(req, "INTERVIEW_FEEDBACK_API_KEY");
  } catch (err) {
    return res.status(err.statusCode || 401).json({ error: err.message });
  }

  const {
    interviewId, candidateName, candidateEmail, interviewerEmail, interviewerName,
    templateName, round, status, outcome, finalVerdict, remarks,
    scheduledDate, scheduledTime, completedAt, updatedAt,
  } = req.body || {};

  if (!interviewId || !status) {
    return res.status(400).json({ error: "interviewId and status are required" });
  }

  try {
    await adminDb
      .collection("interviews")
      .doc(interviewId)
      .set(
        {
          id: interviewId,
          candidateName: candidateName || "",
          candidateEmail: candidateEmail || "",
          interviewerEmail: interviewerEmail || "",
          interviewerName: interviewerName || "",
          templateName: templateName || "",
          round: round || "",
          status,
          outcome: outcome || "",
          finalVerdict: finalVerdict ?? null,
          remarks: remarks || "",
          scheduledDate: scheduledDate || "",
          scheduledTime: scheduledTime || "",
          completedAt: completedAt || null,
          updatedAt: updatedAt || new Date().toISOString(),
          receivedAt: new Date().toISOString(),
        },
        { merge: true }
      );

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("interview-feedback error:", err);
    return res.status(500).json({ error: "Failed to save interview feedback" });
  }
}
