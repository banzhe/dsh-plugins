# @banzhe/dsh-web-icons

Serves the Web launcher icon set — favicon, PWA manifest, maskable and touch icons — from a snapshot that travels inside this Bundle, instead of the copy that ships inside whichever `@deepseek-ai/dsh-web-frontend` the running harness happens to have.

[中文版](./README.zh-CN.md)

A Host-side [DSH](https://github.com/deepseek-ai/deepseek-harness) Bundle intended for the **web** and **desktop** profiles.

## Features

- Eight `webServer` **exact** routes, registered when the plugin activates:

  | Pathname | Asset |
  |---|---|
  | `/favicon.ico` | `favicon.ico` |
  | `/favicon-dark.svg` | `favicon-dark.svg` |
  | `/icon-192.png` | `icon-192.png` |
  | `/icon-512.png` | `icon-512.png` |
  | `/icon-maskable-192.png` | `icon-maskable-192.png` |
  | `/icon-maskable-512.png` | `icon-maskable-512.png` |
  | `/apple-touch-icon.png` | `apple-touch-icon.png` |
  | `/manifest.webmanifest` | `manifest.webmanifest` |

- An exact route is matched before the fallback seat that serves the built Web directory, so these responses replace the dist's copies rather than competing with them.
- `GET` and `HEAD` are answered; other methods get `405` with `allow: GET, HEAD`.
- Responses carry `cache-control: no-cache` plus a weak validator over the file's size and mtime, so a browser revalidates instead of re-downloading several hundred kilobytes per navigation.
- `favicon.svg` is deliberately not claimed: the DSH source retired that mark and its build test requires the dist not to ship it.
- Runtime conflicts are loud by design — a composition that already registers one of these exact pathnames fails activation with `webserver: duplicate exact route "<path>"`.
- Uninstalling falls back to the dist copies immediately after the Host restarts.

### Where it does not apply

- **The Desktop application window.** The shell answers seven of these eight pathnames for its own `dsh-app://app/` window before any request reaches the Host. `/favicon-dark.svg` is the exception. The browser origin (`DSH_WEB_URL`) is the surface this Bundle is for.
- **Anything outside the page.** The executable, taskbar, tray, installer, macOS Dock and About icons are build-time artifacts of the desktop package; no plugin can reach them.
- **An already-installed PWA shortcut.** Its icon is cached by the operating system. Reinstall the shortcut to pick up new artwork.
- **The in-app sidebar brand mark.** That is a UI slot occupant, not a Web icon.

## Install

### From npm

```sh
dsh plugin --profile web add @banzhe/dsh-web-icons
```

### From a local checkout

```sh
pnpm install
pnpm --filter @banzhe/dsh-web-icons build
dsh plugin --profile web add ./plugins/web-icons
```

`link:` keeps the installed package pointing at this checkout, so a rebuild is enough after a source change. Route registration happens at activation: a newly installed Bundle reaches the Host without a restart on a `live` patch profile, while a rebuilt `lib/` needs one.

The **`desktop` profile is reserved**: a plain `dsh` on `PATH` refuses it with *"profile "desktop" is managed exclusively by the Electron application"*. The Desktop installation carries its own permitted carrier — on Windows, `<install>\resources\runtime\cli\bin\dsh.cmd`:

```powershell
& '<install>\resources\runtime\cli\bin\dsh.cmd' plugin --profile desktop add 'link:D:/path/to/dsh-plugins/plugins/web-icons'
```

The alternative is to add the dependency and the `dsh.profile.bundles` entry to `$DSH_HOME/profiles/desktop/package.json` by hand and run `pnpm install` in that directory. The two profiles do not share a bundle list.

Remove with:

```sh
dsh plugin --profile web remove @banzhe/dsh-web-icons
```

## Docs

Implementation notes: [`docs/plugins/web-icons.md`](https://github.com/banzhe/dsh-plugins/blob/master/docs/plugins/web-icons.md).
