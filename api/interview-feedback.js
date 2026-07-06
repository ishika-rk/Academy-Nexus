import { adminDb } from "./_lib/firebaseAdmin.js";
import { requireApiKey } from "./_lib/auth.js";

// Called BY the Interview Coordinator App to push interview feedback/results
// back into Academy Nexus once an interview has been conducted.
//
// Auth: header  x-api-key: <INTERVIEW_FEEDBACK_API_KEY>
//
// Expected JSON body:
// {
//   "resultId": "the results/{id} doc this interview was sent from",
//   "studentId": "string",
//   "outcome": "Selected" | "Rejected" | "On Hold",
//   "feedback": "free text feedback from the interviewer",
//   "interviewer": "optional string",
//   "interviewedAt": "ISO 8601 date string"
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

  const { resultId, studentId, outcome, feedback, interviewer, interviewedAt } = req.body || {};

  if (!resultId || !studentId || !outcome) {
    return res.status(400).json({ error: "resultId, studentId and outcome are required" });
  }

  try {
    await adminDb
      .collection("interviews")
      .doc(resultId)
      .set(
        {
          resultId,
          studentId,
          outcome,
          feedback: feedback || "",
          interviewer: interviewer || "",
          interviewedAt: interviewedAt || null,
          status: "completed",
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
