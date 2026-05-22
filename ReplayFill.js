// ReplayFiller - A mineflayer bot to automate filling replays on Hypixel.
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

// -- Imports-------------------------------------------------------------------
const path = require("path");
const fs = require("fs");
const os = require("os");
const https = require("https");
const { spawn } = require("child_process");
const { Authflow, Titles } = require("prismarine-auth");
const { startBotWorker } = require("./BotWorker");

const APP_NAME = "ReplayFiller";
const AUTH_CACHE_USERNAME = "Player";
const AUTH_FLOW_OPTIONS = {
  authTitle: Titles.MinecraftNintendoSwitch,
  deviceType: "Nintendo",
  flow: "live",
};
const CACHE_EXPIRY_SKEW_MS = 30_000;
const DEFAULT_LOOP_TARGET = 600;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// -- Directory layout ---------------------------------------------------------
function getDataDir() {
  switch (process.platform) {
    case "win32":
      return path.join(
        process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"),
        APP_NAME,
      );
    case "darwin":
      return path.join(os.homedir(), "Library", "Application Support", APP_NAME);
    default:
      return path.join(os.homedir(), ".local", "share", APP_NAME);
  }
}

function getPlatformAppDataRoot() {
  if (process.platform === "win32") {
    return process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
  }
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support");
  }
  return process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share");
}

function getMinecraftDir() {
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "minecraft");
  }
  if (process.platform === "win32") {
    return path.join(getPlatformAppDataRoot(), ".minecraft");
  }
  return path.join(os.homedir(), ".minecraft");
}

const ACCOUNTS_DIR = getDataDir();
if (!fs.existsSync(ACCOUNTS_DIR))
  fs.mkdirSync(ACCOUNTS_DIR, { recursive: true });

// -- Readline -----------------------------------------------------------------
const readline = require("readline");
let rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});
const ask = (q) => new Promise((resolve) => rl.question(q, resolve));

// -- Account helpers ----------------------------------------------------------
function listAccountUUIDs() {
  if (!fs.existsSync(ACCOUNTS_DIR)) return [];
  return fs
    .readdirSync(ACCOUNTS_DIR)
    .filter(
      (f) =>
        UUID_RE.test(f) &&
        fs.statSync(path.join(ACCOUNTS_DIR, f)).isDirectory(),
    );
}

function metaPath(uuid) {
  return path.join(ACCOUNTS_DIR, uuid, "meta.json");
}

function sourceSessionPath(uuid) {
  return path.join(ACCOUNTS_DIR, uuid, "source-session.json");
}

function readMeta(uuid) {
  try {
    return JSON.parse(fs.readFileSync(metaPath(uuid), "utf8"));
  } catch {
    return null;
  }
}

function writeMeta(uuid, data) {
  ensureAccountDir(uuid);
  fs.writeFileSync(metaPath(uuid), JSON.stringify(data, null, 2));
}

function readSourceSession(uuid) {
  try {
    return JSON.parse(fs.readFileSync(sourceSessionPath(uuid), "utf8"));
  } catch {
    return null;
  }
}

function writeSourceSession(uuid, data) {
  ensureAccountDir(uuid);
  fs.writeFileSync(sourceSessionPath(uuid), JSON.stringify(data, null, 2));
}

