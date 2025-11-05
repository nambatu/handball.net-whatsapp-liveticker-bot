// app.js - Main Application File

require('dotenv').config();
const path = require('path');
const qrcode = require('qrcode-terminal');
const { Client, LocalAuth } = require('whatsapp-web.js');
const { loadSeenTickers, saveSeenTickers, loadScheduledTickers, saveScheduledTickers } = require('./utils.js');
// Import the new getGameIdFromUrl helper
const { initializePolling, masterScheduler, dispatcherLoop, startPolling, beginActualPolling, getGameIdFromUrl } = require('./polling.js');

// --- GLOBAL STATE ---
const activeTickers = new Map();
const jobQueue = [];
const SEEN_FILE = path.resolve(__dirname, 'seen_tickers.json');
const SCHEDULE_FILE = path.resolve(__dirname, 'scheduled_tickers.json');

// --- WHATSAPP CLIENT INITIALIZATION ---
// Creates the WhatsApp client instance
const client = new Client({
    // Uses local file system to save session data, avoiding QR scan on every start
    authStrategy: new LocalAuth(),
    puppeteer: {
        headless: true, // Run the underlying browser without a visible window
        args: ['--no-sandbox', '--disable-setuid-sandbox'], // Necessary arguments for running on Linux/Raspberry Pi
        executablePath: '/usr/bin/chromium' // Specify path to Chromium on Raspberry Pi OS
    }
/* ,
    // Stabilizes connection by using a specific remote version of WhatsApp Web
    webVersionCache: {
        type: 'remote',
        remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2413.51.html'
    }
*/        
});

// --- INITIALIZE MODULES ---
// Pass shared state variables (maps, queues, file paths) to the polling module
// This allows polling.js to access and modify the central state.
initializePolling(activeTickers, jobQueue, client, SEEN_FILE, SCHEDULE_FILE);

// --- WHATSAPP CLIENT EVENT HANDLERS ---

/**
 * Handles the QR code event.
 * Displays the QR code in the terminal for the user to scan with their phone.
 */
client.on('qr', qr => {
    qrcode.generate(qr, { small: true });
    console.log('QR-Code generiert. Scannen Sie diesen mit WhatsApp.');
});

/**
 * Handles the 'ready' event, fired when the client successfully connects to WhatsApp.
 * Loads previously seen events and re-schedules any tickers that were planned.
 */
client.on('ready', () => {
    console.log('WhatsApp-Client ist bereit!');
    // Load seen event IDs from the JSON file into the activeTickers map
    loadSeenTickers(activeTickers, SEEN_FILE);

    // Load scheduled tickers from the JSON file
    const scheduledTickersData = loadScheduledTickers(SCHEDULE_FILE);
    const now = Date.now();
    let rescheduledCount = 0;

    // Iterate through the loaded schedule data
    for (const chatId in scheduledTickersData) {
        const scheduleData = scheduledTickersData[chatId];
        const startTime = new Date(scheduleData.startTime);
        const delay = startTime.getTime() - now; // Calculate remaining time until start

        // --- FIX: Ensure gameId is set on restart ---
        const gameId = getGameIdFromUrl(scheduleData.meetingPageUrl);
        if (!gameId) {
            console.warn(`[${chatId}] Überspringe geladenen Ticker, ungültige URL: ${scheduleData.meetingPageUrl}`);
            continue; // Skip this ticker
        }
        // --- END FIX ---

        // Create or get the state object for this ticker
        const tickerState = activeTickers.get(chatId) || { seen: new Set() };
        // Populate state with schedule data (URL, group name etc.)
        tickerState.meetingPageUrl = scheduleData.meetingPageUrl;
        tickerState.gameId = gameId; // --- ADDED THIS LINE ---
        tickerState.groupName = scheduleData.groupName;
        tickerState.mode = scheduleData.mode; // Restore the mode
        tickerState.recapEvents = []; // Initialize recap buffer (not recapMessages)
        tickerState.isPolling = false; // It's not polling yet
        activeTickers.set(chatId, tickerState); // Ensure it's in the main map

        if (delay > 0) {
            // If start time is still in the future, set a new timeout
            console.log(`[${chatId}] Lade geplante Aufgabe. Startet in ${Math.round(delay / 60000)} Minuten.`);
            tickerState.isScheduled = true;
            tickerState.scheduleTimeout = setTimeout(() => {
                // When timer fires, call the function to start actual polling
                beginActualPolling(chatId);
            }, delay);
            rescheduledCount++;
        } else {
            // If start time has passed while bot was offline, start polling immediately
            console.log(`[${chatId}] Geplante Startzeit verpasst. Starte Polling sofort.`);
            beginActualPolling(chatId); // Call function to start polling now
        }
    }
    if (rescheduledCount > 0) {
        console.log(`${rescheduledCount} Ticker erfolgreich neu geplant.`);
    }
});

