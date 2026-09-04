process.env.TZ = 'Europe/Athens';

const express = require('express');
const cors = require('cors');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;
const nodemailer = require('nodemailer');

app.use(cors());
app.use(express.json());

// Ανάγνωση των στοιχείων Supabase από τα GitHub Secrets
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.error('[SUPABASE ERROR] Λείπουν τα SUPABASE_URL ή SUPABASE_KEY από τα GitHub Secrets!');
}

// ============================================================
//  ΑΥΤΟΜΑΤΟΣ ΣΥΓΧΡΟΝΙΣΜΟΣ ΤΩΝ 155 ΤΡΑΓΟΥΔΙΩΝ ΣΤΟ SUPABASE
// ============================================================
async function syncSongsToSupabase() {
    if (!SUPABASE_URL || !SUPABASE_KEY) return;
    try {
        console.log('[SUPABASE SYNC] Έναρξη συγχρονισμού των τραγουδιών...');
        const files = fs.readdirSync(__dirname);
        let mp3Files = files.filter(file => path.extname(file).toLowerCase() === '.mp3' && !isHourFile(file));

        const songsPayload = mp3Files.map(file => {
            let displayTitle = file.replace(/^\([A-ZZΠα-ωήίόύέώ\s]+\)\s*/i, '').replace('.mp3', '').replace(/_/g, ' ');
            return { filename: file, title: displayTitle };
        });

        // Μαζικό ανέβασμα των τραγουδιών με παράκαμψη διπλότυπων (upsert)
        const response = await fetch(`${SUPABASE_URL}/rest/v1/songs`, {
            method: 'POST',
            headers: {
                "apikey": SUPABASE_KEY,
                "Authorization": `Bearer ${SUPABASE_KEY}`,
                "Content-Type": "application/json",
                "Prefer": "resolution=merge-duplicates"
            },
            body: JSON.stringify(songsPayload)
        });

        if (response.ok) {
            console.log(`[SUPABASE SYNC] Επιτυχής συγχρονισμός! Καταχωρήθηκαν ${songsPayload.length} τραγούδια.`);
        } else {
            console.error('[SUPABASE SYNC ERROR] Η βάση απέρριψε τα δεδομένα των τραγουδιών.');
        }
    } catch (error) {
        console.error('[SUPABASE SYNC EXCEPTION]', error);
    }
}

// Έλεγχος εκκρεμών παραγγελιών στον πίνακα requests του Supabase
async function checkSupabaseRequest() {
    if (!SUPABASE_URL || !SUPABASE_KEY) return null;
    try {
        const fetchUrl = `${SUPABASE_URL}/rest/v1/requests?played=eq.false&order=created_at.asc&limit=1`;
        const response = await fetch(fetchUrl, {
            headers: {
                "apikey": SUPABASE_KEY,
                "Authorization": `Bearer ${SUPABASE_KEY}`
            }
        });
        if (!response.ok) return null;
        const data = await response.json();
        
        if (data && data.length > 0) {
            const reqData = data[0];
            // Έλεγχος αν το αρχείο υπάρχει φυσικά στον server
            if (fs.existsSync(path.join(__dirname, reqData.filename))) {
                // Μαρκάρισμα της παραγγελίας ως παιγμένης (played = true)
                await fetch(`${SUPABASE_URL}/rest/v1/requests?id=eq.${reqData.id}`, {
                    method: 'PATCH',
                    headers: {
                        "apikey": SUPABASE_KEY,
                        "Authorization": `Bearer ${SUPABASE_KEY}`,
                        "Content-Type": "application/json"
                    },
                    body: JSON.stringify({ played: true })
                });
                return reqData;
            }
        }
    } catch (error) {
        console.error("[SUPABASE FETCH ERROR]", error);
    }
    return null;
}

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
    console.warn('[FONT WARNING] Δεν βρέθηκε καμία από τις προτεινόμενες γραμματοσειρές.');
} else {
    console.log(`[FONT] Χρήση γραμματοσειράς: ${FONT_PATH}`);
}

const FONT_ARG = FONT_PATH ? `fontfile='${FONT_PATH}':` : '';