function ensureAccountDir(uuid) {
  const dir = path.join(ACCOUNTS_DIR, uuid);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function deleteAccount(uuid) {
  const dir = path.join(ACCOUNTS_DIR, uuid);
  if (!fs.existsSync(dir)) return false;
  fs.rmSync(dir, { recursive: true, force: true });
  return true;
}

function tokenDirForUUID(uuid) {
  const base = path.join(ACCOUNTS_DIR, uuid);
  if (process.platform === "darwin")
    return path.join(base, "Library", "Application Support", "minecraft", "nmp-cache");
  return path.join(base, ".minecraft", "nmp-cache");
}

// -- Cache validity -----------------------------------------------------------
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

function decodeJwtPayload(token) {
  try {
    const payload = String(token || "").split(".")[1];
    if (!payload) return null;
    const padded = payload
      .replace(/-/g, "+")
      .replace(/_/g, "/")
      .padEnd(Math.ceil(payload.length / 4) * 4, "=");
    return JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
  } catch {
    return null;
  }
}

function getTokenProfileUUID(mca) {
  const payload = decodeJwtPayload(mca?.access_token);
  if (!payload) return null;
  if (payload?.profiles?.mc) return formatUUID(payload.profiles.mc);

  const profile = Array.isArray(payload.pfd)
    ? payload.pfd.find((entry) => entry?.type === "mc" && entry?.id)
    : null;
  return profile?.id ? formatUUID(profile.id) : null;
}

function getTokenProfileName(mca) {
  const payload = decodeJwtPayload(mca?.access_token);
  if (!payload) return null;

  const profile = Array.isArray(payload.pfd)
    ? payload.pfd.find((entry) => entry?.type === "mc" && entry?.name)
    : null;
  return profile?.name || null;
}

function mcaTokenMatchesAccount(mca, uuid) {
  const tokenUUID = getTokenProfileUUID(mca);
  return !tokenUUID || normalizeUUID(tokenUUID) === normalizeUUID(uuid);
}

function isMcaTokenUnexpired(mca) {
  const obtainedOn = Number(mca?.obtainedOn);
  const expiresIn = Number(mca?.expires_in);
  if (!Number.isFinite(obtainedOn) || !Number.isFinite(expiresIn)) {
    return false;
  }
  return obtainedOn + expiresIn * 1000 > Date.now() + CACHE_EXPIRY_SKEW_MS;
}

function readCacheJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function collectMcaTokens(tokenDir) {
  return fs
    .readdirSync(tokenDir)
    .filter((f) => f.endsWith("_mca-cache.json"))
    .flatMap((filename) => {
      const data = readCacheJson(path.join(tokenDir, filename));
      if (!data) return [];

      const candidates = [];
      if (data?.mca) candidates.push(data.mca);
      for (const [key, val] of Object.entries(data)) {
        if (key !== "mca" && val?.mca) candidates.push(val.mca);
      }
      return candidates;
    });
}

function hasMicrosoftRefreshToken(tokenDir) {
  return fs
    .readdirSync(tokenDir)
    .filter(
      (filename) =>
        filename.endsWith("_live-cache.json") ||
        filename.endsWith("_msal-cache.json"),
    )
    .some((filename) => {
      const data = readCacheJson(path.join(tokenDir, filename));
      return Boolean(data?.token?.refresh_token);
    });
}

function uniqueExistingFiles(candidates) {
  const seen = new Set();
  return candidates
    .filter(Boolean)
    .map((candidate) => path.resolve(candidate))
    .filter((candidate) => {
      if (seen.has(candidate) || !fs.existsSync(candidate)) return false;
      seen.add(candidate);
      return fs.statSync(candidate).isFile();
    });
}

function parseJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(`${filePath}: ${error.message}`);
  }
}

function fromHome(...segments) {
  return path.join(os.homedir(), ...segments);
}

function lunarAccountsCandidates() {
  const candidates = [
    fromHome(".lunarclient", "settings", "game", "accounts.json"),
  ];

  if (process.platform === "darwin") {
    candidates.unshift(
      fromHome(
        "Library",
        "Application Support",
        "lunarclient",
        "settings",
        "game",
        "accounts.json",
      ),
    );
  }

  return candidates;
}

function vanillaAccountsCandidates() {
  return [
    path.join(getMinecraftDir(), "launcher_accounts.json"),
    path.join(getMinecraftDir(), "launcher_accounts_microsoft_store.json"),
  ];
}

function iasAccountsCandidates() {
  return [path.join(getMinecraftDir(), "config", "ias.json")];
}

function accountSourceFiles() {
  return [
    {
      id: "lunar",
      label: "Lunar Client",
      parser: "launcher-json",
      paths: lunarAccountsCandidates(),
    },
    {
      id: "vanilla",
      label: "Minecraft Launcher",
      parser: "launcher-json",
      paths: vanillaAccountsCandidates(),
    },
    {
      id: "ias",
      label: "In-Game Account Switcher",
      parser: "ias-json",
      paths: iasAccountsCandidates(),
    },
  ].flatMap((source) =>
    uniqueExistingFiles(source.paths).map((filePath) => ({
      ...source,
      path: filePath,
      paths: undefined,
    })),
  );
}

