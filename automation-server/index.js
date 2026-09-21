"use strict";
// Local Topin automation server for Academy Nexus's Assessment Generation page.
// Runs on the POC's own machine (Playwright + a saved Topin browser session) — never deployed to Vercel.
// Adapted from the IOE Admin Portal's server (github.com/sravanthi025/ioe-admin-portal): same
// OTP-login + clone-and-publish flow, without the token/SEB/direct-API paths this app doesn't use.
const fs           = require("fs");
const path         = require("path");
const express      = require("express");
const cors         = require("cors");
const { chromium } = require("playwright");
const topinClone   = require("./topin-clone");

const app  = express();
const PORT = process.env.PORT || 3001;
const SESSION_FILE = path.join(__dirname, "topin-session.json");

// Chrome asks for this when a public https page (the Vercel app) calls localhost; must precede cors() so it lands on preflights.
app.use((req, res, next) => { res.setHeader("Access-Control-Allow-Private-Network", "true"); next(); });
app.use(cors({ origin: true }));
app.use(express.json());

// ── SSE broadcast ─────────────────────────────────────────────
const sseClients = new Set();
let jobRunning     = false;
let browser        = null;
let pendingAuthCtx = null;
let authCaptured   = false;

function broadcast(type, message, extra = {}) {
  const payload = JSON.stringify({ type, message, ts: new Date().toISOString(), ...extra });
  sseClients.forEach(res => { try { res.write(`data: ${payload}\n\n`); } catch { /* client gone */ } });
  console.log(`[${type.toUpperCase()}] ${message}`);
}

app.get("/api/health", (_req, res) => res.json({ status: "ok", ts: Date.now() }));

// We can only confirm a session file exists here — whether it's still valid is checked for real
// (against Topin) by /api/publish/start and /api/publish/run.
app.get("/api/publish/token-status", (_req, res) => res.json({ hasSession: fs.existsSync(SESSION_FILE) }));

app.get("/api/publish/progress", (req, res) => {
  res.setHeader("Content-Type",  "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection",    "keep-alive");
  sseClients.add(res);
  res.write(`data: ${JSON.stringify({ type: "connected", message: "SSE connected", ts: new Date().toISOString() })}\n\n`);
  req.on("close", () => sseClients.delete(res));
});

// ── Browser helpers ───────────────────────────────────────────
async function ensureBrowser() {
  if (!browser || !browser.isConnected()) {
    browser = await chromium.launch({ headless: process.env.HEADLESS !== "false" });
  }
  return browser;
}

// Restores the saved Topin session and confirms it's still logged in. Returns { page, context } or null.
async function getAuthedPage(onLog = () => {}) {
  if (!fs.existsSync(SESSION_FILE)) return null;
  let context;
  try {
    const b = await ensureBrowser();
    context = await b.newContext({ storageState: SESSION_FILE });
    const page = await context.newPage();
    await page.goto(topinClone.BASE_URL, { waitUntil: "domcontentloaded", timeout: 20000 });
    await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
    if (page.url().includes("accounts.ccbp.in")) {
      onLog("Saved Topin session has expired.");
      await context.close().catch(() => {});
      return null;
    }
    return { page, context };
  } catch (e) {
    onLog(`Failed to restore saved Topin session: ${e.message}`);
    await context?.close().catch(() => {});
    return null;
  }
}

// Topin can redirect back to the login page after a good OTP, so the URL alone isn't a reliable
// success signal — watch for the token responses instead.
function watchAuthResponses(context) {
  authCaptured = false;
  context.on("response", async (response) => {
    try {
      const url = response.url();
      if (url.includes("login_otp/verify/v1") || url.includes("mobile/otp/verify") || url.includes("auth_code/v2")) {
        const data = await response.json().catch(() => null);
        if (data?.access_token) authCaptured = true;
      }
    } catch { /* non-fatal */ }
  });
}

