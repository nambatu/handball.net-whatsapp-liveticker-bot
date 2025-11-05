// polling.js
const axios = require('axios');
const { saveSeenTickers, formatEvent, saveScheduledTickers, loadScheduledTickers, formatRecapEventLine } = require('./utils.js');
const { generateGameSummary, extractGameStats } = require('./ai.js');
const { EVENT_MAP } = require('./config.js');

// --- SHARED STATE (Initialized by app.js) ---
let activeTickers, jobQueue, client, seenFilePath, scheduleFilePath;

// --- WORKER POOL CONFIG ---
let lastPolledIndex = -1; 
let activeWorkers = 0; 
const MAX_WORKERS = 2; 
const PRE_GAME_START_MINUTES = 5; 
const RECAP_INTERVAL_MINUTES = 5; 

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

// --- NEW HELPER FUNCTION ---

/**
 * Transforms a user-facing URL into the correct JSON data URL.
 * Handles /ticker, /info, and base URLs.
 * @param {string} meetingPageUrl - The user-provided URL.
 * @returns {string} - The full API URL.
 */
function buildDataUrl(meetingPageUrl) {
    // 1. Parse the URL
    const url = new URL(meetingPageUrl);
    
    // 2. Get the pathname, e.g., "/spiele/handball4all.hamburg.9126461/ticker"
    let pathname = url.pathname;

    // 3. Remove trailing slash if it exists
    if (pathname.endsWith('/')) {
        pathname = pathname.slice(0, -1);
    }

    // 4. Split the path into segments
    const segments = pathname.split('/');
    
    // 5. Get the last segment
    const lastSegment = segments[segments.length - 1];

    // 6. Check if the last segment is a "command" like 'ticker' or 'info'
    if (lastSegment === 'ticker' || lastSegment === 'info') {
        // Remove it
        segments.pop();
    }
    
    // 7. Re-join the path and append /combined
    const newPathname = segments.join('/') + '/combined';
    
    // 8. Return the new URL
    // url.origin is "https://www.handball.net"
    return url.origin + newPathname + '?';
}

// --- END NEW HELPER FUNCTION ---


/**
 * Creates the initial ticker state and adds a 'schedule' job to the queue.
 * @param {string} meetingPageUrl - The URL of the handball.net game webpage.
 * @param {string} chatId - The WhatsApp chat ID where the ticker runs.
 * @param {string} groupName - The name of the WhatsApp group (for AI).
 * @param {('live'|'recap')} mode - The desired ticker mode ('live' or 'recap').
 */
async function queueTickerScheduling(meetingPageUrl, chatId, groupName, mode) {
    // We only validate it's a valid URL. buildDataUrl will handle the format.
    try {
        new URL(meetingPageUrl);
    } catch (e) {
        await client.sendMessage(chatId, 'Fehler: Die angegebene URL ist ungültig.');
        return;
    }

    // Create initial state in memory
    const tickerState = activeTickers.get(chatId) || { seen: new Set() };
    tickerState.isPolling = false; 
    tickerState.isScheduling = true;
    tickerState.meetingPageUrl = meetingPageUrl; // Store the user-facing URL
    // tickerState.gameId = gameId; // --- REMOVED! ---
    tickerState.groupName = groupName;
    tickerState.mode = mode;
    tickerState.recapEvents = []; 
    activeTickers.set(chatId, tickerState); 

    // Add a 'schedule' job to the queue
    jobQueue.push({
        type: 'schedule', 
        chatId,
        meetingPageUrl: meetingPageUrl, // Pass the original URL
        groupName,
        mode,
        jobId: Date.now()
    });

    console.log(`[${chatId}] Planungs-Job zur Warteschlange hinzugefügt. Aktuelle Länge: ${jobQueue.length}`);
    await client.sendMessage(chatId, `⏳ Ticker-Planung für "${groupName}" wird bearbeitet...`);
}


/**
 * Activates the actual polling loop for a ticker.
 * (This function is largely unchanged)
 * @param {string} chatId - The WhatsApp chat ID.
 */
