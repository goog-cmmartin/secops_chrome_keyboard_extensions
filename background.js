/**
 * Google SecOps Extension - Background Service Worker
 * Manages tab querying, fast switching, and tab history across windows.
 */

let secopsTabHistory = [];

/**
 * Normalizes and checks if a URL belongs to Google SecOps / Chronicle
 */
function isSecOpsUrl(url) {
  if (!url) return false;
  return url.includes('backstory.chronicle.security') ||
         url.includes('chronicle.security') ||
         url.includes('secops.google.com');
}

/**
 * Tracks tab activation to maintain a recency stack for quick-switch (SecOps Alt+Tab)
 */
chrome.tabs.onActivated.addListener((activeInfo) => {
  chrome.tabs.get(activeInfo.tabId, (tab) => {
    if (chrome.runtime.lastError || !tab) return;
    if (isSecOpsUrl(tab.url)) {
      secopsTabHistory = [activeInfo.tabId, ...secopsTabHistory.filter(id => id !== activeInfo.tabId)].slice(0, 20);
    }
  });
});

/**
 * Clean up tab history on tab removal
 */
chrome.tabs.onRemoved.addListener((tabId) => {
  secopsTabHistory = secopsTabHistory.filter(id => id !== tabId);
});

/**
 * Message dispatcher
 */
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (!request || !request.action) return;

  switch (request.action) {
    case 'GET_SECOPS_TABS': {
      chrome.tabs.query({}, (tabs) => {
        if (chrome.runtime.lastError) {
          sendResponse({ tabs: [] });
          return;
        }

        const currentSenderTabId = sender.tab ? sender.tab.id : null;

        const secopsTabs = tabs
          .filter(t => isSecOpsUrl(t.url))
          .map(t => {
            let section = 'SecOps';
            try {
              const parsed = new URL(t.url);
              const path = parsed.pathname;
              if (path.includes('/cases/')) {
                const match = path.match(/\/cases\/([0-9a-zA-Z_-]+)/);
                section = match ? `Case ${match[1]}` : 'Cases';
              } else if (path.includes('/search')) {
                section = 'UDM Search';
              } else if (path.includes('/rules')) {
                section = 'Rules & Detections';
              } else if (path.includes('/dashboards')) {
                section = 'Dashboards';
              } else if (path.includes('/settings')) {
                section = 'Settings';
              } else if (path.includes('/marketplace')) {
                section = 'Marketplace';
              } else if (path.includes('/workdesk')) {
                section = 'Workdesk';
              }
            } catch (e) {
              section = 'SecOps';
            }

            return {
              id: t.id,
              title: t.title || 'Google SecOps',
              url: t.url,
              section: section,
              isCurrentTab: t.id === currentSenderTabId,
              windowId: t.windowId,
              favIconUrl: t.favIconUrl
            };
          });

        sendResponse({ tabs: secopsTabs });
      });
      return true; // Asynchronous response
    }

    case 'SWITCH_TO_TAB': {
      if (request.tabId) {
        chrome.tabs.update(request.tabId, { active: true }, (tab) => {
          if (tab && tab.windowId) {
            chrome.windows.update(tab.windowId, { focused: true });
          }
          sendResponse({ success: true });
        });
      } else {
        sendResponse({ success: false, error: 'No tabId provided' });
      }
      return true;
    }

    case 'SWITCH_TO_PREVIOUS_TAB': {
      const currentTabId = sender.tab ? sender.tab.id : null;
      const targetTabId = secopsTabHistory.find(id => id !== currentTabId);

      if (targetTabId) {
        chrome.tabs.get(targetTabId, (tab) => {
          if (chrome.runtime.lastError || !tab) {
            secopsTabHistory = secopsTabHistory.filter(id => id !== targetTabId);
            sendResponse({ success: false, reason: 'Tab no longer exists' });
          } else {
            chrome.tabs.update(targetTabId, { active: true });
            chrome.windows.update(tab.windowId, { focused: true });
            sendResponse({ success: true, tabTitle: tab.title, section: tab.url });
          }
        });
      } else {
        sendResponse({ success: false, reason: 'No other active SecOps tabs in history' });
      }
      return true;
    }

    case 'CLOSE_TAB': {
      if (request.tabId) {
        chrome.tabs.remove(request.tabId, () => {
          sendResponse({ success: true });
        });
      } else {
        sendResponse({ success: false });
      }
      return true;
    }

    default:
      break;
  }
});
