// polling.js
const axios = require('axios');
// const puppeteer = require('puppeteer'); // --- REMOVED! ---
// Import utility functions, including those for saving/loading schedule data and formatting
const { saveSeenTickers, formatEvent, saveScheduledTickers, loadScheduledTickers, formatRecapEventLine } = require('./utils.js');
const { generateGameSummary, extractGameStats } = require('./ai.js'); // Import AI functions
const { EVENT_MAP } = require('./config.js'); // Import event definitions


// --- SHARED STATE (Initialized by app.js) ---
let activeTickers, jobQueue, client, seenFilePath, scheduleFilePath;

// --- WORKER POOL CONFIG ---
let lastPolledIndex = -1; // Tracks the index of the last ticker polled by the scheduler (for round-robin)
let activeWorkers = 0; // Counts currently running workers
const MAX_WORKERS = 2; // Tunable: Maximum number of concurrent Axios requests
const PRE_GAME_START_MINUTES = 5; // How many minutes before scheduled start time to begin active polling
const RECAP_INTERVAL_MINUTES = 5; // Frequency of sending recap messages in 'recap' mode

/**
 * Initializes the polling module with shared state variables from app.js.
 */
function initializePolling(tickers, queue, whatsappClient, seenFile, scheduleFile) {
    activeTickers = tickers;
    jobQueue = queue;
    client = whatsappClient;
    seenFilePath = seenFile;
    scheduleFilePath = scheduleFile;
}

// --- NEW HELPER FUNCTIONS ---

/**
 * Extracts the game ID (e.g., "sportradar.dhbdata.01234") from a handball.net URL.
 * @param {string} url - The user-provided URL.
 * @returns {string|null} - The extracted game ID or null.
 */
function getGameIdFromUrl(url) {
    // Matches URLs like:
    // https://www.handball.net/spiele/spiel/sportradar.dhbdata.01234
    // https://www.handball.net/a/matches/sportradar.dhbdata.01234/liveticker
    const regex = /sportradar\.dhbdata\.\d+/;
    const match = url.match(regex);
    return match ? match[0] : null;
}

/**
 * Builds the full JSON data URL from a game ID.
 * @param {string} gameId - The game ID (e.g., "sportradar.dhbdata.01234").
 * @returns {string} - The full API URL.
 */
function buildDataUrl(gameId) {
    return `https://www.handball.net/a/sportdata/1/games/${gameId}/combined?`;
}

// --- END NEW HELPER FUNCTIONS ---


/**
 * Creates the initial ticker state and adds a 'schedule' job to the queue.
 * This is the entry point called by the !start command.
 * @param {string} meetingPageUrl - The URL of the handball.net game webpage.
 * @param {string} chatId - The WhatsApp chat ID where the ticker runs.
 * @param {string} groupName - The name of the WhatsApp group (for AI).
 * @param {('live'|'recap')} mode - The desired ticker mode ('live' or 'recap').
 */
async function queueTickerScheduling(meetingPageUrl, chatId, groupName, mode) {
    // Validate the URL format early
    const gameId = getGameIdFromUrl(meetingPageUrl);
    if (!gameId) {
        await client.sendMessage(chatId, 'Fehler: Die angegebene URL ist keine gültige handball.net Spiel-URL.');
        return;
    }

    // Create initial state in memory
    const tickerState = activeTickers.get(chatId) || { seen: new Set() };
    tickerState.isPolling = false; // Not polling yet
    tickerState.isScheduling = true; // Mark as *being* scheduled
    tickerState.meetingPageUrl = meetingPageUrl; // This is the user-facing URL
    tickerState.gameId = gameId; // --- NEW: Store the extracted Game ID
    tickerState.groupName = groupName;
    tickerState.mode = mode;
    tickerState.recapEvents = []; // Initialize array for raw recap events
    activeTickers.set(chatId, tickerState); // Store the initial state

    // Add a 'schedule' job to the queue for the worker
    jobQueue.push({
        type: 'schedule', // Job type identifier
        chatId,
        gameId, // Pass the gameId to the worker
        // Pass necessary info for the worker to complete scheduling
        groupName, // Needed for logging/AI if fetch fails before state is fully set
        mode,
        jobId: Date.now() // Unique ID for logging
    });

    console.log(`[${chatId}] Planungs-Job zur Warteschlange hinzugefügt. Aktuelle Länge: ${jobQueue.length}`);
    // Send immediate feedback to the user
    await client.sendMessage(chatId, `⏳ Ticker-Planung für "${groupName}" wird bearbeitet...`);
}