function undashUUID(value) {
  return String(value || "").replace(/-/g, "");
}

function isAccessTokenFresh(expiresAt) {
  if (!expiresAt) return true;
  const expires = new Date(expiresAt).getTime();
  return Number.isFinite(expires) && expires > Date.now() + CACHE_EXPIRY_SKEW_MS;
}

function launcherSourceAccounts(source, parsed) {
  return Object.entries(parsed?.accounts || {})
    .map(([localId, account]) => {
      const profile = account?.minecraftProfile || {};
      const uuid = formatUUID(profile.id);
      if (!UUID_RE.test(uuid) || !profile.name || !account?.accessToken) {
        return null;
      }

      return {
        uuid,
        ign: profile.name,
        accessToken: account.accessToken,
        expiresAt: account.accessTokenExpiresAt || null,
        sourceId: source.id,
        sourceLabel: source.label,
        sourcePath: source.path,
        active: String(localId) === String(parsed?.activeAccountLocalId || ""),
        valid: isAccessTokenFresh(account.accessTokenExpiresAt),
      };
    })
    .filter(Boolean);
}

function iasSourceAccounts(source, parsed) {
  return (parsed?.accounts || [])
    .map((account, index) => {
      const uuid = formatUUID(account?.uuid);
      if (!UUID_RE.test(uuid) || !account?.name || !account?.accessToken) {
        return null;
      }

      return {
        uuid,
        ign: account.name,
        accessToken: account.accessToken,
        expiresAt: null,
        sourceId: source.id,
        sourceLabel: source.label,
        sourcePath: source.path,
        active: index === 0,
        valid: account.isValid !== false,
      };
    })
    .filter(Boolean);
}

function readSourceAccounts(source) {
  const parsed = parseJsonFile(source.path);

  if (source.parser === "launcher-json") {
    return launcherSourceAccounts(source, parsed);
  }

  if (source.parser === "ias-json") {
    return iasSourceAccounts(source, parsed);
  }

  return [];
}

function sourceAccountScore(account) {
  return [
    account.valid ? 1 : 0,
    account.active ? 1 : 0,
    account.expiresAt ? new Date(account.expiresAt).getTime() || 0 : Number.MAX_SAFE_INTEGER,
    getFileMtime(account.sourcePath),
  ];
}

function getFileMtime(filePath) {
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return 0;
  }
}

function compareSourceAccountScore(left, right) {
  const leftScore = sourceAccountScore(left);
  const rightScore = sourceAccountScore(right);
  for (let i = 0; i < leftScore.length; i++) {
    if (leftScore[i] !== rightScore[i]) return leftScore[i] - rightScore[i];
  }
  return 0;
}

function uniqueLabels(labels) {
  return [...new Set(labels.filter(Boolean))];
}

function sourceSessionFromAccount(uuid, account) {
  return {
    ign: account.ign,
    expiresAt: account.expiresAt,
    selectedSource: {
      id: account.sourceId,
      label: account.sourceLabel,
      path: account.sourcePath,
    },
    session: {
      accessToken: account.accessToken,
      selectedProfile: {
        id: undashUUID(uuid),
        name: account.ign,
      },
      availableProfiles: [
        {
          id: undashUUID(uuid),
          name: account.ign,
        },
      ],
    },
  };
}

function buildSourceAccountGroups() {
  const groups = new Map();

  for (const source of accountSourceFiles()) {
    let accounts = [];
    try {
      accounts = readSourceAccounts(source);
    } catch {
      continue;
    }

    for (const account of accounts) {
      if (!groups.has(account.uuid)) groups.set(account.uuid, []);
      groups.get(account.uuid).push(account);
    }
  }

  return groups;
}

function sourceSessionEntries(sourceSession) {
  if (Array.isArray(sourceSession?.sourceSessions)) {
    return sourceSession.sourceSessions;
  }
  return sourceSession?.session ? [sourceSession] : [];
}

