// utils.js

const fs = require('fs');
const path = require('path');
const { EVENT_MAP } = require('./config.js'); // Import event definitions

// --- DATA PERSISTENCE ---

/**
 * Loads the set of seen event IDs for each chat from a JSON file.
 * Populates the activeTickers map with this data on startup.
 * @param {Map} activeTickers - The map storing active ticker states.
 * @param {string} seenFilePath - The path to the 'seen_tickers.json' file.
 */
function loadSeenTickers(activeTickers, seenFilePath) {
    try {
        const raw = fs.readFileSync(seenFilePath, 'utf8'); // Read file content
        const data = JSON.parse(raw); // Parse JSON data
        // Iterate through saved data (chatId -> array of seen IDs)
        for (const [chatId, seenArray] of Object.entries(data)) {
            // If this chat isn't already in memory (e.g., from schedule file), add it with its seen events
            if (!activeTickers.has(chatId)) {
                activeTickers.set(chatId, { seen: new Set(seenArray) }); // Use a Set for efficient lookups
            } else {
                // If ticker state already exists (e.g., loaded from schedule), just add the 'seen' set
                const existingState = activeTickers.get(chatId);
                existingState.seen = new Set(seenArray);
            }
        }
        console.log(`Daten für ${Object.keys(data).length} Ticker aus der Datei geladen.`);
    } catch (e) {
        // Handle cases where the file doesn't exist (e.g., first run) or is invalid JSON
        console.log('Keine gespeicherte Ticker-Datei gefunden oder Fehler beim Lesen, starte frisch.');
    }
}

/**
 * Saves the current set of seen event IDs for all active tickers to a JSON file.
 * @param {Map} activeTickers - The map storing active ticker states.
 * @param {string} seenFilePath - The path to the 'seen_tickers.json' file.
 */
function saveSeenTickers(activeTickers, seenFilePath) {
    try {
        const dataToSave = {};
        // Iterate through all tickers currently in memory
        for (const [chatId, tickerState] of activeTickers.entries()) {
            // Convert the Set of seen IDs back to an array for JSON compatibility
            if (tickerState.seen) {
                dataToSave[chatId] = [...tickerState.seen];
            }
        }
        // Write the data to the file, formatted with indentation for readability
        fs.writeFileSync(seenFilePath, JSON.stringify(dataToSave, null, 2), 'utf8');
    } catch (e) {
        console.error('Fehler beim Speichern der Ticker-Daten:', e);
    }
}

/**
 * Loads the schedule data (details of tickers waiting to start) from a JSON file.
 * @param {string} scheduleFilePath - The path to the 'scheduled_tickers.json' file.
 * @returns {object} - An object mapping chatId to schedule details, or {} on error/no file.
 */
function loadScheduledTickers(scheduleFilePath) {
    try {
        const raw = fs.readFileSync(scheduleFilePath, 'utf8');
        return JSON.parse(raw); // Return the parsed schedule object
    } catch (e) {
        // Handle file not found or invalid JSON
        console.log('Keine gespeicherte Planungsdatei gefunden oder Fehler beim Lesen.');
        return {}; // Return empty object to prevent errors in calling code
    }
}

/**
 * Saves the current schedule data (tickers waiting to start) to a JSON file.
 * @param {object} scheduledTickers - An object mapping chatId to schedule details.
 * @param {string} scheduleFilePath - The path to the 'scheduled_tickers.json' file.
 */
function saveScheduledTickers(scheduledTickers, scheduleFilePath) {
    try {
        // Write the schedule object to the file, formatted
        fs.writeFileSync(scheduleFilePath, JSON.stringify(scheduledTickers, null, 2), 'utf8');
    } catch (e) {
        console.error('Fehler beim Speichern der geplanten Ticker:', e);
    }
}

/**
 * Formats a game event object into a user-friendly WhatsApp message string for live mode.
 * Applies different layouts based on the event type (goal, penalty, timeout, etc.).
 * Only includes the score line for goal events.
 * @param {object} ev - The event object from the API.
 * @param {object} tickerState - The state object for the current ticker (contains team names).
 * @param {object} gameSummary - (Not used for StopPeriod anymore, but good to pass for other potential logic)
 * @returns {string} - The formatted message string, or an empty string for ignored events.
 */