/**
 * Activates the actual polling loop for a ticker.
 * (This function is largely unchanged, it just works with the new tickerState)
 * @param {string} chatId - The WhatsApp chat ID.
 */
async function beginActualPolling(chatId) {
    const tickerState = activeTickers.get(chatId);
    // Safety checks
    if (!tickerState) {
        console.warn(`[${chatId}] Ticker-Status nicht gefunden beim Versuch, das Polling zu starten.`);
        const currentSchedule = loadScheduledTickers(scheduleFilePath);
         if (currentSchedule[chatId]) {
             delete currentSchedule[chatId];
             saveScheduledTickers(currentSchedule, scheduleFilePath);
             console.log(`[${chatId}] Überreste aus Planungsdatei entfernt.`);
         }
        return;
    }
    if (tickerState.isPolling) {
        console.log(`[${chatId}] Polling ist bereits aktiv.`);
        return;
    }

    console.log(`[${chatId}] Aktiviere Polling (Modus: ${tickerState.mode}).`);
    tickerState.isPolling = true; // Mark as actively polling
    tickerState.isScheduled = false; // No longer just scheduled

    // Remove from the schedule file persistence
    const currentSchedule = loadScheduledTickers(scheduleFilePath);
    if (currentSchedule[chatId]) {
        delete currentSchedule[chatId]; // ** Remove the entry **
        saveScheduledTickers(currentSchedule, scheduleFilePath); // ** Save the updated file **
        console.log(`[${chatId}] Aus Planungsdatei entfernt.`);
    }

    // --- Send Emoji Legend (Only in Recap Mode) ---
    if (tickerState.mode === 'recap') {
        try {
            let legendMessage = "ℹ️ *Ticker-Legende:*\n";
            for (const key in EVENT_MAP) {
                if (key === "default" || key === "StartPeriod" || key === "StopPeriod") continue;
                const eventDetails = EVENT_MAP[key]; 
                legendMessage += `${eventDetails.emoji} = ${eventDetails.label}\n`;
            }
            await client.sendMessage(chatId, legendMessage.trim());
            console.log(`[${chatId}] Emoji-Legende gesendet (Recap-Modus).`);
        } catch (error) {
            console.error(`[${chatId}] Fehler beim Senden der Legende:`, error);
        }
    }
    // --- End Legend ---

    // Start the recap message timer ONLY if in recap mode
    if (tickerState.mode === 'recap') {
        if (tickerState.recapIntervalId) clearInterval(tickerState.recapIntervalId); // Clear old timer if any
        tickerState.recapIntervalId = setInterval(() => {
            sendRecapMessage(chatId);
        }, RECAP_INTERVAL_MINUTES * 60 * 1000); // Convert minutes to ms
        console.log(`[${chatId}] Recap-Timer gestartet (${RECAP_INTERVAL_MINUTES} min).`);
    }

    // Add the *first* polling job immediately for a quick initial update
    if (!jobQueue.some(job => job.chatId === chatId && job.type === 'poll')) {
        jobQueue.unshift({
            type: 'poll', // Mark as a polling job
            chatId,
            gameId: tickerState.gameId, // Get gameId from state
            tickerState: tickerState, // Pass the current state reference
            jobId: Date.now() // Unique ID for timing/logging
        });
    }
}

/**
 * Sends a recap message containing accumulated events for a specific chat.
 * (This function is largely unchanged)
 * @param {string} chatId - The WhatsApp chat ID.
 */