// ============================================================
//  ΕΞΕΙΔΙΚΕΥΜΕΝΕΣ ΓΡΑΜΜΑΤΟΣΕΙΡΕΣ: Century / Century Gothic / Century Gothic Bold
//  ΣΗΜΕΙΩΣΗ: Το Century και το Century Gothic είναι εμπορικές γραμματοσειρές της
//  Microsoft/Monotype και ΔΕΝ έρχονται προεγκατεστημένες σε Linux servers. Αν τα
//  αρχεία .ttf/.otf δεν βρεθούν στις παρακάτω διαδρομές, γίνεται αυτόματη επιστροφή
//  (fallback) στη γραμματοσειρά DejaVu/FreeSans/Liberation (FONT_PATH) ώστε να μη
//  σταματήσει ποτέ το stream. Για να εμφανιστούν όντως οι σωστές γραμματοσειρές,
//  ανέβασε τα αρχεία τους στον server (π.χ. σε /usr/share/fonts/truetype/custom/)
//  με τα ονόματα που αναζητούνται παρακάτω, ή προσάρμοσε τις διαδρομές.
const CUSTOM_FONT_DIR = '/usr/share/fonts/truetype/custom';

function resolveNamedFont(candidateFileNames) {
    for (const name of candidateFileNames) {
        const p = path.join(CUSTOM_FONT_DIR, name);
        if (fs.existsSync(p)) return p;
    }
    return null;
}

// Century (για την ώρα)
const TIME_FONT = resolveNamedFont(['Century.ttf', 'CENTURY.TTF', 'Century Regular.ttf']) || FONT_PATH;
// Century Gothic (για τον τίτλο τραγουδιού)
const TITLE_FONT = resolveNamedFont(['CenturyGothic.ttf', 'GOTHIC.TTF', 'Century Gothic.ttf']) || FONT_PATH;
// Century Gothic Bold (για την κατηγορία)
const CATEGORY_FONT = resolveNamedFont(['CenturyGothicBold.ttf', 'GOTHICB.TTF', 'Century Gothic Bold.ttf']) || FONT_PATH;

if (TIME_FONT === FONT_PATH) {
    console.warn('[FONT WARNING] Δεν βρέθηκε η γραμματοσειρά Century — γίνεται χρήση της εφεδρικής για την ώρα.');
}
if (TITLE_FONT === FONT_PATH) {
    console.warn('[FONT WARNING] Δεν βρέθηκε η γραμματοσειρά Century Gothic — γίνεται χρήση της εφεδρικής για τον τίτλο.');
}
if (CATEGORY_FONT === FONT_PATH) {
    console.warn('[FONT WARNING] Δεν βρέθηκε η γραμματοσειρά Century Gothic Bold — γίνεται χρήση της εφεδρικής για την κατηγορία.');
}

let lastAnnouncedHour = getGreekTime().hour;
let lastAnthemDate = getGreekTime().date;
let songCounter = 0;
let currentNowPlaying = { title: "Φορτώνει...", genre: "Radio" };

let globalPlayedSongs = [];
let newYearQueue = [];
let lastNewYearSequenceKey = null;

app.get('/api/now-playing', (req, res) => {
    res.json(currentNowPlaying);
});

app.get('/', (req, res) => {
    res.send('Thavma Παλμός Automation System v8.5 (Supabase Edition) is Running!');
});