/**
 * Handles the 'disconnected' event.
 * Marks all tickers as inactive and saves the current seen events state.
 */
client.on('disconnected', (reason) => {
    console.log('Client getrennt:', reason);
    // Mark all tickers as stopped to prevent scheduler/worker activity
    activeTickers.forEach(ticker => {
        ticker.isPolling = false;
        ticker.isScheduled = false; // Also mark scheduled as false
        if (ticker.scheduleTimeout) clearTimeout(ticker.scheduleTimeout); // Clear any pending timers
        if (ticker.recapIntervalId) clearInterval(ticker.recapIntervalId); // Clear recap timers
     });
    saveSeenTickers(activeTickers, SEEN_FILE); // Save current seen state
    // Note: Scheduled tickers are NOT saved here, only on successful scheduling via !start
});

// --- MESSAGE LISTENER ---
/**
 * Handles incoming WhatsApp messages.
 * Parses commands (!start, !stop, !reset) and executes corresponding actions.
 */
client.on('message', async msg => {
    // Ignore messages not starting with '!'
    if (!msg.body.startsWith('!')) return;

    // Ensure the message is from a group chat
    const chat = await msg.getChat();
    if (!chat.isGroup) {
        await msg.reply('Fehler: Befehle funktionieren nur in Gruppen.');
        return;
    }

    // Parse message content
    const chatId = chat.id._serialized; // Unique ID for the group chat
    const args = msg.body.split(' ');   // Split message into words
    const command = args[0].toLowerCase(); // Get the command (e.g., '!start')
    const groupName = chat.name;          // Get the name of the group

    // --- !start Command ---
    if (command === '!start1' && args.length >= 2) {
        // Prevent starting if already active or scheduled
        if (activeTickers.has(chatId) && (activeTickers.get(chatId).isPolling || activeTickers.get(chatId).isScheduled)) {
            await msg.reply('In dieser Gruppe läuft oder ist bereits ein Live-Ticker geplant. Stoppen oder resetten Sie ihn zuerst.');
            return;
        }
        const meetingPageUrl = args[1]; // Get the URL from the command
        const mode = (args[2] && args[2].toLowerCase() === 'recap') ? 'recap' : 'live'; // Determine mode (live or recap)

        try {
            // Call the scheduling function from polling.js
            await startPolling(meetingPageUrl, chatId, groupName, mode);
        } catch (error) {
            // Handle critical errors during scheduling/startup
            console.error(`[${chatId}] Kritischer Fehler beim Starten des Tickers:`, error);
            await msg.reply('Ein kritischer Fehler ist aufgetreten und der Ticker konnte nicht gestartet werden.');
            activeTickers.delete(chatId); // Clean up failed state
        }
    }
    // --- !stop Command ---
    else if (command === '!stop1') {
        const tickerState = activeTickers.get(chatId);
        let wasStopped = false; // Flag to check if action was taken

        if (tickerState) {
            // If it was scheduled, clear the timeout and remove from schedule file
            if (tickerState.isScheduled && tickerState.scheduleTimeout) {
                clearTimeout(tickerState.scheduleTimeout);
                tickerState.isScheduled = false;
                const currentSchedule = loadScheduledTickers(SCHEDULE_FILE);
                if (currentSchedule[chatId]) {
                    delete currentSchedule[chatId];
                    saveScheduledTickers(currentSchedule, SCHEDULE_FILE);
                }
                wasStopped = true;
            }
            // If it was polling, mark as stopped and clear recap timer
            if (tickerState.isPolling) {
                tickerState.isPolling = false;
                if (tickerState.recapIntervalId) clearInterval(tickerState.recapIntervalId);
                wasStopped = true;
            }
            // Remove any pending jobs for this chat from the queue
            const index = jobQueue.findIndex(job => job.chatId === chatId);
            if (index > -1) jobQueue.splice(index, 1);
        }

        // Send confirmation only if something was actually stopped
        if (wasStopped) {
            await client.sendMessage(chatId, 'Laufender/geplanter Live-Ticker in dieser Gruppe gestoppt.');
            console.log(`Live-Ticker für Gruppe "${groupName}" (${chatId}) gestoppt.`);
        } else {
            await msg.reply('In dieser Gruppe läuft derzeit kein Live-Ticker.');
        }
    }
    // --- !reset Command ---
    else if (command === '!reset1') {
        const tickerState = activeTickers.get(chatId);

        // Stop timers and polling if active/scheduled
        if (tickerState) {
            if (tickerState.scheduleTimeout) clearTimeout(tickerState.scheduleTimeout);
            if (tickerState.recapIntervalId) clearInterval(tickerState.recapIntervalId);
            tickerState.isPolling = false;
            tickerState.isScheduled = false;
            // Remove pending jobs
            const index = jobQueue.findIndex(job => job.chatId === chatId);
            if (index > -1) jobQueue.splice(index, 1);
        }

        // Always remove from active tickers map (memory)
        activeTickers.delete(chatId);
        // Always save the seen tickers file (to remove the entry from persistence)
        saveSeenTickers(activeTickers, SEEN_FILE);

        // Also remove from the schedule file persistence
        const currentSchedule = loadScheduledTickers(SCHEDULE_FILE);
        if (currentSchedule[chatId]) {
            delete currentSchedule[chatId];
            saveScheduledTickers(currentSchedule, SCHEDULE_FILE);
        }

        await msg.reply('Alle Ticker-Daten für diese Gruppe wurden zurückgesetzt.');
        console.log(`Ticker-Daten für Gruppe "${groupName}" (${chatId}) wurden manuell zurückgesetzt.`);
    }
    // --- Handle !start command without a URL ---
    else if (command === '!start1') {
        await msg.reply(`Fehler: Bitte geben Sie eine gültige URL an. Format:\n\n!start <URL> [recap]`);
    }
    // --- Optional: Handle other unknown commands ---
    // else {
    //     await msg.reply(`Unbekannter Befehl: ${command}\nVerfügbare Befehle: !start <URL> [recap], !stop, !reset`);
    // }
});

