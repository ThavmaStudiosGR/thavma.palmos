process.env.TZ = 'Europe/Athens';

const express = require('express');
const cors = require('cors');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;
const nodemailer = require('nodemailer');

// ============================================================
//  SUPABASE
//  Το Supabase είναι η κεντρική ουρά παραγγελιών.
//  Το site γράφει την παραγγελιά εδώ και το automation την
//  διαβάζει από εδώ για να την παίξει στο LIVE.
// ============================================================
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.warn('[SUPABASE WARNING] Λείπουν SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY (ή SUPABASE_KEY). Οι παραγγελιές από Supabase δεν θα λειτουργήσουν.');
}

const SUPABASE_HEADERS = {
    'apikey': SUPABASE_KEY || '',
    'Authorization': `Bearer ${SUPABASE_KEY || ''}`,
    'Content-Type': 'application/json'
};

app.use(cors());
app.use(express.json());

// ============================================================
//  ΓΡΑΜΜΑΤΟΣΕΙΡΑ (FFmpeg Font Fix - Ελληνικά χωρίς τετραγωνάκια)
// ============================================================
const FONT_CANDIDATES = [
    '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
    '/usr/share/fonts/truetype/freefont/FreeSansBold.ttf',
    '/usr/share/fonts/truetype/freefont/FreeSans.ttf',
    '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf',
];

function resolveFont() {
    for (const candidate of FONT_CANDIDATES) {
        if (fs.existsSync(candidate)) return candidate;
    }
    return null;
}

const FONT_PATH = resolveFont();
if (!FONT_PATH) {
    console.warn('[FONT WARNING] Δεν βρέθηκε καμία από τις προτεινόμενες γραμματοσειρές. Εγκατάστησε π.χ. `apt-get install fonts-dejavu-core` για σωστή απεικόνιση ελληνικών.');
} else {
    console.log(`[FONT] Χρήση γραμματοσειράς: ${FONT_PATH}`);
}

// Το fontfile='...' κομμάτι που μπαίνει μέσα σε κάθε drawtext filter
const FONT_ARG = FONT_PATH ? `fontfile='${FONT_PATH}':` : '';

let lastAnnouncedHour = getGreekTime().hour;
let lastAnthemDate = `${getGreekTime().year}-${getGreekTime().month}-${getGreekTime().date}`;
let songCounter = 0;
let currentNowPlaying = { title: "Φορτώνει...", genre: "Radio" };

// Η παλιά local requestQueue δεν χρησιμοποιείται πλέον για τις παραγγελιές.
// Η πραγματική ουρά βρίσκεται στο Supabase ώστε το site και το LIVE να
// βλέπουν την ίδια κατάσταση.
let requestQueue = [];
let globalPlayedSongs = [];

// Ουρά υποχρεωτικής, σε σειρά, Πρωτοχρονιάτικης ακολουθίας
let newYearQueue = [];
let lastNewYearSequenceKey = null; // π.χ. "2027-1" -> έτος-ημέρα, ώστε να ενεργοποιείται μία φορά


// ============================================================
//  SUPABASE SONG SYNC
//  Συγχρονίζει τα τοπικά MP3 με τον πίνακα songs.
//  Δεν διαγράφει εγγραφές από το Supabase.
// ============================================================
async function syncSongsToSupabase() {
    if (!SUPABASE_URL || !SUPABASE_KEY) return;

    try {
        const files = fs.readdirSync(__dirname)
            .filter(file => path.extname(file).toLowerCase() === '.mp3' && !isHourFile(file));

        if (files.length === 0) {
            console.log('[SUPABASE] Δεν βρέθηκαν MP3 για συγχρονισμό.');
            return;
        }

        const rows = files.map(file => ({
            filename: file,
            title: file
                .replace(/^\([A-ZΖΠα-ωήίόύέώ\s]+\)\s*/i, '')
                .replace(/\.mp3$/i, '')
                .replace(/_/g, ' ')
        }));

        const response = await fetch(`${SUPABASE_URL}/rest/v1/songs?on_conflict=filename`, {
            method: 'POST',
            headers: {
                ...SUPABASE_HEADERS,
                'Prefer': 'resolution=merge-duplicates,return=minimal'
            },
            body: JSON.stringify(rows)
        });

        if (!response.ok) {
            const text = await response.text();
            throw new Error(`HTTP ${response.status}: ${text}`);
        }

        console.log(`[SUPABASE] Συγχρονίστηκαν ${rows.length} τραγούδια.`);
    } catch (error) {
        console.error('[SUPABASE SONG SYNC ERROR]', error.message);
    }
}

