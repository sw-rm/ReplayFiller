# Replay Filler

A mineflayer bot to automate filling replays on Hypixel. Supports multiple accounts - each account's login tokens are cached locally, so switching between accounts is seamless.

Works on **Windows, macOS, and Linux**.

## Installation

Download the latest binary for your platform from [Releases](https://github.com/sw-rm/ReplayFiller/releases):

- **Windows** — download `replayfill-win.exe` and run it
- **macOS** — download `replayfill-macos`, then run:
  ```bash
  chmod +x replayfill-macos && ./replayfill-macos
  ```
- **Linux** — download `replayfill-linux`, then run:
  ```bash
  chmod +x replayfill-linux && ./replayfill-linux
  ```

On launch you will be presented with a menu to add, select, or delete accounts.

## Account Management

Accounts are managed through the interactive menu at startup:

- **Add new account** - enter the Minecraft IGN of the account to add. The UUID is looked up automatically via the Mojang API and the account is stored under that UUID. On first use you will be prompted to log in via Microsoft; the token is then cached locally for future runs.
- **Select account & start** - pick a saved account to begin the replay fill loop. Each account displays its current IGN (refreshed live from Mojang) alongside a `[VALID]` or `[INVALID]` status indicating whether the cached login token is still usable. Selecting an `[INVALID]` account will trigger a Microsoft re-login.
- **Delete account** - permanently removes an account and all of its cached tokens.

Account data is stored in an OS-native location created automatically at runtime:

- **Windows:** `%APPDATA%\ReplayFiller\`
- **macOS:** `~/Library/Application Support/ReplayFiller/`
- **Linux:** `~/.local/share/ReplayFiller/`

Each account gets its own subfolder:

```
ReplayFiller/
└── <uuid>/
    ├── meta.json                                          <- stores UUID and last known IGN
    ├── .minecraft/nmp-cache/                              <- token cache (Windows & Linux)
    └── Library/Application Support/minecraft/nmp-cache/  <- token cache (Mac)
```

Each account's tokens are fully isolated so switching accounts always uses the correct credentials.

IGNs are always fetched fresh from Mojang when the menu loads, so name changes are reflected automatically. The last known IGN is also saved in `meta.json` as a fallback when offline.

## Runtime Commands

Once the bot is running, the following commands are available:

| Command    | Description                               |
| ---------- | ----------------------------------------- |
| `stop`     | Pause the bot and disconnect              |
| `continue` | Resume after a stop                       |
| `status`   | Show current account, state, and progress |
| `menu`     | Stop the bot and return to the main menu  |
| `help`     | List available commands                   |
| `quit`     | Exit the program                          |

## Authors

- [@sw-rm](https://github.com/sw-rm)
