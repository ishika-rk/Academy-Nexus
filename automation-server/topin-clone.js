"use strict";
// Clone-based Topin publish automation — drives the real config.topin.tech UI with
// Playwright: open the existing config, click Clone, fill in name/tag/schedule, publish.
//
// Ported from https://github.com/saidineshsimhadri/topin-cloner (src/topinAutomation.js),
// which the org already uses successfully for CSV-driven bulk cloning. Trimmed to the
// inputs this portal already has per config row (title, tag, start/end datetime, optional
// exit PIN) — no CSV, no time-slot guessing, no TinyURL shortening.

const BASE_URL = "https://config.topin.tech/";

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const TOPIN_TIME_INTERVAL_MINUTES = 5;

function normalizeSpaces(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function normalizeSampleViewLink(url) {
  const trimmed = normalizeSpaces(url);
  if (!trimmed) throw new Error("Config link is empty.");
  if (!trimmed.startsWith("http")) {
    throw new Error(`Config link does not look like a URL: "${trimmed}"`);
  }
  return trimmed.replace("/edit-assessment/", "/view-assessment/");
}

function buildDate(dateStr, timeStr) {
  const [year, month, day] = String(dateStr).split("-").map(Number);
  const [hour, minute]     = String(timeStr).split(":").map(Number);
  return new Date(year, month - 1, day, hour || 0, minute || 0, 0, 0);
}

function floorDateToInterval(date, intervalMinutes = TOPIN_TIME_INTERVAL_MINUTES) {
  const normalizedDate = new Date(date.getTime());
  const minutes = normalizedDate.getMinutes();
  normalizedDate.setMinutes(Math.floor(minutes / intervalMinutes) * intervalMinutes, 0, 0);
  return normalizedDate;
}

function formatTimeSlot(date) {
  const hours = date.getHours();
  const minutes = date.getMinutes();
  const period = hours >= 12 ? "PM" : "AM";
  const twelveHour = hours % 12 || 12;
  return `${twelveHour}:${String(minutes).padStart(2, "0")} ${period}`;
}

function formatMonthYear(date) {
  return `${MONTH_NAMES[date.getMonth()]} ${date.getFullYear()}`;
}

function ordinalSuffix(day) {
  if (day >= 11 && day <= 13) return "th";
  const lastDigit = day % 10;
  if (lastDigit === 1) return "st";
  if (lastDigit === 2) return "nd";
  if (lastDigit === 3) return "rd";
  return "th";
}

function buildDateButtonName(date) {
  const weekday = WEEKDAY_NAMES[date.getDay()];
  const month   = MONTH_NAMES[date.getMonth()];
  const day     = date.getDate();
  return `Choose ${weekday}, ${month} ${day}${ordinalSuffix(day)}, ${date.getFullYear()}`;
}

async function waitForPageSettled(page, timeout = 15000) {
  await page.waitForLoadState("domcontentloaded");
  await page.waitForLoadState("networkidle", { timeout }).catch(() => {});
}

function cloneActionLocator(page) {
  return page.locator("button, a, [role=\"button\"]").filter({ hasText: /clone/i }).first();
}
function saveAndNextLocator(page) {
  return page.locator("button, a, [role=\"button\"]").filter({ hasText: /save\s*&\s*next/i }).first();
}
function publishAssessmentLocator(page) {
  return page.locator("button, a, [role=\"button\"]").filter({ hasText: /^publish assessment$/i }).first();
}

async function getLabeledValue(page, label) {
  return page.evaluate((expectedLabel) => {
    const normalize = (value) => value.replace(/\s+/g, " ").trim();
    const nodes = Array.from(document.querySelectorAll("main *"));
    for (const node of nodes) {
      const text = normalize(node.textContent || "");
      if (text !== expectedLabel) continue;
      const sibling = node.nextElementSibling;
      if (sibling) {
        const siblingText = normalize(sibling.textContent || "");
        if (siblingText) return siblingText;
      }
      const parent = node.parentElement;
      if (parent) {
        const children = Array.from(parent.children);
        const next = children[children.indexOf(node) + 1];
        if (next) {
          const nextText = normalize(next.textContent || "");
          if (nextText) return nextText;
        }
      }
    }
    return null;
  }, label);
}

async function detectAccessType(page) {
  const bodyText = await page.locator("body").textContent();
  if ((bodyText || "").includes("Only invited candidates can access and write the assessment")) return "Private";
  if ((bodyText || "").includes("Anyone can access and write the assessment")) return "Public";
  return "Private";
}

async function ensureMonth(page, targetDate) {
  const picker = page.locator(".react-datepicker").last();
  const targetMonthYear = formatMonthYear(targetDate);

  for (let attempt = 0; attempt < 24; attempt += 1) {
    const currentMonthYear = normalizeSpaces(
      (await picker.locator(".react-datepicker__current-month").textContent()) || "",
    );
    if (currentMonthYear === targetMonthYear) return;

    const [currentMonthName, currentYearText] = currentMonthYear.split(" ");
    const currentMonthIndex = MONTH_NAMES.findIndex((month) => month === currentMonthName);
    const currentKey = Number(currentYearText) * 12 + currentMonthIndex;
    const targetKey  = targetDate.getFullYear() * 12 + targetDate.getMonth();

    if (currentKey < targetKey) await picker.getByRole("button", { name: "Next Month" }).click();
    else                        await picker.getByRole("button", { name: "Previous Month" }).click();
  }
  throw new Error(`Unable to navigate date picker to ${targetMonthYear}`);
}

async function setDateTimeField(page, testId, targetDate) {
  const normalizedTargetDate = floorDateToInterval(targetDate);
  const wrapper = page.locator(`[data-testid="${testId}"]`);
  const input   = wrapper.locator('input[placeholder="Select Date & Time"]');
  await input.click();
  await page.locator(".react-datepicker").last().waitFor({ state: "visible" });

  await ensureMonth(page, normalizedTargetDate);
  await page.locator(".react-datepicker").last()
    .getByRole("button", { name: buildDateButtonName(normalizedTargetDate) })
    .click();

  const timeText = formatTimeSlot(normalizedTargetDate);
  const pickerEl = page.locator(".react-datepicker").last();

  const scrollResult = await pickerEl.evaluate((el, targetText) => {
    const list  = el.querySelector(".react-datepicker__time-list");
    const items = Array.from(el.querySelectorAll(".react-datepicker__time-list-item"));
    const index = items.findIndex((item) => (item.textContent || "").trim() === targetText);
    if (index === -1 || !list) return null;
    list.scrollTop = items[index].offsetTop;
    return true;
  }, timeText);

  if (!scrollResult) throw new Error(`Time option "${timeText}" not found in the date picker time list.`);
  await page.waitForTimeout(150);

  const timeItemHandle = await pickerEl.evaluateHandle((el, targetText) => {
    const items = Array.from(el.querySelectorAll(".react-datepicker__time-list-item"));
    return items.find((item) => (item.textContent || "").trim() === targetText) || null;
  }, timeText);

  const element = timeItemHandle.asElement();
  if (!element) throw new Error(`Time option "${timeText}" could not be located for clicking.`);
  await element.click();
  await timeItemHandle.dispose();
  await page.waitForTimeout(300);

  const finalValue = normalizeSpaces(await input.inputValue());
  if (!finalValue.includes(timeText)) {
    throw new Error(`Failed to set ${testId} to ${timeText}. Current value: "${finalValue}"`);
  }
}

async function replaceUniqueExamIdTag(page, oldTag, newTag) {
  if (!newTag || oldTag === newTag) return;
  if (oldTag) {
    await page.evaluate((tagToRemove) => {
      const chips = Array.from(document.querySelectorAll('[data-testid="bscd-assess-categories-input"] .Select__multi-value'));
      const chip  = chips.find((node) => (node.textContent || "").includes(tagToRemove));
      const remove = chip ? chip.querySelector(".Select__multi-value__remove") : null;
      if (remove) {
        remove.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
        remove.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      }
    }, oldTag);
  }
  const input = page.locator('[data-testid="bscd-assess-categories-input"] input').first();
  await input.fill(newTag);
  await input.press("Enter");
}

async function ensureInternalAdminOpen(page) {
  const secureButton = page.getByRole("button", { name: "Enable Secure Browser" });
  if (!(await secureButton.isVisible().catch(() => false))) {
    await page.getByRole("button", { name: "Internal Admin Options" }).click();
  }
}

async function ensureRadioOptionSelected(container, testId) {
  const option = container.locator(`input[data-testid="${testId}"]`).first();
  await option.waitFor({ state: "attached", timeout: 10000 });
  if (await option.isChecked().catch(() => false)) return;
  await container.locator("label", { hasText: testId }).first().click();
}

async function setQrBasedAttendanceMode(page) {
  await ensureInternalAdminOpen(page);
  const container = page.locator('[data-testid="ao-qr-code-option"]');
  if (!(await container.locator("label", { hasText: "During Exam" }).first().isVisible().catch(() => false))) {
    await container.getByRole("button", { name: "Enable QR Based Attendance" }).click();
  }
  await ensureRadioOptionSelected(container, "During Exam");
}

async function setExamPinMode(page) {
  await ensureInternalAdminOpen(page);
  const container = page.locator('[data-testid="ao-pin-to-start-enable-option"]');
  if (!(await container.locator("label", { hasText: "Common Start PIN" }).first().isVisible().catch(() => false))) {
    await container.getByRole("button", { name: "Enable Exam PIN" }).click();
  }
  await ensureRadioOptionSelected(container, "Common Start PIN");
}

async function openSampleAndReadMetadata(page, sampleConfigLink, onLog) {
  const viewLink = normalizeSampleViewLink(sampleConfigLink);
  onLog(`Opening config: ${viewLink}`);
  await page.goto(viewLink, { waitUntil: "domcontentloaded" });
  await waitForPageSettled(page);

  if (page.url().includes("accounts.ccbp.in/login")) {
    throw new Error("Redirected to the login page while opening the config link — session expired.");
  }

  await page.waitForTimeout(1500);
  const bodyText = await page.locator("body").textContent().catch(() => "");
  if ((bodyText || "").includes("Invalid Link") || (bodyText || "").includes("Go to Home")) {
    throw new Error(`Config link is invalid or inaccessible: "${sampleConfigLink}"`);
  }

  await cloneActionLocator(page).waitFor({ timeout: 30000 });

  const sampleTag  = await getLabeledValue(page, "Tags");
  const accessType = await detectAccessType(page);
  return { sampleTag, accessType };
}

async function cloneAssessment(page) {
  await cloneActionLocator(page).click();
  await page.waitForURL(/create-assessment|edit-assessment/, { timeout: 30000 });
  await saveAndNextLocator(page).click();
  await page.waitForURL(/edit-assessment/, { timeout: 30000 });
  await page.locator('input[placeholder="Enter Assessment Name"]').waitFor({ timeout: 30000 });
  return page.url();
}

async function publishAssessment(page, accessType) {
  await saveAndNextLocator(page).click();
  await publishAssessmentLocator(page).waitFor({ timeout: 30000 });
  await publishAssessmentLocator(page).click();

  const accessChoice = accessType === "Public" ? "Public" : "Private";
  await page.locator("div").filter({ hasText: new RegExp(`^${accessChoice}`) }).first().click();
  await page.getByRole("button", { name: "Yes, I agree" }).click();
  const copyLinkButton = page.getByRole("button", { name: "Copy Link" });
  await copyLinkButton.waitFor({ timeout: 60000 });

  // The invite API needs org_id from this link, so try hard to capture it —
  // clipboard read fails silently in some headless setups, so fall back to
  // scanning the page DOM for it before giving up.
  try {
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: BASE_URL });
    await copyLinkButton.click();
    const clip = await page.evaluate(async () => navigator.clipboard.readText());
    if (clip && clip.includes("org_id=")) return clip.trim();
  } catch { /* fall through to DOM scan */ }

  const scanned = await page.evaluate(() => {
    for (const el of document.querySelectorAll("input")) {
      if (el.value && el.value.includes("org_id=")) return el.value;
    }
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const t = (node.textContent || "").trim();
      if (t.includes("org_id=") && t.includes("assessment.topin.tech")) return t;
    }
    return "";
  }).catch(() => "");

  return scanned || "";
}