// ============================================================
//  SUPABASE REQUEST
//  Παίρνει την παλαιότερη μη παιγμένη παραγγελιά.
//  Η εγγραφή ΔΕΝ γίνεται played πριν επιβεβαιωθεί ότι το αρχείο
//  υπάρχει τοπικά. Έτσι δεν χάνεται παραγγελιά από λάθος αρχείο.
// ============================================================
async function checkSupabaseRequest() {
    if (!SUPABASE_URL || !SUPABASE_KEY) return null;

    try {
        const response = await fetch(
            `${SUPABASE_URL}/rest/v1/requests?played=eq.false&order=created_at.asc&limit=1`,
            {
                method: 'GET',
                headers: SUPABASE_HEADERS
            }
        );

        if (!response.ok) {
            const text = await response.text();
            throw new Error(`HTTP ${response.status}: ${text}`);
        }

        const requests = await response.json();
        if (!Array.isArray(requests) || requests.length === 0) return null;

        const request = requests[0];
        const filename = request.filename;

        if (!filename || !fs.existsSync(path.join(__dirname, filename))) {
            console.warn(`[SUPABASE REQUEST] Το αρχείο δεν βρέθηκε τοπικά: ${filename}`);
            return null;
        }

        return {
            id: request.id,
            filename,
            requester: request.requester || request.name || 'Άγνωστος'
        };
    } catch (error) {
        console.error('[SUPABASE REQUEST ERROR]', error.message);
        return null;
    }
}

// Μαρκάρει την παραγγελιά ως παιγμένη μόνο όταν το FFmpeg ξεκινήσει κανονικά.
async function markSupabaseRequestPlayed(requestId) {
    if (!SUPABASE_URL || !SUPABASE_KEY || !requestId) return false;

    try {
        const response = await fetch(
            `${SUPABASE_URL}/rest/v1/requests?id=eq.${encodeURIComponent(requestId)}`,
            {
                method: 'PATCH',
                headers: {
                    ...SUPABASE_HEADERS,
                    'Prefer': 'return=minimal'
                },
                body: JSON.stringify({ played: true })
            }
        );

        if (!response.ok) {
            const text = await response.text();
            throw new Error(`HTTP ${response.status}: ${text}`);
        }

        console.log(`[SUPABASE REQUEST] Η παραγγελιά ${requestId} σημειώθηκε ως played.`);
        return true;
    } catch (error) {
        console.error('[SUPABASE MARK PLAYED ERROR]', error.message);
        return false;
    }
}

app.get('/api/now-playing', (req, res) => {
    res.json(currentNowPlaying);
});

app.get('/api/songs', (req, res) => {
    const files = fs.readdirSync(__dirname);
    let mp3Files = files.filter(file => path.extname(file).toLowerCase() === '.mp3' && !isHourFile(file));

    const songList = mp3Files.map(file => {
        let displayTitle = file.replace(/^\([A-ZΖΠα-ωήίόύέώ\s]+\)\s*/i, '').replace('.mp3', '').replace(/_/g, ' ');
        return { filename: file, title: displayTitle };
    });

    res.json(songList);
});

app.post('/api/request', async (req, res) => {
    const { filename, requester } = req.body;

    if (!filename || !fs.existsSync(path.join(__dirname, filename))) {
        return res.status(400).json({ success: false, message: "Το τραγούδι δεν βρέθηκε." });
    }

    const cleanRequester = String(requester || "Άγνωστος").trim().slice(0, 80);

    // ΠΡΩΤΑ γράφουμε την παραγγελιά στο Supabase.
    // Έτσι το site και το LIVE χρησιμοποιούν την ίδια ουρά.
    if (!SUPABASE_URL || !SUPABASE_KEY) {
        return res.status(503).json({
            success: false,
            message: "Η υπηρεσία παραγγελιών δεν είναι διαθέσιμη αυτή τη στιγμή."
        });
    }

    try {
        const response = await fetch(`${SUPABASE_URL}/rest/v1/requests`, {
            method: 'POST',
            headers: {
                ...SUPABASE_HEADERS,
                'Prefer': 'return=representation'
            },
            body: JSON.stringify({
                filename,
                requester: cleanRequester,
                played: false
            })
        });

        if (!response.ok) {
            const text = await response.text();
            throw new Error(`HTTP ${response.status}: ${text}`);
        }

        const saved = await response.json();

        console.log(`[REQUEST ADDED] ${filename} από ${cleanRequester} -> Supabase`);
        return res.json({
            success: true,
            message: "Η παραγγελιά καταχωρήθηκε!",
            request: Array.isArray(saved) ? saved[0] : saved
        });
    } catch (error) {
        console.error('[SUPABASE REQUEST INSERT ERROR]', error.message);
        return res.status(500).json({
            success: false,
            message: "Η παραγγελιά δεν μπόρεσε να καταχωρηθεί."
        });
    }
});

