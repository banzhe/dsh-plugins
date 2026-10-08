# @banzhe/dsh-web-icons

Serves the Web launcher icon set — favicon, PWA manifest, maskable and touch icons — from a snapshot that travels inside this Bundle, instead of the copy that ships inside whichever `@deepseek-ai/dsh-web-frontend` the running harness happens to have.

Intended for the `web` and `desktop` profiles.

## What it contributes

Eight `webServer` **exact** routes, registered when the plugin activates:

| Pathname | Asset | `content-type` |
|---|---|---|
| `/favicon.ico` | `favicon.ico` | `image/vnd.microsoft.icon` |
| `/favicon-dark.svg` | `favicon-dark.svg` | `image/svg+xml` |
| `/icon-192.png` | `icon-192.png` | `image/png` |
| `/icon-512.png` | `icon-512.png` | `image/png` |
| `/icon-maskable-192.png` | `icon-maskable-192.png` | `image/png` |
| `/icon-maskable-512.png` | `icon-maskable-512.png` | `image/png` |
| `/apple-touch-icon.png` | `apple-touch-icon.png` | `image/png` |
| `/manifest.webmanifest` | `manifest.webmanifest` | `application/manifest+json` |

An exact route is matched before the fallback seat that serves the built Web directory, so these responses replace the dist's copies rather than competing with them. `GET` and `HEAD` are answered; other methods get `405` with `allow: GET, HEAD`. Responses carry `cache-control: no-cache` plus a weak validator over the file's size and mtime, so a browser revalidates instead of re-downloading several hundred kilobytes per navigation. A revalidation and a HEAD are answered from the file's identity alone — one `stat`, no read — because the maskable pair alone is 322 KB.

`favicon.svg` is deliberately **not** claimed: the DSH source retired that mark and its build test requires the dist not to ship it. `/favicon-dark.svg` is the one row nothing references: it is part of the source artwork, so it is served, but no document asks for it.

## Where it does not apply

- **The Desktop application window.** The shell answers seven of these eight pathnames for its own `dsh-app://app/` window before any request reaches the Host, so those seven change nothing there. `/favicon-dark.svg` is the exception — the shell does not claim it, so this plugin answers it inside the window too. The browser origin (`DSH_WEB_URL`) is the surface this Bundle is for.
- **Anything outside the page.** The executable, taskbar, tray, installer, macOS Dock and About icons are build-time artifacts of the desktop package; no plugin can reach them.
- **An already-installed PWA shortcut.** Its icon is cached by the operating system. Reinstall the shortcut to pick up new artwork.
- **The in-app sidebar brand mark.** That is a UI slot occupant (`sidebar.brand.mark`), not a Web icon.

## Install

```sh
dsh plugin --profile web add link:/path/to/dsh-plugins/plugins/web-icons
```

The `desktop` profile is reserved: a plain `dsh` on `PATH` refuses it with *"profile \"desktop\" is managed exclusively by the Electron application"*. The Desktop installation carries its own permitted carrier — on Windows, `<install>\resources\runtime\cli\bin\dsh.cmd`:

```powershell
& '<install>\resources\runtime\cli\bin\dsh.cmd' plugin --profile desktop add 'link:D:/path/to/dsh-plugins/plugins/web-icons'
```

The alternative is to add the dependency and the `dsh.profile.bundles` entry to `$DSH_HOME/profiles/desktop/package.json` by hand and run `pnpm install` in that directory. The two profiles do not share a bundle list.

`link:` keeps the installed package pointing at this checkout, so `pnpm --filter @banzhe/dsh-web-icons build` is enough after a source change. Route registration happens at activation: a newly installed Bundle reaches the Host without a restart on a `live` patch profile, while a rebuilt `lib/` needs one.

Runtime conflicts are loud by design — a composition that already registers one of these exact pathnames fails activation with `webserver: duplicate exact route "<path>"`. Disable the other owner or this Bundle.

Uninstall with `dsh plugin --profile <name> remove @banzhe/dsh-web-icons`; the paths fall back to the dist copies immediately after the Host restarts.

## Refreshing the snapshot

The assets are a byte-for-byte copy of `apps/web/public` from the DSH source revision this Bundle was built for (see `docs/adr/0010`). To re-sync after the artwork changes, copy that directory over this Bundle's assets — using the checkout's own path, for example:

```powershell
Copy-Item <dsh-checkout>\apps\web\public\* <dsh-plugins>\plugins\web-icons\assets\ -Force
pnpm --filter @banzhe/dsh-web-icons test
pnpm --filter @banzhe/dsh-web-icons build
```

`tests/assets.spec.ts` pins the manifest's shape and every asset's file signature, so a re-sync that changes the icon set fails until the expectation is updated. Nothing pins hashes: replacing artwork is the expected operation, and the validator (size + mtime) is what keeps served bytes and cached bytes in agreement. Copying — rather than editing in place — is what moves the mtime, so a re-sync is visible to a client that already holds the old bytes.
