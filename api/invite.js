import { requireUser } from "./_lib/auth.js";

// Called BY our own frontend (Assessment Generation → Invite Students) to invite candidates to a
// published Topin assessment. Runs server-side so TOPIN_INVITE_API_KEY never reaches the browser.
//
// Auth: header  Authorization: Bearer <Firebase ID token>
// Body: { "candidates": ["<uid>", ...], "assessmentId": "<org_id from the assessment link>" }
export const config = { maxDuration: 60 };

const INVITE_ENDPOINT = "https://nxtwave-assessments-backend-topin-prod-apis.ccbp.in/api/nw_integrations/invite/assess/candidates/v2/";
const BATCH_SIZE = 20;

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    await requireUser(req);
  } catch (err) {
    return res.status(err.statusCode || 401).json({ error: err.message });
  }

  const apiKey = process.env.TOPIN_INVITE_API_KEY;
  if (!apiKey) return res.status(501).json({ error: "TOPIN_INVITE_API_KEY is not set." });

  const { candidates, assessmentId } = req.body || {};
  if (!Array.isArray(candidates) || !candidates.length || !assessmentId) {
    return res.status(400).json({ error: "Missing required fields: candidates[], assessmentId" });
  }

  const results = { total: candidates.length, sent: 0, failed: 0, errors: [] };

  for (let i = 0; i < candidates.length; i += BATCH_SIZE) {
    const batch = candidates.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    let success = false;
    let lastError = "";

    for (let attempt = 0; attempt < 3 && !success; attempt++) {
      if (attempt > 0) await new Promise(r => setTimeout(r, 500 * 2 ** attempt));
      try {
        const resp = await fetch(INVITE_ENDPOINT, {
          method: "POST",
          headers: { "X-API-KEY": apiKey, "Content-Type": "application/json" },
          body: JSON.stringify({ candidate_user_ids: batch, assessment_id: assessmentId }),
        });
        if (resp.ok) success = true;
        else lastError = `HTTP ${resp.status}: ${await resp.text().catch(() => "")}`;
      } catch (e) {
        lastError = e.message;
      }
    }

    if (success) results.sent += batch.length;
    else {
      results.failed += batch.length;
      results.errors.push(`Batch ${batchNum}: ${lastError}`);
    }
    if (i + BATCH_SIZE < candidates.length) await new Promise(r => setTimeout(r, 400));
  }

  return res.status(200).json(results);
}
