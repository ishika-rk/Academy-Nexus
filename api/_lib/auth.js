import { adminAuth } from "./firebaseAdmin.js";

// Verifies the Firebase ID token of a signed-in Academy Nexus user.
// Used for endpoints our own frontend calls (as opposed to endpoints called by external systems).
export async function requireUser(req) {
  const header = req.headers.authorization || "";
  const idToken = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!idToken) {
    const err = new Error("Missing Authorization: Bearer <idToken> header");
    err.statusCode = 401;
    throw err;
  }
  try {
    return await adminAuth.verifyIdToken(idToken);
  } catch {
    const err = new Error("Invalid or expired ID token");
    err.statusCode = 401;
    throw err;
  }
}

// Verifies a shared-secret API key for endpoints called by external systems
// (e.g. the Interview Coordinator App pushing feedback back to us).
export function requireApiKey(req, envVarName) {
  const expected = process.env[envVarName];
  if (!expected) {
    const err = new Error(`Server missing ${envVarName}`);
    err.statusCode = 500;
    throw err;
  }
  const provided = req.headers["x-api-key"];
  if (provided !== expected) {
    const err = new Error("Invalid or missing x-api-key header");
    err.statusCode = 401;
    throw err;
  }
}
