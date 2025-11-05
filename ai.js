// ai.js 
const { GoogleGenerativeAI } = require("@google/generative-ai"); // Use GoogleGenerativeAI

// The client gets the API key from the environment variable `GEMINI_API_KEY`.
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY); // Use GoogleGenerAI

/**
 * NEW: Helper function to find the top scorer(s) from a lineup array.
 * @param {Array} lineup - The lineup array (e.g., gameData.lineup.home).
 * @returns {string} - Formatted string of top scorer(s) (e.g., "Hauke Frahm (4 Tore)").
 */
function findTopScorer(lineup) {
    if (!lineup || lineup.length === 0) return "Niemand";

    let topScore = 0;
    lineup.forEach(player => {
        if (player.goals > topScore) {
            topScore = player.goals;
        }
    });

    if (topScore === 0) return "Niemand";

    const topScorers = lineup
        .filter(player => player.goals === topScore)
        .map(player => `${player.firstname} ${player.lastname}`);

    return `${topScorers.join(' & ')} (${topScore} Tore)`;
}

/**
 * NEW: Generates the stats object needed for the prompt.
 * @param {object} lineupData - The `gameData.lineup` object.
 * @returns {object} - An object with stats (topScorers, penalties, sevenMeters).
 */
function getStatsForPrompt(lineupData, teamNames) {
    const stats = {
        home: { name: teamNames.home, penalties: 0, sevenMetersMade: 0, sevenMetersMissed: 0 },
        guest: { name: teamNames.guest, penalties: 0, sevenMetersMade: 0, sevenMetersMissed: 0 }
    };

    lineupData.home.forEach(p => {
        stats.home.penalties += p.penalties;
        stats.home.sevenMetersMade += p.penaltyGoals;
        stats.home.sevenMetersMissed += p.penaltyMissed;
    });
    lineupData.away.forEach(p => {
        stats.guest.penalties += p.penalties;
        stats.guest.sevenMetersMade += p.penaltyGoals;
        stats.guest.sevenMetersMissed += p.penaltyMissed;
    });

    return {
        homeTopScorer: findTopScorer(lineupData.home),
        guestTopScorer: findTopScorer(lineupData.away),
        homePenalties: stats.home.penalties,
        guestPenalties: stats.guest.penalties,
        homeSevenMeters: `${stats.home.sevenMetersMade} von ${stats.home.sevenMetersMade + stats.home.sevenMetersMissed}`,
        guestSevenMeters: `${stats.guest.sevenMetersMade} von ${stats.guest.sevenMetersMade + stats.guest.sevenMetersMissed}`
    };
}


/**
 * REWRITTEN: Extracts game stats from the `lineup` object and returns a formatted string.
 * This is called by polling.js to send the final stats message.
 * @param {object} lineupData - The `gameData.lineup` object (contains .home and .away arrays).
 * @param {object} teamNames - The team names object.
 * @returns {string} - A formatted WhatsApp message string with game stats.
 */
async function extractGameStats(lineupData, teamNames) {
    if (!lineupData || !lineupData.home || !lineupData.away) {
        console.log("Lineup-Daten für Statistiken nicht gefunden.");
        return "";
    }

    // Use the new helper function to get stats
    const gameStats = getStatsForPrompt(lineupData, teamNames);

    // Format the stats into a string message
    const statsMessage = `📊 *Statistiken zum Spiel:*\n` +
                         `-----------------------------------\n` +
                         `*Topscorer (${teamNames.home}):* ${gameStats.homeTopScorer}\n` +
                         `*Topscorer (${teamNames.guest}):* ${gameStats.guestTopScorer}\n` +
                         `*7-Meter (${teamNames.home}):* ${gameStats.homeSevenMeters}\n` +
                         `*7-Meter (${teamNames.guest}):* ${gameStats.guestSevenMeters}\n` +
                         `*Zeitstrafen (${teamNames.home}):* ${gameStats.homePenalties}\n` +
                         `*Zeitstrafen (${teamNames.guest}):* ${gameStats.guestPenalties}`;
    
    return statsMessage;
}


/**
 * REWRITTEN: Generates the AI game summary.
 * No longer needs `halftimeLength`.
 * Now requires `lineupData` to be passed from polling.js.
 * @param {Array} events - The chronological (reversed) list of events.
 * @param {object} teamNames - The team names object.
 * @param {string} groupName - The name of the WhatsApp group.
 * @param {object} lineupData - The `gameData.lineup` object.
 * @returns {string} - The formatted AI summary message.
 */