// ── Main entry point ────────────────────────────────────────────
async function cloneAndPublish(page, opts, onLog = () => {}) {
  const { sampleConfigLink, title, uniqueExamId, startDate, endDate } = opts;

  const sample = await openSampleAndReadMetadata(page, sampleConfigLink, onLog);

  onLog("Cloning sample assessment...");
  const newConfigLink = await cloneAssessment(page);

  onLog("Setting assessment name...");
  await page.locator('input[placeholder="Enter Assessment Name"]').fill(title);

  onLog("Setting tag...");
  await replaceUniqueExamIdTag(page, sample.sampleTag, uniqueExamId);

  onLog("Setting start date & time...");
  await setDateTimeField(page, "bscd-start-date-time-input", startDate);

  onLog("Setting end date & time...");
  await setDateTimeField(page, "bscd-end-date-time-input", endDate);

  // Exit PIN is intentionally left untouched — keep whatever the cloned
  // sample config already has instead of generating/setting a new one.
  onLog("Confirming QR attendance / exam PIN mode...");
  await setQrBasedAttendanceMode(page);
  await setExamPinMode(page);

  onLog("Publishing...");
  const assessmentLink = await publishAssessment(page, sample.accessType);

  return {
    newConfigLink,
    assessmentLink: assessmentLink || newConfigLink.replace("/edit-assessment/", "/view-assessment/"),
  };
}

module.exports = { cloneAndPublish, buildDate, BASE_URL };