app.get('/', (req, res) => {
    res.send('Thavma Παλμός Automation System v7.0 (Greek Font Fix + Christmas/NYE FX) is Running!');
});

app.post('/api/comment', async (req, res) => {
    const { name, comment } = req.body;

    if (!name || !comment) {
        return res.status(400).json({ success: false, message: "Παρακαλώ συμπληρώστε όλα τα πεδία." });
    }

    // Ρύθμιση του αποστολέα email (Nodemailer)
    const transporter = nodemailer.createTransport({
        service: 'gmail',
        auth: {
            user: process.env.EMAIL_USER, // Το email σου
            pass: process.env.EMAIL_PASS  // Κωδικός εφαρμογής Gmail
        }
    });

    const mailOptions = {
        from: process.env.EMAIL_USER,
        to: 'nikosthavmagr@gmail.com',
        subject: `Thavma Παλμός - Νέο Σχόλιο από: ${name}`,
        text: `Ο Χρήστης ${name} έγραψε το παρακάτω σχόλιο:\n\n"${comment}"\n\nστην ιστοσελίδα [Thavma Παλμός]`
    };

    try {
        await transporter.sendMail(mailOptions);
        console.log(`[EMAIL SENT] Στάλθηκε σχόλιο από ${name}`);
        res.json({ success: true, message: "Το σχόλιο εστάλη επιτυχώς!" });
    } catch (error) {
        console.error("[EMAIL ERROR]", error);
        res.status(500).json({ success: false, message: "Υπήρξε πρόβλημα στην αποστολή." });
    }
});

app.listen(PORT, '0.0.0.0', async () => {
    console.log(`Ο Server ξεκίνησε στο port ${PORT}`);
    await syncSongsToSupabase();
    startNextMedia();
});

// ============================================================
//  ΧΡΟΝΟΣ (Ελλάδα)
// ============================================================
function getGreekTime() {
    const date = new Date();
    const greekString = date.toLocaleString("en-US", { timeZone: "Europe/Athens" });
    const greekDate = new Date(greekString);
    return {
        raw: greekDate,
        day: greekDate.getDay(),
        date: greekDate.getDate(),
        month: greekDate.getMonth(),   // 0 = Ιανουάριος ... 11 = Δεκέμβριος
        year: greekDate.getFullYear(),
        hour: greekDate.getHours(),
        minute: greekDate.getMinutes(),
        second: greekDate.getSeconds()
    };
}

// Βοηθητικό: Date object στην "Ελληνική" βάση του δοσμένου getGreekTime(), με offset ημερών & ώρα-στόχο
function athensTargetDate(t, dayOffset, hour, minute, second) {
    return new Date(t.raw.getFullYear(), t.raw.getMonth(), t.raw.getDate() + dayOffset, hour, minute, second, 0);
}

// Δευτερόλεπτα από "τώρα" (t.raw) μέχρι μια target ημερομηνία/ώρα. Μπορεί να είναι αρνητικό αν έχει ήδη περάσει.
function secondsFromNowTo(t, targetDate) {
    return (targetDate.getTime() - t.raw.getTime()) / 1000;
}

function findHourFile(hour) {
    const expectedFile = `clock${hour}.mp3`;
    if (fs.existsSync(path.join(__dirname, expectedFile))) {
        return expectedFile;
    }
    return null;
}

function isHourFile(fileName) {
    if (fileName === 'thavma_palmos_jingle.mp3' || fileName === 'ethnikos_ymnos.mp3') return true;
    if (fileName === 'ΚαλήΧρονιά.mp3' || fileName === 'thavma_palmos_christmas_jingle.mp3') return true;
    if (fileName === 'Αρχιμηνιά και Αρχιχρονιά το λάδι 19.mp3') return true;
    return /^clock\d+\.mp3$/.test(fileName);
}

// ============================================================
//  ΧΡΙΣΤΟΥΓΕΝΝΙΑΤΙΚΗ ΠΕΡΙΟΔΟΣ / (X) ΛΟΓΙΚΗ
// ============================================================
// Περίοδος: 18 Νοεμβρίου -> 31 Ιανουαρίου (wrap γύρω από τη χρονιά)
function isChristmasPeriod(month, date) {
    if (month === 10 && date >= 18) return true; // Νοέμβριος από 18 και μετά
    if (month === 11) return true;                // Ολόκληρος ο Δεκέμβριος
    if (month === 0) return true;                 // Ολόκληρος ο Ιανουάριος
    return false;
}