async function sendRecapMessage(chatId) {
    const tickerState = activeTickers.get(chatId);
    if (!tickerState || !tickerState.isPolling || !tickerState.recapEvents || tickerState.recapEvents.length === 0) {
        if (tickerState && tickerState.recapEvents) tickerState.recapEvents = []; // Clear buffer defensively
        return; // Nothing to do
    }

    console.log(`[${chatId}] Sende ${tickerState.recapEvents.length} Events im Recap.`);

    // --- Calculate Game Time Range ---
    // Ensure chronological order (oldest first) before creating range
    tickerState.recapEvents.sort((a, b) => a.timestamp - b.timestamp); 
    const firstEventTime = tickerState.recapEvents[0].time;
    const lastEventTime = tickerState.recapEvents[tickerState.recapEvents.length - 1].time;
    const startMinute = firstEventTime.split(':')[0];
    const endMinute = lastEventTime.split(':')[0];
    const timeRangeTitle = `Minute ${startMinute} - ${endMinute}`;

    // --- Build Recap Body ---
    const recapLines = tickerState.recapEvents.map(ev => formatRecapEventLine(ev, tickerState));
    const validLines = recapLines.filter(line => line && line.trim() !== '');

    if (validLines.length === 0) {
        console.log(`[${chatId}] Keine gültigen Events zum Senden im Recap gefunden.`);
        tickerState.recapEvents = []; // Clear buffer anyway
        return;
    }

    // --- Construct Final Message ---
    const teamHeader = `*${tickerState.teamNames.home}* : *${tickerState.teamNames.guest}*`;
    const recapBody = validLines.join('\n'); // Join lines with newline
    const finalMessage = `📬 *Recap ${timeRangeTitle}*\n\n${teamHeader}\n${recapBody}`;

    try {
        await client.sendMessage(chatId, finalMessage);
        tickerState.recapEvents = []; // Clear buffer after successful send
    } catch (error) {
        console.error(`[${chatId}] Fehler beim Senden der Recap-Nachricht:`, error);
        tickerState.recapEvents = []; // Clear buffer even on error
    }
}

/**
 * Master Scheduler: Runs periodically (e.g., every 20s).
 * (This function is unchanged)
 */
function masterScheduler() {
    // Only consider tickers that are actively polling
    const pollingTickers = Array.from(activeTickers.values()).filter(t => t.isPolling);
    if (pollingTickers.length === 0) return; // Exit if none are active

    // Round-robin selection
    lastPolledIndex = (lastPolledIndex + 1) % pollingTickers.length;
    const tickerStateToPoll = pollingTickers[lastPolledIndex];
    // Find the chatId for the selected state
    const chatId = [...activeTickers.entries()].find(([key, val]) => val === tickerStateToPoll)?.[0];

    // Add a 'poll' job only if the ticker is valid and not already waiting in the queue
    if (chatId && tickerStateToPoll.isPolling && !jobQueue.some(job => job.chatId === chatId && job.type === 'poll')) {
        jobQueue.push({
             type: 'poll',
             chatId,
             gameId: tickerStateToPoll.gameId, // Pass the gameId
             tickerState: tickerStateToPoll, // Pass the state reference
             jobId: Date.now()
        });
        console.log(`[${chatId}] Poll-Job zur Warteschlange hinzugefügt. Aktuelle Länge: ${jobQueue.length}`);
    }
}

/**
 * Dispatcher Loop: Runs frequently (e.g., every 0.5s).
 * (This function is unchanged)
 */
function dispatcherLoop() {
    if (jobQueue.length > 0 && activeWorkers < MAX_WORKERS) {
        activeWorkers++; // Reserve a worker slot
        const job = jobQueue.shift(); // Get the oldest job
        runWorker(job); // Start the worker (async, don't await)
    }
}

/**
 * Executes a single job (either 'schedule' or 'poll') using Axios.
 * This is the new, lightweight worker. NO PUPPETEER.
 * @param {object} job - The job object from the queue.
 */