function sourceSessionEntryIsValid(entry, uuid, sourceSession) {
  const expiresAt = entry?.expiresAt ?? sourceSession?.expiresAt ?? null;
  return Boolean(
    entry?.session?.accessToken &&
      entry?.session?.selectedProfile?.id &&
      normalizeUUID(entry.session.selectedProfile.id) === normalizeUUID(uuid) &&
      isAccessTokenFresh(expiresAt),
  );
}

function sourceSessionIsValid(sourceSession, uuid) {
  return sourceSessionEntries(sourceSession).some((entry) =>
    sourceSessionEntryIsValid(entry, uuid, sourceSession),
  );
}

function getSourceStatus(uuid) {
  const session = readSourceSession(uuid);
  if (!session) return { valid: false, reason: "missing" };
  return {
    valid: sourceSessionIsValid(session, uuid),
    reason: sourceSessionIsValid(session, uuid) ? "source-token" : "expired",
  };
}

function syncSourceAccounts() {
  let imported = 0;
  for (const [uuid, accounts] of buildSourceAccountGroups()) {
    const sortedAccounts = [...accounts].sort((left, right) =>
      compareSourceAccountScore(right, left),
    );
    const usable = sortedAccounts
      .filter((account) => account.valid)
    const best = usable[0] || sortedAccounts[0];
    if (!best) continue;

    const sourceLabels = uniqueLabels(accounts.map((account) => account.sourceLabel));
    const previousMeta = readMeta(uuid) || { uuid };
    const previousLabels = uniqueLabels(previousMeta.sourceLabels || []);
    const nextLabels = uniqueLabels([...previousLabels, ...sourceLabels]);
    writeMeta(uuid, {
      ...previousMeta,
      uuid,
      ignAtAdd: previousMeta.ignAtAdd || best.ign,
      sourceLabels: nextLabels,
    });

    if (best.valid) {
      const sourceSessions = usable.map((account) =>
        sourceSessionFromAccount(uuid, account),
      );
      const primary = sourceSessions[0];
      writeSourceSession(uuid, {
        uuid,
        ign: primary.ign,
        expiresAt: primary.expiresAt,
        updatedAt: new Date().toISOString(),
        selectedSource: primary.selectedSource,
        sources: sourceLabels.map((label) => ({ label })),
        sourceSessions,
        session: primary.session,
      });
    }

    if (nextLabels.length !== previousLabels.length || !previousMeta.uuid) {
      imported++;
    }
  }

  return imported;
}

function syncAndReportSourceAccounts() {
  const imported = syncSourceAccounts();
  if (imported > 0) {
    console.log(`  Imported ${imported} account(s) from launcher source files.`);
  }
}

function getCacheStatus(uuid) {
  const tokenDir = tokenDirForUUID(uuid);
  if (!fs.existsSync(tokenDir)) {
    return { valid: false, reason: "missing" };
  }

  const mcaTokens = collectMcaTokens(tokenDir);
  const hasWrongAccountToken = mcaTokens.some(
    (mca) => !mcaTokenMatchesAccount(mca, uuid),
  );
  if (hasWrongAccountToken) {
    return { valid: false, reason: "wrong-account" };
  }

  if (mcaTokens.some(isMcaTokenUnexpired)) {
    return { valid: true, reason: "minecraft-token" };
  }

  if (hasMicrosoftRefreshToken(tokenDir)) {
    return { valid: true, reason: "refresh-token" };
  }

  return { valid: false, reason: "expired-or-empty" };
}

// -- Mojang API ---------------------------------------------------------------
function httpsGet(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: { "User-Agent": "ReplayFill/1.0" } }, (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => {
          try {
            resolve(JSON.parse(body));
          } catch {
            resolve(null);
          }
        });
      })
      .on("error", reject);
  });
}

async function fetchIGN(uuid) {
  try {
    const stripped = uuid.replace(/-/g, "");
    const data = await httpsGet(
      `https://sessionserver.mojang.com/session/minecraft/profile/${stripped}`,
    );
    return data?.name ?? null;
  } catch {
    return null;
  }
}

