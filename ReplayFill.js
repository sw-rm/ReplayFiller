const path  = require('path');
const fs    = require('fs');
const https = require('https');

// -- Cache dirs being set ------------------------------------------------------
const ACCOUNTS_DIR = path.join(__dirname, 'accounts');
const CACHE_DIR    = path.join(__dirname, 'auth-cache');
const TOKEN_DIR    = path.join(CACHE_DIR, '.minecraft', 'nmp-cache');

[ACCOUNTS_DIR, TOKEN_DIR].forEach(dir => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

process.env.APPDATA = CACHE_DIR; // windows
process.env.HOME    = CACHE_DIR; // linux / mac

const mineflayer = require('mineflayer');
const readline   = require('readline');

// -- Readline ------------------------------------------------------------------
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise(resolve => rl.question(q, resolve));

// -- State ---------------------------------------------------------------------
let bot             = null;
let currentInterval = null;
let count           = 0;
let isPaused        = false;
let activeAccount   = null;

// -- Account metadata helpers  -------------------------------------------------
function listAccountUUIDs() {
    if (!fs.existsSync(ACCOUNTS_DIR)) return [];
    return fs.readdirSync(ACCOUNTS_DIR).filter(f => 
        fs.statSync(path.join(ACCOUNTS_DIR, f)).isDirectory()
    );
}

function metaPath(uuid) {
    return path.join(ACCOUNTS_DIR, uuid, 'meta.json');
}

function readMeta(uuid) {
    try { return JSON.parse(fs.readFileSync(metaPath(uuid), 'utf8')); }
    catch { return null; }
}

function writeMeta(uuid, data) {
    fs.writeFileSync(metaPath(uuid), JSON.stringify(data, null, 2));
}

function accountCacheDir(uuid) {
    return path.join(ACCOUNTS_DIR, uuid);
}

function ensureAccountDir(uuid) {
    const dir = accountCacheDir(uuid);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return dir;
}

function deleteAccount(uuid) {
    const dir = accountCacheDir(uuid);
    if (!fs.existsSync(dir)) return false;
    fs.rmSync(dir, { recursive: true, force: true});
    return true;
}

// -- Cache validity check ------------------------------------------------------
function isCacheValid(uuid) {
    const dir = accountCacheDir(uuid);
    if (!fs.existsSync(dir)) return false;

    const files = fs.readdirSync(dir).filter(f => f.endsWith('_mca-cache.json'));
    for (const filename of files) {
        try {
            const data = JSON.parse(fs.readFileSynce(path.join(dir, filename), 'utf8'));
            const entries = typeof data === 'object' ? Object.values(data) : [];
            for (const entry of entries) {
                const expires = entry?.accessTokenExpiresOn ?? entry?.obtainedOn;
                if (!expires) continue;
                if (new Date(expires) > new Date()) return true;
            }
        } catch {}
    } 
    return false;
}

// -- Mojang API ----------------------------------------------------------------
function httpsGet(url) {
    return new Promise((resolve, reject) => {
        https.get(url, { headers: { 'User-Agent': 'ReplayFill/1.0' } }, (res) => {
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => {
                try { resolve(JSON.parse(body)); }
                catch { resolve(null); }
            });
        }).on('error', reject);
    });
}

// Returns current IGN for a UUID, or null if fails
async function fetchIGN(uuid) {
    try {
        const stripped = uuid.replace(/-/g, '');
        const data     = await httpsGet(`https://sessionserver.mojang.com/session/minecraft/profile/${stripped}`);
        return data?.name ?? null;
    } catch {
        return null;
    }
}

// Returns { uuid, ign } for a given IGN, or null if fails
async function fetchProfileFromIGN(ign) {
    try{
        const data = await httpsGet(`https://api.mojang.com/users/profiles/minecraft/${encodeURIComponent(ign)}`);
        if (!data?.id || !data?.name) return null;
        const s = data.id;
        const uuid = `${s.slice(0,8)}-${s.slice(8,12)}-${s.slice(12,16)}-${s.slice(16,20)}-${s.slice(20)}`;
        return { uuid, ign: data.name };
    } catch {
        return null;
    }
}