async function runWorker(job) {
    const { chatId, jobId, type, gameId } = job;
    const tickerState = activeTickers.get(chatId); // Get current state from map
    const timerLabel = `[${chatId}] Job ${jobId} (${type}) Execution Time`;
    console.time(timerLabel); // Start timing
    // let browser = null; // --- REMOVED! ---

    // --- Pre-execution Check ---
    if (!tickerState || (type === 'poll' && !tickerState.isPolling) || (type === 'schedule' && !tickerState.isScheduling)) {
        console.log(`[${chatId}] Job ${jobId} (${type}) wird übersprungen, da Ticker-Status ungültig oder geändert.`);
        activeWorkers--; // Free worker slot immediately since job is skipped
        console.timeEnd(timerLabel);
        return;
    }

    console.log(`[${chatId}] Worker startet Job ${jobId} (${type}). Verbleibende Jobs: ${jobQueue.length}. Aktive Worker: ${activeWorkers}`);

    try {
        // --- THIS IS THE NEW LOGIC ---
        // 1. Build the data URL
        const dataUrl = buildDataUrl(gameId);

        // 2. Fetch the data with Axios
        // We add a cache-buster (`_=${Date.now()}`) to ensure we always get fresh data
        const metaRes = await axios.get(`${dataUrl}&_=${Date.now()}`, { timeout: 10000 });
        const gameData = metaRes.data.data; // The root of the data we need
        const gameSummary = gameData.summary;

        if (!gameSummary || !gameData.events) {
            throw new Error("Ungültige Datenstruktur von API empfangen.");
        }
        // --- END NEW LOGIC ---


        // --- Logic for 'schedule' job ---
        if (type === 'schedule') {
            const scheduledTime = new Date(gameSummary.startsAt);
            const startTime = new Date(scheduledTime.getTime() - (PRE_GAME_START_MINUTES * 60000));
            const delay = startTime.getTime() - Date.now();
            const teamNames = { home: gameSummary.homeTeam.name, guest: gameSummary.awayTeam.name };
            const startTimeLocale = startTime.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
            const startDateLocale = startTime.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });

            // Store the essential info in our state
            tickerState.teamNames = teamNames;
            tickerState.gameId = gameId; // Already set, but good to confirm
            tickerState.lastUpdatedAt = gameSummary.updatedAt; // --- NEW: Set initial update timestamp
            tickerState.meetingPageUrl = activeTickers.get(chatId).meetingPageUrl; // Ensure user-facing URL is kept

            if (delay > 0) { // Still in future
                console.log(`[${chatId}] Planungs-Job erfolgreich...`);
                const modeDescriptionScheduled = (tickerState.mode === 'recap') ? `im Recap-Modus (${RECAP_INTERVAL_MINUTES}-Minuten-Zusammenfassungen)` : "mit Live-Updates";
                await client.sendMessage(chatId, `✅ Ticker für *${teamNames.home}* vs *${teamNames.guest}* ist geplant (${modeDescriptionScheduled}) und startet automatisch am ${startDateLocale} um ca. ${startTimeLocale} Uhr.`);                
                tickerState.isPolling = false; 
                tickerState.isScheduled = true;
                
                const currentSchedule = loadScheduledTickers(scheduleFilePath);
                // ** Save schedule data **
                currentSchedule[chatId] = {
                    meetingPageUrl: tickerState.meetingPageUrl, // Save user-facing URL
                    gameId: gameId, // Save gameId
                    startTime: startTime.toISOString(),
                    groupName: tickerState.groupName,
                    mode: tickerState.mode
                };
                saveScheduledTickers(currentSchedule, scheduleFilePath);
                tickerState.scheduleTimeout = setTimeout(() => beginActualPolling(chatId), delay);
            } else { // Already started
                console.log(`[${chatId}] Planungs-Job erfolgreich. Spiel beginnt sofort...`);
                let startMessage = `▶️ Ticker für *${teamNames.home}* vs *${teamNames.guest}* wird sofort gestartet. `;
                startMessage += (tickerState.mode === 'recap') ? `Du erhältst alle ${RECAP_INTERVAL_MINUTES} Minuten eine Zusammenfassung. 📬` : `Du erhältst alle Events live! ⚽`;
                await client.sendMessage(chatId, startMessage);
                tickerState.isScheduling = false;
                beginActualPolling(chatId); // This will add the first 'poll' job
            }
        }
        // --- Logic for 'poll' job ---
        else if (type === 'poll') {
             // Ensure teamNames are set (e.g., if bot restarted and loaded from schedule)
             if (!tickerState.teamNames) { 
                 tickerState.teamNames = { home: gameSummary.homeTeam.name, guest: gameSummary.awayTeam.name }; 
             }
             
             // --- NEW UPDATE CHECK ---
             const newUpdatedAt = gameSummary.updatedAt;
             if (newUpdatedAt && newUpdatedAt !== tickerState.lastUpdatedAt) {
                console.log(`[${chatId}] Neue Version erkannt: ${newUpdatedAt}`);
                tickerState.lastUpdatedAt = newUpdatedAt; // Store the new timestamp
                
                // Pass the full gameData object to processEvents
                if (await processEvents(gameData, tickerState, chatId)) {
                    saveSeenTickers(activeTickers, seenFilePath); // Save seen state only if new events were processed
                }
            } else {
                 console.log(`[${chatId}] Keine neue Version erkannt (${newUpdatedAt || 'N/A'}).`);
            }
        }
    } catch (error) {
        console.error(`[${chatId}] Fehler im Worker-Job ${jobId} (${type}):`, error.message);
        if (type === 'schedule') {
             await client.sendMessage(chatId, 'Fehler: Die initiale Planung des Tickers ist fehlgeschlagen. Bitte versuchen Sie es erneut.');
             activeTickers.delete(chatId);
             const currentSchedule = loadScheduledTickers(scheduleFilePath);
             if (currentSchedule[chatId]) {
                 delete currentSchedule[chatId];
                 saveScheduledTickers(currentSchedule, scheduleFilePath);
             }
        }
        // if (browser) await browser.close(); // --- REMOVED! ---
    } finally {
        console.timeEnd(timerLabel);
        activeWorkers--; // Free the worker slot
    }
}