async function beginActualPolling(chatId) {
    const tickerState = activeTickers.get(chatId);
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
    tickerState.isPolling = true; 
    tickerState.isScheduled = false;

    // Remove from the schedule file persistence
    const currentSchedule = loadScheduledTickers(scheduleFilePath);
    if (currentSchedule[chatId]) {
        delete currentSchedule[chatId]; 
        saveScheduledTickers(currentSchedule, scheduleFilePath); 
        console.log(`[${chatId}] Aus Planungsdatei entfernt.`);
    }

    // Send Emoji Legend (Only in Recap Mode)
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
    
    // Start the recap message timer ONLY if in recap mode
    if (tickerState.mode === 'recap') {
        if (tickerState.recapIntervalId) clearInterval(tickerState.recapIntervalId);
        tickerState.recapIntervalId = setInterval(() => {
            sendRecapMessage(chatId);
        }, RECAP_INTERVAL_MINUTES * 60 * 1000); 
        console.log(`[${chatId}] Recap-Timer gestartet (${RECAP_INTERVAL_MINUTES} min).`);
    }

    // Add the *first* polling job immediately
    if (!jobQueue.some(job => job.chatId === chatId && job.type === 'poll')) {
        jobQueue.unshift({
            type: 'poll', 
            chatId,
            meetingPageUrl: tickerState.meetingPageUrl, // Get URL from state
            tickerState: tickerState, 
            jobId: Date.now() 
        });
    }
}

/**
 * Sends a recap message.
 * (This function is unchanged)
 * @param {string} chatId - The WhatsApp chat ID.
 */
async function sendRecapMessage(chatId) {
    const tickerState = activeTickers.get(chatId);
    if (!tickerState || !tickerState.isPolling || !tickerState.recapEvents || tickerState.recapEvents.length === 0) {
        if (tickerState && tickerState.recapEvents) tickerState.recapEvents = [];
        return; 
    }

    console.log(`[${chatId}] Sende ${tickerState.recapEvents.length} Events im Recap.`);

    // Ensure chronological order
    tickerState.recapEvents.sort((a, b) => a.timestamp - b.timestamp); 
    const firstEventTime = tickerState.recapEvents[0].time;
    const lastEventTime = tickerState.recapEvents[tickerState.recapEvents.length - 1].time;
    const startMinute = firstEventTime ? firstEventTime.split(':')[0] : '0';
    const endMinute = lastEventTime ? lastEventTime.split(':')[0] : '??';
    const timeRangeTitle = `Minute ${startMinute} - ${endMinute}`;

    const recapLines = tickerState.recapEvents.map(ev => formatRecapEventLine(ev, tickerState));
    const validLines = recapLines.filter(line => line && line.trim() !== '');

    if (validLines.length === 0) {
        console.log(`[${chatId}] Keine gültigen Events zum Senden im Recap gefunden.`);
        tickerState.recapEvents = []; 
        return;
    }

    const teamHeader = `*${tickerState.teamNames.home}* : *${tickerState.teamNames.guest}*`;
    const recapBody = validLines.join('\n'); 
    const finalMessage = `📬 *Recap ${timeRangeTitle}*\n\n${teamHeader}\n${recapBody}`;

    try {
        await client.sendMessage(chatId, finalMessage);
        tickerState.recapEvents = []; // Clear buffer
    } catch (error) {
        console.error(`[${chatId}] Fehler beim Senden der Recap-Nachricht:`, error);
        tickerState.recapEvents = []; 
    }
}

/**
 * Master Scheduler: Runs periodically.
 * (Simplified, no gameId)
 */
function masterScheduler() {
    const pollingTickers = Array.from(activeTickers.values()).filter(t => t.isPolling);
    if (pollingTickers.length === 0) return; 

    lastPolledIndex = (lastPolledIndex + 1) % pollingTickers.length;
    const tickerStateToPoll = pollingTickers[lastPolledIndex];
    const chatId = [...activeTickers.entries()].find(([key, val]) => val === tickerStateToPoll)?.[0];

    if (chatId && tickerStateToPoll.isPolling && !jobQueue.some(job => job.chatId === chatId && job.type === 'poll')) {
        jobQueue.push({
             type: 'poll',
             chatId,
             meetingPageUrl: tickerStateToPoll.meetingPageUrl, // Pass the original URL
             tickerState: tickerStateToPoll,
             jobId: Date.now()
        });
        console.log(`[${chatId}] Poll-Job zur Warteschlange hinzugefügt. Aktuelle Länge: ${jobQueue.length}`);
    }
}

/**
 * Dispatcher Loop: Runs frequently.
 * (This function is unchanged)
 */
function dispatcherLoop() {
    if (jobQueue.length > 0 && activeWorkers < MAX_WORKERS) {
        activeWorkers++; 
        const job = jobQueue.shift(); 
        runWorker(job); 
    }
}

