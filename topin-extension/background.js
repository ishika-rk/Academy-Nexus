// Background service worker — routes messages between the Academy Nexus page (via
// externally_connectable) and the content script running in the Topin tab it opens.
"use strict";

// tabId -> { sendResponse, kind: "clone" | "publish" }
const pending = {};
// tabId -> { mode: "clone", payload } | { mode: "publish" } — kept until the content script
// signals it's ready to receive its instruction
const jobPayloads = {};

function tabExists(tabId) {
  return new Promise((resolve) => {
    if (tabId == null) { resolve(false); return; }
    chrome.tabs.get(tabId, (tab) => resolve(!chrome.runtime.lastError && !!tab));
  });
}

// ── From the Academy Nexus page ────────────────────────────────
chrome.runtime.onMessageExternal.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "PING") {
    sendResponse({ ok: true, version: chrome.runtime.getManifest().version });
    return false;
  }

  if (msg?.type === "CLONE") {
    // Background so Clone doesn't yank the person off the Academy Nexus page — they can
    // still watch it via "Open tab" any time.
    chrome.tabs.create({ url: msg.payload.sampleConfigLink, active: false }, (tab) => {
      jobPayloads[tab.id] = { mode: "clone", payload: msg.payload };
      pending[tab.id] = { sendResponse, kind: "clone" };
    });
    return true; // async response
  }

  // Both PUBLISH and FOCUS_TAB target a previously-opened review tab by id. That tab may
  // have been closed since — in which case fall back to reopening the same saved config
  // link fresh (the data was already persisted at clone time, so this still works) instead
  // of failing silently.
  if (msg?.type === "PUBLISH") {
    (async () => {
      const { tabId, fallbackUrl } = msg.payload || {};
      if (tabId != null && (await tabExists(tabId))) {
        pending[tabId] = { sendResponse, kind: "publish" };
        chrome.tabs.sendMessage(tabId, { type: "RUN_PUBLISH" }).catch((e) => {
          delete pending[tabId];
          sendResponse({ ok: false, error: `Could not reach the review tab: ${e.message}` });
        });
        return;
      }
      if (!fallbackUrl) { sendResponse({ ok: false, error: "That review tab was closed, and there's no link to reopen it from — clone again." }); return; }
      chrome.tabs.create({ url: fallbackUrl, active: false }, (tab) => {
        jobPayloads[tab.id] = { mode: "publish" };
        pending[tab.id] = { sendResponse, kind: "publish" };
      });
    })();
    return true;
  }

  if (msg?.type === "FOCUS_TAB") {
    (async () => {
      const { tabId, fallbackUrl } = msg.payload || {};
      if (tabId != null && (await tabExists(tabId))) {
        await chrome.tabs.update(tabId, { active: true }).catch(() => {});
        sendResponse({ ok: true, tabId });
        return;
      }
      if (!fallbackUrl) { sendResponse({ ok: false, error: "That review tab was closed, and there's no link to reopen it from — clone again." }); return; }
      chrome.tabs.create({ url: fallbackUrl }, (tab) => sendResponse({ ok: true, tabId: tab.id, reopened: true }));
    })();
    return true;
  }

  return false;
});

// ── From the content script running in the Topin tab ──────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const tabId = sender.tab?.id;
  if (!tabId) return false;

  if (msg?.type === "CS_READY") {
    const job = jobPayloads[tabId];
    if (job?.mode === "clone") chrome.tabs.sendMessage(tabId, { type: "RUN_CLONE", payload: job.payload }).catch(() => {});
    else if (job?.mode === "publish") chrome.tabs.sendMessage(tabId, { type: "RUN_PUBLISH" }).catch(() => {});
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