async function fetchProfileFromIGN(ign) {
  try {
    const data = await httpsGet(
      `https://api.mojang.com/users/profiles/minecraft/${encodeURIComponent(ign)}`,
    );
    if (!data?.id || !data?.name) return null;
    const uuid = formatUUID(data.id);
    return { uuid, ign: data.name };
  } catch {
    return null;
  }
}

function describeCacheStatus(status) {
  if (status.valid) return "VALID";
  if (status.reason === "wrong-account") return "WRONG ACCOUNT";
  return "INVALID";
}

function describeAccountStatus(account) {
  if (account.valid) return "VALID";
  if (account.cacheStatus?.reason === "wrong-account") return "WRONG ACCOUNT";
  return "INVALID";
}

function formatBanDuration(ms) {
  let remaining = Math.max(0, Math.ceil(ms / 1000));
  const units = [
    ["d", 24 * 60 * 60],
    ["h", 60 * 60],
    ["m", 60],
    ["s", 1],
  ];
  const parts = [];

  for (const [label, seconds] of units) {
    const value = Math.floor(remaining / seconds);
    remaining %= seconds;
    if (value > 0) parts.push(`${value}${label}`);
  }

  return parts.length > 0 ? parts.join(" ") : "0s";
}

function getBanStatusLabel(meta) {
  const banStatus = meta?.banStatus;
  if (!banStatus) return null;

  if (banStatus.type === "security") return "SEC BAN";

  if (banStatus.type === "temporary") {
    const until = banStatus.until ? new Date(banStatus.until).getTime() : null;
    if (Number.isFinite(until)) {
      const remaining = until - Date.now();
      return remaining > 0
        ? `BAN - ${formatBanDuration(remaining)}`
        : "BAN - expired";
    }
    if (banStatus.durationText) return `BAN - ${banStatus.durationText}`;
  }

  return banStatus.label || null;
}

function getAccountSourceLabels(uuid, cacheStatus) {
  const meta = readMeta(uuid) || {};
  const sourceSession = readSourceSession(uuid);
  const labels = [
    ...(Array.isArray(meta.sourceLabels) ? meta.sourceLabels : []),
    ...(Array.isArray(sourceSession?.sources)
      ? sourceSession.sources.map((source) => source.label)
      : []),
  ];

  if (cacheStatus.valid) labels.push("ReplayFiller Microsoft");
  return uniqueLabels(labels);
}

function formatSourceLabels(labels) {
  return labels.length > 0 ? labels.join(", ") : "No imported source";
}

function formatAccountMenuRow(account, index) {
  const badges = [
    account.banLabel ? `[${account.banLabel}]` : null,
    `[${describeAccountStatus(account)}]`,
    `[${formatSourceLabels(account.sources)}]`,
  ].filter(Boolean);

  return `${index + 1}) ${account.ign.padEnd(20)} ${badges.join(" ")}`;
}

function printMenuBox(title, rows) {
  const content = rows.map((row) => `  ${row}`);
  const width = Math.max(title.length + 4, ...content.map((row) => row.length));
  const titleLine = `-- ${title} ${"-".repeat(Math.max(1, width - title.length - 4))}`;
  const bottomLine = "-".repeat(width);

  console.log(`\n${titleLine}`);
  content.forEach((row) => console.log(row));
  console.log(bottomLine);
}

function createAuthFlow(uuid, { forceRefresh = false } = {}) {
  const cacheDir = tokenDirForUUID(uuid);
  if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });

  return new Authflow(
    AUTH_CACHE_USERNAME,
    cacheDir,
    { ...AUTH_FLOW_OPTIONS, forceRefresh },
    (data) => {
      const url = `${data.verification_uri}?otc=${data.user_code}`;
      console.log("\nMicrosoft authentication required.");
      console.log(`Open: ${url}`);
      console.log(`Code: ${data.user_code}\n`);
    },
  );
}

