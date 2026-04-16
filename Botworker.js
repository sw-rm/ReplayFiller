// BotWorker.js - runs as a child process with HOME/APPDATA already set to accounts/<uuid>/ by the parent
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

// -- Imports ------------------------------------------------------------------
const path = require("path");
const fs = require("fs");

// -- Config -------------------------------------------------------------------
const uuid = process.env.RF_UUID;
const ign = process.env.RF_IGN;
const ACCOUNTS_DIR = process.env.RF_ACCOUNTS_DIR;

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

// -- Helpers ------------------------------------------------------------------
function tokenDir() {
  const base = path.join(ACCOUNTS_DIR, uuid);
  if (process.platform === "darwin")
    return path.join(base, "Library", "Application Support", "minecraft", "nmp-cache");
  return path.join(base, ".minecraft", "nmp-cache");
}
function createBot() {
  const tDir = tokenDir();
  if (!fs.existsSync(tDir)) fs.mkdirSync(tDir, { recursive: true });

  bot = mineflayer.createBot({
    host: "hypixel.net",
    version: "1.8.9",
    auth: "microsoft",
    skipValidation: true,
    cachePath: tDir,
  });

  bot.once("spawn", () => {
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

function startHousingLoop() {
  clearLoop();
  console.log(`[${ign}] Starting /housing random loop...`);
  currentInterval = setInterval(() => {
    if (count >= 999) {
      clearLoop();
      console.log(`[${ign}] Completed 999 /housing random commands.`);
      return;
    }
    if (bot && !isPaused) {
      count++;
      bot.chat("/housing random");
      console.log(`[${ign}] Sent /housing random (${count}/999)`);
    }
  }, 3750);
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
    `Bot stopped. Progress: ${count}/999. Type 'continue' to resume or 'menu' to go back.`,
  );
}

function continueBot() {
  if (!isPaused) {
    console.log("Bot is not paused.");
    return;
  }
  isPaused = false;
  console.log(`Resuming [${ign}]... Progress: ${count}/999`);
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
        `Account: ${ign} | Status: ${isPaused ? "Paused" : "Running"} | Progress: ${count}/999`,
      );
      break;
    case "menu":
      stopBot();
      rl.close();
      process.exit(42); // 42 = signal to parent to return to menu
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
      if (cmd !== "")
        console.log(
          `Unknown command: ${cmd}. Type "help" for available commands.`,
        );
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
