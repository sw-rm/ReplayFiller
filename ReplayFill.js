const mineflayer = require('mineflayer');
const readline = require('readline');

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

let bot = null;
let currentInterval = null;
let count = 0;
let isPaused = false;

const botConfig = {
    host: 'hypixel.net',
    version: '1.8.9',
    auth: 'microsoft',
    skipValidation: true
};

function createBot() {
    bot = mineflayer.createBot(botConfig);
    
    bot.once('spawn', () => {
        console.log('Bot spawned, waiting for Hypixel welcome...');
        
        setTimeout(() => {
            if (!isPaused) {
                startHousingLoop();
            }
        }, 10000);
    });
    
    bot.on('kicked', (reason) => {
        console.log('Kicked:', reason);
        if (currentInterval) {
            clearInterval(currentInterval);
            currentInterval = null;
        }
    });
    
    bot.on('error', (err) => {
        console.log('Error:', err);
        if (currentInterval) {
            clearInterval(currentInterval);
            currentInterval = null;
        }
    });
}

function startHousingLoop() {
    if (currentInterval) {
        clearInterval(currentInterval);
    }
    
    console.log('Starting /housing random spam loop...');
    currentInterval = setInterval(() => {
        if (count >= 999) {
            clearInterval(currentInterval);
            currentInterval = null;
            console.log('Completed 999 /housing random commands.');
            return;
        }
        
        if (bot && !isPaused) {
            count++;
            bot.chat('/housing random');
            console.log(`Sent /housing random (${count}/999)`);
        }
    }, 3750);
}

function stopBot() {
    isPaused = true;
    console.log('Stopping bot and pausing loop...');
    
    if (currentInterval) {
        clearInterval(currentInterval);
        currentInterval = null;
    }
    
    if (bot) {
        bot.quit('Manual stop');
        bot = null;
    }
    
    console.log(`Bot stopped. Progress: ${count}/999. Type 'continue' to resume.`);
}

function continueBot() {
    if (!isPaused) {
        console.log('Bot is not paused.');
        return;
    }
    
    isPaused = false;
    console.log(`Continuing bot... Progress: ${count}/999`);
    createBot();
}

rl.on('line', (input) => {
    const command = input.trim().toLowerCase();
    
    if (command === 'stop') {
        stopBot();
    } else if (command === 'continue') {
        continueBot();
    } else if (command === 'status') {
        console.log(`Status: ${isPaused ? 'Paused' : 'Running'}, Progress: ${count}/999`);
    } else if (command === 'help') {
        console.log('Commands: stop, continue, status, help, quit');
    } else if (command === 'quit' || command === 'exit') {
        if (bot) {
            bot.quit('Manual exit');
        }
        rl.close();
        process.exit(0);
    } else if (command !== '') {
        console.log(`Unknown command: ${command}. Type "help" for available commands.`);
    }
});

process.on('SIGINT', () => {
    console.log('\nReceived SIGINT. Shutting down gracefully...');
    if (bot) {
        bot.quit('Process terminated');
    }
    rl.close();
    process.exit(0);
});

console.log('Bot starting... Type "help" for available commands.');
createBot();
