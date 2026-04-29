const ALLOWED_ORIGIN = "https://yue.haofenshu.com/";
const SIDE_PANEL_PATH = "sidepanel.html";

function isAllowedUrl(url) {
  return typeof url === "string" && url.startsWith(ALLOWED_ORIGIN);
}

async function configureSidePanel() {
  if (!chrome.sidePanel?.setPanelBehavior) {
    return;
  }

  if (chrome.sidePanel?.setOptions) {
    try {
      await chrome.sidePanel.setOptions({
        enabled: false
      });
    } catch (error) {
      console.warn("Failed to disable the default side panel.", error);
    }
  }

  try {
    await chrome.sidePanel.setPanelBehavior({
      openPanelOnActionClick: true
    });
  } catch (error) {
    console.warn("Failed to configure side panel behavior.", error);
  }
}

async function updateSidePanelForTab(tabId, url) {
  if (!chrome.sidePanel?.setOptions || typeof tabId !== "number") {
    return;
  }

  const enabled = isAllowedUrl(url);

  try {
    if (enabled) {
      await chrome.sidePanel.setOptions({
        tabId,
        path: SIDE_PANEL_PATH,
        enabled: true
      });
      return;
    }

    await chrome.sidePanel.setOptions({
      tabId,
      enabled: false
    });
  } catch (error) {
    console.warn("Failed to update side panel options.", error);
  }
}

async function refreshCurrentWindowTabs() {
  try {
    const tabs = await chrome.tabs.query({});
    await Promise.all(tabs.map((tab) => updateSidePanelForTab(tab.id, tab.url)));
  } catch (error) {
    console.warn("Failed to refresh side panel availability.", error);
  }
}

chrome.runtime.onInstalled.addListener(() => {
  void configureSidePanel();
  void refreshCurrentWindowTabs();
});

chrome.runtime.onStartup.addListener(() => {
  void configureSidePanel();
  void refreshCurrentWindowTabs();
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url || changeInfo.status === "complete") {
    void updateSidePanelForTab(tabId, tab.url ?? changeInfo.url);
  }
});

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const tab = await chrome.tabs.get(tabId);
    await updateSidePanelForTab(tabId, tab.url);
  } catch (error) {
    console.warn("Failed to refresh active tab side panel state.", error);
  }
});
