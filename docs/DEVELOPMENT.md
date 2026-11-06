# LocalSendPlus

A desktop app for sending **files, folders, text and clipboard contents** to other devices — on your local network **and across VPN tunnels / routed subnets** that are reachable through your router.

The UI is modelled on [LocalSend](https://localsend.org) (Material 3, teal accent, left navigation rail, big "File / Folder / Media / Text / Paste" buttons, nearby-devices list, Quick Save). The code is an independent implementation — it speaks the open **LocalSend protocol v2.2** ([spec](https://github.com/localsend/protocol), [reference app](https://github.com/localsend/localsend)) so it can exchange data with LocalSend on Windows, macOS, Linux, Android and iOS.

## What's different from LocalSend

| | LocalSend | LocalSendPlus |
|---|---|---|
| Local LAN discovery (multicast + /24 sweep) | yes | yes — multicast on **every** adapter, plus optional /24 sweep per adapter |
| Devices on a VPN or routed subnet | only if you type each IP | **Networks** tab: saved CIDR / range / IP targets, scanned in parallel, auto-rescanned, labelled per network |
| Find ranges for me | – | reads adapters + routing table (`route print`) and suggests VPN / routed ranges |
| Saved hosts / DNS names | – | re-checked on every scan |
| Device grouping | flat list | grouped by network (Local network, *Branch VPN*, …) with latency badges |
| Folders | yes | yes (recursive, structure preserved, parallel uploads) |
| Text / paste | yes | yes + paste screenshots, copied files, drag & drop |
| PIN | yes | yes (brute-force throttled) — recommended across VPNs |
| Share via link (download API, spec §5) | yes | yes — QR code + per-interface links, optional PIN, approve each browser, auto-stop timer |
| File integrity (`sha256`, HTTP 422) | yes | yes — checksums sent per file (setting: off / ≤ 64 MB / all) and verified on receive |
| File dates (`metadata.modified/accessed`) | yes | yes — preserved on received files (can be turned off) |
| Command line | `localsend-cli` | `localsendplus-cli` — `devices`, `send --to alias\|ip`, `--text`, `receive`, `share` |
| Portable mode | yes | yes — see Editions: folder / single-exe / web, no installation |
| Device name | random alias | defaults to the computer name (editable; clear it to follow the PC name again) |
| Browser UI | – | web edition, usable remotely over LAN / VPN |
| Start with Windows | yes | yes — **Settings → General → Start automatically at start-up** (hidden in the tray) |

### How discovery works beyond the LAN

Multicast never crosses a router, so for anything routable LocalSendPlus **probes addresses** instead:

1. For every enabled range on the **Networks** page it checks TCP `53317` (configurable) on each address, then performs LocalSend's two-way `POST /api/localsend/v2/register` handshake. That makes you visible to *them* as well.
2. Results are labelled with the range name (and coloured as LAN / VPN / Routed) and the lowest-latency route is preferred if a device is seen on several.
3. Ranges rescan every N minutes (default 5); vanished devices are dropped after two failed keep-alive checks.
4. Saved hosts (IP or DNS name) are re-resolved and re-registered on each scan.

Limits: up to 65 536 addresses per range (a /16) by default; 256 parallel probes; 900 ms timeout — all adjustable. The remote device must run LocalSendPlus/LocalSend and allow inbound TCP 53317 from your VPN address.

## Editions

| Edition | File | Installation | Notes |
|---|---|---|---|
| Installer | `localsendplus-setup-<ver>-<arch>.exe` | yes (NSIS, per machine) | Start Menu / desktop shortcuts, firewall rule |
| **Portable folder** | `localsendplus-portable-<ver>-win-<arch>.zip` | **none** | unzip anywhere (USB stick, sync folder) and run `localsendplus.exe`; everything stays in `data\` |
| **Portable single file** | `localsendplus-portable-<ver>-<arch>.exe` | **none** | one self-extracting exe; `data\` and `Received\` are created next to it (slower start-up than the folder) |
| **Web** | `localsendplus-web-<ver>-win-<arch>.zip` | **none** | the same engine behind a browser UI; bundles its own Node.js |

`<arch>` is `x64` or `arm64` (Windows on Arm, native).

**Portable identity.** A portable instance is recognised by the PC it runs on: its device name follows the host name, and its
certificate (fingerprint) is stored per host name (`data\identity-<host>.json`), so the same folder used on two PCs never shows
one identity twice. Portable mode is switched on by a `portable.txt` next to the exe (the folder zip ships one) or by the
single-file build itself.

## Web edition

`Start-LocalSendPlus-Web.cmd` starts `node\node.exe web\server.js --open`: this PC only, `http://localhost:53320`. `Start-LocalSendPlus-Web-LAN.cmd`
adds `--lan --https` so other machines on the LAN or over a VPN can open it. `node web\server.js --help` lists every option.

* The **host PC is the endpoint** other devices see (named after the PC); the browser is its remote control. Same UI as the desktop app, including Networks.
* Access needs a token (`data\web-token.txt`, printed as a link at start-up). Cookies are `HttpOnly; SameSite=Strict`; POSTs need an `X-LSP` header, `Origin`
  must match, and the `Host` header is checked (DNS-rebinding protection). Failed sign-ins are throttled.
* Files chosen in the browser are uploaded to `data\staging` on the host (cleared after 24 h) and sent from there; the UI cannot send or browse any other file on the PC.
  Received files stay on the host and are downloaded through History > folder icon (only files that were received).
* Unattended host? Use `--quick-save` or a PIN, because incoming requests are answered in an open browser tab.
* Browsers cannot do multicast or raw TCP, which is why the engine runs on the host rather than in the page.
* Limits: dropping whole folders onto the page is not supported (use the Folder button); `--no-auth` is refused for anything but 127.0.0.1.
## Protocol conformance (v2.2)

| Spec section | Status |
|---|---|
| §1 defaults — port/UDP 53317, multicast 224.0.0.167 | yes (both configurable) |
| §2 fingerprint — SHA-256 of the certificate (HTTPS) | yes |
| §3.1 multicast announce / HTTP `register` reply / UDP fallback reply | yes |
| §3.2 legacy HTTP discovery (sweep of local subnets and saved ranges) | yes |
| §4.1 `prepare-upload` — accept / partial / reject, PIN (`401`/`429`), `204` when no files, `409` busy | yes |
| §4.2 `upload` — token + sender-IP binding, `sha256` check with `422` | yes |
| §4.3 `cancel` | yes |
| §5 download API — `prepare-download`, `download`, browser page, `sessionId` refresh, PIN | yes (`/` page is served over plain HTTP on the share port) |
| §6.1 `info` (and legacy v1 `info`) | yes |
| §7.1 device types `mobile`/`desktop`/`web`/`headless`/`server`, unknown → `desktop` | yes |
| v3 (nonce/token pairing, WebRTC) | not implemented — still experimental upstream |

## Share via link

On the **Send** page choose what to send, then press the link icon next to *Selection*. LocalSendPlus starts a small plain-HTTP server (port 53318, next free port if busy) and shows a QR code and one link per network adapter. Anyone who opens the link in a browser sees the file list and can download — nothing needs to be installed on their side.

* Optional PIN, and each new browser has to be approved by you unless you choose *Allow without asking*.
* The share stops by itself after 15 min / 1 h / 4 h (or never) and when the app quits.
* Only `GET /`, `prepare-download` and `download` are exposed on that port — never the upload API. Downloads support `Range` (resume).
* The same download API is also available on the normal protocol port for LocalSend-compatible clients while a share is active (`download: true` is advertised).

## Command line

`localsendplus-cli.cmd` is installed next to the app (add that folder to `PATH`); from a source checkout use `npm run cli -- <command>`.

```powershell
localsendplus-cli devices                                   # list reachable devices
localsendplus-cli send --to "Cute Tomato" report.pdf ./photos
localsendplus-cli send --to 10.20.4.15 --text "hello"       # alias, IP or IP:port; --text - reads stdin
localsendplus-cli receive --yes --dir C:\Inbox              # headless receiver (prompts unless --yes)
localsendplus-cli share --pin 1234 --minutes 30 .\build.zip # prints links + terminal QR
```

Settings for the CLI live in `~/.localsendplus` (`--home` / `$LOCALSENDPLUS_HOME` to change). It never touches the desktop app's data.

## Run / build

Requires Node 22.12+ (only for development; the packaged app needs nothing).

```powershell
npm install
npm start                 # run
npm test                  # protocol + web-server end-to-end tests
npm run test:ui           # drives the real window against a headless peer
npm run cli -- --help    # command-line client
npm run installer         # NSIS installer -> dist-installer/   (installer:arm64 for Windows on Arm)
npm run package           # portable folder + zip -> release/   (package:arm64)
npm run portable-exe      # single-file portable exe -> dist-installer/   (portable-exe:arm64)
npm run package-web       # web edition zip -> release/   (package-web:arm64)
npm run web               # run the web edition from source
npm run icons             # regenerate assets/icon.*
```

Install a packaged build for the current user (Start Menu + Desktop shortcut + firewall rule):

```powershell
powershell -ExecutionPolicy Bypass -File .\Install-LocalSendPlus.ps1
```

The firewall rule can also be added later from **Settings → Network → Windows Firewall**.

## Layout

```
main.js, preload.js         Electron shell, tray, IPC, notifications, firewall helper, portable mode
bin/localsendplus.js       Command-line client
web/                        Browser edition: server.js (HTTP + SSE + uploads) and sa-web.js (the bridge the UI calls)
src/core/                   Pure-Node engine (no Electron dependency)
  protocol.js                 Spec constants (version, defaults, device types, helpers)
  server.js                   HTTPS receiver: register / prepare-upload / upload / cancel / info
  share.js                    Download API + browser page (share via link)
  sender.js                   prepare-upload + parallel streamed uploads, folder walking
  discovery.js                UDP multicast on all interfaces
  scanner.js                  TCP probe + register handshake, range sweeps
  network.js                  adapters, VPN detection, routing-table suggestions, CIDR maths
  engine.js                   device registry, scans, transfers, history, settings
src/renderer/               Vanilla JS UI (no framework, no network access, strict CSP)
test/e2e.js                 Protocol / safety tests
scripts/                    icons, packaging, UI test, screenshot helper
```

## Security notes

* Transport is HTTPS with a per-install self-signed certificate; the SHA-256 fingerprint identifies a device (same model as LocalSend). Plain HTTP can be enabled in Settings but is flagged as unencrypted.
* Receiver validates every path (no `..`, drive letters, reserved names) and never writes outside the destination folder; partial files use a `.lsp-part` suffix and are removed on failure/cancel.
* Only one transfer session at a time (409 otherwise); upload tokens are per-file and bound to the sender's IP; optional PIN with lock-out after 3 bad attempts.
* The renderer runs sandboxed with context isolation and a CSP that blocks remote content.

## Known limitations

* Windows build is unsigned, so SmartScreen may warn on first run.
* Share links are plain HTTP (browsers reject self-signed certificates) — use the PIN on shared networks.
* Interop is implemented from the published protocol spec; it has not been exercised against a live LocalSend peer from a second machine.
* If LocalSend is already running on the same PC it owns port 53317 — LocalSendPlus will say so and you can pick another port in Settings (multicast uses its own port setting, default 53317, so both apps still discover each other).
* The single-file portable exe unpacks itself to a temp folder on every start, so it launches slower than the portable folder.
* The web edition's browser tab must be open to answer incoming-transfer prompts (or use Quick Save / a PIN).
