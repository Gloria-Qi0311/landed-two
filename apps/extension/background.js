// background.js — service worker for side panel
// Opens the side panel when the extension icon is clicked

chrome.action.onClicked.addListener(async (tab) => {
  await chrome.sidePanel.open({ windowId: tab.windowId });
});
