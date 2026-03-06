# 🔥 codexapp

### 🚀 Run Codex App UI Anywhere: Linux, Windows, or Termux on Android 🚀

[![npm](https://img.shields.io/npm/v/codexapp?style=for-the-badge&logo=npm&logoColor=white)](https://www.npmjs.com/package/codexapp)
[![platform](https://img.shields.io/badge/Platform-Linux%20%7C%20Windows%20%7C%20Android-blue?style=for-the-badge)](#-quick-start)
[![node](https://img.shields.io/badge/Node-18%2B-339933?style=for-the-badge&logo=node.js&logoColor=white)](https://nodejs.org/)
[![license](https://img.shields.io/badge/License-MIT-yellow?style=for-the-badge)](./LICENSE)

> **Codex UI in your browser. No drama. One command.**
>  
> **Yes, that is your Codex desktop app experience exposed over web UI. Yes, it runs cross-platform.**

```text
 ██████╗ ██████╗ ██████╗ ███████╗██╗  ██╗██╗   ██╗██╗
██╔════╝██╔═══██╗██╔══██╗██╔════╝╚██╗██╔╝██║   ██║██║
██║     ██║   ██║██║  ██║█████╗   ╚███╔╝ ██║   ██║██║
██║     ██║   ██║██║  ██║██╔══╝   ██╔██╗ ██║   ██║██║
╚██████╗╚██████╔╝██████╔╝███████╗██╔╝ ██╗╚██████╔╝██║
 ╚═════╝ ╚═════╝ ╚═════╝ ╚══════╝╚═╝  ╚═╝ ╚═════╝ ╚═╝
```

---

## 🤯 What Is This?
**`codexapp`** is a lightweight bridge that gives you a browser-accessible UI for Codex app-server workflows.

You run one command. It starts a local web server. You open it from your machine, your LAN, or wherever your setup allows.  

**TL;DR 🧠: Codex app UI, unlocked for Linux, Windows, and Termux-powered Android setups.**

---

## ⚡ Quick Start
> **The main event.**

```bash
# 🔓 Run instantly (recommended)
npx codexapp

# 🌐 Then open in browser
# http://localhost:18923
```

### Linux 🐧
```bash
node -v   # should be 18+
npx codexapp
```

### Windows 🪟 (PowerShell)
```powershell
node -v   # 18+
npx codexapp
```

### Termux (Android) 🤖
```bash
pkg update && pkg upgrade -y
pkg install nodejs -y
npx codexapp
```

Android background requirements:

1. Keep `codexapp` running in the current Termux session (do not close it).
2. In Android settings, disable battery optimization for `Termux`.
3. Keep the persistent Termux notification enabled so Android is less likely to kill it.
4. Optional but recommended in Termux:
```bash
termux-wake-lock
```
5. Open the shown URL in your Android browser. If the app is killed, return to Termux and run `npx codexapp` again.

---

## ✨ Features
> **The payload.**

- 🚀 One-command launch with `npx codexapp`
- 🌍 Cross-platform support for Linux, Windows, and Termux on Android
- 🖥️ Browser-first Codex UI flow on `http://localhost:18923`
- 🌐 LAN-friendly access from other devices on the same network
- 🧭 Explicit server registration model (no surprise default server)
- ⚙️ Settings screen for connector registration, status, rename, rotate-token, and delete
- 🔌 Packaged `codexui-connector` CLI for outbound relay hosts
- 🧪 Remote/headless-friendly setup for server-based Codex usage
- 🔌 Works with reverse proxies and tunneling setups
- 🔗 Dedicated Settings screen for connector registration, status, token rotation, and deletion
- 🌐 Outbound relay connector package (`codexui-connector`) for remote server onboarding
- ⚡ No global install required for quick experimentation
- 🎙️ Built-in hold-to-dictate voice input with transcription to composer draft

---

## 🧩 Recent Product Features (from main commits)
> **Not just launch. Actual UX upgrades.**

- 🗂️ Searchable project picker in new-thread flow
- ➕ Inline "Add new project" input inside picker (no browser prompt)
- 📌 New projects get pinned to top automatically
- 🧠 Smart default new-project name suggestion via server-side free-directory scan (`New Project (N)`)
- 🔄 Project order persisted globally to workspace roots state
- 🧵 Optimistic in-progress threads preserved during refresh/poll cycles
- 📱 Mobile drawer sidebar in desktop layout (teleported overlay + swipe-friendly structure)
- 🎛️ Skills Hub mobile-friendly spacing/toolbar layout improvements
- 🪟 Skill detail modal tuned for mobile sheet-style behavior
- 🧪 Skills Hub event typing fix for `SkillCard` select emit compatibility
- 🎙️ Voice dictation flow in composer (`hold to dictate` -> transcribe -> append text)

---

## 📘 Implementation Report

- Multi-stage delivery report (Multi-server, Multi-user, Outbound relay, E2EE):  
  [`docs/implementation-report.md`](docs/implementation-report.md)


## 🔗 Hub + Connector Onboarding

CodexUI can now run as a central **hub** with user-scoped remote **connectors**.

### From the web UI
1. Open **Settings**
2. Create a connector
3. Copy the generated one-time install token / install command
4. Run the connector on the remote host

### From a terminal
```bash
npx codexui-connector provision   --hub https://hub.example.com   --username alice   --password 'your-password'   --connector edge-laptop   --name 'Alice Edge Laptop'
```

Then start the remote connector:

```bash
npx codexui-connector connect   --hub https://hub.example.com   --token '<one-time-token>'   --connector edge-laptop
```

Detailed guides:
- [`docs/settings-and-connectors.md`](docs/settings-and-connectors.md)
- [`docs/connector-package.md`](docs/connector-package.md)

## ⚙️ Settings + Connector Onboarding

CodexUI now uses an **explicit registration** model:
- no local/default server is auto-created
- a fresh account starts empty
- you register a server or connector before opening projects and threads

### Browser flow

1. Sign in to the hub.
2. Open **Settings** in the sidebar.
3. Create a connector.
4. Copy the one-time token or the suggested install command.
5. Run the connector on the target host.

### Connector CLI flow

Provision from a remote host:

```bash
node dist-cli/connector.js provision \
  --hub http://127.0.0.1:4300 \
  --username admin \
  --password admin \
  --connector build-runner \
  --name "Build Runner"
```

Connect with an issued token:

```bash
node dist-cli/connector.js connect \
  --hub http://127.0.0.1:4300 \
  --token <one-time-token> \
  --connector build-runner
```

More details:
- [`docs/settings-and-connectors.md`](docs/settings-and-connectors.md)
- [`docs/connector-package.md`](docs/connector-package.md)

---

## 🌍 What Can You Do With This?

| 🔥 Use Case | 💥 What You Get |
|---|---|
| 💻 Linux workstation | Run Codex UI in browser without depending on desktop shell |
| 🪟 Windows machine | Launch web UI and access from Chrome/Edge quickly |
| 📱 Termux on Android | Start service in Termux and control from mobile browser |
| 🧪 Remote dev box | Keep Codex process on server, view UI from client device |
| 🌐 LAN sharing | Open UI from another device on same network |
| 🧰 Headless workflows | Keep terminal + browser split for productivity |
| 🔌 Custom routing | Put behind reverse proxy/tunnel if needed |
| ⚡ Fast experiments | `npx` run without full global setup |

---

## 🖼️ Screenshots

### Skills Hub
![Skills Hub](docs/screenshots/skills-hub.png)

### Chat
![Chat](docs/screenshots/chat.png)

### Mobile UI
![Skills Hub Mobile](docs/screenshots/skills-hub-mobile.png)
![Chat Mobile](docs/screenshots/chat-mobile.png)

---

## 🏗️ Architecture

```text
┌─────────────────────────────┐
│  Browser (Desktop/Mobile)   │
└──────────────┬──────────────┘
               │ HTTP / SSE
┌──────────────▼──────────────┐
│       CodexUI Hub           │
│ (Express + Vue + Relay Hub) │
└───────┬───────────┬─────────┘
        │           │
        │ local     │ outbound relay
        ▼           ▼
┌──────────────┐  ┌──────────────────────┐
│ Codex server │  │ codexui-connector    │
│ (local)      │  │ + Codex app-server   │
└──────────────┘  └──────────────────────┘
```

---

## 🎯 Requirements
- ✅ Node.js `18+`
- ✅ Codex app-server environment available
- ✅ Browser access to host/port
- ✅ Microphone permission (only for voice dictation)

---

## 🐛 Troubleshooting

| ❌ Problem | ✅ Fix |
|---|---|
| Port already in use | Run on a free port or stop old process |
| `npx` fails | Update npm/node, then retry |
| Termux install fails | `pkg update && pkg upgrade` then reinstall `nodejs` |
| Can’t open from other device | Check firewall, bind address, and LAN routing |

---

## 🤝 Contributing
Issues and PRs are welcome.  
Bring bug reports, platform notes, and setup improvements.

---

## ⭐ Star This Repo
If you believe Codex UI should be accessible from **any machine, any OS, any screen**, star this project and share it. ⭐

<div align="center">
Built for speed, portability, and a little bit of chaos 😏
</div>
