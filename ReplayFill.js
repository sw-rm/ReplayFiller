const mineflayer = require('mineflayer');

const bot = mineflayer.createBot({
    host: 'hypixel.net',
    version: '1.8.9',
    auth: 'microsoft',
    skipValidation: true
});

let hasRunHousing = false;

bot.once('spawn', () => {
  console.log('Bot spawned (first time only), waiting for Hypixel welcome...');
  
  setTimeout(() => {
    console.log('Starting /housing random spam loop...');
    let count = 0;
    const interval = setInterval(() => {
        if (count >= 999) {
            clearInterval(interval);
            console.log('Completed 999 /housing random commands.');
            return;
        }
        count++; 
        bot.chat('/housing random');
        console.log(`Sent /housing random (${count}/999)`);
    }, 3750);
}, 10000);
});

bot.on('kicked', (reason) => console.log('Kicked:', reason));
bot.on('error', (err) => console.log('Error:', err));
