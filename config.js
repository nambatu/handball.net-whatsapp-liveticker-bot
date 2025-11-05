// config.js

const EVENT_MAP = {
    // New event types from handball.net JSON
    "StartPeriod": { label: "Spielbeginn", emoji: "▶️" },
    "StopPeriod": { label: "Periodenende", emoji: "⏸️" }, // This is used for both halftime and game end
    "Goal": { label: "Tor", emoji: "🤾‍♀️" },
    "SevenMeterGoal": { label: "7-Meter Tor", emoji: "7️⃣✅" },
    "SevenMeterMissed": { label: "7-Meter Fehlwurf", emoji: "7️⃣❌" },
    "TwoMinutePenalty": { label: "Zeitstrafe", emoji: "✌🏼" },
    "Warning": { label: "Gelbe Karte", emoji: "🟨" },
    "Timeout": { label: "Timeout", emoji: "⏱️" },
    "Disqualification": { label: "Rote Karte", emoji: "🟥" },
    "DisqualificationWithReport": { label: "Blaue Karte", emoji: "🟦" },

    // A fallback for any event type we haven't seen yet
    "default": { label: "Ereignis", emoji: "📢" }
};

// This makes the EVENT_MAP available to other files
module.exports = { EVENT_MAP };