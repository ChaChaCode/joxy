const { contextBridge, ipcRenderer } = require('electron');
const invoke = (name, ...args) => ipcRenderer.invoke(`joxy:${name}`, ...args).then((result) => {
  if (!result.ok) throw new Error(result.error || 'Не удалось выполнить действие.');
  return result.value;
});
contextBridge.exposeInMainWorld('joxy', Object.freeze({
  state: () => invoke('state'),
  import: (value) => invoke('import', value),
  importFile: () => invoke('import-file'),
  refresh: (id) => invoke('refresh', id),
  openProvider: (id, kind) => invoke('open-provider', id, kind),
  select: (id) => invoke('select', id),
  connect: () => invoke('connect'),
  disconnect: () => invoke('disconnect'),
  test: (id) => invoke('test', id),
  settings: (patch) => invoke('settings', patch),
  elevate: (patch, options) => invoke('elevate', patch, options),
  environment: () => invoke('environment'),
  exportDiagnostics: () => invoke('export-diagnostics'),
  minimize: () => invoke('minimize'),
  close: () => invoke('close'),
  onState: (callback) => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('joxy:state', listener);
    return () => ipcRenderer.removeListener('joxy:state', listener);
  },
}));
