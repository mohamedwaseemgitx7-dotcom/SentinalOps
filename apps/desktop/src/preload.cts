import { contextBridge, ipcRenderer } from 'electron';

// The only capability the page gets: reading the local one-time setup token on first run.
contextBridge.exposeInMainWorld('sentinelDesktop', {
  getSetupToken: (): Promise<string | null> => ipcRenderer.invoke('sentinel:get-setup-token'),
});
