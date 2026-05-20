// BotWorker.js - runs as a child process with the selected account cache path set by the parent
// Copyright (C) 2026  sw-rm
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
// GNU General Public License for more details.
//
// You should have received a copy of the GNU General Public License
// along with this program. If not, see <https://www.gnu.org/licenses/>.

// -- Suppress experimental fetch warning emitted by mineflayer's auth library --
const originalEmit = process.emit;
process.emit = function (name, data) {
  if (
    name === "warning" &&
    data?.name === "ExperimentalWarning" &&
    data?.message?.includes("Fetch API")
  ) {
    return false;
  }
  return originalEmit.apply(process, arguments);
};

// -- Imports ------------------------------------------------------------------
const path = require("path");
const fs = require("fs");
const { Titles } = require("prismarine-auth");

const DEFAULT_LOOP_TARGET = 600;

// -- Config -------------------------------------------------------------------
async function startBotWorker() {
  const uuid = process.env.RF_UUID;
  const ign = process.env.RF_IGN;
  const ACCOUNTS_DIR = process.env.RF_ACCOUNTS_DIR;
  const authCacheDir = process.env.RF_AUTH_CACHE_DIR;
  const authUsername = process.env.RF_AUTH_USERNAME || "Player";
  const sourceSessionFile = process.env.RF_SOURCE_SESSION_PATH;
  const loopTarget = parseLoopTarget(process.env.RF_LOOP_TARGET);

  const mineflayer = require("mineflayer");

// -- Readline -----------------------------------------------------------------
  const readline = require("readline");

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

// -- State --------------------------------------------------------------------
  let bot = null;
  let currentInterval = null;
  let spawnTimeout = null;
  let count = 0;
  let isPaused = false;
  let authMismatch = false;
  let usingSourceAuth = false;

// -- Helpers ------------------------------------------------------------------
  function parseLoopTarget(value) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed > 0
      ? parsed
      : DEFAULT_LOOP_TARGET;
  }

  function tokenDir() {
    if (authCacheDir) return authCacheDir;
    const base = path.join(ACCOUNTS_DIR, uuid);
    if (process.platform === "darwin") {
      return path.join(base, "Library", "Application Support", "minecraft", "nmp-cache");
    }
    return path.join(base, ".minecraft", "nmp-cache");
  }

  function normalizeUUID(value) {
    return String(value || "")
      .replace(/-/g, "")
      .toLowerCase();
  }

  function formatUUID(value) {
    const stripped = normalizeUUID(value);
    if (stripped.length !== 32) return value;
    return `${stripped.slice(0, 8)}-${stripped.slice(8, 12)}-${stripped.slice(12, 16)}-${stripped.slice(16, 20)}-${stripped.slice(20)}`;
  }

  function clearLoop() {
    if (spawnTimeout) {
      clearTimeout(spawnTimeout);
      spawnTimeout = null;
    }
    if (currentInterval) {
      clearInterval(currentInterval);
      currentInterval = null;
    }
  }

  function clearTokenCache() {
    const tDir = tokenDir();
    if (fs.existsSync(tDir)) {
      fs.rmSync(tDir, { recursive: true, force: true });
    }
    fs.mkdirSync(tDir, { recursive: true });
  }

  function readSourceSession() {
    try {
      return JSON.parse(fs.readFileSync(sourceSessionFile, "utf8"));
    } catch {
      return null;
    }
  }

  function isSourceSessionValid(session) {
    if (
      !session?.session?.accessToken ||
      !session?.session?.selectedProfile?.id
    ) {
      return false;
    }
    return (
      normalizeUUID(session.session.selectedProfile.id) === normalizeUUID(uuid) &&
      isAccessTokenFresh(session.expiresAt)
    );
  }

  function isAccessTokenFresh(expiresAt) {
    if (!expiresAt) return true;
    const expires = new Date(expiresAt).getTime();
    return Number.isFinite(expires) && expires > Date.now() + 30_000;
  }

  function buildBotOptions(tDir) {
    const sourceSession = readSourceSession();
    if (isSourceSessionValid(sourceSession)) {
      usingSourceAuth = true;
      console.log(
        `[${ign}] Using ${sourceSession.selectedSource?.label || "source"} session.`,
      );
      return {
        host: "hypixel.net",
        version: "1.8.9",
        username: sourceSession.session.selectedProfile.name,
        auth: require("minecraft-protocol/src/client/mojangAuth"),
        session: sourceSession.session,
        profilesFolder: false,
        skipValidation: true,
      };
    }

    usingSourceAuth = false;
    return {
      host: "hypixel.net",
      version: "1.8.9",
      username: authUsername,
      auth: "microsoft",
      authTitle: Titles.MinecraftNintendoSwitch,
      deviceType: "Nintendo",
      flow: "live",
      skipValidation: true,
      profilesFolder: tDir,
      onMsaCode: (data) => {
        const url = `${data.verification_uri}?otc=${data.user_code}`;
        console.log(`[${ign}] Microsoft authentication required.`);
        console.log(`[${ign}] Open: ${url}`);
        console.log(`[${ign}] Code: ${data.user_code}`);
      },
    };
  }

  function startHousingLoop() {
    clearLoop();
    console.log(`[${ign}] Starting /housing random loop (${loopTarget} total)...`);
    currentInterval = setInterval(() => {
      if (count >= loopTarget) {
        clearLoop();
        console.log(`[${ign}] Completed ${loopTarget} /housing random commands.`);
        return;
      }
      if (bot && !isPaused) {
        count++;
        bot.chat("/housing random");
        console.log(`[${ign}] Sent /housing random (${count}/${loopTarget})`);
      }
    }, 3750);
  }

  function createBot() {
    const tDir = tokenDir();
    if (!fs.existsSync(tDir)) fs.mkdirSync(tDir, { recursive: true });

    bot = mineflayer.createBot(buildBotOptions(tDir));

    bot._client.on("session", (session) => {
      const profile = session?.selectedProfile;
      if (!profile?.id) return;

      const profileUUID = formatUUID(profile.id);
      if (normalizeUUID(profileUUID) !== normalizeUUID(uuid)) {
        authMismatch = true;
        console.log(
          `[${ign}] Authenticated as ${profile.name} (${profileUUID}), expected ${ign} (${uuid}).`,
        );
        clearLoop();
        if (!usingSourceAuth) clearTokenCache();
        bot.end("Authenticated account does not match selected account");
      }
    });

    bot.once("spawn", () => {
      if (authMismatch) return;
      console.log(`[${ign}] Bot spawned, waiting for Hypixel welcome...`);
      spawnTimeout = setTimeout(() => {
        if (!isPaused) startHousingLoop();
      }, 10000);
    });

    bot.on("kicked", (reason) => {
      console.log(`[${ign}] Kicked:`, reason);
      clearLoop();
    });

    bot.on("error", (err) => {
      console.log(`[${ign}] Error:`, err);
      clearLoop();
    });

    bot.on("end", () => {
      clearLoop();
      bot = null;
      if (authMismatch) {
        console.log(
          `[${ign}] Stopped because the authenticated account does not match this ReplayFiller account.`,
        );
      }
    });
  }

