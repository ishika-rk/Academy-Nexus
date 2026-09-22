// Runs on every config.topin.tech page. Drives the real Topin UI to clone a config,
// fill in name/tag/schedule, save it (so it's reviewable at its own URL), and — on a
// later separate command — publish it. Ported from the IOE Admin Portal's Playwright
// automation (server/topin-clone.js, itself from github.com/saidineshsimhadri/topin-cloner)
// to plain DOM calls, since a content script has no Playwright runtime available.
//
// The clone → fill → Save & Next → Final Review sequence and every selector below (button
// text, data-testid names, react-datepicker structure) were verified 2026-09-22 against the
// real production Topin site with a Playwright script driving the exact same steps — see
// project-topin-automation memory. What's NOT yet verified is this specific file: a content
// script drives the page via plain dispatched DOM events instead of Playwright's automation
// engine, which is a real, if small, behavioral gap (React sometimes treats synthetic events
// differently). The first real run of the installed extension is the actual test of that.
//
// One confirmed quirk to know about: reopening a saved config's URL completely fresh (a new
// tab, not the one this script leaves open) lands on step 3 "Publish & Invite" by default,
// not step 2 "Final Review" — Topin remembers the furthest step reached. runClone() below
// already handles this by clicking back to "Final Review" before returning, so the tab it
// hands back is on the right page; it only matters if someone reopens the link separately.
"use strict";

const MONTH_NAMES = ["January","February","March","April","May","June","July","August","September","October","November","December"];
const TIME_INTERVAL_MINUTES = 5;

function normalizeSpaces(v) { return String(v || "").replace(/\s+/g, " ").trim(); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function waitFor(fn, { timeout = 20000, interval = 200, desc = "" } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const v = fn();
    if (v) return v;
    await sleep(interval);
  }
  throw new Error(`Timed out waiting for: ${desc || "condition"}`);
}

function findButtonByText(regex) {
  return Array.from(document.querySelectorAll("button, a, [role=\"button\"]"))
    .find((el) => regex.test(normalizeSpaces(el.textContent)));
}
function waitForButtonByText(regex, opts) {
  return waitFor(() => findButtonByText(regex), { desc: `button matching ${regex}`, ...opts });
}

// React controlled inputs ignore a plain `.value =` assignment — go through the native
// setter so React's change handler actually fires.
function setNativeValue(el, value) {
  const proto = el.tagName === "TEXTAREA" ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
  setter.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}
function clickEl(el) {
  el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
  el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  el.click();
}

function floorDateToInterval(date, minutes = TIME_INTERVAL_MINUTES) {
  const d = new Date(date.getTime());
  d.setMinutes(Math.floor(d.getMinutes() / minutes) * minutes, 0, 0);
  return d;
}
function formatTimeSlot(date) {
  const h = date.getHours(), m = date.getMinutes();
  const period = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 || 12;
  return `${h12}:${String(m).padStart(2, "0")} ${period}`;
}
function formatMonthYear(date) { return `${MONTH_NAMES[date.getMonth()]} ${date.getFullYear()}`; }
function ordinalSuffix(day) {
  if (day >= 11 && day <= 13) return "th";
  const last = day % 10;
  return last === 1 ? "st" : last === 2 ? "nd" : last === 3 ? "rd" : "th";
}
function buildDateAriaLabel(date) {
  // react-datepicker labels each day button "Choose <Weekday>, <Month> <Day><suffix>, <Year>"
  const weekday = date.toLocaleDateString("en-US", { weekday: "long" });
  return `Choose ${weekday}, ${MONTH_NAMES[date.getMonth()]} ${date.getDate()}${ordinalSuffix(date.getDate())}, ${date.getFullYear()}`;
}

