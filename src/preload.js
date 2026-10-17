const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('mj', {
  getState: () => ipcRenderer.invoke('state:get'),
  saveGame: (id, patch) => ipcRenderer.invoke('game:save', id, patch),
  saveRun: (id, patch) => ipcRenderer.invoke('run:save', id, patch),
  savePrep: (id, prep) => ipcRenderer.invoke('run:prep', id, prep),
  completeReview: (entry) => ipcRenderer.invoke('review:complete', entry),
  addLiveNote: (entry) => ipcRenderer.invoke('live:add', entry),
  deleteGame: (id) => ipcRenderer.invoke('game:delete', id),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  exportMarkdown: () => ipcRenderer.invoke('journal:export'),
  getCalibration: () => ipcRenderer.invoke('calibrate:get'),
  finishCalibration: (rect) => ipcRenderer.send('calibrate:done', rect),
  cancelCalibration: () => ipcRenderer.send('calibrate:cancel'),
  startCalibration: () => ipcRenderer.send('calibrate:start'),
  openGate: () => ipcRenderer.send('gate:open'),
  hideGate: () => ipcRenderer.send('gate:hide'),
  openJournal: () => ipcRenderer.send('journal:open'),
  openJournalFolder: () => ipcRenderer.send('journal:folder'),
  focusMtga: () => ipcRenderer.send('mtga:focus'),
  setNotepadCollapsed: (collapsed) => ipcRenderer.send('notepad:collapse', collapsed),
  simulateGame: () => ipcRenderer.send('dev:simulate'),
  simulateTurn: () => ipcRenderer.send('dev:turn'),
  setPaused: (paused) => ipcRenderer.send('lock:pause', paused),
  onChange: (cb) => {
    const listener = () => cb();
    ipcRenderer.on('state:changed', listener);
    return () => ipcRenderer.removeListener('state:changed', listener);
  },
});