/**
 * Executes a single job (either 'schedule' or 'poll') using Axios.
 * (Simplified, no gameId)
 * @param {object} job - The job object from the queue.
 */
async function runWorker(job) {
    const { chatId, jobId, type, meetingPageUrl } = job;
    const tickerState = activeTickers.get(chatId);
    const timerLabel = `[${chatId}] Job ${jobId} (${type}) Execution Time`;
    console.time(timerLabel); 

    if (!tickerState || (type === 'poll' && !tickerState.isPolling) || (type === 'schedule' && !tickerState.isScheduling)) {
        console.log(`[${chatId}] Job ${jobId} (${type}) wird übersprungen, da Ticker-Status ungültig oder geändert.`);
        activeWorkers--; 
        console.timeEnd(timerLabel);
        return;
    }

    console.log(`[${chatId}] Worker startet Job ${jobId} (${type}). Verbleibende Jobs: ${jobQueue.length}. Aktive Worker: ${activeWorkers}`);

    try {
        // 1. Build the data URL from the original meeting URL
        const dataUrl = buildDataUrl(meetingPageUrl);

        // 2. Fetch the data with Axios
        const metaRes = await axios.get(`${dataUrl}&_=${Date.now()}`, { timeout: 10000 });
        const gameData = metaRes.data.data; 
        const gameSummary = gameData.summary;

        if (!gameSummary || !gameData.events) {
            throw new Error("Ungültige Datenstruktur von API empfangen.");
        }

        // --- Logic for 'schedule' job ---
        if (type === 'schedule') {
            const scheduledTime = new Date(gameSummary.startsAt);
            const startTime = new Date(scheduledTime.getTime() - (PRE_GAME_START_MINUTES * 60000));
            const delay = startTime.getTime() - Date.now();
            const teamNames = { home: gameSummary.homeTeam.name, guest: gameSummary.awayTeam.name };
            const startTimeLocale = startTime.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
            const startDateLocale = startTime.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });

            tickerState.teamNames = teamNames;
            tickerState.lastUpdatedAt = gameSummary.updatedAt; 
            tickerState.meetingPageUrl = meetingPageUrl; // Ensure user-facing URL is kept

            if (delay > 0) { // Still in future
                console.log(`[${chatId}] Planungs-Job erfolgreich...`);
                const modeDescriptionScheduled = (tickerState.mode === 'recap') ? `im Recap-Modus (${RECAP_INTERVAL_MINUTES}-Minuten-Zusammenfassungen)` : "mit Live-Updates";
                await client.sendMessage(chatId, `✅ Ticker für *${teamNames.home}* vs *${teamNames.guest}* ist geplant (${modeDescriptionScheduled}) und startet automatisch am ${startDateLocale} um ca. ${startTimeLocale} Uhr.`);                
                tickerState.isPolling = false; 
                tickerState.isScheduled = true;
                
                const currentSchedule = loadScheduledTickers(scheduleFilePath);
                currentSchedule[chatId] = {
                    meetingPageUrl: tickerState.meetingPageUrl, // Save user-facing URL
                    // gameId: gameId, // --- REMOVED! ---
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
                beginActualPolling(chatId); 
            }
        }
        // --- Logic for 'poll' job ---
        else if (type === 'poll') {
             if (!tickerState.teamNames) { 
                 tickerState.teamNames = { home: gameSummary.homeTeam.name, guest: gameSummary.awayTeam.name }; 
             }
             
             const newUpdatedAt = gameSummary.updatedAt;
             if (newUpdatedAt && newUpdatedAt !== tickerState.lastUpdatedAt) {
                console.log(`[${chatId}] Neue Version erkannt: ${newUpdatedAt}`);
                tickerState.lastUpdatedAt = newUpdatedAt;
                
                if (await processEvents(gameData, tickerState, chatId)) {
                    saveSeenTickers(activeTickers, seenFilePath); 
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
    } finally {
        console.timeEnd(timerLabel);
        activeWorkers--; 
    }
}

/**
 * Processes events, handles modes, calls AI, sends final stats, schedules cleanup.
 * (This function is unchanged, but we must pass gameData.lineup to the AI)
 * @param {object} gameData - The full data object from the API (contains .summary, .events, .lineup).
 * @param {object} tickerState - The state object for the specific ticker.
 * @param {string} chatId - The WhatsApp chat ID.
 * @returns {boolean} - True if new, unseen events were processed, false otherwise.
 */
async function processEvents(gameData, tickerState, chatId) {
    if (!gameData || !Array.isArray(gameData.events)) return false;
    
    let newUnseenEventsProcessed = false;
    const gameSummary = gameData.summary; 
    
    // API sends events newest-first, so we reverse them
    const events = gameData.events.slice().reverse();

    for (const ev of events) {
        if (tickerState.seen.has(ev.id)) continue; 

        tickerState.seen.add(ev.id);
        newUnseenEventsProcessed = true;

        let msg = "";
        if (tickerState.mode === 'live') {
            msg = formatEvent(ev, tickerState, gameSummary);
        }

        // Handle Sending / Storing based on mode
        if (tickerState.mode === 'live' && msg) {
            try {
                console.log(`[${chatId}] Sende neues Event (Live):`, msg);
                await client.sendMessage(chatId, msg);
            } catch (sendError) {
                console.error(`[${chatId}] Fehler beim Senden der Nachricht für Event ${ev.id}:`, sendError);
            }
        }
        else if (tickerState.mode === 'recap') {
            const ignoredEvents = [];
            if (!ignoredEvents.includes(ev.type)) {
                console.log(`[${chatId}] Speichere Event-Objekt für Recap (ID: ${ev.id}, Typ: ${ev.type})`);
                tickerState.recapEvents = tickerState.recapEvents || [];
                tickerState.recapEvents.push(ev);
            }
        }
        
        // Handle Critical Events
        const isCriticalEvent = (ev.type === "StopPeriod" || ev.type === "StartPeriod");
        if (isCriticalEvent && tickerState.mode === 'recap') {
            console.log(`[${chatId}] Kritisches Event (${ev.type}) erkannt, sende Recap sofort.`);
            await sendRecapMessage(chatId); 
        }

        // Handle Game End
        if (ev.type === "StopPeriod") {
            const minute = ev.time ? parseInt(ev.time.split(':')[0], 10) : 0;
            if (minute > 30) { // This means it's game end (e.g., "60:00")
                console.log(`[${chatId}] Spielende-Event empfangen. Ticker wird gestoppt.`);
                tickerState.isPolling = false;
                if (tickerState.recapIntervalId) clearInterval(tickerState.recapIntervalId);

                const index = jobQueue.findIndex(job => job.chatId === chatId);
                if (index > -1) jobQueue.splice(index, 1);

                // --- Send Final Stats ---
                try {
                    const statsMessage = await extractGameStats(gameData.lineup, tickerState.teamNames);
                    setTimeout(async () => {
                         try { await client.sendMessage(chatId, statsMessage); }
                         catch(e) { console.error(`[${chatId}] Fehler beim Senden der Spielstatistiken:`, e); }
                    }, 1000); 
                } catch (e) { console.error(`[${chatId}] Fehler beim Erstellen der Spielstatistiken:`, e); }

                // --- Send AI Summary ---
                try {
                    // We must pass gameData.lineup to the AI function
                    const summary = await generateGameSummary(events, tickerState.teamNames, tickerState.groupName, gameData.lineup);
                    setTimeout(async () => {
                         if (summary) {
                             try { await client.sendMessage(chatId, summary); }
                             catch(e) { console.error(`[${chatId}] Fehler beim Senden der AI-Zusammenfassung:`, e); }
                         }
                    }, 2000); 
                } catch (e) { console.error(`[${chatId}] Fehler beim Generieren der AI-Zusammenfassung:`, e); }

                // --- Send Final Bot Message ---
                setTimeout(async () => {
                    const finalMessage = "Vielen Dank fürs Mitfiebern! 🥳\n\nDen Quellcode für diesen Bot könnt ihr hier einsehen:\nhttps://github.com/nambatu/whatsapp-liveticker-bot/";
                    try { await client.sendMessage(chatId, finalMessage); }
                    catch (e) { console.error(`[${chatId}] Fehler beim Senden der Abschlussnachricht: `, e); }
                }, 4000); 

                // --- Schedule Cleanup ---
                setTimeout(() => {
                    if (activeTickers.has(chatId)) {
                        activeTickers.delete(chatId);
                        saveSeenTickers(activeTickers, seenFilePath);
                        console.log(`[${chatId}] Ticker-Daten automatisch bereinigt.`);
                    }
                }, 3600000); // 1 hour
                break; 
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
    startPolling: queueTickerScheduling,
    beginActualPolling
    // We no longer need to export getGameIdFromUrl
};