async function generateGameSummary(events, teamNames, groupName, lineupData) {
    if (!process.env.GEMINI_API_KEY) {
        console.log("GEMINI_API_KEY nicht gefunden. KI-Zusammenfassung wird übersprungen.");
        return "";
    }

    // Find final and halftime scores from the event list
    const finalEvent = events.find(e => e.type === "StopPeriod" && parseInt(e.time.split(':')[0], 10) > 30);
    const halftimeEvent = events.find(e => e.type === "StopPeriod" && parseInt(e.time.split(':')[0], 10) <= 30);

    const finalScore = finalEvent ? finalEvent.score.replace('-', ':') : "N/A";
    const halftimeScore = halftimeEvent ? halftimeEvent.score.replace('-', ':') : "N/A";
    const gameDurationMinutes = finalEvent ? parseInt(finalEvent.time.split(':')[0], 10) : 60;

    // Score-Progression based on 10-minute intervals
    let scoreProgression = "Start: 0:0";
    for (let minute = 10; minute <= gameDurationMinutes; minute += 10) {
        // Find the last event *before or at* this minute
        const eventAtTime = [...events].reverse().find(e => {
            const evMinute = parseInt(e.time.split(':')[0], 10);
            return evMinute <= minute && e.score;
        });
        
        if (eventAtTime) {
            scoreProgression += `, ${minute}min: ${eventAtTime.score.replace('-', ':')}`;
        }
    }

    // 2. Detaillierte Statistiken extrahieren (using new helper)
    const gameStats = getStatsForPrompt(lineupData, teamNames);

    // 3. & 4. Neuer, kreativer und parteiischer Prompt (halftimeLength entfernt)
    const prompt = `Du bist ein witziger, leicht sarkastischer und fachkundiger deutscher Handball-Kommentator.
    Deine Aufgabe ist es, eine kurze, unterhaltsame Zusammenfassung (ca. 2-4 Sätze) für ein gerade beendetes Spiel zu schreiben.

    WICHTIG: Die WhatsApp-Gruppe, in der du postest, heißt "${groupName}". Analysiere diesen Namen, um herauszufinden, welches Team du unterstützen sollst. 
    Falls der Gruppenname NICHT EINDEUTIG einem Team zuzuordnen ist, sei neutral und ignoriere den Grußennamen. Falls sich die Gruppe aber DEFINITIV einem Team zuordnen lässt, unterstütze das Team mit Herzblut und roaste auch gerne das gegnerische Team.
    
    Hier sind die Spieldaten:
    - Heimmannschaft: ${teamNames.home}
    - Gastmannschaft: ${teamNames.guest}
    - Halbzeitstand: ${halftimeScore}
    - Endstand: ${finalScore}
    - Spiellänge: ${gameDurationMinutes} Minuten
    - Spielverlauf (ausgewählte Spielstände): ${scoreProgression}, Ende: ${finalScore}
    - Topscorer ${teamNames.home}: ${gameStats.homeTopScorer}
    - Topscorer ${teamNames.guest}: ${gameStats.guestTopScorer}
    - Zeitstrafen ${teamNames.home}: ${gameStats.homePenalties}
    - Zeitstrafen ${teamNames.guest}: ${gameStats.guestPenalties}
    - 7-Meter ${teamNames.home}: ${gameStats.homeSevenMeters}
    - 7-Meter ${teamNames.guest}: ${gameStats.guestSevenMeters}

    Anweisungen:
    1.  Gib deiner Zusammenfassung eine kreative, reißerische Überschrift in Fett (z.B. *Herzschlagfinale in der Halle West!* oder *Eine Lehrstunde in Sachen Abwehrschlacht.*).
    2.  Verwende die Statistiken für spitze Kommentare. (z.B. "Mit ${gameStats.guestPenalties} Zeitstrafen hat sich Team Gast das Leben selbst schwer gemacht." oder "Am Ende hat die Kaltschnäuzigkeit vom 7-Meter-Punkt den Unterschied gemacht."). Verwende die Statistiken nur, wenn sie auch sinnvoll oder wichtig für das Spiel waren.
    3.  Sei kreativ, vermeide Standardfloskeln. Gib dem Kommentar Persönlichkeit! Vermeide Sachen aus den Daten zu interpretieren die nicht daraus zu erschließen sind, bleibe lieber bei den Fakten als eine "zu offensive Abwehr" zu erfinden. 
    4.  Falls Julian Langschwert, Tiard Brinkmann und/oder Simon Goßmann gespielt hat, lobe ihn sarkastisch bis in den Himmel.

    Deine Zusammenfassung (nur Überschrift und Text, ohne "Zusammenfassung:"):`;

    try {
        const model = genAI.getGenerativeModel({ model: "gemini-pro" });
        const result = await model.generateContent(prompt);
        const response = result.response;
        const text = response.text();
        
        return `🤖 *KI-Analyse zum Spiel:*\n\n${text}`;
    } catch (error) {
        console.error("Fehler bei der AI-Zusammenfassung:", error);
        return "";
    }
}

module.exports = { generateGameSummary, extractGameStats };