// -- Build account list --------------------------------------------------------
async function buildAccountList() {
    const uuids = listAccountUUIDs();
    console.log('  Fetching account info...');

    const accounts = await Promise.all(uuids.map(async (uuid) => {
        const meta    = readMeta(uuid);
        const valid   = isCacheValid(uuid);
        const liveIGN = await fetchIGN(uuid);
        const ign     = liveIGN ?? meta?.ignAtAdd ?? uuid; // fallback just incase

        if (liveIGN && meta) {
            writeMeta(uuid, { ...meta, ignAtAdd: liveIGN });
        }

        return { uuid, ign, valid };
    }));

    return accounts;
}

// -- Bot -----------------------------------------------------------------------
function createBot() {
    if (!activeAccount) {console.log('No account selected.'); return; }

    bot = mineflayer.createBot({
        host:           'hypixel.net',
        version:        '1.8.9',
        auth:           'microsoft',
        skipValidation: true,
        cachePath:      activeAccount.cacheDir
    });
    
    bot.once('spawn', () => {
        console.log(`[${activeAccount.ign}] Bot spawned, waiting for Hypixel welcome...`);
        setTimeout(() => { if (!isPaused) startHousingLoop(); }, 10000);
    })
    
    bot.on('kicked', (reason) => {
        console.log(`[${activeAccount.ign}] Kicked:`, reason);
        clearLoop();
    });
    
    bot.on('error', (err) => {
        console.log(`[${activeAccount.ign}] Error:`, err);
        clearLoop();
    });
}

function clearLoop() {
    if (currentInterval) { clearInterval(currentInterval); currentInterval = null; }
}

function startHousingLoop() {
    clearLoop();
    console.log(`[${activeAccount.ign}] Starting filling loop...`);
    currentInterval = setInterval(() => {
        if (count >= 999) {
            clearInterval(currentInterval);
            currentInterval = null;
            console.log(`[${activeAccount.ign}] Completed 999 fill commands.`);
            return;
        }
        
        if (bot && !isPaused) {
            count++;
            bot.chat('/housing random');
            console.log(`[${activeAccount.ign}] Sent fill command (${count}/999)`);
        }
    }, 3750);
}

function stopBot() {
    isPaused = true;
    clearLoop();
    if (bot) { bot.quit('Manual stop'); bot = null; }
    console.log(`Bot stopped. Progress: ${count}/999. Type 'continue' to resume or 'menu' to go back.`);
}

function continueBot() {
    if (!isPaused) { console.log('Bot is not paused.'); return; }
    isPaused = false;
    console.log(`Resuiming [${activeAccount.ign}]... Progress: ${count}/999`);
    createBot();
}

// -- Menus ---------------------------------------------------------------------
async function mainMenu() {
    console.log('\n==================================');
    console.log('     ReplayFill  -  Main Menu     ');
    console.log('==================================');
    console.log('  1) Select account & start');
    console.log('  2) Add a new account');
    console.log('  3) Delete an account');
    console.log('  4) Exit');
    console.log('----------------------------------');

    const choice = (await ask('Choice: ')).trim();
    switch (choice) {
        case '1': return selectAccountMenu();
        case '2': return addAccountMenu();
        case '3': return deleteAccountMenu();
        case '4':
            console.log('Goodbye.');
            rl.close();
            process.exit(0);
        default:
            console.log('Invalid choice.');
            return mainMenu();
    }
}

async function selectAccountMenu() {
    const uuids = listAccountUUIDs();
    if (uuids.length === 0) {
        console.log('\nNo accounts saved yet. Add one first.');
        return mainMenu();
    }

    const accounts = await buildAccountList();

    console.log('\n-- Select Account -----------------------------');
    accounts.forEach((acc, i) => {
        const status = acc.valid? '[VALID]' : '[INVALID]';
        console.log(`  ${i + 1}) ${acc.ign.padEnd(20)} ${status}`);
    });
    console.log('  0) Back');
    console.log('------------------------------------------------');

    const input = (await ask('Choice: ')).trim();
    const idx   = parseInt(input, 10);

    if (input === '0') return mainMenu();
    if (isNaN(idx) || idx < 1 || idx > accounts.length) {
        console.log('Invalid choice.');
        return selectAccountMenu();
    }

    const chosen  = accounts[idx - 1];
    activeAccount = { uuid: chosen.uuid, ign: chosen.ign, cacheDir: accountCacheDir(chosen.uuid) };
    count         = 0;
    isPaused      = false;

    console.log(`\nSelect: ${chosen.ign} (${chosen.uuid})`);
    if (!chosen.valid) {
        console.log('Warning: cache is INVALID - you will be prompeted to log in via Microsoft again.');
    }
    console.log('Starting bot... (type "help" for runtime commands)\n');
    createBot();
    runtimeLoop();
}