// --- MAIN EXECUTION ---
// Start the Master Scheduler to add jobs periodically
setInterval(masterScheduler, 20000); // Check every 20 seconds
// Start the Dispatcher Loop to process jobs from the queue
setInterval(dispatcherLoop, 500); // Check every 0.5 seconds
// Initialize the WhatsApp client and start listening
client.initialize();

// --- GRACEFUL SHUTDOWN HANDLER ---
/**
 * Handles the SIGINT signal (e.g., Ctrl+C in terminal).
 * Marks tickers as stopped, saves current state, and destroys the client.
 */
process.on('SIGINT', async () => {
    console.log('(SIGINT) Empfangen. Bot wird heruntergefahren...');
    // Mark all tickers as stopped to prevent scheduler/worker activity during shutdown
    activeTickers.forEach(ticker => {
        ticker.isPolling = false;
        ticker.isScheduled = false;
        if (ticker.scheduleTimeout) clearTimeout(ticker.scheduleTimeout);
        if (ticker.recapIntervalId) clearInterval(ticker.recapIntervalId);
     });
    saveSeenTickers(activeTickers, SEEN_FILE); // Save final seen state
    // Note: Schedule file is intentionally NOT cleared here, allowing restarts
    if (client) await client.destroy(); // Properly close the WhatsApp connection
    process.exit(0); // Exit the Node.js process
});