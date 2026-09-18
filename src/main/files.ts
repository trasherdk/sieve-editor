import { dialog, type BrowserWindow } from 'electron'
import { readFile, writeFile } from 'node:fs/promises'
import { basename, extname } from 'node:path'
import { MAX_SCRIPT_BYTES } from '../shared/types'
import type { FileExportResult, FileImportResult } from '../shared/types'

const FILTERS = [
  { name: 'Sieve scripts', extensions: ['sieve', 'siv'] },
  { name: 'Text', extensions: ['txt'] },
  { name: 'All files', extensions: ['*'] }
]

function parent(win: BrowserWindow | null): BrowserWindow | undefined {
  return win && !win.isDestroyed() ? win : undefined
}

export async function exportScriptFile(
  win: BrowserWindow | null,
  suggestedName: string,
  content: string
): Promise<FileExportResult> {
  const base = suggestedName.trim() || 'script'
  const defaultPath = /\.(sieve|siv|txt)$/i.test(base) ? base : `${base}.sieve`
  const options = {
    title: 'Export Sieve script',
    defaultPath,
    filters: FILTERS
  }
  const host = parent(win)
  const result = host
    ? await dialog.showSaveDialog(host, options)
    : await dialog.showSaveDialog(options)
  if (result.canceled || !result.filePath) return { canceled: true }
  await writeFile(result.filePath, content, 'utf8')
  return { canceled: false, path: result.filePath }
}

export async function importScriptFile(win: BrowserWindow | null): Promise<FileImportResult> {
  const options = {
    title: 'Import Sieve script',
    properties: ['openFile' as const],
    filters: FILTERS
  }
  const host = parent(win)
  const result = host
    ? await dialog.showOpenDialog(host, options)
    : await dialog.showOpenDialog(options)
  const filePath = result.filePaths[0]
  if (result.canceled || !filePath) return { canceled: true }
  const buf = await readFile(filePath)
  if (buf.byteLength > MAX_SCRIPT_BYTES) {
    throw new Error(`File is ${buf.byteLength} bytes; server limit is ${MAX_SCRIPT_BYTES} (sieve_maxscriptsize).`)
  }
  const ext = extname(filePath)
  const name = basename(filePath, ext)
  return { canceled: false, name, content: buf.toString('utf8') }
}
