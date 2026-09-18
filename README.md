# Sieve Editor

Desktop editor for **Cyrus Sieve** scripts on a ManageSieve-compatible server. The point is to list, edit, save, activate, and delete scripts against live ManageSieve — with syntax highlighting — without standing up a web server or copying the old AGPL app.

- Protocol: [RFC 5804](https://datatracker.ietf.org/doc/html/rfc5804) (ManageSieve)
- Language: [RFC 5228](https://datatracker.ietf.org/doc/html/rfc5228) (Sieve)
- Sibling tree `sieve-old` (thsmi/sieve) is a **protocol and UX reference only**. Do not copy that code.

This is **not** SvelteKit. Browsers cannot speak ManageSieve (raw TCP). Electron’s **main process** owns the socket.

## Architecture

```mermaid
flowchart LR
  Renderer["Renderer Svelte plus CodeMirror"] -->|"IPC preload"| Main["Electron main"]
  Main -->|"STARTTLS plus SASL"| Timsieved["Cyrus timsieved 4190"]
  Timsieved --> Store["User sieve scripts"]
  Main --> Sqlite["SQLite userData"]
```

| Piece | Where |
| --- | --- |
| Window, IPC, session | [`src/main/index.ts`](src/main/index.ts) |
| ManageSieve client | [`src/main/managesieve.ts`](src/main/managesieve.ts) |
| SQLite / accounts | [`src/main/db/`](src/main/db/) |
| Preload `contextBridge` | [`src/preload/index.ts`](src/preload/index.ts) |
| Login, list, editor | [`src/renderer/src/App.svelte`](src/renderer/src/App.svelte) |

Main uses `contextIsolation: true` and `nodeIntegration: false`. The renderer never gets `net` / `tls`. One TCP session per logged-in account. IPC: `list`, `get`, `put`, `activate`, `delete`, `check`.

Cyrus allows **one active script**. Syntax errors come back as `NO "line N: …"`. Script bodies use ManageSieve literals (`{n+}` / `{n}`).

Host and port are editable (default port **4190**, Cyrus `timsieved`). SASL **PLAIN** and **LOGIN**. STARTTLS when the server offers it. TLS verification uses the OS trust store, not Node’s Mozilla bundle; login can skip verify or allow plaintext as a fallback.

## Local data

No MySQL. Drizzle ORM + **better-sqlite3** in main only.

- File: `sieve.sqlite` under Electron `app.getPath('userData')` (not in this repo)
- Tables: `accounts` (host, port, user, TLS prefs, last script — one row per server+user), `settings` (window bounds, last account, indent)
- Passwords: `safeStorage.encryptString` (Windows DPAPI), ciphertext in SQLite — never plaintext, never committed
- Migrations: [`drizzle/`](drizzle/) — applied on startup

Scripts stay on Cyrus. SQLite is not a backup of script bodies.

## Dev / package

Electron 43+ does **not** download its binary in npm `postinstall`. This repo’s `postinstall` runs `node ./node_modules/electron/install.js` then rebuilds native modules. If you see `Error: Electron uninstall`, the zip was not extracted — run that install script again.

```bash
cd sieve-editor
pnpm.cmd install
pnpm.cmd dev
```

Windows installer:

```bash
pnpm.cmd run build:win
```

Unpackaged dir only: `pnpm.cmd run build:unpack`. Linux locally: `pnpm.cmd run build:linux` (AppImage + .deb).

## Release

Ship from a **clean `develop`** that matches **`origin/develop`**:

```bash
cd sieve-editor
pnpm release
```

Optional version bump first (`package.json` is currently **0.3.0**):

```bash
pnpm release -- --bump patch

pnpm release -- --bump minor

pnpm release -- --bump major
```

The script fails unless the current branch is `develop` and it matches `origin/develop`. If `origin/main` has commits that are not in `develop` (for example a previous merge commit), it merges `main` into `develop` first. After the Release PR is merged, it fast-forwards `develop` to `main` so **both branches are the same commit**, tags `vX.Y.Z`, and GitHub Actions **publishes** the GitHub Release (not a draft) with binaries, then writes **release notes from commits since the previous tag**. Creating that GitHub Release locally first will block the upload.

| Platform | Installer | Portable |
| --- | --- | --- |
| Windows | NSIS `sieve-editor-*-setup.exe` | `sieve-editor-*-portable.exe` |
| Linux | `.deb` | AppImage |

Linux artifacts are built on Ubuntu runners; they are not tested on a local Linux desktop. macOS is not in this flow (no signing/notarization). `gh` must be logged in (`gh auth login -p ssh`).

Packaged builds check GitHub Releases on startup (and when you click the version next to the app name). If a newer **published** release exists, the app asks whether to update. **NSIS** and **AppImage** apply the installer in-app; **portable** replaces its own `.exe`; **.deb** opens the GitHub download page. Draft or empty GitHub Releases are invisible to the updater. Builds are unsigned, so Windows may still warn on SmartScreen.

The Windows setup wizard asks where to install (not one-click). Shortcut and window title are **Sieve Editor**, with the version next to the name.

UI notes:

- Script list: **include tree** from the active script (RFC 6609); unused scripts below
- CodeMirror 6 + `@codemirror/legacy-modes` sieve mode; keywords from CAPABILITY `SIEVE`
- Debounced server syntax check (~500ms): `CHECKSCRIPT` when advertised, otherwise PUTSCRIPT/DELETESCRIPT (RFC 5804 fallback). Local checks: unclosed strings, unmatched `[]` `()` `{}`, missing `,` in lists, missing `;` after commands.
- Multiple servers/accounts: saved list on connect; **Disconnect** returns there. Socket drop stays in the editor with **Connect**.
- Save limit **50K** (`sieve_maxscriptsize`)
- Script lifecycle: **Save** stays on the toolbar (**Ctrl+S** / **Cmd+S**). **Actions** menu: new, format (re-indent with the configured tab/spaces), duplicate, rename, activate (confirms; refuses syntax errors; unsaved buffers must be saved first), delete, export/import `.sieve` files. Import stays local until Save. Rename is put + optional setactive + delete.

## Out of scope

Graphical block editor, GSSAPI/Kerberos, a browser-facing HTTP proxy, copying sieve-old, macOS packages.

## Plans

Original implementation notes live in [`docs/plans/`](docs/plans/). Start with this README for how the app works now.
