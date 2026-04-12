const path = require("path");
const fs = require("fs");
const os = require("os");
const https = require("https");
const { spawn } = require("child_process");

// -- Directory layout ---------------------------------------------------------
function getDataDir() {
  const appName = "ReplayFiller";
  switch (process.platform) {
    case "win32":
      return path.join(process.env.APPDATA, appName);
    case "darwin":
      return path.join(os.homedir(), "Library", "Application Support", appName);
    default:
      return path.join(os.homedir(), ".local", "share", appName);
  }
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
    .filter((f) => fs.statSync(path.join(ACCOUNTS_DIR, f)).isDirectory());
}

function metaPath(uuid) {
  return path.join(ACCOUNTS_DIR, uuid, "meta.json");
}

function readMeta(uuid) {
  try {
    return JSON.parse(fs.readFileSync(metaPath(uuid), "utf8"));
  } catch {
    return null;
  }
}

function writeMeta(uuid, data) {
  fs.writeFileSync(metaPath(uuid), JSON.stringify(data, null, 2));
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
function isCacheValid(uuid) {
  const tokenDir = tokenDirForUUID(uuid);
  if (!fs.existsSync(tokenDir)) return false;

  const files = fs
    .readdirSync(tokenDir)
    .filter((f) => f.endsWith("_mca-cache.json"));

  for (const filename of files) {
    try {
      const data = JSON.parse(
        fs.readFileSync(path.join(tokenDir, filename), "utf8"),
      );
      const candidates = [];
      if (data?.mca) candidates.push(data.mca);
      for (const [key, val] of Object.entries(data)) {
        if (key !== "mca" && val?.mca) candidates.push(val.mca);
      }
      for (const mca of candidates) {
        if (mca.obtainedOn + mca.expires_in * 1000 > Date.now()) return true;
      }
    } catch {
      /* corrupt */
    }
  }
  return false;
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
    const s = data.id;
    const uuid = `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
    return { uuid, ign: data.name };
  } catch {
    return null;
  }
}

async function buildAccountList() {
  const uuids = listAccountUUIDs();
  console.log("  Fetching account info...");
  return Promise.all(
    uuids.map(async (uuid) => {
      const meta = readMeta(uuid);
      const valid = isCacheValid(uuid);
      const liveIGN = await fetchIGN(uuid);
      const ign = liveIGN ?? meta?.ignAtAdd ?? uuid;
      if (liveIGN && meta) writeMeta(uuid, { ...meta, ignAtAdd: liveIGN });
      return { uuid, ign, valid };
    }),
  );
}

// -- Bot worker ---------------------------------------------------------------
// The bot runs in a child process with HOME/APPDATA set to accounts/<uuid>/
function runBot(account) {
  const accountDir = path.join(ACCOUNTS_DIR, account.uuid);

  const workerPath = process.pkg
    ? path.join(path.dirname(process.execPath), "BotWorker.js")
    : path.join(__dirname, "BotWorker.js");

  const env = {
    ...process.env,
    HOME: accountDir,
    APPDATA: accountDir,
    RF_UUID: account.uuid,
    RF_IGN: account.ign,
    RF_ACCOUNTS_DIR: ACCOUNTS_DIR,
  };

  rl.close();
  process.stdin.pause();

  const worker = spawn(
    process.execPath,
    [workerPath],
    {
      env,
      stdio: ["inherit", "inherit", "inherit"],
    },
  );

  worker.on("exit", (code) => {
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
  if (listAccountUUIDs().length === 0) {
    console.log("\nNo accounts saved yet. Add one first.");
    return mainMenu();
  }

  const accounts = await buildAccountList();

  console.log("\n-- Select Account -----------------------------");
  accounts.forEach((acc, i) => {
    const status = acc.valid ? "[VALID]" : "[INVALID]";
    console.log(`  ${i + 1}) ${acc.ign.padEnd(20)} ${status}`);
  });
  console.log("  0) Back");
  console.log("-----------------------------------------------");

  const input = (await ask("Choice: ")).trim();
  const idx = parseInt(input, 10);

  if (input === "0") return mainMenu();
  if (isNaN(idx) || idx < 1 || idx > accounts.length) {
    console.log("Invalid choice.");
    return selectAccountMenu();
  }

  const chosen = accounts[idx - 1];
  if (!chosen.valid) {
    console.log(
      "Warning: cache is INVALID -- you will be prompted to log in via Microsoft again.",
    );
  }
  console.log(
    `\nStarting bot as ${chosen.ign}... (type "help" for runtime commands)\n`,
  );

  runBot(chosen);
}

async function addAccountMenu() {
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
  if (listAccountUUIDs().length === 0) {
    console.log("\nNo accounts to delete.");
    return mainMenu();
  }

  const accounts = await buildAccountList();

  console.log("\n-- Delete Account -----------------------------");
  accounts.forEach((acc, i) => {
    const status = acc.valid ? "[VALID]" : "[INVALID]";
    console.log(`  ${i + 1}) ${acc.ign.padEnd(20)} ${status}`);
  });
  console.log("  0) Back");
  console.log("-----------------------------------------------");

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
mainMenu();
