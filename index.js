const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 10000;

// Απαραίτητο για να διαβάζει σωστά την IP πίσω από το proxy του Render
app.set('trust proxy', 1); 

// Ενεργοποίηση CORS για να δέχεται αιτήματα από το CodeSandbox
app.use(cors());
app.use(express.json());

// --- ΒΑΣΗ ΤΡΑΓΟΥΔΙΩΝ (Mock Data) ---
const availableSongs = {
    R: [
        { filename: "radio_hit_1", title: "Σύγχρονο Pop Hit" },
        { filename: "radio_hit_2", title: "Ραδιοφωνική Επιτυχία" }
    ],
    B: [
        { filename: "dance_pop_1", title: "Dance-Pop Ρυθμός" },
        { filename: "club_banger", title: "Club Βραδιά" }
    ],
    P_LZ: [
        { filename: "tsifteteli_1", title: "Ανεβαστικό Τσιφτετέλι" },
        { filename: "laiko_heavy", title: "Βαρύ Λαϊκό" },
        { filename: "nisiotiko_party", title: "Νησιώτικο Γλέντι" },
        { filename: "kalamatiano_classic", title: "Παραδοσιακό Καλαματιανό" }
    ],
    MIX: [
        { filename: "mix_summer", title: "Thavma Summer Mix" },
        { filename: "mix_night", title: "Late Night Mix" }
    ]
};

// --- STATE ΣΥΣΤΗΜΑΤΟΣ ---
let nowPlaying = {
    title: "Thavma Παλμός - Κανονική Ροή",
    genre: "RADIO",
    requester: ""
};

const requestQueue = []; // Εδώ μπαίνουν οι παραγγελίες
const ipCooldowns = new Map(); // Αποθήκευση IP και χρόνου λήξης της ποινής
const COOLDOWN_MINUTES = 30;

// --- ΛΟΓΙΚΗ ΑΛΛΑΓΗΣ ΤΡΑΓΟΥΔΙΩΝ ---
// Κάθε 3 λεπτά (180000 ms) ελέγχει αν υπάρχει παραγγελία στην ουρά.
// Αν υπάρχει, την βάζει να παίξει. Αν όχι, επιστρέφει στην κανονική ροή.
setInterval(() => {
    if (requestQueue.length > 0) {
        const nextSong = requestQueue.shift();
        nowPlaying = {
            title: nextSong.title,
            genre: "ΠΑΡΑΓΓΕΛΙΑ",
            requester: nextSong.requester
        };
        console.log(`[PLAYING] Τώρα παίζει η παραγγελία του/της: ${nextSong.requester}`);
    } else {
        nowPlaying = {
            title: "Thavma Παλμός - Κανονική Ροή",
            genre: "RADIO",
            requester: ""
        };
    }
}, 180000); 

// --- ENDPOINTS (API) ---

// 1. Επιστροφή της λίστας τραγουδιών
app.get('/api/songs', (req, res) => {
    res.json(availableSongs);
});

// 2. Επιστροφή του τι παίζει τώρα (για το Live Panel)
app.get('/api/now-playing', (req, res) => {
    res.json(nowPlaying);
});

// 3. Λήψη νέας παραγγελίας
app.get('/api/request', (req, res) => {
    const songId = req.query.song;
    const requesterName = req.query.name;
    const bypassCode = req.query.bypass;
    const userIp = req.ip;

    // Βασικός έλεγχος δεδομένων
    if (!songId || !requesterName) {
        return res.status(400).json({ message: "Λείπουν στοιχεία παραγγελίας." });
    }

    // --- ΕΛΕΓΧΟΣ COOLDOWN (30 Λεπτά) ---
    const isBypass = (bypassCode === 'TPΠ' || bypassCode === 'TPP');
    const now = Date.now();

    if (!isBypass) {
        if (ipCooldowns.has(userIp)) {
            const expirationTime = ipCooldowns.get(userIp);
            if (now < expirationTime) {
                const remainingMinutes = Math.ceil((expirationTime - now) / 60000);
                return res.status(429).json({ 
                    message: `Έχεις κάνει ήδη παραγγελία! Δοκίμασε ξανά σε ${remainingMinutes} λεπτά.` 
                });
            }
        }
        // Καταγραφή νέου cooldown αν δεν έχει bypass
        ipCooldowns.set(userIp, now + (COOLDOWN_MINUTES * 60000));
    }

    // --- ΑΝΑΖΗΤΗΣΗ ΤΙΤΛΟΥ ΤΡΑΓΟΥΔΙΟΥ ---
    let songTitle = "Άγνωστο Τραγούδι";
    for (const category in availableSongs) {
        const found = availableSongs[category].find(s => s.filename === songId);
        if (found) {
            songTitle = found.title;
            break;
        }
    }

    // --- ΕΙΣΑΓΩΓΗ ΣΤΗΝ ΟΥΡΑ ---
    requestQueue.push({
        title: songTitle,
        requester: requesterName
    });

    console.log(`[NEW REQUEST] Το τραγούδι "${songTitle}" προστέθηκε από: ${requesterName} (IP: ${userIp})`);

    // Αν η ουρά ήταν άδεια και έπαιζε η κανονική ροή, ανανεώνουμε το nowPlaying αμέσως
    if (nowPlaying.genre === "RADIO" && requestQueue.length === 1) {
        const next = requestQueue.shift();
        nowPlaying = {
            title: next.title,
            genre: "ΠΑΡΑΓΓΕΛΙΑ",
            requester: next.requester
        };
    }

    return res.json({ 
        message: `Έγινε η παραγγελιά! ${isBypass ? '(Admin Bypass Ενεργό)' : ''}` 
    });
});

// Εκκίνηση Server
app.listen(PORT, () => {
    console.log(`Thavma Stream API is running on port ${PORT}`);
    console.log(`Listening for requests...`);
});