// -- Commands -----------------------------------------------------------------
  function stopBot() {
    isPaused = true;
    clearLoop();
    if (bot) {
      bot.quit("Manual stop");
      bot = null;
    }
    console.log(
      `Bot stopped. Progress: ${count}/${loopTarget}. Type 'continue' to resume or 'menu' to go back.`,
    );
  }

  function continueBot() {
    if (!isPaused) {
      console.log("Bot is not paused.");
      return;
    }
    isPaused = false;
    console.log(`Resuming [${ign}]... Progress: ${count}/${loopTarget}`);
    createBot();
  }

// -- Input handling -----------------------------------------------------------
  rl.on("line", (input) => {
    const cmd = input.trim().toLowerCase();
    switch (cmd) {
      case "stop":
        stopBot();
        break;
      case "continue":
        continueBot();
        break;
      case "status":
        console.log(
          `Account: ${ign} | Status: ${isPaused ? "Paused" : "Running"} | Progress: ${count}/${loopTarget}`,
        );
        break;
      case "menu":
        stopBot();
        rl.close();
        process.exit(42);
        break;
      case "help":
        console.log("Runtime commands: stop, continue, status, menu, help, quit");
        break;
      case "quit":
      case "exit":
        if (bot) bot.quit("Manual exit");
        rl.close();
        process.exit(0);
        break;
      default:
        if (cmd !== "") {
          console.log(`Unknown command: ${cmd}. Type "help" for available commands.`);
        }
    }
  });

// -- Graceful shutdown --------------------------------------------------------
  process.on("SIGINT", () => {
    console.log("\nShutting down...");
    if (bot) bot.quit("Process terminated");
    rl.close();
    process.exit(0);
  });

// -- Entry point --------------------------------------------------------------
  createBot();
}

module.exports = { startBotWorker };