// 1η Ιανουαρίου 00:00 - 02:00 -> boost του (X) στο 80%
function isNewYearXBoostWindow(month, date, hour) {
    return month === 0 && date === 1 && hour >= 0 && hour < 2;
}

function getRequiredGenre() {
    const time = getGreekTime();
    const d = time.day;
    const h = time.hour;

    if (d === 0 || d === 6) {
        if ((h >= 12 && h < 16) || (h >= 20 && h < 24)) return 'MIX_PREFER_P';
        return 'MIX';
    }
    if (d === 1 || d === 3 || d === 5) {
        if (h >= 2 && h < 7) return 'B';
        if (h >= 7 && h < 12) return 'R';
        if (h >= 12 && h < 17) return 'P_LZ';
        if (h >= 17 && h < 20) return 'R';
        return 'MIX';
    }
    if (d === 2 || d === 4) {
        if (h >= 0 && h < 8) return 'B';
        if (h >= 8 && h < 12) return 'R';
        if (h >= 12 && h < 16) return 'P_LZ';
        if (h >= 16 && h < 20) return 'R';
        return 'MIX';
    }
    return 'MIX';
}

async function selectNextFile() {
    const time = getGreekTime();

    // 1. Εθνικός Ύμνος
    const todayKey = `${time.year}-${time.month}-${time.date}`;
    if (time.hour === 0 && lastAnthemDate !== todayKey) {
        if (fs.existsSync(path.join(__dirname, 'ethnikos_ymnos.mp3'))) {
            lastAnthemDate = todayKey;
            currentNowPlaying = { title: "ΕΘΝΙΚΟΣ ΥΜΝΟΣ", genre: "Ειδική Μετάδοση" };
            return { file: 'ethnikos_ymnos.mp3', title: 'ΕΘΝΙΚΟΣ ΥΜΝΟΣ', genreLabel: 'Ειδική Μετάδοση', isSystem: true };
        }
    }

    // 2. Αναγγελία Ώρας
    if (lastAnnouncedHour !== time.hour) {
        const hourFile = findHourFile(time.hour);
        if (hourFile) {
            console.log(`[TIME CHIME] Βρέθηκε το αρχείο ώρας: ${hourFile}`);
            lastAnnouncedHour = time.hour;
            let hourString = time.hour < 10 ? `0${time.hour}.00` : `${time.hour}.00`;
            currentNowPlaying = { title: `Η ώρα είναι ${hourString}`, genre: "Ώρα Ελλάδος" };

            // Αν είναι η 00:00 της 1ης Ιανουαρίου, προγραμματίζουμε την υποχρεωτική Πρωτοχρονιάτικη ακολουθία
            if (time.hour === 0 && time.month === 0 && time.date === 1) {
                const sequenceKey = `${time.year}-${time.date}`;
                if (lastNewYearSequenceKey !== sequenceKey) {
                    const nySequenceFiles = [
                        'ΚαλήΧρονιά.mp3',
                        'thavma_palmos_christmas_jingle.mp3',
                        'Αρχιμηνιά και Αρχιχρονιά το λάδι 19.mp3'
                    ];
                    newYearQueue = nySequenceFiles.filter(f => fs.existsSync(path.join(__dirname, f)));
                    lastNewYearSequenceKey = sequenceKey;
                    console.log(`[NEW YEAR] Προγραμματίστηκε η Πρωτοχρονιάτικη ακολουθία (${newYearQueue.length} αρχεία).`);
                }
            }

            return { file: hourFile, title: `Η ώρα είναι ${hourString}`, genreLabel: 'Ώρα Ελλάδος', isHourAnnouncement: true };
        }
    }

    // 2.5 Υποχρεωτική Πρωτοχρονιάτικη ακολουθία (σε σειρά, πριν από οτιδήποτε άλλο)
    if (newYearQueue.length > 0) {
        const nextFile = newYearQueue.shift();
        if (fs.existsSync(path.join(__dirname, nextFile))) {
            let displayTitle = nextFile.replace('.mp3', '');
            currentNowPlaying = { title: displayTitle, genre: "Πρωτοχρονιάτικη Ακολουθία" };
            return { file: nextFile, title: displayTitle, genreLabel: 'Πρωτοχρονιάτικη Ακολουθία', isSystem: true };
        }
    }

    // 3. Jingle ανά 5 τραγούδια
    if (songCounter >= 5) {
        if (fs.existsSync(path.join(__dirname, 'thavma_palmos_jingle.mp3'))) {
            songCounter = 0;
            currentNowPlaying = { title: "Thavma Παλμός Jingle", genre: "Σήμα Σταθμού" };
            return { file: 'thavma_palmos_jingle.mp3', title: 'Thavma Παλμός Jingle', genreLabel: 'Σήμα Σταθμού', isSystem: true };
        }
    }

    // 4. ΕΛΕΓΧΟΣ ΠΑΡΑΓΓΕΛΙΑΣ
    // Η παραγγελιά έρχεται από το Supabase, όχι από local memory.
    // Έτσι μπορεί να σταλεί από το site και να την πάρει το LIVE.
    const supabaseRequest = await checkSupabaseRequest();

    if (supabaseRequest) {
        const requestedFile = supabaseRequest.filename;

        let displayTitle = requestedFile
            .replace(/^\([A-ZΖΠα-ωήίόύέώ\s]+\)\s*/i, '')
            .replace(/\.mp3$/i, '')
            .replace(/_/g, ' ');

        const displayGenre = `Παραγγελία Ακροατή [${supabaseRequest.requester}]`;

        return {
            file: requestedFile,
            title: displayTitle,
            genreLabel: displayGenre,
            isSong: true,
            isRequest: true,
            requestId: supabaseRequest.id
        };
    }

    // 5. Κανονικό Τραγούδι
    const files = fs.readdirSync(__dirname);
    let mp3Files = files.filter(file => path.extname(file).toLowerCase() === '.mp3' && !isHourFile(file));

    if (mp3Files.length === 0) return null;

    const christmasActive = isChristmasPeriod(time.month, time.date);
    const xFiles = mp3Files.filter(f => f.startsWith('(X)'));
    // Όταν είναι ενεργή η χριστουγεννιάτικη περίοδος, η "κανονική" δεξαμενή τραγουδιών
    // εξαιρεί προσωρινά τα (X) ώστε να ελέγχουμε εμείς με πιθανότητα πότε μπαίνουν.
    const normalPool = christmasActive ? mp3Files.filter(f => !f.startsWith('(X)')) : mp3Files;

    const genre = getRequiredGenre();
    let filteredFiles = [];
    let genreLabel = "Mix Πρόγραμμα";

    if (genre === 'B') {
        filteredFiles = normalPool.filter(f => f.startsWith('(B)'));
        genreLabel = "Beats (Disco, Dance, Club)";
    } else if (genre === 'R') {
        filteredFiles = normalPool.filter(f => f.startsWith('(R)'));
        genreLabel = "Radio (Κανονική Ροή)";
    } else if (genre === 'P_LZ') {
        filteredFiles = normalPool.filter(f => f.startsWith('(Π)') || f.startsWith('(ΛΖ)'));
        genreLabel = "Παραδοσιακά & Λαϊκά";
    } else if (genre === 'MIX_PREFER_P') {
        let pFiles = normalPool.filter(f => f.startsWith('(Π)'));
        if (pFiles.length > 0 && Math.random() < 0.7) filteredFiles = pFiles;
        else filteredFiles = normalPool;
        genreLabel = "Mix (Έμφαση στα Παραδοσιακά)";
    } else {
        filteredFiles = normalPool;
        genreLabel = "Mix Πρόγραμμα";
    }

    if (filteredFiles.length === 0) filteredFiles = normalPool;

    // Χριστουγεννιάτικη επιλογή (X)
    if (christmasActive && xFiles.length > 0) {
        const xBoost = isNewYearXBoostWindow(time.month, time.date, time.hour);
        const xProbability = xBoost ? 0.80 : 0.35;

        if (Math.random() < xProbability) {
            // Αμιγώς χριστουγεννιάτικο τραγούδι
            filteredFiles = xFiles;
            genreLabel = xBoost
                ? "Χριστουγεννιάτικο Πρόγραμμα (X) - Πρωτοχρονιά"
                : "Χριστουγεννιάτικο Πρόγραμμα (X)";
        } else {
            // Αναμειγνύονται στη ροή του κανονικού προγράμματος
            filteredFiles = filteredFiles.concat(xFiles);
        }
    }

    if (filteredFiles.length === 0) filteredFiles = mp3Files;

    let availableFiles = filteredFiles.filter(f => !globalPlayedSongs.includes(f));

    if (availableFiles.length === 0) {
        globalPlayedSongs = globalPlayedSongs.filter(f => !filteredFiles.includes(f));
        availableFiles = filteredFiles;
    }

    const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;
    const now = Date.now();
    let randomFile;

    let availableNewFiles = availableFiles.filter(f => {
        const filePath = path.join(__dirname, f);
        return fs.existsSync(filePath) && (now - fs.statSync(filePath).mtimeMs) <= THREE_DAYS_MS;
    });

    if (availableNewFiles.length > 0) {
        availableNewFiles.sort((a, b) => {
            return fs.statSync(path.join(__dirname, b)).mtimeMs - fs.statSync(path.join(__dirname, a)).mtimeMs;
        });
        randomFile = availableNewFiles[0];
        genreLabel = "ΝΕΟ ΤΡΑΓΟΥΔΙ! - " + genreLabel;
    } else {
        randomFile = availableFiles[Math.floor(Math.random() * availableFiles.length)];
    }

    globalPlayedSongs.push(randomFile);

    let displayTitle = randomFile.replace(/^\([A-ZΖΠα-ωήίόύέώ\s]+\)\s*/i, '').replace('.mp3', '').replace(/_/g, ' ');

    return { file: randomFile, title: displayTitle, genreLabel: genreLabel, isSong: true };
}

