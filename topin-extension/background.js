// Background service worker — routes messages between the Academy Nexus page (via
// externally_connectable) and the content script running in the Topin tab it opens.
"use strict";

// tabId -> { sendResponse, kind: "clone" | "publish" }
const pending = {};
// tabId -> the clone payload, kept until the content script signals it's ready to receive it
const jobPayloads = {};

// ── From the Academy Nexus page ────────────────────────────────
chrome.runtime.onMessageExternal.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "PING") {
    sendResponse({ ok: true, version: chrome.runtime.getManifest().version });
    return false;
  }

  if (msg?.type === "CLONE") {
    chrome.tabs.create({ url: msg.payload.sampleConfigLink }, (tab) => {
      jobPayloads[tab.id] = msg.payload;
      pending[tab.id] = { sendResponse, kind: "clone" };
    });
    return true; // async response
  }

  if (msg?.type === "PUBLISH") {
    const tabId = msg.payload?.tabId;
    if (!tabId) { sendResponse({ ok: false, error: "No tab to publish from — clone first." }); return false; }
    pending[tabId] = { sendResponse, kind: "publish" };
    chrome.tabs.sendMessage(tabId, { type: "RUN_PUBLISH" }).catch((e) => {
      delete pending[tabId];
      sendResponse({ ok: false, error: `Could not reach the review tab: ${e.message}` });
    });
    return true;
  }

  if (msg?.type === "FOCUS_TAB") {
    const tabId = msg.payload?.tabId;
    if (tabId) chrome.tabs.update(tabId, { active: true }).catch(() => {});
    sendResponse({ ok: true });
    return false;
  }

  return false;
});

// ── From the content script running in the Topin tab ──────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const tabId = sender.tab?.id;
  if (!tabId) return false;

  if (msg?.type === "CS_READY") {
    const payload = jobPayloads[tabId];
    if (payload) chrome.tabs.sendMessage(tabId, { type: "RUN_CLONE", payload }).catch(() => {});
    sendResponse({});
    return false;
  }

  if (msg?.type === "CLONE_DONE" || msg?.type === "CLONE_ERROR") {
    const job = pending[tabId];
    delete jobPayloads[tabId];
    delete pending[tabId];
    if (job) {
      job.sendResponse(
        msg.type === "CLONE_DONE"
          ? { ok: true, tabId, editLink: msg.result.editLink }
          : { ok: false, error: msg.error }
      );
    }
    sendResponse({});
    return false;
  }

  if (msg?.type === "PUBLISH_DONE" || msg?.type === "PUBLISH_ERROR") {
    const job = pending[tabId];
    delete pending[tabId];
    if (job) {
      job.sendResponse(
        msg.type === "PUBLISH_DONE"
          ? { ok: true, assessmentLink: msg.result.assessmentLink }
          : { ok: false, error: msg.error }
      );
    }
    sendResponse({});
    return false;
  }

  return false;
});

// If the Topin tab is closed mid-flow, don't leave the app waiting forever.
chrome.tabs.onRemoved.addListener((tabId) => {
  const job = pending[tabId];
  if (job) {
    job.sendResponse({ ok: false, error: "The Topin tab was closed before finishing." });
    delete pending[tabId];
  }
  delete jobPayloads[tabId];
});