/**
 * Processes events, handles modes, calls AI, sends final stats, schedules cleanup.
 * @param {object} gameData - The full data object from the API (contains .summary, .events, .lineup).
 * @param {object} tickerState - The state object for the specific ticker.
 * @param {string} chatId - The WhatsApp chat ID.
 * @returns {boolean} - True if new, unseen events were processed, false otherwise.
 */
async function processEvents(gameData, tickerState, chatId) {
    if (!gameData || !Array.isArray(gameData.events)) return false;
    
    let newUnseenEventsProcessed = false;
    const gameSummary = gameData.summary; // Get summary for context
    
    // API sends events newest-first, so we reverse them to get chronological order (oldest-first)
    const events = gameData.events.slice().reverse();

    for (const ev of events) {
        if (tickerState.seen.has(ev.id)) continue; // Use new ev.id

        // Mark as seen immediately
        tickerState.seen.add(ev.id);
        newUnseenEventsProcessed = true;

        // Format a message *only* for live mode.
        let msg = "";
        if (tickerState.mode === 'live') {
            // Pass gameSummary to formatEvent for StopPeriod logic
            msg = formatEvent(ev, tickerState, gameSummary);
        }

        // --- Handle Sending / Storing based on mode ---
        
        // For Live Mode, send message if it's not empty
        if (tickerState.mode === 'live' && msg) {
            try {
                console.log(`[${chatId}] Sende neues Event (Live):`, msg);
                await client.sendMessage(chatId, msg);
            } catch (sendError) {
                console.error(`[${chatId}] Fehler beim Senden der Nachricht für Event ${ev.id}:`, sendError);
            }
        }
        // For Recap Mode, just store the event object
        else if (tickerState.mode === 'recap') {
            // We store all events (except ignored ones) to build the recap
            const ignoredEvents = []; // No ignored events for now
            if (!ignoredEvents.includes(ev.type)) {
                console.log(`[${chatId}] Speichere Event-Objekt für Recap (ID: ${ev.id}, Typ: ${ev.type})`);
                tickerState.recapEvents = tickerState.recapEvents || [];
                tickerState.recapEvents.push(ev);
            }
        }
        
        // --- Handle Critical Events (AFTER processing them) ---
        const isCriticalEvent = (ev.type === "StopPeriod" || ev.type === "StartPeriod");
        if (isCriticalEvent && tickerState.mode === 'recap') {
            // If it's a critical event in recap mode, send the buffer *now*
            console.log(`[${chatId}] Kritisches Event (${ev.type}) erkannt, sende Recap sofort.`);
            await sendRecapMessage(chatId); // This sends and clears the buffer
        }


        // --- Handle Game End ---
        if (ev.type === "StopPeriod") {
            // Use our new reliable time-based check
            const minute = parseInt(ev.time.split(':')[0], 10);
            if (minute > 30) { // This means it's game end (e.g., "60:00")
                console.log(`[${chatId}] Spielende-Event empfangen. Ticker wird gestoppt.`);
                tickerState.isPolling = false;
                if (tickerState.recapIntervalId) clearInterval(tickerState.recapIntervalId);

                // Remove pending job
                const index = jobQueue.findIndex(job => job.chatId === chatId);
                if (index > -1) jobQueue.splice(index, 1);

                // --- Send Final Stats ---
                try {
                    // We pass gameData.lineup which has all player stats
                    const statsMessage = await extractGameStats(gameData.lineup, tickerState.teamNames);
                    
                    setTimeout(async () => {
                         try { await client.sendMessage(chatId, statsMessage); }
                         catch(e) { console.error(`[${chatId}] Fehler beim Senden der Spielstatistiken:`, e); }
                    }, 1000); // 1s delay
                } catch (e) { console.error(`[${chatId}] Fehler beim Erstellen der Spielstatistiken:`, e); }

                // --- Send AI Summary ---
                try {
                    // Pass the full chronological event list
                    const summary = await generateGameSummary(events, tickerState.teamNames, tickerState.groupName, gameData.lineup);                    setTimeout(async () => {
                         if (summary) {
                             try { await client.sendMessage(chatId, summary); }
                             catch(e) { console.error(`[${chatId}] Fehler beim Senden der AI-Zusammenfassung:`, e); }
                         }
                    }, 2000); // 2s delay
                } catch (e) { console.error(`[${chatId}] Fehler beim Generieren der AI-Zusammenfassung:`, e); }

                // --- Send Final Bot Message ---
                setTimeout(async () => {
                    const finalMessage = "Vielen Dank fürs Mitfiebern! 🥳\n\nDen Quellcode für diesen Bot könnt ihr hier einsehen:\nhttps://github.com/nambatu/whatsapp-liveticker-bot/";
                    try { await client.sendMessage(chatId, finalMessage); }
                    catch (e) { console.error(`[${chatId}] Fehler beim Senden der Abschlussnachricht: `, e); }
                }, 4000); // 4s delay

                // --- Schedule Cleanup ---
                setTimeout(() => {
                    if (activeTickers.has(chatId)) {
                        activeTickers.delete(chatId);
                        saveSeenTickers(activeTickers, seenFilePath);
                        console.log(`[${chatId}] Ticker-Daten automatisch bereinigt.`);
                    }
                }, 3600000); // 1 hour
                break; // Stop processing events
            }
        }
    }
    return newUnseenEventsProcessed;
}

// --- Exports ---
module.exports = {
    initializePolling,
    masterScheduler,
    dispatcherLoop,
    startPolling: queueTickerScheduling, // Export queueTickerScheduling as startPolling
    beginActualPolling,
    getGameIdFromUrl
};