// ============================================================
//  VISUAL COUNTDOWN & FX ΠΡΩΤΟΧΡΟΝΙΑΣ (31/12 23:50:00 -> 00:00:00)
// ============================================================
// Όλα τα offsets υπολογίζονται σε δευτερόλεπτα σχετικά με τη στιγμή εκκίνησης
// της τρέχουσας ffmpeg διεργασίας (spawnTime). Μέσα στο φίλτρο, η μεταβλητή `t`
// του FFmpeg είναι ακριβώς αυτά τα δευτερόλεπτα από την εκκίνηση, οπότε η αντιστοίχιση
// είναι ακριβής ανεξάρτητα από το ποιο τραγούδι παίζει εκείνη τη στιγμή.
function buildNewYearCountdownFilters(spawnTime) {
    const isDec31 = (spawnTime.month === 11 && spawnTime.date === 31);
    const isEarlyJan1 = (spawnTime.month === 0 && spawnTime.date === 1 && spawnTime.hour === 0 && spawnTime.minute === 0 && spawnTime.second < 20);

    if (!isDec31 && !isEarlyJan1) {
        return { filters: [], blackoutStart: null, blackoutEnd: null, suppressNormalOverlayUntil: null };
    }

    const target2350 = athensTargetDate(spawnTime, 0, 23, 50, 0);
    const target2359 = athensTargetDate(spawnTime, 0, 23, 59, 0);
    const target235950 = athensTargetDate(spawnTime, 0, 23, 59, 50);
    const targetMidnight = isDec31
        ? athensTargetDate(spawnTime, 1, 0, 0, 0)
        : athensTargetDate(spawnTime, 0, 0, 0, 0);

    const off2350 = secondsFromNowTo(spawnTime, target2350);
    const off2359 = secondsFromNowTo(spawnTime, target2359);
    const off235950 = secondsFromNowTo(spawnTime, target235950);
    const offMidnight = secondsFromNowTo(spawnTime, targetMidnight);
    const nextYear = isDec31 ? spawnTime.year + 1 : spawnTime.year;

    const filters = [];

    // Έκφραση υπολειπόμενου χρόνου (σε δευτερόλεπτα) μέχρι τα μεσάνυχτα, σε σχέση με το t του FFmpeg
    const remainingExpr = `(${offMidnight.toFixed(2)}-t)`;

    // -------- ΦΑΣΗ Α: 23:50 -> 23:59, ανά λεπτό, μεγαλώνει το μέγεθος & γίνεται πιο χρυσαφί --------
    const goldSteps = ['white', '0xFFF5CC', '0xFFEDB0', '0xFFE494', '0xFFDC78', '0xFFD35C', '0xFFCB40', '0xFFD700', '0xFFD700'];
    for (let i = 0; i < 9; i++) {
        const start = off2350 + i * 60;
        const end = off2350 + (i + 1) * 60;
        const fontsize = 42 + i * 7;
        const color = goldSteps[i];
        const countdownText = `%{eif\\:trunc(${remainingExpr}/60)\\:d\\:2}\\:%{eif\\:mod(trunc(${remainingExpr})\\,60)\\:d\\:2}`;
        filters.push(
            `drawtext=${FONT_ARG}text='${countdownText}':x=(w-text_w)/2:y=90:fontsize=${fontsize}:fontcolor=${color}:box=1:boxcolor=black@0.55:boxborderw=12:enable='between(t\\,${start.toFixed(2)}\\,${end.toFixed(2)})'`
        );
    }

    // -------- ΦΑΣΗ Β: 23:59:00 -> 23:59:50, μαύρη οθόνη + pulse ανά δευτερόλεπτο --------
    for (let i = 0; i < 50; i++) {
        const start = off2359 + i;
        const end = off2359 + i + 1;
        const fontsize = i % 2 === 0 ? 130 : 150;
        const secondsText = `%{eif\\:trunc(${remainingExpr})\\:d\\:2}`;
        filters.push(
            `drawtext=${FONT_ARG}text='${secondsText}':x=(w-text_w)/2:y=(h-text_h)/2:fontsize=${fontsize}:fontcolor=0xFFD700:enable='between(t\\,${start.toFixed(2)}\\,${end.toFixed(2)})'`
        );
    }

    // -------- ΦΑΣΗ Γ: 23:59:50 -> 23:59:59, τελευταία 10", "τρελό" έντονο pulse --------
    const crazyColors = ['0xFFD700', '0xFFFFFF'];
    for (let i = 0; i < 10; i++) {
        const start = off235950 + i;
        const end = off235950 + i + 1;
        const fontsize = i % 2 === 0 ? 190 : 220;
        const color = crazyColors[i % 2];
        const secondsText = `%{eif\\:trunc(${remainingExpr})\\:d\\:1}`;
        filters.push(
            `drawtext=${FONT_ARG}text='${secondsText}':x=(w-text_w)/2:y=(h-text_h)/2:fontsize=${fontsize}:fontcolor=${color}:enable='between(t\\,${start.toFixed(2)}\\,${end.toFixed(2)})'`
        );
    }

    // -------- ΦΑΣΗ Δ: 00:00:00, "Καλή Χρονιά {έτος}!" + απλά fireworks --------
    const nyStart = offMidnight;
    const nyEnd = offMidnight + 10;
    const nyText = `Καλή Χρονιά ${nextYear}!`.replace(/'/g, '’');
    filters.push(
        `drawtext=${FONT_ARG}text='${nyText}':x=(w-text_w)/2:y=(h-text_h)/2:fontsize=100:fontcolor=0xFFD700:box=1:boxcolor=black@0.5:boxborderw=16:enable='between(t\\,${nyStart.toFixed(2)}\\,${nyEnd.toFixed(2)})'`
    );

    // Απλό "fireworks" εφέ χωρίς εξωτερικό asset: μερικές αστεράκι-εκρήξεις σε διαφορετικά σημεία,
    // η καθεμία εμφανίζεται στιγμιαία λίγο μετά τα μεσάνυχτα.
    const burstPoints = [
        { x: 'w*0.15', y: 'h*0.25', delay: 0.3 },
        { x: 'w*0.85', y: 'h*0.20', delay: 0.9 },
        { x: 'w*0.25', y: 'h*0.75', delay: 1.6 },
        { x: 'w*0.75', y: 'h*0.70', delay: 2.3 },
        { x: 'w*0.50', y: 'h*0.15', delay: 3.0 },
    ];
    burstPoints.forEach((b, idx) => {
        const bStart = offMidnight + b.delay;
        const bEnd = bStart + 1.2;
        const color = idx % 2 === 0 ? '0xFFD700' : '0xFF4444';
        filters.push(
            `drawtext=${FONT_ARG}text='✦':x=${b.x}:y=${b.y}:fontsize=80:fontcolor=${color}:enable='between(t\\,${bStart.toFixed(2)}\\,${bEnd.toFixed(2)})'`
        );
    });

    return {
        filters,
        blackoutStart: off2359,
        blackoutEnd: offMidnight,
        // Κρύβουμε τα κανονικά label/title/clock overlays κατά το blackout & λίγο μετά τα μεσάνυχτα
        suppressNormalOverlayFrom: off2359,
        suppressNormalOverlayUntil: nyEnd
    };
}

async function startNextMedia() {
    const media = await selectNextFile();

    if (!media || !fs.existsSync(path.join(__dirname, 'background.jpg'))) {
        setTimeout(startNextMedia, 5000);
        return;
    }

    console.log(`Playing [${media.title}]`);

    if (media.isHourAnnouncement) songCounter = 0;
    else if (media.isSong && !media.isRequest) songCounter++;

    currentNowPlaying = { title: media.title, genre: media.genreLabel };

    const streamKey = process.env.YOUTUBE_STREAM_KEY;
    if (!streamKey) {
        setTimeout(startNextMedia, 5000);
        return;
    }

    // ΑΠΟΛΥΤΟΣ ΚΑΘΑΡΙΣΜΟΣ: Αντικατάσταση του : και , με ασφαλείς χαρακτήρες για το FFmpeg
    const cleanLabel = media.genreLabel.replace(/'/g, "’").replace(/:/g, " — ").replace(/,/g, " ");
    const cleanTitle = media.title.replace(/'/g, "’").replace(/:/g, ".").replace(/,/g, " ");
    const clockText = "%{localtime\\:%H\\\\\\:%M\\\\\\:%S & %d\\\\\\/%m\\\\\\/%Y}";

    const spawnTime = getGreekTime();
    const ny = buildNewYearCountdownFilters(spawnTime);

    // Αν υπάρχει ενεργό "blackout" παράθυρο (23:59:00 -> 00:00:00), βάζουμε μαύρο drawbox
    // πάνω από το background.jpg, ώστε να μείνουν μόνο οι αριθμοί/το κείμενο ορατά.
    let blackoutFilter = '';
    if (ny.blackoutStart !== null) {
        blackoutFilter = `,drawbox=x=0:y=0:w=iw:h=ih:color=black:t=fill:enable='between(t\\,${ny.blackoutStart.toFixed(2)}\\,${ny.blackoutEnd.toFixed(2)})'`;
    }

    // Τα κανονικά overlays (label/title/clock) κρύβονται όσο διαρκεί το blackout + λίγο μετά τα μεσάνυχτα
    let normalOverlayEnable = '';
    if (ny && ny.suppressNormalOverlayFrom !== undefined && ny.suppressNormalOverlayFrom !== null) {
        normalOverlayEnable = `:enable='not(between(t\\,${ny.suppressNormalOverlayFrom.toFixed(2)}\\,${ny.suppressNormalOverlayUntil.toFixed(2)}))'`;
    }

    const baseOverlayFilters =
        `drawtext=${FONT_ARG}text='${cleanLabel}':x=30:y=30:fontsize=20:fontcolor=yellow:box=1:boxcolor=black@0.6:boxborderw=8${normalOverlayEnable}, ` +
        `drawtext=${FONT_ARG}text='${cleanTitle}':x=30:y=65:fontsize=28:fontcolor=white:box=1:boxcolor=black@0.6:boxborderw=10${normalOverlayEnable}, ` +
        `drawtext=${FONT_ARG}text='${clockText}':x=w-tw-30:y=30:fontsize=20:fontcolor=black${normalOverlayEnable}`;

    const countdownFilterChain = ny.filters.length > 0 ? ',' + ny.filters.join(', ') : '';

    const vfChain =
        `scale=1280:720${blackoutFilter}, ${baseOverlayFilters}${countdownFilterChain}`;

    // ΣΤΡΩΤΗ ΡΟΗ: Το -fflags μπήκε πρώτο, και το -re μπήκε αποκλειστικά στον ήχο για να παίζουν σωστά τα μικρά αρχεία
    const ffmpeg = spawn('ffmpeg', [
        '-re',
        '-fflags', '+genpts',
        '-loop', '1', '-framerate', '2', '-i', 'background.jpg',
        '-i', path.join(__dirname, media.file),
        '-map', '0:v:0', '-map', '1:a:0',
        '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'stillimage', '-threads', '1',
        '-vf', vfChain,
        '-r', '15', '-g', '30', '-b:v', '2500k', '-maxrate', '2500k', '-bufsize', '5000k',
        '-c:a', 'aac', '-b:a', '128k', '-shortest', '-pix_fmt', 'yuv420p', '-f', 'flv',
        `rtmp://a.rtmp.youtube.com/live2/${streamKey}`
    ], { stdio: ['ignore', 'ignore', 'pipe'] });

    // Μόλις ξεκινήσει το FFmpeg χωρίς άμεσο spawn error, η παραγγελιά
    // θεωρείται ότι μπήκε στο LIVE και μπορεί να γίνει played.
    if (media.isRequest && media.requestId) {
        ffmpeg.once('spawn', () => {
            markSupabaseRequestPlayed(media.requestId).catch(error => {
                console.error('[SUPABASE REQUEST PLAYED ERROR]', error.message);
            });
        });
    }

    ffmpeg.stderr.on('data', data => {
        const message = data.toString().trim();
        if (message && message.toLowerCase().includes('error')) {
            console.error('[FFMPEG ERROR]', message);
        }
    });

    ffmpeg.on('close', () => {
        setImmediate(startNextMedia);
    });

    ffmpeg.on('error', error => {
        console.error('[FFMPEG SPAWN ERROR]', error.message);
        setTimeout(startNextMedia, 1000);
    });
}