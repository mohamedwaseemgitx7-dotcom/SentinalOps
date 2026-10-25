# Download and install SentinelOps (Windows)

SentinelOps is a local-first DevOps monitoring and security dashboard. This page explains how to get the Windows app onto your laptop.

> **This repository is private.** You can only see this page and the downloads if the owner has given you access. Don't have access? See [Request access](#request-access).

## Requirements

- Windows 10 or 11, 64-bit
- About 400 MB free disk space
- No administrator rights needed · no Node.js or other runtime needed (everything is included)

## 1. Download

1. Open the repository's **Releases** page: <https://github.com/mohamedwaseemgitx7-dotcom/dmonitz/releases> (sign in to GitHub first — private repositories show "404" when you are signed out).
2. Under the latest release (e.g. **v0.2.0**), open **Assets** and download:
   - `SentinelOps-0.2.0-x64-setup.exe` — the installer (**recommended**), or
   - `SentinelOps-0.2.0-portable.exe` — runs without installing, and
   - `SHA256SUMS.txt` — checksums to verify the download.

## 2. Verify the file (30 seconds, recommended)

Open **PowerShell** in your Downloads folder and run:

```powershell
Get-FileHash .\SentinelOps-0.2.0-x64-setup.exe -Algorithm SHA256
Get-Content .\SHA256SUMS.txt
```

The long hash printed by the first command must match the line for the same file in `SHA256SUMS.txt` (upper/lower case does not matter). **If it does not match, delete the file and do not run it.**

## 3. Install

1. Double-click `SentinelOps-0.2.0-x64-setup.exe`.
2. Windows may show **"Windows protected your PC"** (SmartScreen). This appears because the app is not yet code-signed, not because a threat was found. Only after the checksum in step 2 matched: click **More info → Run anyway**.
3. Choose an install folder (the default `%LOCALAPPDATA%\Programs\SentinelOps` is fine) → **Install**.
4. Start **SentinelOps** from the Desktop or Start menu shortcut.

> If your PC has **Smart App Control** turned on, unsigned apps are blocked with no "Run anyway" option. Please contact the owner — do not turn security features off.

## 4. First run

1. The app opens on **Create the administrator account**.
2. Click **Fill** (it enters the one-time setup token for you).
3. Choose a username and a password of **12+ characters** that does not contain the username → **Create account**.
4. Click **Analyze something** to connect a GitHub repository, a local project folder or a website.

Each laptop has its **own** SentinelOps data and its own accounts (up to 3). Data is stored in `%APPDATA%\SentinelOps\data` on that laptop only.

## 5. Update to a new version

Download the newer installer from Releases and run it — it upgrades in place and keeps your data.

## 6. Uninstall

**Settings → Apps → Installed apps → SentinelOps → Uninstall.** Your data is kept; delete `%APPDATA%\SentinelOps` to remove it as well.

## Troubleshooting

| Problem | Fix |
|---|---|
| Releases page shows **404** | You are signed out, or you have not been given access yet. |
| "Windows protected your PC" | Verify the checksum (step 2), then **More info → Run anyway**. |
| "Smart App Control blocked an app" | Unsigned apps cannot run with Smart App Control on; contact the owner. |
| The app opens but shows an error about the local server | Close all SentinelOps windows and start it again. |
| Forgot your password | Uninstalling does not reset it. Contact the owner for the account-recovery steps. |

## Request access

The owner shares SentinelOps privately. To ask for access:

1. Send the owner your **GitHub username** (create a free account at <https://github.com/signup> if needed).
2. The owner invites you as a collaborator; GitHub emails you an invitation.
3. Accept the invitation (link in the email, or <https://github.com/notifications>), then follow the steps above.

If you do not use GitHub, the owner can send you the installer and `SHA256SUMS.txt` directly — verify the checksum (step 2) before running it.
