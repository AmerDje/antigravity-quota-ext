# Antigravity Quotas

An Antigravity editor extension that displays remaining quotas for Antigravity AI models directly in your editor.

## Features

- **Sidebar Panel** — View all model quotas with color-coded icons (green / yellow / red)
- **Status Bar** — See your lowest quota at a glance without opening the sidebar
- **Low Quota Alerts** — Get a notification when any model drops below 20%
- **Auto Refresh** — Quotas refresh every 5 minutes, with a manual refresh button

## Installation

### Prerequisites

- [Node.js](https://nodejs.org/) (v18+)
- [Antigravity Editor](https://www.antigravity.dev/)

### Build & Install from Source

1. **Install dependencies**

   ```bash
   npm install
   ```

2. **Compile TypeScript**

   ```bash
   npm run compile
   ```

3. **Package the extension**

   ```bash
   npx @vscode/vsce package --no-git-tag-version
   ```

4. **Install the `.vsix` file** (choose one method):

   **Option A — Command line:**

   ```bash
   antigravity --install-extension antigravity-quotas-0.0.1.vsix
   ```

   **Option B — Antigravity UI:**
   1. Open the **Extensions** panel
   2. Click the **three-dot menu** (`···`) at the top of the Extensions panel
   3. Select **Install from VSIX...**
   4. Browse to and select `antigravity-quotas-0.0.1.vsix`

5. **Reload Antigravity** when prompted

## Usage

Once installed, the extension works automatically:

| Feature           | Where                                  | What it shows                                               |
| ----------------- | -------------------------------------- | ----------------------------------------------------------- |
| **Sidebar**       | Activity bar → Antigravity Quotas      | All models with quota %, reset times, and a countdown timer |
| **Status Bar**    | Bottom-right of the Antigravity editor | Lowest quota model + percentage (click to refresh)          |
| **Notifications** | Antigravity editor notification popup  | Warning when any model drops below 20%                      |

### Manual Refresh

- Click the **refresh icon** in the sidebar panel title, or
- Click the **status bar item**

## Development

```bash
npm run watch    # Auto-recompile on file changes
```

Press `F5` in Antigravity to launch an Extension Development Host for testing.
