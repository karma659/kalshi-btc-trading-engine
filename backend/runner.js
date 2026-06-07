/**
 * 24/7 Bot Orchestrator
 * 
 * Keeps the Kalshi trading engine strictly confined to the later part of the hour.
 * Starts index.js at XX:38, lets it run, and waits for it to automatically exit 
 * at XX:59 before sleeping until the next XX:38.
 */

const { spawn } = require('child_process');

function getMinutes() {
  return new Date().getUTCMinutes();
}

function waitAndRun() {
  const mins = getMinutes();

  // If we are between XX:30 and XX:58, launch the bot immediately!
  // (The bot's internal index.js logic already forces a graceful exit at XX:59)
  if (mins >= 38 && mins < 59) {
    console.log(`\n[RUNNER] Time is XX:${mins}. Starting trading engine...`);
    const bot = spawn('node', ['index.js'], { stdio: 'inherit' });

    bot.on('close', (code) => {
      console.log(`\n[RUNNER] Engine exited (Code ${code}).`);
      scheduleNext();
    });
  } else {
    scheduleNext();
  }
}

function scheduleNext() {
  const now = new Date();
  const mins = now.getUTCMinutes();

  // If the bot crashed during the active window, restart it after 10 seconds.
  if (mins >= 38 && mins < 59) {
    console.log(`[RUNNER] Engine stopped early at XX:${mins}. Restarting in 10 seconds...`);
    setTimeout(waitAndRun, 10000);
    return;
  }

  // Otherwise, calculate exact milliseconds to hit the next XX:38:00 exactly
  const minsToWait = (mins < 38) ? (38 - mins) : (60 - mins + 38);
  const msToWait = (minsToWait * 60 * 1000) - (now.getUTCSeconds() * 1000) - now.getUTCMilliseconds();
  
  console.log(`[RUNNER] Currently XX:${mins}. Pausing operations for ~${Math.round(msToWait / 60000)} minutes until XX:38...`);
  setTimeout(waitAndRun, msToWait);
}

console.log('[RUNNER] 24/7 Orchestrator Started. Target Window: XX:38 to XX:59');
waitAndRun();