function formatEvent(ev, tickerState, gameSummary) {
    // Get basic event info from config, using 'default' as a fallback
    const eventInfo = EVENT_MAP[ev.type] || EVENT_MAP["default"];
    const homeTeamName = tickerState.teamNames ? tickerState.teamNames.home : 'Heim';
    const guestTeamName = tickerState.teamNames ? tickerState.teamNames.guest : 'Gast';
    
    const time = ev.time ? ` (${ev.time})` : ''; 

    switch (ev.type) { 
        case "Goal":
        case "SevenMeterGoal": {
            let scoreLine;
            const [pointsHome, pointsGuest] = ev.score.split('-')
            // Create score line, bolding the score of the team that scored
            if (ev.team === 'Home') {
                scoreLine = `${homeTeamName}  *${pointsHome}*:${pointsGuest}  ${guestTeamName}`;
            } else {
                scoreLine = `${homeTeamName}  ${pointsHome}:*${pointsGuest}* ${guestTeamName}`;
            }
            return `${scoreLine}\n${eventInfo.emoji} ${ev.message} (${time})`;
        }

        case "SevenMeterMissed":
        case "TwoMinutePenalty":
        case "Warning":
        case "Disqualification":
        case "DisqualificationWithReport":
        case "Timeout": 
            return `${eventInfo.emoji} ${ev.message} (${time})`;

        case "StartPeriod": 
            if (ev.time === "00:00") {
                return `▶️ *Das Spiel hat begonnen!*`;
            } else {
                return `▶️ *Die zweite Halbzeit hat begonnen!*`;
            }       

        case "StopPeriod": {
            const [homeScore, awayScore] = ev.score.split('-');
            const minute = parseInt(ev.time.split(':')[0], 10);

            // If the minute is greater than 30 (e.g., "60:00"), it's the end of the game.
            if (minute > 30) {
                 return `🏁 *Spielende*\n${homeTeamName}  *${homeScore}:${awayScore}* ${guestTeamName}`;
            } else {
                 // Otherwise (e.g., "30:00"), it's halftime.
                 return `⏸️ *Halbzeit*\n${homeTeamName}  *${homeScore}:${awayScore}* ${guestTeamName}`;
            }
        }

        // Fallback for any other unknown or unhandled event types
        default:
            return `${eventInfo.emoji} ${ev.message || eventInfo.label} (${time})`;
    }
}

/**
 * Formats a single event into a line for the recap message (Emoji-only version).
 * @param {object} ev - The raw event object from the `handball.net` API.
 * @param {object} tickerState - The state object for the ticker.
 * @returns {string} - The formatted recap line string.
 */
function formatRecapEventLine(ev, tickerState) {
    const eventInfo = EVENT_MAP[ev.type] || EVENT_MAP["default"];
    const time = ev.time || '--:--';
    let scoreStr = ev.score ? ev.score.replace('-', ':') : '--:--';
    const detailStr = ev.message || eventInfo.label;

    switch (ev.type) {
        case "Goal":
        case "SevenMeterGoal":
            // Bold the new score
            const [home, away] = scoreStr.split(':');
            scoreStr = (ev.team === "Home") ? `*${home}*:${away}` : `${home}:*${away}*`;
            return `${eventInfo.emoji} ${time} | ${scoreStr} | ${detailStr}`;

        case "StartPeriod":
        case "StopPeriod":
            // Make critical events stand out
            return `${eventInfo.emoji} ${time} | *${detailStr}* | *${scoreStr}*`;

        // All other events
        default:
            // For 7m-miss, penalty, timeout, etc.
            // Ignored events won't be added to the recap buffer, so no need to check
            return `${eventInfo.emoji} ${time} | ${scoreStr} | ${detailStr}`;
    }
}

// Export all functions needed by other modules
module.exports = {
    loadSeenTickers,
    saveSeenTickers,
    formatEvent, // For live mode and critical events
    loadScheduledTickers,
    saveScheduledTickers,
    formatRecapEventLine // For recap mode messages
};