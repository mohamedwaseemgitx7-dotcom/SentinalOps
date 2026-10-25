# Building and distributing SentinelOps on Windows

## What the desktop app is

| | |
|---|---|
| Language / framework | TypeScript; Electron 44 (Chromium + Node 24.22) wrapping the same Fastify server and React UI as the web app |
| Packaging | electron-builder 26 → NSIS per-user installer + portable exe; optional MSIX/AppX for the Microsoft Store |
| Runtime | Self-contained (Electron ships its runtime); no .NET, VC++ or Node install needed |
| Privileges | `asInvoker` — never requests administrator rights; installs per-user |
| Behaviour | Starts a server on `127.0.0.1:<random port>`; stores data in `%APPDATA%\SentinelOps\data`; makes outbound HTTPS calls only for features you configure (GitHub API, OSV.dev, monitors, webhooks). No auto-update, no startup persistence, no registry writes beyond the installer's uninstall entry, no downloading/executing other programs, no packer/obfuscator (no UPX) |
| Signing | **Not signed** today (see below) |

## Build

```powershell
# from D:\dmonitz — caches on D: because C: is small
$env:ELECTRON_BUILDER_CACHE = "D:\dmonitz\.cache\electron-builder"
$env:electron_config_cache   = "D:\dmonitz\.cache\electron"
$env:CSC_IDENTITY_AUTO_DISCOVERY = "false"
npm ci
npm run desktop:build
Get-FileHash apps\desktop\release\*.exe -Algorithm SHA256
```

Outputs `apps\desktop\release\SentinelOps-<version>-x64-setup.exe` and `SentinelOps-<version>-portable.exe`.
A clean build on a fresh GitHub-hosted Windows runner: **Actions → Windows build → Run workflow** (`.github/workflows/windows-build.yml`), which also writes `SHA256SUMS.txt`.

## Why Windows may warn — and what does *not* fix it

| Situation | What the user sees | Cause |
|---|---|---|
| Built and run on the same PC | Nothing — runs normally | No Mark of the Web (verified 2026-10-25: no Defender/SmartScreen/Code Integrity events) |
| Downloaded (browser, GitHub, email, chat) | **"Windows protected your PC"** → *More info* → *Run anyway*, publisher "Unknown" | SmartScreen reputation check on a file with Mark of the Web and no trusted signature |
| Smart App Control **On** | Blocked with no "Run anyway" | Smart App Control only allows signed or known-good apps (it is Off on the development PC) |

Not fixes: disabling Defender/SmartScreen, adding antivirus exclusions, packing/obfuscating, or a **self-signed certificate** (it is only trusted on machines where you manually import it as a trusted root — that weakens those machines and does nothing for other users).

## Ways to remove the warning legitimately

| Option | Cost | Works for you? | Notes |
|---|---|---|---|
| **Microsoft Store (MSIX)** | **Free** (individual registration has been free since Sept 2025) | ✅ | Microsoft signs the package; users install from the Store with no SmartScreen prompt; automatic updates. Requires Store certification review. |
| Azure Artifact Signing (formerly Trusted Signing) | US$9.99/month + paid Azure subscription | ❌ individuals only in USA/Canada | Cheapest trusted signing where eligible. |
| OV code-signing certificate from a CA (DigiCert, Sectigo, GlobalSign, Certum…) | Paid yearly; hardware token or cloud HSM | ✅ (costs money) | Signature removes "Unknown publisher", but SmartScreen reputation still builds up over time per Microsoft — warnings can continue for new releases at first. EV certificates **no longer** bypass SmartScreen. |
| Distribute unsigned + published SHA-256 | Free | ✅ (current) | Users verify the hash, then choose *Run anyway*. Honest, but warns. |

### Microsoft Store (recommended ₹0 path)

1. Create a free individual account: <https://storedeveloper.microsoft.com> → Partner Center.
2. Reserve the name **SentinelOps** → *Product management → Product identity*, copy:
   `Package/Identity/Name`, `Package/Identity/Publisher` (`CN=…`), `Package/Properties/PublisherDisplayName`.
3. Build the package (no certificate needed — the Store signs it):
   ```powershell
   $env:STORE_IDENTITY_NAME = "<Package/Identity/Name>"
   $env:STORE_PUBLISHER = "<CN=...>"
   $env:STORE_PUBLISHER_DISPLAY_NAME = "<Publisher display name>"
   npm run dist:store -w @sentinelops/desktop
   ```
4. Upload `apps\desktop\release\SentinelOps-<version>-x64-setup.appx` in a new submission. Declare `runFullTrust` usage (desktop app) when asked.

Packaging was verified on 2026-10-25 with placeholder identity values (manifest contains `runFullTrust`, `internetClient`, entry point `app\SentinelOps.exe`); that test package was deleted. The real package needs your Partner Center values.

### If you later buy a code-signing certificate

Add two repository secrets (Settings → Secrets and variables → Actions) — never commit them:

- `WINDOWS_CERT_PFX_BASE64` — the `.pfx` file, base64-encoded (`[Convert]::ToBase64String([IO.File]::ReadAllBytes("cert.pfx"))`)
- `WINDOWS_CERT_PASSWORD` — its password

The Windows build workflow then signs automatically and fails if any exe is not `Valid`. (Most CA certificates are now issued on hardware tokens/cloud HSMs; for those, follow the CA's signing-tool guide instead of a `.pfx`.)

## If Defender ever *detects* SentinelOps

1. Do not ignore it and do not add an exclusion. Record the detection name, time and file hash (`Get-MpThreatDetection`, Windows Security → Protection history).
2. Rebuild from a clean checkout (`git status` clean, `npm ci`), compare hashes, and scan (`MpCmdRun -Scan -ScanType 3 -File <exe>`).
3. If it is a false positive, submit the exe as a software developer at <https://www.microsoft.com/wdsi/filesubmission> and track it in your submission history.

## Verify a download

```powershell
Get-FileHash .\SentinelOps-<version>-x64-setup.exe -Algorithm SHA256   # compare with SHA256SUMS.txt / RELEASE-CHECKLIST.md
Get-AuthenticodeSignature .\SentinelOps-<version>-x64-setup.exe        # NotSigned today; Valid once signed
```

Only after the hash matches, either choose *More info → Run anyway* in the SmartScreen prompt, or remove the download marker for that one file with `Unblock-File .\SentinelOps-<version>-x64-setup.exe`. Never disable SmartScreen globally.

## Install / uninstall

- Installer: per-user, no admin; default folder `%LOCALAPPDATA%\Programs\SentinelOps` (silent to another folder: `/S /D=D:\SentinelOps`).
- Data: `%APPDATA%\SentinelOps\data` (builds ≤ 0.1.0 used `%APPDATA%\@sentinelops\desktop\data`; 0.2.0 copies it over once and keeps the original).
- Uninstall: Settings → Apps → SentinelOps. Data is kept; delete the data folder to remove all history.
