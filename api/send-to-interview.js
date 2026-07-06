import { adminDb } from "./_lib/firebaseAdmin.js";
import { requireUser } from "./_lib/auth.js";

// Called BY our own frontend (Results page) to hand off eligible students
// to the Interview Coordinator App. Runs server-side so the Interview
// Coordinator App's API key never reaches the browser.
//
// Auth: header  Authorization: Bearer <Firebase ID token>
//
// Expected JSON body:
// { "students": [{ "resultId": "...", "studentId": "...", "name": "...", "examId": "...", "examName": "...", "program": "Online" | "Offline", "score": 0 }] }
export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    await requireUser(req);
  } catch (err) {
    return res.status(err.statusCode || 401).json({ error: err.message });
  }

  const { students } = req.body || {};
  if (!Array.isArray(students) || students.length === 0) {
    return res.status(400).json({ error: "students must be a non-empty array" });
  }

  const targetUrl = process.env.INTERVIEW_APP_URL;
  const targetApiKey = process.env.INTERVIEW_APP_API_KEY;

  if (!targetUrl || !targetApiKey) {
    return res.status(501).json({
      error:
        "Interview Coordinator App integration is not configured yet. Set INTERVIEW_APP_URL and INTERVIEW_APP_API_KEY.",
    });
  }

  try {
    const response = await fetch(targetUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": targetApiKey,
      },
      body: JSON.stringify({ students }),
    });

    if (!response.ok) {
      const detail = await response.text();
      console.error("Interview Coordinator App rejected the request:", response.status, detail);
      return res.status(502).json({ error: "Interview Coordinator App rejected the request" });
    }

    const batch = adminDb.batch();
    const now = new Date().toISOString();

    for (const student of students) {
      const resultRef = adminDb.collection("results").doc(student.resultId);
      batch.set(resultRef, { interviewStatus: "sent", sentToInterviewAt: now }, { merge: true });

      const interviewRef = adminDb.collection("interviews").doc(student.resultId);
      batch.set(
        interviewRef,
        {
          resultId: student.resultId,
          studentId: student.studentId,
          name: student.name || "",
          examId: student.examId || "",
          examName: student.examName || "",
          program: student.program || "",
          score: student.score ?? null,
          status: "pending",
          sentAt: now,
        },
        { merge: true }
      );
    }

    await batch.commit();

    return res.status(200).json({ ok: true, sent: students.length });
  } catch (err) {
    console.error("send-to-interview error:", err);
    return res.status(500).json({ error: "Failed to send students to Interview Coordinator App" });
  }
}