async function ensureMonth(picker, targetDate) {
  const targetMonthYear = formatMonthYear(targetDate);
  for (let attempt = 0; attempt < 24; attempt++) {
    const cur = normalizeSpaces(picker.querySelector(".react-datepicker__current-month")?.textContent || "");
    if (cur === targetMonthYear) return;
    const [curMonthName, curYearText] = cur.split(" ");
    const curKey = Number(curYearText) * 12 + MONTH_NAMES.indexOf(curMonthName);
    const targetKey = targetDate.getFullYear() * 12 + targetDate.getMonth();
    const btn = picker.querySelector(
      curKey < targetKey
        ? 'button[aria-label="Next Month"], .react-datepicker__navigation--next'
        : 'button[aria-label="Previous Month"], .react-datepicker__navigation--previous'
    );
    if (!btn) throw new Error("Could not find month navigation button in the date picker");
    clickEl(btn);
    await sleep(150);
  }
  throw new Error(`Unable to navigate date picker to ${targetMonthYear}`);
}

async function setDateTimeField(testId, targetDate) {
  const normalized = floorDateToInterval(targetDate);
  const wrapper = document.querySelector(`[data-testid="${testId}"]`);
  if (!wrapper) throw new Error(`Field "${testId}" not found on the page`);
  const input = wrapper.querySelector('input[placeholder="Select Date & Time"]');
  if (!input) throw new Error(`Date input not found inside "${testId}"`);
  clickEl(input);

  const picker = await waitFor(() => {
    const all = document.querySelectorAll(".react-datepicker");
    return all.length ? all[all.length - 1] : null;
  }, { desc: "date picker to open" });

  await ensureMonth(picker, normalized);

  const dateLabel = buildDateAriaLabel(normalized);
  const dateBtn = await waitFor(
    () => Array.from(picker.querySelectorAll("[role=\"button\"], button"))
      .find((b) => normalizeSpaces(b.getAttribute("aria-label") || b.textContent) === dateLabel),
    { desc: `date button "${dateLabel}"` }
  );
  clickEl(dateBtn);
  await sleep(200);

  const timeText = formatTimeSlot(normalized);
  const list = picker.querySelector(".react-datepicker__time-list");
  const items = Array.from(picker.querySelectorAll(".react-datepicker__time-list-item"));
  const idx = items.findIndex((it) => normalizeSpaces(it.textContent) === timeText);
  if (idx === -1 || !list) throw new Error(`Time option "${timeText}" not found in the picker`);
  // Topin disables past times for a same-day date and silently ignores clicks on them —
  // catch that up front instead of a confusing "field shows the wrong thing" error later.
  if (items[idx].className.includes("disabled")) {
    throw new Error(`${normalizeSpaces(input.getAttribute("aria-label") || testId)} of ${timeText} on ${normalizeSpaces(picker.querySelector(".react-datepicker__current-month")?.textContent)} ${normalized.getDate()} has already passed — Topin won't accept a start/end time in the past. Check the exam's date in Exam Details.`);
  }
  list.scrollTop = items[idx].offsetTop;
  await sleep(150);
  clickEl(items[idx]);
  await sleep(300);

  const finalValue = normalizeSpaces(input.value);
  if (!finalValue.includes(timeText)) throw new Error(`Failed to set ${testId} to ${timeText} — field shows "${finalValue}"`);
}

async function fillTag(tag) {
  const input = document.querySelector('[data-testid="bscd-assess-categories-input"] input');
  if (!input) throw new Error("Tags field not found");
  clickEl(input);
  setNativeValue(input, tag);
  await sleep(200);
  input.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter", code: "Enter", keyCode: 13 }));
  await sleep(200);
}

