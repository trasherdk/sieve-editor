import { contextBridge, ipcRenderer } from 'electron'
import type { AccountInput, SieveApi } from '../shared/types'

const api: SieveApi = {
  ping: () => ipcRenderer.invoke('ping'),
  accounts: {
    list: () => ipcRenderer.invoke('accounts:list'),
    save: (input: AccountInput) => ipcRenderer.invoke('accounts:save', input),
    remove: (id: number) => ipcRenderer.invoke('accounts:remove', id)
  },
  sieve: {
    connect: (input: AccountInput) => ipcRenderer.invoke('sieve:connect', input),
    disconnect: () => ipcRenderer.invoke('sieve:disconnect'),
    list: () => ipcRenderer.invoke('sieve:list'),
    snapshot: () => ipcRenderer.invoke('sieve:snapshot'), // bodies for include tree
    get: (name: string) => ipcRenderer.invoke('sieve:get', name),
    put: (name: string, body: string) => ipcRenderer.invoke('sieve:put', name, body),
    activate: (name: string) => ipcRenderer.invoke('sieve:activate', name),
    deactivate: () => ipcRenderer.invoke('sieve:deactivate'),
    delete: (name: string) => ipcRenderer.invoke('sieve:delete', name),
    check: (body: string) => ipcRenderer.invoke('sieve:check', body),
    capabilities: () => ipcRenderer.invoke('sieve:capabilities')
  }
}

contextBridge.exposeInMainWorld('api', api)