app.post('/api/comment', async (req, res) => {
    const { name, comment } = req.body;

    if (!name || !comment) {
        return res.status(400).json({ success: false, message: "Παρακαλώ συμπληρώστε όλα τα πεδία." });
    }

    const transporter = nodemailer.createTransport({
        service: 'gmail',
        auth: {
            user: process.env.EMAIL_USER,
            pass: process.env.EMAIL_PASS
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
    await syncSongsToSupabase(); // Συγχρονισμός των 155 τραγουδιών στη βάση δεδομένων
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
        month: greekDate.getMonth(),
        year: greekDate.getFullYear(),
        hour: greekDate.getHours(),
        minute: greekDate.getMinutes(),
        second: greekDate.getSeconds()
    };
}

function athensTargetDate(t, dayOffset, hour, minute, second) {
    return new Date(t.raw.getFullYear(), t.raw.getMonth(), t.raw.getDate() + dayOffset, hour, minute, second, 0);
}

// Δευτερόλεπτα από "τώρα" (t.raw) μέχρι μια target ημερομηνία/ώρα
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
function isChristmasPeriod(month, date) {
    if (month === 10 && date >= 18) return true;
    if (month === 11) return true;
    if (month === 0) return true;
    return false;
}

function isNewYearXBoostWindow(month, date, hour) {
    return month === 0 && date === 1 && hour >= 0 && hour < 2;
}

// ============================================================
//  ΟΡΘΟΔΟΞΟ ΠΑΣΧΑ - ΑΥΤΟΜΑΤΟΣ ΥΠΟΛΟΓΙΣΜΟΣ & ΠΕΡΙΟΔΟΣ
//  (Μεγάλη Δευτέρα έως και Κυριακή του Θωμά)
// ============================================================

// Υπολογίζει την ημερομηνία της Κυριακής του Ορθόδοξου Πάσχα (αλγόριθμος Meeus,
// Ιουλιανό ημερολόγιο μετατρεπόμενο σε Γρηγοριανή ημερομηνία). Ισχύει για 1900-2099.
function getOrthodoxEasterDate(year) {
    const a = year % 4;
    const b = year % 7;
    const c = year % 19;
    const d = (19 * c + 15) % 30;
    const e = (2 * a + 4 * b - d + 34) % 7;
    const julianMonth = Math.floor((d + e + 114) / 31); // 3 = Μάρτιος, 4 = Απρίλιος (Ιουλιανό)
    const julianDay = ((d + e + 114) % 31) + 1;

    // Μετατροπή από Ιουλιανό σε Γρηγοριανό ημερολόγιο (+13 ημέρες, ισχύει 1900-2099)
    const easterUTC = new Date(Date.UTC(year, julianMonth - 1, julianDay));
    easterUTC.setUTCDate(easterUTC.getUTCDate() + 13);
    return easterUTC;
}

// Ελέγχει αν η τρέχουσα ημερομηνία (Ελλάδας) βρίσκεται στην πασχαλινή περίοδο:
// από Μεγάλη Δευτέρα (Πάσχα - 6 ημέρες) έως και την Κυριακή του Θωμά (Πάσχα + 7 ημέρες).
function isEasterPeriod(time) {
    const easterSunday = getOrthodoxEasterDate(time.year);

    const holyMonday = new Date(easterSunday);
    holyMonday.setUTCDate(easterSunday.getUTCDate() - 6);
    holyMonday.setUTCHours(0, 0, 0, 0);

    const thomasSunday = new Date(easterSunday);
    thomasSunday.setUTCDate(easterSunday.getUTCDate() + 7);
    thomasSunday.setUTCHours(23, 59, 59, 999);

    const todayUTC = new Date(Date.UTC(time.year, time.month, time.date));
    return todayUTC >= holyMonday && todayUTC <= thomasSunday;
}

function getRequiredGenre() {
    const time = getGreekTime();
    const d = time.day;
    const h = time.hour;

    // Πασχαλινή περίοδος: υπερισχύει του κανονικού εβδομαδιαίου προγράμματος
    if (isEasterPeriod(time)) return 'EASTER_MODE';

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
    if (time.hour === 0 && lastAnthemDate !== time.date) {
        if (fs.existsSync(path.join(__dirname, 'ethnikos_ymnos.mp3'))) {
            lastAnthemDate = time.date;
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

            if (time.hour === 0 && time.month === 0 && time.date === 1) {
                const sequenceKey = `${time.year}-${time.date}`;
                if (lastNewYearSequenceKey !== sequenceKey) {
                    const nySequenceFiles = ['ΚαλήΧρονιά.mp3', 'thavma_palmos_christmas_jingle.mp3', 'Αρχιμηνιά και Αρχιχρονιά το λάδι 19.mp3'];
                    newYearQueue = nySequenceFiles.filter(f => fs.existsSync(path.join(__dirname, f)));
                    lastNewYearSequenceKey = sequenceKey;
                    console.log(`[NEW YEAR] Προγραμματίστηκε η Πρωτοχρονιάτικη ακολουθία.`);
                }
            }
            return { file: hourFile, title: `Η ώρα είναι ${hourString}`, genreLabel: 'Ώρα Ελλάδος', isHourAnnouncement: true };
        }
    }

    // 2.5 Υποχρεωτική Πρωτοχρονιάτικη ακολουθία
    if (newYearQueue.length > 0) {
        const nextFile = newYearQueue.shift();
        if (fs.existsSync(path.join(__dirname, nextFile))) {
            let displayTitle = nextFile.replace('.mp3', '');
            return { file: nextFile, title: displayTitle, genreLabel: 'Πρωτοχρονιάτικη Ακολουθία', isSystem: true };
        }
    }

    // 3. Jingle ανά 5 τραγούδια
    if (songCounter >= 5) {
        if (fs.existsSync(path.join(__dirname, 'thavma_palmos_jingle.mp3'))) {
            songCounter = 0;
            return { file: 'thavma_palmos_jingle.mp3', title: 'Thavma Παλμός Jingle', genreLabel: 'Σήμα Σταθμού', isSystem: true };
        }
    }

    // 4. ΕΛΕΓΧΟΣ LIVE ΠΑΡΑΓΓΕΛΙΑΣ ΑΠΟ TO SUPABASE (Αντικατέστησε την τοπική ουρά)
    const liveRequest = await checkSupabaseRequest();
    if (liveRequest) {
        let displayTitle = liveRequest.filename.replace(/^[A-ZZΠα-ωήίόύέώ\s]+\s*/i, '').replace('.mp3', '').replace(/_/g, ' ');
        return {
            file: liveRequest.filename,
            title: displayTitle,
            genreLabel: `Παραγγελιά Ακροατή [${liveRequest.requester}]`,
            isSong: true,
            isRequest: true
        };
    }

    // 5. Κανονικό Τραγούδι
    const files = fs.readdirSync(__dirname);
    let mp3Files = files.filter(file => path.extname(file).toLowerCase() === '.mp3' && !isHourFile(file));
    if (mp3Files.length === 0) return null;

    const christmasActive = isChristmasPeriod(time.month, time.date);
    const xFiles = mp3Files.filter(f => f.startsWith('(X)'));
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
    } else if (genre === 'EASTER_MODE') {
        // Πασχαλινή λειτουργία: παίζει κανονικά MIX (όλα τα τραγούδια), αλλά με 20%
        // πιθανότητα να δοθεί έμφαση αποκλειστικά σε τραγούδια (Π) ή (ΛΖ)
        const easterFiles = normalPool.filter(f => f.startsWith('(Π)') || f.startsWith('(ΛΖ)'));
        if (easterFiles.length > 0 && Math.random() < 0.20) {
            filteredFiles = easterFiles;
            genreLabel = "Πασχαλινό Πρόγραμμα (Έμφαση στα Παραδοσιακά)";
        } else {
            filteredFiles = normalPool;
            genreLabel = "Πασχαλινό Πρόγραμμα (Mix)";
        }
    } else {
        // genre === 'MIX' (ή οτιδήποτε άλλο): όλες οι κατηγορίες μαζί, χωρίς φιλτράρισμα tag
        filteredFiles = normalPool;
        genreLabel = "Mix Πρόγραμμα";
    }

    if (filteredFiles.length === 0) filteredFiles = normalPool;

    if (christmasActive && xFiles.length > 0) {
        const xBoost = isNewYearXBoostWindow(time.month, time.date, time.hour);
        const xProbability = xBoost ? 0.80 : 0.35;
        if (Math.random() < xProbability) {
            filteredFiles = xFiles;
            genreLabel = xBoost ? "Χριστουγεννιάτικο Πρόγραμμα (X) - Πρωτοχρονιά" : "Χριστουγεννιάτικο Πρόγραμμα (X)";
        } else {
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
    let displayTitle = randomFile.replace(/^[A-ZZΠα-ωήίόύέώ\s]+\s*/i, '').replace('.mp3', '').replace(/_/g, ' ');
    return { file: randomFile, title: displayTitle, genreLabel: genreLabel, isSong: true };
}

// ============================================================
//  VISUAL COUNTDOWN & FX ΠΡΩΤΟΧΡΟΝΙΑΣ
// ============================================================
function buildNewYearCountdownFilters(spawnTime) {
    const isDec31 = (spawnTime.month === 11 && spawnTime.date === 31);
    const isEarlyJan1 = (spawnTime.month === 0 && spawnTime.date === 1 && spawnTime.hour === 0 && spawnTime.minute === 0 && spawnTime.second < 20);

    if (!isDec31 && !isEarlyJan1) {
        return { filters: [], blackoutStart: null, blackoutEnd: null, suppressNormalOverlayUntil: null };
    }

    const target2350 = athensTargetDate(spawnTime, 0, 23, 50, 0);
    const target2359 = athensTargetDate(spawnTime, 0, 23, 59, 0);
    const target235950 = athensTargetDate(spawnTime, 0, 23, 59, 50);
    const targetMidnight = isDec31 ? athensTargetDate(spawnTime, 1, 0, 0, 0) : athensTargetDate(spawnTime, 0, 0, 0, 0);

    const off2350 = secondsFromNowTo(spawnTime, target2350);
    const off2359 = secondsFromNowTo(spawnTime, target2359);
    const off235950 = secondsFromNowTo(spawnTime, target235950);
    const offMidnight = secondsFromNowTo(spawnTime, targetMidnight);
    const nextYear = isDec31 ? spawnTime.year + 1 : spawnTime.year;
    // Διάρκεια εμφάνισης του μηνύματος "Καλή Χρονιά" / περιόδου καταστολής του κανονικού overlay
    const nyEnd = offMidnight + 10;

    const filters = [];
    const remainingExpr = `(${offMidnight.toFixed(2)}-t)`;

    const goldSteps = ['white', '0xFFF5CC', '0xFFEDB0', '0xFFE494', '0xFFDC78', '0xFFD35C', '0xFFCB40', '0xFFD700', '0xFFD700'];
    for (let i = 0; i < 9; i++) {
        const start = off2350 + i * 60;
        const end = off2350 + (i + 1) * 60;
        const fontsize = 42 + i * 7;
        const color = goldSteps[i];
        const countdownText = `%{eif\\:trunc(${remainingExpr}/60)\\:d\\:2}\\:%{eif\\:mod(trunc(${remainingExpr})\\,60)\\:d\\:2}`;
        filters.push(`drawtext=${FONT_ARG}text='${countdownText}':x=(w-text_w)/2:y=90:fontsize=${fontsize}:fontcolor=${color}:box=1:boxcolor=black@0.55:boxborderw=12:enable='between(t\\,${start.toFixed(2)}\\,${end.toFixed(2)})'`);
    }

    for (let i = 0; i < 50; i++) {
        const start = off2359 + i;
        const end = off2359 + i + 1;
        const fontsize = i % 2 === 0 ? 130 : 150;
        const secondsText = `%{eif\\:trunc(${remainingExpr})\\:d\\:2}`;
        filters.push(`drawtext=${FONT_ARG}text='${secondsText}':x=(w-text_w)/2:y=(h-text_h)/2:fontsize=${fontsize}:fontcolor=0xFFD700:enable='between(t\\,${start.toFixed(2)}\\,${end.toFixed(2)})'`);
    }

    const crazyColors = ['0xFFD700', '0xFFFFFF'];
    for (let i = 0; i < 10; i++) {
        const start = off235950 + i;
        const end = off235950 + i + 1;
        const fontsize = i % 2 === 0 ? 190 : 220;
        const color = crazyColors[i % 2];
        const secondsText = `%{eif\\:trunc(${remainingExpr})\\:d\\:1}`;
        filters.push(`drawtext=${FONT_ARG}text='${secondsText}':x=(w-text_w)/2:y=(h-text_h)/2:fontsize=${fontsize}:fontcolor=${color}:enable='between(t\\,${start.toFixed(2)}\\,${end.toFixed(2)})'`);
    }

    const nyText = `Καλή Χρονιά ${nextYear}!`.replace(/'/g, '’');
    filters.push(`drawtext=${FONT_ARG}text='${nyText}':x=(w-text_w)/2:y=(h-text_h)/2:fontsize=100:fontcolor=0xFFD700:box=1:boxcolor=black@0.5:boxborderw=16:enable='between(t\\,${offMidnight.toFixed(2)}\\,${nyEnd.toFixed(2)})'`);

    const burstPoints = [
        { x: 'w0.15', y: 'h0.25', delay: 0.3 },
        { x: 'w0.85', y: 'h0.20', delay: 0.9 },
        { x: 'w0.25', y: 'h0.75', delay: 1.6 },
        { x: 'w0.75', y: 'h0.70', delay: 2.3 },
        { x: 'w0.50', y: 'h0.15', delay: 3.0 },
    ];
    burstPoints.forEach((b, idx) => {
        const bStart = offMidnight + b.delay;
        const bEnd = bStart + 1.2;
        const color = idx % 2 === 0 ? '0xFFD700' : '0xFF4444';
        filters.push(`drawtext=${FONT_ARG}text='✦':x=${b.x}:y=${b.y}:fontsize=80:fontcolor=${color}:enable='between(t\\,${bStart.toFixed(2)}\\,${bEnd.toFixed(2)})'`);
    });

    return {
        filters,
        blackoutStart: off2359,
        blackoutEnd: offMidnight,
        suppressNormalOverlayFrom: off2359,
        suppressNormalOverlayUntil: nyEnd
    };
}

async function startNextMedia() {
    const media = await selectNextFile(); // Αναμονή για τον έλεγχο αρχείων/Supabase

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

    const cleanLabel = media.genreLabel.replace(/'/g, "’").replace(/:/g, " — ").replace(/,/g, " ");
    const cleanTitle = media.title.replace(/'/g, "’").replace(/:/g, ".").replace(/,/g, " ");
    const clockText = "%{localtime\\:%H\\\\\\:%M\\\\\\:%S & %d\\\\\\/%m\\\\\\/%Y}";

    const spawnTime = getGreekTime();
    const ny = buildNewYearCountdownFilters(spawnTime);

    let blackoutFilter = '';
    if (ny.blackoutStart !== null) {
        blackoutFilter = `,drawbox=x=0:y=0:w=iw:h=ih:color=black:t=fill:enable='between(t\\,${ny.blackoutStart.toFixed(2)}\\,${ny.blackoutEnd.toFixed(2)})'`;
    }

    let normalOverlayEnable = '';
    if (ny && ny.suppressNormalOverlayFrom !== undefined && ny.suppressNormalOverlayFrom !== null) {
        normalOverlayEnable = `:enable='not(between(t\\,${ny.suppressNormalOverlayFrom.toFixed(2)}\\,${ny.suppressNormalOverlayUntil.toFixed(2)}))'`;
    }

    // Γραμματοσειρές: Century (ώρα), Century Gothic (τίτλος τραγουδιού), Century Gothic Bold (κατηγορία)
    const baseOverlayFilters =
        `drawtext=fontfile='${CATEGORY_FONT}':text='${cleanLabel}':x=30:y=30:fontsize=20:fontcolor=yellow:box=1:boxcolor=black@0.6:boxborderw=8${normalOverlayEnable},` +
        `drawtext=fontfile='${TITLE_FONT}':text='${cleanTitle}':x=30:y=65:fontsize=28:fontcolor=white:box=1:boxcolor=black@0.6:boxborderw=10${normalOverlayEnable},` +
        `drawtext=fontfile='${TIME_FONT}':text='${clockText}':x=w-tw-30:y=30:fontsize=20:fontcolor=black${normalOverlayEnable}`;

    const countdownFilterChain = ny.filters.length > 0 ? ',' + ny.filters.join(', ') : '';
    const vfChain = `scale=854:480${blackoutFilter}, ${baseOverlayFilters}${countdownFilterChain}`;

    const ffmpeg = spawn('ffmpeg', [
        '-re', '-fflags', '+genpts', '-loop', '1', '-framerate', '12', '-i', 'background.jpg',
        '-i', media.file,
        '-map', '0:v:0', '-map', '1:a:0',
        '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'stillimage', '-threads', '1',
        '-vf', vfChain,
        '-r', '12', '-g', '24', '-b:v', '2500k', '-maxrate', '2500k', '-bufsize', '5000k',
        '-c:a', 'aac', '-b:a', '192k',
        '-af', 'aresample=async=1:min_hard_comp=0.100000:first_pts=0',
        '-max_muxing_queue_size', '4096',
        '-shortest', '-pix_fmt', 'yuv420p', '-f', 'flv',
        `rtmp://a.rtmp.youtube.com/live2/${streamKey}`
    ], { stdio: 'ignore' });

    ffmpeg.on('close', startNextMedia);
    ffmpeg.on('error', startNextMedia);
}

