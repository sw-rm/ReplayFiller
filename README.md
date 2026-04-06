# Replay Filler

A mineflayer bot to automate filling replays on Hypixel. Supports multiple accounts: Each account's login tokens are cached locally inside the project folder, so no external files are created and switching between accounts is seamless.

Works on **Windows, macOS, and Linux**

## Installation

- Download the latest version of [Node.js](<https://nodejs.org/en/download>)

- Download the latest version of Replay Filler from [here](<https://github.com/sw-rm/ReplayFiller/releases>) 

- Extract the `.zip` file 

Enter the root directory:
```bash
cd ReplayFiller
```
    
## Deployment

Install dependencies:
```bash
npm install
```

Start the bot:
```bash
npm start
```

On launch you will be presented with a menu to add, select, or delete accounts.

## Account Management

Accounts are managed through the interactive menu at startup:

- **Add new account** - enter the Minecraft IGN of the account to add. The UUID is looked up automatically via the mojang API and the account is stored under that UUID. On first use you will be prompted to log in via Microsoft; the token is then cached locally for future runs.
- **Select account & start** - pick a saved account to begin the replay fill loop. Each account displays its current IGN (refreshed live from Mojang) alongsidea `[VALID]` or `[INVALID]` status indicating whether the cached login token is still usable. Selecting an `[INVALID]` account will trigger a Microsoft re-login.
- **Delete account** - permenently removes an account and its cached login token.

The project folder will contain two directories created automatically at runtime:

```
ReplayFiller/
    ├── accounts/           <- one subfolder per account
    │   └── <uuid>/
    │       └── meta.json   <- stores UUID and last known IGN
    └── auth-cache/         <- Microsoft / Minecraft token cache
        └── .minecraft/
            └── nmp-cache/
                ├── e53407_live-cache.json
                ├── e53407_mca-cache.json
                └── e53407_xbl-cache.json
```

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

- [@sw-rm](<https://github.com/sw-rm>)