// ── Clone: open the sample, clone it, fill in the new details, save. Stops on the
// saved config's own page (its URL doesn't change across Topin's steps) so it can be
// reviewed before anyone publishes it. ──────────────────────────────────────────
async function runClone({ title, tag, startDate, startTime, endDate, endTime }) {
  const cloneBtn = await waitForButtonByText(/clone/i, { timeout: 30000 });
  clickEl(cloneBtn);

  await waitFor(() => /create-assessment|edit-assessment/.test(location.pathname), { timeout: 30000, desc: "clone to open" });
  const saveNext1 = await waitForButtonByText(/^save\s*&\s*next$/i, { timeout: 30000 });
  clickEl(saveNext1);
  await waitFor(() => /edit-assessment/.test(location.pathname), { timeout: 30000, desc: "cloned config page" });

  const nameInput = await waitFor(() => document.querySelector('input[placeholder="Enter Assessment Name"]'), { timeout: 30000, desc: "assessment name field" });
  setNativeValue(nameInput, title);
  await fillTag(tag);

  const sd = new Date(`${startDate}T${startTime}:00`);
  const ed = new Date(`${endDate}T${endTime}:00`);
  await setDateTimeField("bscd-start-date-time-input", sd);
  await setDateTimeField("bscd-end-date-time-input", ed);

  // The only way Topin persists these fields is clicking Save & Next, which also advances
  // the step indicator — so click back to "Final Review" afterwards to leave the tab on a
  // reviewable, already-saved page rather than mid-flow toward Publish & Invite.
  const saveNext2 = await waitForButtonByText(/^save\s*&\s*next$/i, { timeout: 20000 });
  clickEl(saveNext2);
  await sleep(1500);
  const finalReviewTab = findButtonByText(/final review/i);
  if (finalReviewTab) { clickEl(finalReviewTab); await sleep(800); }

  return { editLink: location.href };
}

// ── Publish: only called explicitly, from the same tab the clone left open/reviewed. ──
async function runPublish() {
  const saveNext = findButtonByText(/^save\s*&\s*next$/i);
  if (saveNext) { clickEl(saveNext); await sleep(1000); }

  const publishBtn = await waitForButtonByText(/^publish assessment$/i, { timeout: 30000 });
  clickEl(publishBtn);
  await sleep(800);

  // The confirmation dialog's Access Type radios (Public/Private) come pre-selected — Private
  // by default, matching how these assessments are actually used — so there's nothing to pick
  // here. (An earlier attempt tried to find-and-click one by matching its heading text, but
  // Topin's markup runs the heading and its description together as one text blob, which broke
  // that match — confirmed against the real dialog 2026-09-23. Leaving the default alone avoids
  // that fragile match entirely; it only becomes wrong if a sample config is meant to publish
  // Public, which isn't how these have been used so far.)
  const agreeBtn = await waitForButtonByText(/yes,?\s*i agree/i, { timeout: 15000 });
  clickEl(agreeBtn);

  const copyBtn = await waitForButtonByText(/^copy link$/i, { timeout: 60000 });
  clickEl(copyBtn);
  await sleep(500);

  let link = "";
  try {
    const clip = (await navigator.clipboard.readText()) || "";
    if (clip.includes("org_id=")) link = clip.trim();
  } catch { /* clipboard read blocked — fall through to a DOM scan */ }

  if (!link) {
    for (const el of document.querySelectorAll("input")) {
      if (el.value?.includes("org_id=")) { link = el.value; break; }
    }
  }
  if (!link) {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const t = (node.textContent || "").trim();
      if (t.includes("org_id=") && t.includes("assessment.topin.tech")) { link = t; break; }
    }
  }

  return { assessmentLink: link };
}

chrome.runtime.sendMessage({ type: "CS_READY" });

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "RUN_CLONE") {
    runClone(msg.payload)
      .then((result) => chrome.runtime.sendMessage({ type: "CLONE_DONE", result }))
      .catch((err) => chrome.runtime.sendMessage({ type: "CLONE_ERROR", error: err.message }));
  }
  if (msg?.type === "RUN_PUBLISH") {
    runPublish()
      .then((result) => chrome.runtime.sendMessage({ type: "PUBLISH_DONE", result }))
      .catch((err) => chrome.runtime.sendMessage({ type: "PUBLISH_ERROR", error: err.message }));
  }
});
