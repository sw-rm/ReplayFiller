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
const REJOIN_DELAY_MS = 5000;

// -- Config -------------------------------------------------------------------
async function startBotWorker() {
  const uuid = process.env.RF_UUID;
  const ign = process.env.RF_IGN;
  const ACCOUNTS_DIR = process.env.RF_ACCOUNTS_DIR;
  const authCacheDir = process.env.RF_AUTH_CACHE_DIR;
  const authUsername = process.env.RF_AUTH_USERNAME || "Player";
  const sourceSessionFile = process.env.RF_SOURCE_SESSION_PATH;
  const loopTarget = parseLoopTarget(process.env.RF_LOOP_TARGET);
  const debugDisconnects = process.env.RF_DEBUG_DISCONNECTS === "1";

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
  let reconnectTimeout = null;
  let count = 0;
  let isPaused = false;
  let isBanned = false;
  let authMismatch = false;
  let usingSourceAuth = false;
  let connectionAttempt = 0;

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

  function clearReconnect() {
    if (reconnectTimeout) {
      clearTimeout(reconnectTimeout);
      reconnectTimeout = null;
    }
  }

  function canReconnect() {
    return !isPaused && !isBanned && !authMismatch && count < loopTarget;
  }

  function scheduleReconnect(reason) {
    clearLoop();
    if (!canReconnect() || reconnectTimeout) return;

    const suffix = reason ? ` after ${reason}` : "";
    console.log(`[${ign}] Rejoining in ${REJOIN_DELAY_MS / 1000} seconds${suffix}...`);
    reconnectTimeout = setTimeout(() => {
      reconnectTimeout = null;
      if (!canReconnect()) return;
      bot = null;
      console.log(`[${ign}] Rejoining now...`);
      createBot();
    }, REJOIN_DELAY_MS);
  }

  function logDebug(message) {
    if (!debugDisconnects) return;
    console.log(`[${ign}] Debug: ${message}`);
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

  function metaFilePath() {
    return path.join(ACCOUNTS_DIR, uuid, "meta.json");
  }

  function readWorkerMeta() {
    try {
      return JSON.parse(fs.readFileSync(metaFilePath(), "utf8"));
    } catch {
      return {};
    }
  }

  function writeWorkerMeta(meta) {
    const accountDir = path.join(ACCOUNTS_DIR, uuid);
    fs.mkdirSync(accountDir, { recursive: true });
    fs.writeFileSync(metaFilePath(), JSON.stringify(meta, null, 2));
  }

  function writeBanStatus(banStatus) {
    const meta = readWorkerMeta();
    writeWorkerMeta({
      ...meta,
      uuid,
      ignAtAdd: meta.ignAtAdd || ign,
      banStatus,
    });
  }

  function clearBanStatus() {
    const meta = readWorkerMeta();
    if (!meta.banStatus) return;
    delete meta.banStatus;
    writeWorkerMeta(meta);
  }

  function parseJsonString(value) {
    const trimmed = value.trim();
    if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return null;
    try {
      return JSON.parse(trimmed);
    } catch {
      return null;
    }
  }

  function extractKickText(value, seen = new Set(), depth = 0) {
    if (value == null || depth > 8) return "";

    if (typeof value === "string") {
      const parsed = parseJsonString(value);
      return parsed ? extractKickText(parsed, seen, depth + 1) : value;
    }

    if (typeof value === "number" || typeof value === "boolean") {
      return String(value);
    }

    if (typeof value !== "object") return "";
    if (seen.has(value)) return "";
    seen.add(value);

    if (Array.isArray(value)) {
      return value
        .map((entry) => extractKickText(entry, seen, depth + 1))
        .filter(Boolean)
        .join(" ");
    }

    const preferredParts = ["text", "translate", "extra", "with", "value", "json"]
      .filter((key) => Object.prototype.hasOwnProperty.call(value, key))
      .map((key) => extractKickText(value[key], seen, depth + 1))
      .filter(Boolean);
    if (preferredParts.length > 0) return preferredParts.join(" ");

    if (
      typeof value.toString === "function" &&
      value.toString !== Object.prototype.toString
    ) {
      const text = value.toString();
      if (text && text !== "[object Object]") return text;
    }

    return Object.values(value)
      .map((entry) => extractKickText(entry, seen, depth + 1))
      .filter(Boolean)
      .join(" ");
  }

  function normalizeKickText(reason) {
    return extractKickText(reason)
      .replace(/\u00a7[0-9a-fk-or]/gi, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function parseBanDurationMs(durationText) {
    const unitMs = {
      d: 24 * 60 * 60 * 1000,
      day: 24 * 60 * 60 * 1000,
      days: 24 * 60 * 60 * 1000,
      h: 60 * 60 * 1000,
      hour: 60 * 60 * 1000,
      hours: 60 * 60 * 1000,
      m: 60 * 1000,
      min: 60 * 1000,
      mins: 60 * 1000,
      minute: 60 * 1000,
      minutes: 60 * 1000,
      s: 1000,
      sec: 1000,
      secs: 1000,
      second: 1000,
      seconds: 1000,
    };
    const re = /(\d+)\s*(d|days?|h|hours?|m|mins?|minutes?|s|secs?|seconds?)/gi;
    let total = 0;
    let match;

    while ((match = re.exec(durationText)) !== null) {
      total += Number(match[1]) * unitMs[match[2].toLowerCase()];
    }

    return total > 0 ? total : null;
  }

  function detectBanStatus(reasonText) {
    if (!reasonText) return null;

    if (
      /account has been blocked/i.test(reasonText) &&
      /suspicious activity/i.test(reasonText)
    ) {
      return {
        type: "security",
        label: "SEC BAN",
        until: null,
        lastSeenAt: new Date().toISOString(),
        raw: reasonText,
      };
    }

    const tempMatch = reasonText.match(
      /temporarily banned for\s+(.+?)\s+from this server/i,
    );
    if (!tempMatch) return null;

    const durationText = tempMatch[1].trim();
    const durationMs = parseBanDurationMs(durationText);
    return {
      type: "temporary",
      label: `BAN - ${durationText}`,
      durationText,
      until: durationMs ? new Date(Date.now() + durationMs).toISOString() : null,
      lastSeenAt: new Date().toISOString(),
      raw: reasonText,
    };
  }

  function handleDisconnectReason(source, reason, activeBot) {
    const reasonText = normalizeKickText(reason);
    logDebug(`${source}: ${reasonText || "<no disconnect message>"}`);

    const banStatus = detectBanStatus(reasonText);
    if (!banStatus) return false;

    handleBanStatus(banStatus, activeBot);
    return true;
  }

  function handleBanStatus(banStatus, activeBot) {
    isBanned = true;
    isPaused = true;
    clearLoop();
    clearReconnect();
    writeBanStatus(banStatus);
    console.log(`[${ign}] ${banStatus.label}. Returning to account manager.`);
    if (activeBot) {
      try {
        activeBot.end("Ban detected");
      } catch {
        // The server may already have closed the connection after the kick.
      }
    }
    rl.close();
    process.exit(42);
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
    clearReconnect();
    const tDir = tokenDir();
    if (!fs.existsSync(tDir)) fs.mkdirSync(tDir, { recursive: true });

    connectionAttempt++;
    const attempt = connectionAttempt;
    let spawnedThisAttempt = false;
    let lastDisconnectText = "";
    logDebug(`connect attempt #${attempt}`);

    const activeBot = mineflayer.createBot(buildBotOptions(tDir));
    bot = activeBot;

    activeBot._client.on("connect", () => {
      logDebug(`attempt #${attempt} socket connected`);
    });

    activeBot._client.on("state", (newState, oldState) => {
      logDebug(`attempt #${attempt} protocol state ${oldState} -> ${newState}`);
    });

    activeBot._client.on("packet", (data, meta) => {
      if (!["disconnect", "kick_disconnect"].includes(meta?.name)) return;
      lastDisconnectText = normalizeKickText(data?.reason ?? data);
      handleDisconnectReason(
        `attempt #${attempt} packet ${meta.name} (${meta.state || "unknown state"})`,
        data?.reason ?? data,
        activeBot,
      );
    });

    activeBot._client.on("end", (reason) => {
      logDebug(
        `attempt #${attempt} client end: ${reason || "socketClosed"} | spawned=${spawnedThisAttempt} | state=${activeBot._client.state} | lastPacket=${lastDisconnectText || "none"}`,
      );
    });

    activeBot._client.on("session", (session) => {
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
        activeBot.end("Authenticated account does not match selected account");
      }
    });

    activeBot.once("spawn", () => {
      if (bot !== activeBot || authMismatch || isBanned) return;
      spawnedThisAttempt = true;
      clearBanStatus();
      console.log(`[${ign}] Bot spawned, waiting for Hypixel welcome...`);
      spawnTimeout = setTimeout(() => {
        if (!isPaused) startHousingLoop();
      }, 10000);
    });

    activeBot.on("kicked", (reason) => {
      if (handleDisconnectReason(`attempt #${attempt} kicked event`, reason, activeBot)) return;
      const reasonText = normalizeKickText(reason);
      console.log(`[${ign}] Kicked: ${reasonText || "No reason provided"}`);
      scheduleReconnect("kick");
    });

    activeBot.on("error", (err) => {
      console.log(`[${ign}] Error:`, err);
      clearLoop();
    });

    activeBot.on("end", () => {
      clearLoop();
      if (bot === activeBot) bot = null;
      if (authMismatch) {
        console.log(
          `[${ign}] Stopped because the authenticated account does not match this ReplayFiller account.`,
        );
        return;
      }
      scheduleReconnect("disconnect");
    });
  }

// -- Commands -----------------------------------------------------------------
  function stopBot() {
    isPaused = true;
    clearLoop();
    clearReconnect();
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
    isBanned = false;
    clearReconnect();
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
        isPaused = true;
        clearReconnect();
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
    isPaused = true;
    clearReconnect();
    if (bot) bot.quit("Process terminated");
    rl.close();
    process.exit(0);
  });

// -- Entry point --------------------------------------------------------------
  createBot();
}

module.exports = { startBotWorker };
