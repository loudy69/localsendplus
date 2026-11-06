# LocalSendPlus

**Send files, folders, text and clipboard contents to other devices — on your local network *and across VPNs and routed networks*.**

LocalSendPlus is a Windows desktop app (x64 and Arm64) built on the open **LocalSend protocol v2.2**. It looks and feels like
[LocalSend](https://github.com/localsend/localsend) and talks to it directly, but it goes further: it is designed to work *beyond the local LAN segment*,
reaching devices through VPN tunnels and advertised/routed subnets that ordinary multicast discovery can never see.

> **Credit where it is due.** LocalSend is a fantastic open-source project by Tien Do Nam and contributors:
> **<https://github.com/localsend/localsend>** (website: <https://localsend.org>). LocalSendPlus is an *independent* implementation written
> from the published [protocol specification](https://github.com/localsend/protocol); it contains no LocalSend code and is not affiliated with or endorsed by the
> LocalSend project. If you only need LAN transfers on phones, tablets and desktops, the original LocalSend is the right tool — go and install it.
> LocalSendPlus exists for the cases where the other device is *not* on your Wi-Fi.

---

## Why LocalSendPlus?

LocalSend finds devices with UDP multicast. Multicast stops at the first router, so as soon as the other device is on a VPN, in another office subnet or behind a
routed link, it simply never shows up. LocalSendPlus keeps LocalSend's multicast discovery and adds **active discovery across routes**:

| | LocalSend | LocalSendPlus |
|---|---|---|
| Devices on the same LAN (multicast) | yes | yes — on **every** adapter, not just one |
| Devices across a **VPN** or **routed/advertised subnet** | only if you type each IP | **Networks** tab: saved CIDRs / ranges / IPs scanned in parallel, auto-rescanned, labelled per network |
| "Find the ranges for me" | – | reads your adapters and routing table and suggests VPN / routed ranges |
| Saved hosts by IP or DNS name | – | re-checked on every scan |
| Device list | flat | grouped by network (Local network, *Branch VPN*, …) with latency badges |
| Folders, text, clipboard, screenshots | yes | yes (+ drag & drop, paste images / copied files) |
| PIN, file integrity (`sha256`), preserved file dates | yes | yes (PIN is brute-force throttled — recommended across VPNs) |
| Share via link / QR (browser download) | yes | yes |
| Command line | `localsend-cli` | `localsendplus-cli` (`devices`, `send`, `receive`, `share`) |
| Browser UI that remote-controls a host PC | – | **Web edition** (runs from source, see below) |
| Portable use, no installation | yes | yes — single-file `.exe` that keeps everything beside it |
| Device name | random alias | **the PC's host name** (editable) |

### How it reaches beyond the LAN

For every enabled range on the **Networks** page, LocalSendPlus checks TCP `53317` on each address (up to 65,536 per range, 256 probes in parallel, 900 ms timeout —
all adjustable) and performs LocalSend's two-way `register` handshake, so **you become visible to them as well**. Results are labelled with the network they came from and the
lowest-latency route wins when a device is seen twice. Ranges rescan every few minutes and vanished devices drop off automatically.

It works with whatever gets you onto the other network — WireGuard, OpenVPN, IPsec, Tailscale, ZeroTier, a site-to-site link or plain static routes.
Bring the VPN up with your normal client, add its address range under **Networks** (or press **Detect**), and the devices behind it appear in the Send list.

**Requirements on the far side:** the other device runs LocalSendPlus or LocalSend and allows inbound TCP **53317** from your VPN / routed address.

---

## Download

Grab the build for your PC from the **[latest release](https://github.com/loudy69/localsendplus/releases/latest)**.

| You have… | Install it (adds Start Menu entry, firewall rule) | …or run it with **no installation** |
|---|---|---|
| Windows 10/11 on **Intel / AMD (x64)** | `localsendplus-setup-1.4.0-x64.exe` | `localsendplus-portable-1.4.0-x64.exe` |
| Windows 11 on **Arm (Snapdragon, Surface Pro X, …)** | `localsendplus-setup-1.4.0-arm64.exe` | `localsendplus-portable-1.4.0-arm64.exe` |

Not sure which you have? *Settings → System → About → System type*.

### The portable build

The portable `.exe` needs no installation and no administrator rights. On first start it creates, **next to the exe**:

* `data\` — settings, history and this device's certificate
* `Received\` — the default folder for received files

The instance **assumes the host (PC) name** as its device name, so it is identifiable as that PC on the network, and its certificate is kept per host name — you can keep the
file on a USB stick or sync folder and use it on several PCs without two machines ever presenting the same identity. (It unpacks itself to a temp folder on every launch, so it
starts a little slower than the installed app.)

### ⚠️ These builds are not digitally signed

The executables are **not code-signed**, so Windows SmartScreen will probably show *"Windows protected your PC"* or a *"Do you want to run this application?"* prompt:

1. Click **More info**.
2. Click **Run anyway**.

Because of that, **verify your download** against the checksums below (and in the release notes) before running it:

```powershell
Get-FileHash .\localsendplus-portable-1.4.0-x64.exe -Algorithm SHA256
```

| File | SHA-256 |
|---|---|
| `localsendplus-setup-1.4.0-x64.exe` | `a2c04d94a3517d3edb55fe340eb3d9860976c2b0625ea66a8fdbdcdab092844a` |
| `localsendplus-setup-1.4.0-arm64.exe` | `52c4e5acd2ae7630602f4861f68476cb7986ce05d5e43ffaa67b709580e337d2` |
| `localsendplus-portable-1.4.0-x64.exe` | `d9fffacd69df212cf62826dc9af352cda961f1557e50bcbbd8f51a85672b3f4e` |
| `localsendplus-portable-1.4.0-arm64.exe` | `d0b3572f338a78680c26b2604606b712027d74b36ac2df6e43a7249ade585b6c` |

If you would rather not run an unsigned binary, build it yourself from this repository (see [Build from source](#build-from-source)).

---

## Quick start

1. Run LocalSendPlus on both devices. On the same LAN they find each other immediately.
2. **Windows Firewall:** *Settings → Network → Windows Firewall → Allow* (needs admin once) so others can reach you on TCP/UDP 53317. The installer does this for you.
3. Pick **File / Folder / Media / Text / Paste** (or drag & drop, or press `Ctrl+V`), click a device, and accept on the other side. Turn on **Quick Save** for devices you trust.
4. **Across a VPN or routed network:** open **Networks → Add range** (e.g. `10.20.4.0/24`, `10.20.4.10-50`, or a single IP) or press **Detect**. The devices appear under their network name.
   Can't scan? Use **Add device by address** (IP or DNS name) — it is remembered and re-checked on every scan.
5. Set a **PIN** under *Settings → Receive* when you open the app up to a VPN or shared network.

## Features

* **Everything LocalSend sends:** files, whole folders (structure preserved, parallel uploads), text and clipboard (including screenshots and copied files), Quick Save, favourites, history.
* **Share via link:** a QR code and one link per adapter; anyone with a browser can download, optionally behind a PIN, with per-browser approval and an auto-stop timer. Only the download API is exposed on that port, never upload.
* **Integrity & safety:** SHA-256 per file with HTTP 422 on mismatch; one session at a time; per-file tokens bound to the sender's IP; partial files cleaned up on cancel; receiver rejects path traversal.
* **Interop:** speaks LocalSend protocol v2.2 (register / prepare-upload / upload / cancel / download API, multicast announce, legacy HTTP discovery) so it exchanges data with LocalSend on Windows, macOS, Linux, Android and iOS.
* **Command line:** `localsendplus-cli devices | send | receive | share` — headless receiver included.
* **Web edition:** the same engine behind a token-protected browser UI so a host PC can be driven from another machine (LAN or VPN). Run it from source: `npm run web`
  (or `npm run package-web` to build a self-contained bundle). Details in [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).

## Security notes

* Transport is HTTPS with a per-install self-signed certificate; the SHA-256 fingerprint identifies a device (same trust model as LocalSend). Plain HTTP can be enabled but is flagged as unencrypted.
* **Anything that can reach TCP 53317 on your VPN/routed address can talk to the receiver.** Use a PIN and leave Quick Save off (or favourites-only) on networks you do not control.
* Share links are plain HTTP because browsers reject self-signed certificates — use the PIN on shared networks.
* The renderer is sandboxed with context isolation and a CSP that blocks remote content.
* The builds are unsigned — verify checksums (above) or build from source.

## Known limitations

* Windows only (x64 and Arm64). The engine is plain Node.js, so a Linux/macOS port is feasible but not built yet.
* Unsigned executables trigger SmartScreen on first run.
* Interop is implemented from the published spec and has been tested between LocalSendPlus instances; it has not been exercised against a live LocalSend peer on a second machine.
* If LocalSend is already running on the same PC it owns port 53317 — pick another port in *Settings → Network* (multicast uses its own port setting so both apps still see each other).
* LocalSend protocol v3 (nonce/token pairing, WebRTC) is not implemented — it is still experimental upstream.

## Build from source

Requires Node 22.12+.

```powershell
npm install
npm start                  # run the desktop app
npm test                   # protocol + web-server end-to-end tests
npm run installer          # NSIS installer, x64   (installer:arm64 for Windows on Arm)
npm run portable-exe       # single-file portable exe   (portable-exe:arm64)
npm run package            # portable folder + zip      (package:arm64)
npm run package-web        # browser edition bundle     (package-web:arm64)
```

Architecture, file layout and protocol-conformance table: [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).

## Acknowledgements

* **[LocalSend](https://github.com/localsend/localsend)** — the original app and the open protocol this project implements. Please support it.
* [LocalSend protocol specification](https://github.com/localsend/protocol).

## License

[MIT](LICENSE) © 2026 loudy69