async function authenticateAccount(account, { forceRefresh = false } = {}) {
  const flow = createAuthFlow(account.uuid, { forceRefresh });
  const { profile } = await flow.getMinecraftJavaToken({ fetchProfile: true });
  if (!profile?.id || !profile?.name) {
    throw new Error("Microsoft login did not return a Minecraft profile.");
  }

  const profileUUID = formatUUID(profile.id);
  if (normalizeUUID(profileUUID) !== normalizeUUID(account.uuid)) {
    throw new Error(
      `Authenticated as ${profile.name} (${profileUUID}), expected ${account.ign} (${account.uuid}).`,
    );
  }

  const meta = readMeta(account.uuid) || { uuid: account.uuid };
  writeMeta(account.uuid, {
    ...meta,
    uuid: account.uuid,
    ignAtAdd: profile.name,
  });
  return { ...account, ign: profile.name };
}

async function buildAccountList() {
  const uuids = listAccountUUIDs();
  console.log("  Fetching account info...");
  const accounts = await Promise.all(
    uuids.map(async (uuid) => {
      const meta = readMeta(uuid);
      const cacheStatus = getCacheStatus(uuid);
      const sourceStatus = getSourceStatus(uuid);
      const liveIGN = await fetchIGN(uuid);
      const ign = liveIGN ?? meta?.ignAtAdd ?? uuid;
      if (liveIGN && meta) writeMeta(uuid, { ...meta, ignAtAdd: liveIGN });
      const valid = cacheStatus.valid || sourceStatus.valid;
      const banLabel = getBanStatusLabel(meta);
      return {
        uuid,
        ign,
        valid,
        banLabel,
        cacheStatus,
        sourceStatus,
        sources: getAccountSourceLabels(uuid, cacheStatus),
      };
    }),
  );

  return accounts.sort((left, right) => {
    if (left.valid !== right.valid) return left.valid ? -1 : 1;
    return left.ign.localeCompare(right.ign, undefined, {
      sensitivity: "base",
      numeric: true,
    });
  });
}

// -- Bot worker ---------------------------------------------------------------
function runBot(account, loopTarget) {
  const cacheDir = tokenDirForUUID(account.uuid);
  const sourcePath = sourceSessionPath(account.uuid);

  const env = {
    ...process.env,
    RF_UUID: account.uuid,
    RF_IGN: account.ign,
    RF_ACCOUNTS_DIR: ACCOUNTS_DIR,
    RF_AUTH_CACHE_DIR: cacheDir,
    RF_AUTH_USERNAME: AUTH_CACHE_USERNAME,
    RF_SOURCE_SESSION_PATH: sourcePath,
    RF_LOOP_TARGET: String(loopTarget),
    RF_WORKER: "1",
  };

  rl.close();
  if (process.stdin.isTTY) process.stdin.setRawMode(false);

  const worker = spawn(process.execPath, [process.argv[1]], {
    env,
    stdio: ["pipe", "inherit", "inherit"],
  });
  worker.stdin.on("error", () => {
    // The worker may close stdin while the parent is still forwarding a final keypress.
  });

  const workerInput = readline.createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
    terminal: false,
  });
  workerInput.on("line", (line) => {
    if (worker.stdin?.writable) worker.stdin.write(`${line}\n`);
  });

  worker.on("exit", (code) => {
    workerInput.close();
    rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    if (code === 42) {
      mainMenu();
    } else {
      console.log(`Bot exited (code ${code}).`);
      mainMenu();
    }
  });
}

// -- Menus --------------------------------------------------------------------
async function askLoopTarget() {
  const input = (
    await ask(`Loop count (Enter for ${DEFAULT_LOOP_TARGET}): `)
  )
    .trim()
    .toLowerCase();

  if (input === "" || input === "default" || input === "d") {
    return DEFAULT_LOOP_TARGET;
  }

  const target = Number(input);
  if (!Number.isSafeInteger(target) || target < 1) {
    console.log("Loop count must be a positive whole number.");
    return askLoopTarget();
  }

  return target;
}

async function mainMenu() {
  console.log("\n==================================");
  console.log("       ReplayFill  -  Main Menu   ");
  console.log("==================================");
  console.log("  1) Select account & start");
  console.log("  2) Add a new account");
  console.log("  3) Delete an account");
  console.log("  4) Exit");
  console.log("----------------------------------");

  const choice = (await ask("Choice: ")).trim();
  switch (choice) {
    case "1":
      return selectAccountMenu();
    case "2":
      return addAccountMenu();
    case "3":
      return deleteAccountMenu();
    case "4":
      console.log("Goodbye.");
      rl.close();
      process.exit(0);
    default:
      console.log("Invalid choice.");
      return mainMenu();
  }
}