// ── Step 1: start OTP login ───────────────────────────────────
app.post("/api/publish/start", async (req, res) => {
  const { mobile } = req.body || {};
  if (!mobile) return res.status(400).json({ error: "mobile number required" });

  const existing = await getAuthedPage(msg => broadcast("info", msg));
  if (existing) {
    await existing.context.close().catch(() => {});
    broadcast("info", "Already logged in — saved session is still valid.");
    return res.json({ status: "already_authenticated" });
  }

  try {
    broadcast("info", "Opening Topin login page...");
    const b = await ensureBrowser();
    if (pendingAuthCtx) { await pendingAuthCtx.close().catch(() => {}); pendingAuthCtx = null; }
    pendingAuthCtx = await b.newContext();
    watchAuthResponses(pendingAuthCtx);
    const pg = await pendingAuthCtx.newPage();

    await pg.goto(topinClone.BASE_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
    if (!pg.url().includes("ccbp.in")) {
      await pg.waitForURL(u => u.href.includes("ccbp.in") || u.href.includes("login"), { timeout: 15000 }).catch(() => {});
    }
    await pg.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});

    const mobileInput = pg.locator([
      'input[placeholder="Enter Number"]',
      'input[placeholder*="mobile" i]',
      'input[placeholder*="phone" i]',
      'input[placeholder*="number" i]',
      'input[type="tel"]',
      'input[name*="mobile" i]',
    ].join(", ")).first();
    await mobileInput.waitFor({ state: "visible", timeout: 15000 });
    await mobileInput.fill(mobile);

    await pg.locator([
      'button:has-text("GET OTP")',
      'button:has-text("Get OTP")',
      'button:has-text("Send OTP")',
      'button:has-text("Continue")',
      'button[type="submit"]',
    ].join(", ")).first().click({ timeout: 10000 });

    broadcast("info", `OTP sent to ${mobile.replace(/\d(?=\d{4})/g, "*")}`);
    res.json({ status: "otp_sent" });
  } catch (e) {
    broadcast("error", `Login start failed: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

// ── Step 2: verify OTP ────────────────────────────────────────
app.post("/api/publish/verify-otp", async (req, res) => {
  const { otp } = req.body || {};
  if (!otp || String(otp).length !== 6) return res.status(400).json({ error: "6-digit OTP required" });
  if (!pendingAuthCtx) return res.status(400).json({ error: "No login in progress — call /start first" });

  try {
    const pages  = pendingAuthCtx.pages();
    const pg     = pages[pages.length - 1];
    const otpStr = String(otp);

    await pg.waitForSelector('#verifyOtpButton, [data-testid="multi-step-verify-otp-button"]', { timeout: 15000 });
    await pg.waitForTimeout(600);

    const allVisible = await pg.locator("input:visible").all();
    if (!allVisible.length) throw new Error("No input fields on OTP page");
    await allVisible[0].click();
    await pg.waitForTimeout(200);
    await allVisible[0].pressSequentially(otpStr, { delay: 120 });
    await pg.waitForTimeout(500);

    const btnDisabled = await pg.$eval(
      '#verifyOtpButton, [data-testid="multi-step-verify-otp-button"]',
      el => el.disabled
    ).catch(() => false);

    // Some layouts use one input box per digit.
    if (btnDisabled && allVisible.length >= 6) {
      for (let i = 0; i < 6; i++) {
        await allVisible[i].click();
        await allVisible[i].pressSequentially(otpStr[i], { delay: 80 });
        await pg.waitForTimeout(100);
      }
      await pg.waitForTimeout(400);
    }

    await pg.waitForSelector(
      '#verifyOtpButton:not([disabled]), [data-testid="multi-step-verify-otp-button"]:not([disabled])',
      { timeout: 8000 }
    ).catch(() => {});

    await pg.click('#verifyOtpButton, [data-testid="multi-step-verify-otp-button"]', { timeout: 8000 })
      .catch(() => pg.getByRole("button", { name: /verify/i }).click({ timeout: 5000 }));

    await pg.waitForTimeout(2000);
    await pg.waitForURL(u => !u.href.includes("accounts.ccbp.in"), { timeout: 25000 }).catch(() => {});
    await pg.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {});
    await pg.waitForTimeout(3000); // let the auth_code exchange finish

    if (!authCaptured && (pg.url().includes("accounts.ccbp.in") || pg.url() === "about:blank")) {
      throw new Error("Still on login page — OTP may be incorrect or expired");
    }

    await pendingAuthCtx.storageState({ path: SESSION_FILE }).catch(() => {});
    await pendingAuthCtx.close().catch(() => {});
    pendingAuthCtx = null;
    broadcast("success", "Logged in — session saved for future publishes");
    res.json({ status: "authenticated" });
  } catch (e) {
    broadcast("error", `OTP verification failed: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

// ── Step 3: clone the chosen config in the real Topin UI and publish ──
// Body: { configUrl, title, uniqueExamId, startDate, startTime, endDate, endTime, isMock }
//   dates "YYYY-MM-DD", times "HH:MM" (24h)
app.post("/api/publish/run", async (req, res) => {
  if (jobRunning) return res.status(409).json({ error: "A publish job is already running" });

  const { configUrl, title, uniqueExamId, startDate, startTime, endDate, endTime, isMock = false } = req.body || {};
  if (!configUrl || !title || !uniqueExamId || !startDate || !startTime || !endDate || !endTime) {
    return res.status(400).json({ error: "Missing fields: configUrl, title, uniqueExamId, startDate, startTime, endDate, endTime" });
  }

  const authed = await getAuthedPage(msg => broadcast("info", msg));
  if (!authed) {
    return res.status(401).json({ status: "needs_otp", error: "No valid Topin session — complete OTP login first" });
  }

  // Respond now; the publish runs async and reports over SSE.
  res.json({ status: "started" });
  jobRunning = true;

  (async () => {
    const { page, context } = authed;
    try {
      const label = isMock ? "Mock Assessment" : "Main Assessment";
      const start = topinClone.buildDate(startDate, startTime);
      const end   = topinClone.buildDate(endDate, endTime);
      broadcast("info", `Starting clone-based publish: ${label}`);
      broadcast("info", `Schedule: ${start.toLocaleString()} → ${end.toLocaleString()}`);
      broadcast("info", `Tag: ${uniqueExamId}`);

      const result = await topinClone.cloneAndPublish(page, {
        sampleConfigLink: configUrl, title, uniqueExamId, startDate: start, endDate: end,
      }, msg => broadcast("info", msg));

      // With no `org_id` link the invite step can't work, so say so rather than passing it off as a clean success.
      const linkCaptured = /org_id=/.test(result.assessmentLink || "");
      if (!linkCaptured) {
        broadcast("info", "Published, but the assessment link couldn't be read from Topin — copy it from the Topin dashboard.");
      }
      broadcast("done", `${label} published`, {
        assessmentLink: linkCaptured ? result.assessmentLink : "",
        newConfigLink:  result.newConfigLink,
        uniqueExamId, isMock,
      });
    } catch (e) {
      broadcast("error", `Publish failed: ${e.message}`);
    } finally {
      // Topin may rotate cookies during use — re-save so the next run doesn't need another OTP.
      await context.storageState({ path: SESSION_FILE }).catch(() => {});
      await context.close().catch(() => {});
      jobRunning = false;
    }
  })();
});

app.listen(PORT, () => {
  console.log("─────────────────────────────────────────────");
  console.log("  Academy Nexus — Topin automation server");
  console.log(`  http://localhost:${PORT}   (health: /api/health)`);
  console.log("─────────────────────────────────────────────");
});
