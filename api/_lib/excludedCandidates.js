// Known test/dummy candidates from the Interview Coordinator App's own testing that should never
// surface in Academy Nexus, even though they carry programName "Academy". Checked before every
// write by both inbound paths (/api/ic-interviews sync and /api/interview-feedback push), so they
// never land in our `interviews` collection — deleting our copy alone wouldn't stick, the next
// sync would just pull it right back in from their side.
//
// A candidate is excluded if EITHER their UID or their name matches. Both are compared cleaned
// up (UID: lowercase, no spaces; name: lowercase, spaces collapsed), since the Interview App's
// values carry stray whitespace (candidateUid has been seen with a trailing tab).
export const EXCLUDED_CANDIDATE_UIDS = [
  "82e12a3e-cc1a-4ccb-be34-61771f4ff010", // swarna student — added 2026-10-28
];
export const EXCLUDED_CANDIDATE_NAMES = [
  "HarshitaStudent",
  "swarna student", // added 2026-10-28
];

const normUid = (v) => String(v || "").replace(/\s+/g, "").toLowerCase();
const normName = (v) => String(v || "").trim().replace(/\s+/g, " ").toLowerCase();

const uidSet = new Set(EXCLUDED_CANDIDATE_UIDS.map(normUid));
const nameSet = new Set(EXCLUDED_CANDIDATE_NAMES.map(normName));

export function isExcludedCandidate({ candidateUid, candidateName } = {}) {
  return uidSet.has(normUid(candidateUid)) || nameSet.has(normName(candidateName));
}

// Firestore matching is exact, so the cleanup query has to name every spelling it looks for:
// each name as listed, lowercased, and Title Cased.
function nameVariants(name) {
  const lower = normName(name);
  const title = lower.replace(/\b\w/g, (c) => c.toUpperCase());
  return [name, lower, title];
}

// Removes any excluded candidate already sitting in our own collection (e.g. from before they
// were added to the lists above). Adds the deletes to the caller's batch.
export async function addExcludedCandidateDeletes(adminDb, batch) {
  const col = adminDb.collection("interviews");
  const names = [...new Set(EXCLUDED_CANDIDATE_NAMES.flatMap(nameVariants))];
  const [byUid, byName] = await Promise.all([
    col.where("candidateUid", "in", EXCLUDED_CANDIDATE_UIDS.map(normUid)).get(),
    col.where("candidateName", "in", names).get(),
  ]);
  const seen = new Set();
  for (const d of [...byUid.docs, ...byName.docs]) {
    if (seen.has(d.id)) continue;
    seen.add(d.id);
    batch.delete(d.ref);
  }
}