async function selectAccountMenu() {
  syncAndReportSourceAccounts();

  if (listAccountUUIDs().length === 0) {
    console.log("\nNo accounts saved yet. Add one first.");
    return mainMenu();
  }

  const accounts = await buildAccountList();

  const rows = accounts.map(formatAccountMenuRow);
  rows.push("0) Back");
  printMenuBox("Select Account", rows);

  const input = (await ask("Choice: ")).trim();
  const idx = parseInt(input, 10);

  if (input === "0") return mainMenu();
  if (isNaN(idx) || idx < 1 || idx > accounts.length) {
    console.log("Invalid choice.");
    return selectAccountMenu();
  }

  let chosen = accounts[idx - 1];
  if (!chosen.valid) {
    console.log("Cache is invalid. Starting Microsoft login before launch...");
    try {
      chosen = await authenticateAccount(chosen, { forceRefresh: true });
      console.log(`Authenticated as ${chosen.ign}.`);
    } catch (error) {
      console.log(`Authentication failed: ${error.message}`);
      return selectAccountMenu();
    }
  }
  const loopTarget = await askLoopTarget();
  console.log(
    `\nStarting bot as ${chosen.ign} for ${loopTarget} loop(s)... (type "help" for runtime commands)\n`,
  );

  runBot(chosen, loopTarget);
}

async function addAccountMenu() {
  syncSourceAccounts();

  console.log("\n-- Add Account --------------------------------");
  console.log("Enter the Minecraft IGN of the account to add.");
  const rawIGN = (await ask("IGN: ")).trim();

  if (!rawIGN) {
    console.log("IGN cannot be empty.");
    return addAccountMenu();
  }

  console.log("  Looking up account...");
  const profile = await fetchProfileFromIGN(rawIGN);
  if (!profile) {
    console.log(
      "Could not find a Minecraft account with that IGN. Please check and try again.",
    );
    return addAccountMenu();
  }

  const { uuid, ign } = profile;
  if (listAccountUUIDs().includes(uuid)) {
    console.log(`Account "${ign}" (${uuid}) is already saved.`);
    return mainMenu();
  }

  ensureAccountDir(uuid);
  writeMeta(uuid, { uuid, ignAtAdd: ign });
  console.log(`\nAccount added: ${ign} (${uuid})`);
  console.log(
    "When you select it, you will be prompted to log in via Microsoft.",
  );
  return mainMenu();
}

async function deleteAccountMenu() {
  syncAndReportSourceAccounts();

  if (listAccountUUIDs().length === 0) {
    console.log("\nNo accounts to delete.");
    return mainMenu();
  }

  const accounts = await buildAccountList();

  const rows = accounts.map(formatAccountMenuRow);
  rows.push("0) Back");
  printMenuBox("Delete Account", rows);

  const input = (await ask("Choice: ")).trim();
  const idx = parseInt(input, 10);

  if (input === "0") return mainMenu();
  if (isNaN(idx) || idx < 1 || idx > accounts.length) {
    console.log("Invalid choice.");
    return deleteAccountMenu();
  }

  const chosen = accounts[idx - 1];
  const confirm = (
    await ask(
      `Delete "${chosen.ign}" (${chosen.uuid}) and its cached tokens? (yes/no): `,
    )
  )
    .trim()
    .toLowerCase();
  if (confirm === "yes" || confirm === "y") {
    deleteAccount(chosen.uuid);
    console.log(`Account "${chosen.ign}" deleted.`);
  } else {
    console.log("Cancelled.");
  }
  return mainMenu();
}

// -- Graceful shutdown --------------------------------------------------------
process.on("SIGINT", () => {
  console.log("\nShutting down...");
  rl.close();
  process.exit(0);
});

// -- Entry point --------------------------------------------------------------
if (process.env.RF_WORKER === "1") {
  startBotWorker().catch((err) => {
    console.error(err);
    process.exit(1);
  });
} else {
  mainMenu();
}
