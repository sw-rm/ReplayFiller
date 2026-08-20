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
const {
  refreshReplayFillerSession,
  refreshIasSession,
  MsaRefreshError,
} = require("./msaTokenRefresh");

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
    output: process.stdin.isTTY ? process.stdout : undefined,
    terminal: Boolean(process.stdin.isTTY),
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
  let connectionAttempt = 0;
  let sourceAuthFailuresSeen = false;
  let allowMicrosoftAfterSourceFailure = false;
  let microsoftFallbackFailed = false;
  let resolvingSourceFailure = false;
  let sourceFailureChoiceResolver = null;
  const failedSourceAuthKeys = new Set();

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
      return path.join(
        base,
        "Library",
        "Application Support",
        "minecraft",
        "nmp-cache",
      );
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
    console.log(
      `[${ign}] Rejoining in ${REJOIN_DELAY_MS / 1000} seconds${suffix}...`,
    );
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

  function readCacheJson(filePath) {
    try {
      return JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch {
      return null;
    }
  }

  function hasCachedMcaToken(data) {
    if (data?.mca?.access_token) return true;
    return Object.values(data || {}).some((value) => value?.mca?.access_token);
  }

  function hasCachedMicrosoftRefreshToken(data) {
    if (data?.token?.refresh_token) return true;
    return Object.values(data || {}).some(
      (value) => value?.token?.refresh_token,
    );
  }

  function hasReplayFillerMicrosoftCache(tDir) {
    if (!fs.existsSync(tDir)) return false;
    return fs
      .readdirSync(tDir)
      .filter(
        (filename) =>
          filename.endsWith("_mca-cache.json") ||
          filename.endsWith("_live-cache.json") ||
          filename.endsWith("_msal-cache.json"),
      )
      .some((filename) => {
        const data = readCacheJson(path.join(tDir, filename));
        return hasCachedMcaToken(data) || hasCachedMicrosoftRefreshToken(data);
      });
  }

  function readSourceSession() {
    try {
      return JSON.parse(fs.readFileSync(sourceSessionFile, "utf8"));
    } catch {
      return null;
    }
  }

  function getSourceSessionEntries(sourceSession) {
    if (Array.isArray(sourceSession?.sourceSessions)) {
      return sourceSession.sourceSessions;
    }
    return sourceSession?.session ? [sourceSession] : [];
  }

  function sourceCandidateLabel(candidate) {
    return candidate?.selectedSource?.label || "source";
  }

  function sourceCandidateKey(candidate) {
    const selectedSource = candidate?.selectedSource || {};
    const profile = candidate?.session?.selectedProfile || {};
    const tokenTail = String(candidate?.session?.accessToken || "").slice(-16);
    return [
      candidate.index,
      selectedSource.id || "",
      selectedSource.path || "",
      profile.id || "",
      profile.name || "",
      tokenTail,
    ].join("|");
  }

  function sourceCandidateFromEntry(entry, index, sourceSession) {
    const selectedSource =
      entry?.selectedSource || sourceSession?.selectedSource || {};
    const candidate = {
      index,
      ign: entry?.ign || sourceSession?.ign,
      expiresAt: entry?.expiresAt ?? sourceSession?.expiresAt ?? null,
      selectedSource,
      session: entry?.session,
      authFlow: entry?.authFlow ?? null,
      refreshToken: entry?.refreshToken ?? null,
    };
    candidate.key = sourceCandidateKey(candidate);
    return candidate;
  }

  function isSourceCandidateValid(candidate) {
    if (
      !candidate?.session?.accessToken ||
      !candidate?.session?.selectedProfile?.id
    ) {
      return false;
    }
    return (
      normalizeUUID(candidate.session.selectedProfile.id) ===
        normalizeUUID(uuid) &&
      isAccessTokenFresh(candidate.expiresAt, candidate.session.accessToken)
    );
  }

  function isAccessTokenFresh(expiresAt, accessToken) {
    if (expiresAt) {
      const expires = new Date(expiresAt).getTime();
      return Number.isFinite(expires) && expires > Date.now() + 30_000;
    }
    if (accessToken && accessToken.includes(".")) {
      try {
        const payload = JSON.parse(
          Buffer.from(accessToken.split(".")[1], "base64url").toString(),
        );
        if (payload?.exp) {
          return payload.exp * 1000 > Date.now() + 30_000;
        }
      } catch {}
    }
    return true;
  }

  function getSourceAuthCandidates() {
    const sourceSession = readSourceSession();
    const candidates = getSourceSessionEntries(sourceSession)
      .map((entry, index) =>
        sourceCandidateFromEntry(entry, index, sourceSession),
      )
      .filter(isSourceCandidateValid);

    return candidates.map((candidate, index) => ({
      ...candidate,
      position: index + 1,
      total: candidates.length,
    }));
  }

  function selectSourceAuthCandidate() {
    return getSourceAuthCandidates().find(
      (candidate) => !failedSourceAuthKeys.has(candidate.key),
    );
  }

  function hasUntriedSourceAuthCandidate() {
    return Boolean(selectSourceAuthCandidate());
  }

  function sourceAttemptText(candidate) {
    const label = sourceCandidateLabel(candidate);
    if (!candidate || candidate.total <= 1) return label;
    return `${label} (${candidate.position}/${candidate.total})`;
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

    const preferredParts = [
      "text",
      "translate",
      "extra",
      "with",
      "value",
      "json",
    ]
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
      until: durationMs
        ? new Date(Date.now() + durationMs).toISOString()
        : null,
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

  function errorText(error) {
    if (!error) return "";
    if (typeof error === "string") return error;
    return [error.name, error.message, error.stack].filter(Boolean).join(" ");
  }

  function summarizeErrorText(text) {
    const normalized = String(text || "")
      .replace(/\s+/g, " ")
      .trim();
    return normalized.length > 180
      ? `${normalized.slice(0, 177)}...`
      : normalized;
  }

  function isLikelySourceAuthFailure(text) {
    return /ForbiddenOperationException|InvalidCredentialsException|invalid\s+(session|token|grant)|expired\s+token|bad\s+login|failed\s+to\s+authenticate|unauthori[sz]ed|forbidden|yggdrasil/i.test(
      text || "",
    );
  }

  function getExpiredIasHint() {
    try {
      const session = JSON.parse(
        require("fs").readFileSync(sourceSessionFile, "utf8"),
      );
      const entries = Array.isArray(session?.sourceSessions)
        ? session.sourceSessions
        : session?.session
          ? [session]
          : [];

      for (const entry of entries) {
        const sourceId = entry?.selectedSource?.id;
        if (sourceId !== "ias") continue;
        const token = entry?.session?.accessToken;
        if (!token?.includes(".")) continue;
        try {
          const payload = JSON.parse(
            Buffer.from(token.split(".")[1], "base64url").toString(),
          );
          if (payload?.exp && payload.exp * 1000 < Date.now()) {
            const minsAgo = Math.round(
              (Date.now() - payload.exp * 1000) / 60000,
            );
            return `IAS token for ${ign} expired ${minsAgo} minute(s) ago.\n  Fix: join any server on this account in Minecraft, disconnect, then choose option 1 to rescan.`;
          }
        } catch {
          // not decodable
        }
      }
    } catch {
      // can't read session file
    }
    return null;
  }

  function askSourceFailureChoice() {
    const hint = getExpiredIasHint();
    if (hint) {
      console.log(`[${ign}] ${hint}`);
    } else {
      console.log(`[${ign}] All imported account-source sessions failed.`);
    }
    console.log(
      "  1) Re-login in game, then return to the account manager to rescan",
    );
    console.log("  2) Add/use ReplayFiller Microsoft login now");
    process.stdout.write("Choice (1/2): ");
    return new Promise((resolve) => {
      sourceFailureChoiceResolver = resolve;
    });
  }

  async function promptAfterAllSourceAuthFailed() {
    if (resolvingSourceFailure) return;
    resolvingSourceFailure = true;
    isPaused = true;
    clearLoop();
    clearReconnect();

    while (true) {
      const choice = (await askSourceFailureChoice()).trim().toLowerCase();
      if (["1", "r", "relogin", "ingame", "in-game", "game"].includes(choice)) {
        rl.close();
        process.exit(42);
      }
      if (["2", "m", "ms", "microsoft"].includes(choice)) {
        allowMicrosoftAfterSourceFailure = true;
        microsoftFallbackFailed = false;
        resolvingSourceFailure = false;
        isPaused = false;
        clearTokenCache();
        console.log(`[${ign}] Starting ReplayFiller Microsoft authentication.`);
        createBot();
        return;
      }
      console.log("Choose 1 or 2.");
    }
  }

  function iasRefreshCachePath() {
    return path.join(ACCOUNTS_DIR, uuid, "ias-refresh-cache.json");
  }

  function readCachedIasRefreshToken() {
    try {
      const data = JSON.parse(fs.readFileSync(iasRefreshCachePath(), "utf8"));
      return data?.refreshToken || null;
    } catch {
      return null;
    }
  }

  function writeCachedIasRefreshToken(refreshToken) {
    const dir = path.join(ACCOUNTS_DIR, uuid);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      iasRefreshCachePath(),
      JSON.stringify(
        { refreshToken, updatedAt: new Date().toISOString() },
        null,
        2,
      ),
    );
  }

  // Persist a refreshed source session back into source-session.json so the
  // next selectSourceAuthCandidate() call (e.g. after a reconnect) treats
  // this source as fresh again, without needing to re-run the refresh.
  function persistRefreshedSourceSession(candidate, session) {
    try {
      const raw = JSON.parse(fs.readFileSync(sourceSessionFile, "utf8"));
      if (
        Array.isArray(raw.sourceSessions) &&
        raw.sourceSessions[candidate.index]
      ) {
        raw.sourceSessions[candidate.index].session = session;
        raw.sourceSessions[candidate.index].expiresAt = null;
      } else if (raw.session) {
        raw.session = session;
        raw.expiresAt = null;
      } else {
        return;
      }
      fs.writeFileSync(sourceSessionFile, JSON.stringify(raw, null, 2));
    } catch {
      // Best-effort; a failure here just means we won't benefit from this
      // refresh on the *next* launch. This session still works right now.
    }
  }

  // Try to silently refresh a failed source candidate (currently: In-Game
  // Account Switcher) using its Microsoft refresh_token. On success, persists
  // the new access token so the next selectSourceAuthCandidate() call picks
  // it up as fresh, and caches the rotated refresh token locally. Returns
  // true if the refresh succeeded.
  async function refreshAndPersistSourceSession(candidate) {
    if (candidate?.authFlow !== "ias") return false;
    const refreshToken = readCachedIasRefreshToken() || candidate.refreshToken;
    if (!refreshToken) return false;

    try {
      const { session, rotatedRefreshToken } =
        await refreshIasSession(refreshToken);
      writeCachedIasRefreshToken(rotatedRefreshToken);
      persistRefreshedSourceSession(candidate, session);
      console.log(
        `[${ign}] Silently refreshed ${sourceCandidateLabel(candidate)} session for ${session.selectedProfile.name}.`,
      );
      return true;
    } catch (err) {
      const stage = err instanceof MsaRefreshError ? err.stage : "error";
      console.log(
        `[${ign}] Silent ${sourceCandidateLabel(candidate)} refresh failed (${stage}): ${err.message}`,
      );
      return false;
    }
  }

  // Try to silently turn a cached ReplayFiller Microsoft refresh_token into a
  // fresh Minecraft session, without triggering the interactive device-code
  // flow. Returns null (and logs why) if there's nothing usable cached or the
  // refresh chain fails for any reason - callers should fall back to the
  // normal interactive "microsoft" auth branch in that case.
  async function getOrRefreshMicrosoftSession(tDir) {
    try {
      const session = await refreshReplayFillerSession(tDir);
      if (session) {
        console.log(
          `[${ign}] Silently refreshed ReplayFiller Microsoft session for ${session.selectedProfile.name}.`,
        );
      }
      return session;
    } catch (err) {
      const stage = err instanceof MsaRefreshError ? err.stage : "error";
      console.log(
        `[${ign}] Silent Microsoft refresh failed (${stage}): ${err.message}`,
      );
      return null;
    }
  }

  function buildBotOptions(tDir, sourceCandidate, refreshedSession) {
    if (sourceCandidate) {
      console.log(
        `[${ign}] Using ${sourceAttemptText(sourceCandidate)} session.`,
      );
      return {
        host: "hypixel.net",
        version: "1.8.9",
        username: sourceCandidate.session.selectedProfile.name,
        auth: require("minecraft-protocol/src/client/mojangAuth"),
        session: sourceCandidate.session,
        profilesFolder: false,
        skipValidation: true,
      };
    }

    if (refreshedSession) {
      console.log(
        `[${ign}] Using silently refreshed ReplayFiller Microsoft session.`,
      );
      return {
        host: "hypixel.net",
        version: "1.8.9",
        username: refreshedSession.selectedProfile.name,
        auth: require("minecraft-protocol/src/client/mojangAuth"),
        session: refreshedSession,
        profilesFolder: false,
        skipValidation: true,
      };
    }

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
    console.log(
      `[${ign}] Starting /housing random loop (${loopTarget} total)...`,
    );
    currentInterval = setInterval(() => {
      if (count >= loopTarget) {
        clearLoop();
        console.log(
          `[${ign}] Completed ${loopTarget} /housing random commands.`,
        );
        return;
      }
      if (bot && !isPaused) {
        count++;
        bot.chat("/housing random");
        console.log(`[${ign}] Sent /housing random (${count}/${loopTarget})`);
      }
    }, 3750);
  }

  async function createBot() {
    clearReconnect();
    const tDir = tokenDir();
    if (!fs.existsSync(tDir)) fs.mkdirSync(tDir, { recursive: true });

    const sourceCandidate = selectSourceAuthCandidate();
    if (
      !sourceCandidate &&
      sourceAuthFailuresSeen &&
      !allowMicrosoftAfterSourceFailure
    ) {
      if (!microsoftFallbackFailed && hasReplayFillerMicrosoftCache(tDir)) {
        allowMicrosoftAfterSourceFailure = true;
        console.log(`[${ign}] Trying ReplayFiller Microsoft authentication.`);
      } else {
        promptAfterAllSourceAuthFailed();
        return;
      }
    }

    let refreshedSession = null;
    if (!sourceCandidate) {
      refreshedSession = await getOrRefreshMicrosoftSession(tDir);
      // State may have changed while we were waiting on the network (e.g.
      // the user typed "stop", or a ban got flagged from elsewhere).
      if (isPaused || isBanned || authMismatch) return;
    }

    connectionAttempt++;
    const attempt = connectionAttempt;
    let spawnedThisAttempt = false;
    let lastDisconnectText = "";
    let sourceAuthFailureHandled = false;
    let microsoftAuthFailureHandled = false;
    logDebug(`connect attempt #${attempt}`);

    if (sourceCandidate?.session?.accessToken?.includes(".")) {
      try {
        const payload = JSON.parse(
          Buffer.from(
            sourceCandidate.session.accessToken.split(".")[1],
            "base64url",
          ).toString(),
        );

        console.log("================================");
        console.log("JWT IAT:", new Date(payload.iat * 1000));
        console.log("JWT EXP:", new Date(payload.exp * 1000));
        console.log("NOW:", new Date());
        console.log("================================");
      } catch (e) {
        console.log("Failed to decode JWT:", e);
      }
    }

    const activeBot = mineflayer.createBot(
      buildBotOptions(tDir, sourceCandidate, refreshedSession),
    );
    bot = activeBot;

    function handleSourceAuthFailure(reason) {
      if (
        sourceAuthFailureHandled ||
        !sourceCandidate ||
        spawnedThisAttempt ||
        !isLikelySourceAuthFailure(reason)
      ) {
        return false;
      }

      sourceAuthFailureHandled = true;
      clearLoop();
      clearReconnect();
      if (bot === activeBot) bot = null;

      console.log("================================");
      console.log("SOURCE AUTH FAILURE");
      console.log("Reason type:", typeof reason);
      console.log("Reason:", reason);

      if (reason instanceof Error) {
        console.log("Name:", reason.name);
        console.log("Message:", reason.message);
        console.log("Stack:");
        console.log(reason.stack);
      }

      try {
        console.log("JSON:");
        console.log(JSON.stringify(reason, null, 2));
      } catch {}

      console.log("================================");

      const summary = summarizeErrorText(reason);
      const suffix = summary ? `: ${summary}` : ".";
      console.log(
        `[${ign}] ${sourceCandidateLabel(sourceCandidate)} session failed${suffix}`,
      );

      try {
        activeBot.end("Source session failed");
      } catch {
        // The auth path may already have closed the connection.
      }

      (async () => {
        const refreshed = await refreshAndPersistSourceSession(sourceCandidate);
        if (!refreshed) {
          sourceAuthFailuresSeen = true;
          failedSourceAuthKeys.add(sourceCandidate.key);
          if (hasUntriedSourceAuthCandidate()) {
            console.log(`[${ign}] Trying next account source...`);
          }
        }
        createBot();
      })();
      return true;
    }

    function handleMicrosoftFallbackFailure(reason) {
      if (
        microsoftAuthFailureHandled ||
        sourceCandidate ||
        spawnedThisAttempt ||
        !sourceAuthFailuresSeen ||
        !allowMicrosoftAfterSourceFailure ||
        !isLikelySourceAuthFailure(reason)
      ) {
        return false;
      }

      microsoftAuthFailureHandled = true;
      microsoftFallbackFailed = true;
      allowMicrosoftAfterSourceFailure = false;
      clearLoop();
      clearReconnect();
      if (bot === activeBot) bot = null;

      const summary = summarizeErrorText(reason);
      const suffix = summary ? `: ${summary}` : ".";
      console.log(
        `[${ign}] ReplayFiller Microsoft authentication failed${suffix}`,
      );

      try {
        activeBot.end("ReplayFiller Microsoft authentication failed");
      } catch {
        // The auth path may already have closed the connection.
      }

      setTimeout(() => createBot(), 0);
      return true;
    }

    activeBot._client.on("connect", () => {
      logDebug(`attempt #${attempt} socket connected`);
    });

    activeBot._client.on("state", (newState, oldState) => {
      logDebug(`attempt #${attempt} protocol state ${oldState} -> ${newState}`);
    });

    activeBot._client.on("packet", (data, meta) => {
      if (!["disconnect", "kick_disconnect"].includes(meta?.name)) return;
      if (sourceAuthFailureHandled || microsoftAuthFailureHandled) return;
      lastDisconnectText = normalizeKickText(data?.reason ?? data);
      const handledBan = handleDisconnectReason(
        `attempt #${attempt} packet ${meta.name} (${meta.state || "unknown state"})`,
        data?.reason ?? data,
        activeBot,
      );
      if (handledBan) return;
      if (handleSourceAuthFailure(lastDisconnectText)) return;
      handleMicrosoftFallbackFailure(lastDisconnectText);
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
        if (!sourceCandidate) clearTokenCache();
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
      if (sourceAuthFailureHandled || microsoftAuthFailureHandled) return;
      if (
        handleDisconnectReason(
          `attempt #${attempt} kicked event`,
          reason,
          activeBot,
        )
      )
        return;
      const reasonText = normalizeKickText(reason);
      if (handleSourceAuthFailure(reasonText)) return;
      if (handleMicrosoftFallbackFailure(reasonText)) return;
      console.log(`[${ign}] Kicked: ${reasonText || "No reason provided"}`);
      scheduleReconnect("kick");
    });

    activeBot.on("error", (err) => {
      console.log("================================");
      console.log("BOT ERROR");
      console.log("Name:", err?.name);
      console.log("Message:", err?.message);
      console.log("Stack:");
      console.log(err?.stack);

      try {
        console.log("JSON:");
        console.log(JSON.stringify(err, null, 2));
      } catch {}

      console.log("================================");

      if (sourceAuthFailureHandled || microsoftAuthFailureHandled) return;

      const text = errorText(err);
      if (handleSourceAuthFailure(text)) return;
      if (handleMicrosoftFallbackFailure(text)) return;

      console.log(`[${ign}] Error:`, err);
      clearLoop();
    });

    activeBot.on("end", () => {
      clearLoop();
      if (bot === activeBot) bot = null;
      if (sourceAuthFailureHandled || microsoftAuthFailureHandled) return;
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
    if (sourceFailureChoiceResolver) {
      const resolve = sourceFailureChoiceResolver;
      sourceFailureChoiceResolver = null;
      resolve(input);
      return;
    }

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
        console.log(
          "Runtime commands: stop, continue, status, menu, help, quit",
        );
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
          console.log(
            `Unknown command: ${cmd}. Type "help" for available commands.`,
          );
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