async function addAccountMenu() {
    console.log('\n-- Add Account --------------------------------');
    console.log('Enter the Minecraft IGN of the account to add.');
    const rawIGN = (await ask('IGN: ')).trim();

    if (!rawIGN) {
        console.log('IGN cannot be empty.');
        return addAccountMenu();
    }

    console.log('  Looking up account...');
    const profile = await fetchProfileFromIGN(rawIGN);
    if (!profile) {
        console.log('Could not find a Minecraft account with that IGN. Please check and try again.');
        return addAccountMenu();
    }

    const { uuid, ign} = profile;

    if (listAccountUUIDs().includes(uuid)) {
        console.log(`Account "${ign}" (${uuid}) is already saved.`);
        return mainMenu();
    }

    ensureAccountDir(uuid);
    writeMeta(uuid, { uuid, ignAtAdd: ign });

    console.log(`\nAccount added : ${ign} (${uuid})`);
    console.log('When you select it, you will be prompted to log in via Microsoft.');
    return mainMenu();
}

async function deleteAccountMenu() {
    const uuids = listAccountUUIDs();
    if (uuids.length === 0) {
        console.log('\nNo accounts to delete.');
        return mainMenu();
    }

    const accounts = await buildAccountList();

    console.log('\n-- Delete Account -----------------------------');
    accounts.forEach((acc, i) => {
        const status = acc.valid ? '[VALID]' : '[INVALID]';
        console.log(`  ${i+1}) ${acc.ign.padEnd(20)} ${status}`);
    });
    console.log('  0) Back');
    console.log('------------------------------------------------');

    const input = (await ask('Choice: ')).trim();
    const idx   = parseInt(input, 10);

    if (input === '0') return mainMenu();
    if (isNaN(idx) || idx < 1 || idx > accounts.length) {
        console.log('Invalid choice.');
        return deleteAccountMenu();
    }

    const chosen = accounts[idx - 1];
    const confirm = (await ask(`Delete "${chosen.ign}" (${chosen.uuid}) and its cached tokens? (yes/no): `)).trim().toLowerCase();

    if (confirm === 'yes' || confirm === 'y') {
        deleteAccount(chosen.uuid);
        console.log(`Account "${chosen.ign}" deleted.`);
    } else {
        console.log('Cancelled.');
    }

    return mainMenu();
    
}

// -- Runtime command loop ------------------------------------------------------
function runtimeLoop() {
    rl.removeAllListeners('line');
    rl.on('line', (input) => {
        const cmd = input.trim().toLowerCase();
        switch (cmd) {
            case 'stop':     stopBot(); break;
            case 'continue': continueBot(); break;
            case 'status':
                console.log(`Account: ${activeAccount.ign} | Status: ${isPaused ? "Paused" : "Running"} | Progress: ${count}/999`);
                break;
            case 'menu':
                stopBot();
                activeAccount = null;
                count = 0;
                isPaused = false;
                rl.removeAllListeners('line');
                mainMenu();
                break;
            case 'help':
                console.log('Runtime commands: stop, continue, status, menu, help, quit');
                break;
            case 'quit':
            case 'exit':
                if (bot) bot.quit('Manual exit');
                rl.close();
                process.exit(0);
                break;
            default:
                if (cmd !== '') console.log(`Unknown command: ${cmd}. Type "help" for available commands.`);
        }
    });
}

// -- Graceful shutdown ---------------------------------------------------------
process.on('SIGINT', () => {
    console.log('\nShutting down...');
    if (bot) bot.quit('Process terminated');
    rl.close();
    process.exit(0);
});

// -- Entry point ---------------------------------------------------------------
mainMenu();