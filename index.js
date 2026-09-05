process.env.TZ = 'Europe/Athens';

const express = require('express');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

const supabase = SUPABASE_URL && SUPABASE_KEY ? createClient(SUPABASE_URL, SUPABASE_KEY) : null;

if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.error('[SUPABASE ERROR] Λείπουν τα SUPABASE_URL ή SUPABASE_KEY από τα GitHub Secrets!');
}

const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
    }
});

app.post('/api/request-song', async (req, res) => {
    // ΝΕΑ πεδία: category (προαιρετικό), deviceId (υποχρεωτικό, από το frontend
    // localStorage), vipCode (προαιρετικό — "TP26" παρακάμπτει το όριο 30 λεπτών).
    // Το email έγινε προαιρετικό αφού η φόρμα του site δεν το ζητάει πλέον.
    const { song, requester, category, email, deviceId, vipCode } = req.body;
    if (!song || !requester || !deviceId) {
        return res.status(400).json({ error: 'Λείπουν υποχρεωτικά πεδία (όνομα, τραγούδι, deviceId)' });
    }
    if (!supabase) {
        return res.status(503).json({ error: 'Supabase not configured' });
    }

    const isVip = vipCode === 'TP26';

    try {
        if (!isVip) {
            // Έλεγχος ορίου 30 λεπτών ανά συσκευή (deviceId)
            const thirtyMinAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();
            const { data: recent, error: recentErr } = await supabase
                .from('song_requests')
                .select('id, created_at')
                .eq('device_id', deviceId)
                .gte('created_at', thirtyMinAgo)
                .limit(1);
            if (recentErr) throw recentErr;
            if (recent && recent.length > 0) {
                return res.status(429).json({
                    error: 'Μπορείς να στείλεις 1 παραγγελία κάθε 30 λεπτά. Αν έχεις κωδικό VIP, βάλτον για απεριόριστες παραγγελίες.'
                });
            }
        }

        const { error } = await supabase.from('song_requests').insert([{
            song,
            requester,
            category: category || null,
            email: email || null,
            device_id: deviceId,
            is_vip: isVip,
            status: 'pending'
        }]);
        if (error) throw error;
        res.json({ success: true });
    } catch (error) {
        console.error('[REQUEST ERROR]', error.message);
        res.status(500).json({ error: 'Σφάλμα κατά την αποθήκευση της παραγγελίας' });
    }
});

app.get('/api/now-playing', (req, res) => {
    res.json(currentNowPlaying);
});

async function syncSongsToSupabase() {
    if (!supabase) return;
    try {
        const files = fs.readdirSync(__dirname);
        const mp3Files = files.filter(f => path.extname(f).toLowerCase() === '.mp3' && !isHourFile(f));
        const { error } = await supabase.from('songs').upsert(
            mp3Files.map(f => ({ filename: f, synced_at: new Date() })),
            { onConflict: 'filename' }
        );
        if (error) throw error;
        console.log(`[SUPABASE SYNC] Συγχρονίστηκαν ${mp3Files.length} τραγούδια`);
    } catch (error) {
        console.error('[SYNC ERROR]', error.message);
    }
}

async function checkSupabaseRequest() {
    if (!supabase) return null;
    try {
        const { data, error } = await supabase
            .from('song_requests')
            .select('*')
            .eq('status', 'pending')
            .order('created_at', { ascending: true })
            .limit(1);
        if (error || !data || data.length === 0) return null;
        const request = data[0];
        await supabase.from('song_requests').update({ status: 'processed' }).eq('id', request.id);
        const files = fs.readdirSync(__dirname);
        const match = files.find(f => f.toLowerCase().includes(request.song.toLowerCase()) && path.extname(f).toLowerCase() === '.mp3');
        if (match) {
            console.log(`[LIVE REQUEST] Αναπαράγεται: ${match} (από ${request.requester})`);
            if (request.email) {
                try {
                    await transporter.sendMail({
                        to: request.email,
                        from: process.env.EMAIL_USER,
                        subject: 'Το τραγούδι σας αναμεταδόθηκε! 🎵',
                        html: `<h2>Γεια σας!</h2><p>Το τραγούδι "${request.song}" αναμεταδίδεται τώρα στο Thavma Παλμός! 🎧</p>`
                    });
                } catch (mailErr) {
                    console.error('[EMAIL ERROR]', mailErr.message);
                }
            }
            return { filename: match, requester: request.requester };
        }
    } catch (error) {
        console.error('[REQUEST CHECK ERROR]', error.message);
    }
    return null;
}

function getGreekTime() {
    const now = new Date();
    return {
        raw: now,
        year: now.getFullYear(),
        month: now.getMonth(),
        date: now.getDate(),
        day: now.getDay(),
        hour: now.getHours(),
        minute: now.getMinutes(),
        second: now.getSeconds()
    };
}

function findHourFile(hour) {
    const hourFileName = `clock${hour}.mp3`;
    return fs.existsSync(path.join(__dirname, hourFileName)) ? hourFileName : null;
}

function isHourFile(fileName) {
    if (fileName === 'thavma_palmos_jingle.mp3' || fileName === 'ethnikos_ymnos.mp3') return true;
    if (fileName === 'ΚαλήΧρονιά.mp3' || fileName === 'thavma_palmos_christmas_jingle.mp3') return true;
    if (fileName === 'Αρχιμηνιά και Αρχιχρονιά το λάδι 19.mp3') return true;
    return /^clock\d+\.mp3$/.test(fileName);
}

function isChristmasPeriod(month, date) {
    return (month === 10 && date >= 18) || month === 11 || (month === 0 && date <= 31);
}

function getOrthodoxEasterDate(year) {
    const a = year % 4;
    const b = year % 7;
    const c = year % 19;
    const d = (19 * c + 15) % 30;
    const e = (2 * a + 4 * b - d + 34) % 7;
    const julianMonth = Math.floor((d + e + 114) / 31);
    const julianDay = ((d + e + 114) % 31) + 1;
    const easterUTC = new Date(Date.UTC(year, julianMonth - 1, julianDay));
    easterUTC.setUTCDate(easterUTC.getUTCDate() + 13);
    return easterUTC;
}

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
    const d = time.day; // 0: Κυριακή, 1: Δευτέρα, ..., 6: Σάββατο
    const h = time.hour;

    // Πασχαλινό Mode (εφόσον είναι ενεργό)
    if (isEasterPeriod(time)) {
        return 'EASTER_MODE';
    }

    // Σαββατοκύριακο (0 = Κυριακή, 6 = Σάββατο): Όλη μέρα Mix Πρόγραμμα
    if (d === 0 || d === 6) {
        return 'MIX';
    }

    // Δευτέρα (1), Τετάρτη (3), Παρασκευή (5)
    if (d === 1 || d === 3 || d === 5) {
        if (h >= 2 && h < 7) return 'B';     // 02:00 – 07:00 | Beats
        if (h >= 7 && h < 12) return 'R';    // 07:00 – 12:00 | Radio
        if (h >= 12 && h < 17) return 'P_LZ';// 12:00 – 17:00 | Παραδοσιακά & Λαϊκά
        if (h >= 17 && h < 20) return 'R';    // 17:00 – 20:00 | Radio
        return 'MIX';                         // 20:00 – 02:00 | Mix Πρόγραμμα
    }

    // Τρίτη (2), Πέμπτη (4)
    if (d === 2 || d === 4) {
        if (h >= 2 && h < 8) return 'B';     // 02:00 – 08:00 | Beats  ← ΔΙΟΡΘΩΘΗΚΕ (ήταν 0)
        if (h >= 8 && h < 12) return 'R';    // 08:00 – 12:00 | Radio
        if (h >= 12 && h < 16) return 'P_LZ';// 12:00 – 16:00 | Παραδοσιακά & Λαϊκά
        if (h >= 16 && h < 20) return 'R';    // 16:00 – 20:00 | Radio
        return 'MIX';                         // 20:00 – 02:00 | Mix Πρόγραμμα
    }

    return 'MIX';
}

let lastAnnouncedHour = getGreekTime().hour;
let lastAnthemDate = getGreekTime().date;
let songCounter = 0;
let currentNowPlaying = { title: "Φορτώνει...", genre: "Radio" };

let globalPlayedSongs = [];
let newYearQueue = [];
let lastNewYearSequenceKey = null;

let currentFfmpegProcess = null;
let isShuttingDown = false;

function hasTag(filename, ...variants) {
    return variants.some(v => filename.startsWith(`(${v})`));
}

function shuffleArray(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
}

const TAG = {
    BEATS: ['B'],
    RADIO: ['R'],
    PARADOSIAKA: ['Π'],
    LAIKA_ZEIMBEKIKA: ['ΛΖ'],
    CHRISTMAS: ['X']
};

const FONT_PATH = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf';
if (fs.existsSync(FONT_PATH)) {
    console.log('[FONT] Χρήση γραμματοσειράς: ' + FONT_PATH);
} else {
    console.warn('[FONT WARNING] Δεν βρέθηκε η γραμματοσειρά.');
}

const FONT_ARG = FONT_PATH ? `fontfile='${FONT_PATH}':` : '';

const CUSTOM_FONT_DIR = '/usr/share/fonts/truetype/custom';

function resolveNamedFont(candidateFileNames) {
    for (const name of candidateFileNames) {
        const p = path.join(CUSTOM_FONT_DIR, name);
        if (fs.existsSync(p)) return p;
    }
    return null;
}

const TIME_FONT = resolveNamedFont(['Century.ttf', 'CENTURY.TTF', 'Century Regular.ttf']) || FONT_PATH;
const TITLE_FONT = resolveNamedFont(['CenturyGothic.ttf', 'GOTHIC.TTF', 'Century Gothic.ttf']) || FONT_PATH;
const CATEGORY_FONT = resolveNamedFont(['CenturyGothicBold.ttf', 'GOTHICB.TTF', 'Century Gothic Bold.ttf']) || FONT_PATH;

function isNewYearXBoostWindow(month, date, hour) {
    return month === 0 && date === 1 && hour >= 0 && hour < 2;
}

async function selectNextFile() {
    const time = getGreekTime();

    if (time.hour === 0 && lastAnthemDate !== time.date) {
        if (fs.existsSync(path.join(__dirname, 'ethnikos_ymnos.mp3'))) {
            lastAnthemDate = time.date;
            return { file: 'ethnikos_ymnos.mp3', title: 'ΕΘΝΙΚΟΣ ΥΜΝΟΣ', genreLabel: 'Ειδική Μετάδοση', isSystem: true };
        }
    }

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

    if (newYearQueue.length > 0) {
        const nextFile = newYearQueue.shift();
        if (fs.existsSync(path.join(__dirname, nextFile))) {
            let displayTitle = nextFile.replace('.mp3', '');
            return { file: nextFile, title: displayTitle, genreLabel: 'Πρωτοχρονιάτικη Ακολουθία', isSystem: true };
        }
    }

    if (songCounter >= 5) {
        if (fs.existsSync(path.join(__dirname, 'thavma_palmos_jingle.mp3'))) {
            songCounter = 0;
            return { file: 'thavma_palmos_jingle.mp3', title: 'Thavma Παλμός Jingle', genreLabel: 'Σήμα Σταθμού', isSystem: true };
        }
    }

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

    const files = fs.readdirSync(__dirname);
    let mp3Files = files.filter(file => path.extname(file).toLowerCase() === '.mp3' && !isHourFile(file));
    if (mp3Files.length === 0) return null;

    const christmasActive = isChristmasPeriod(time.month, time.date);
    const xFiles = mp3Files.filter(f => hasTag(f, ...TAG.CHRISTMAS));
    const normalPool = mp3Files.filter(f => !hasTag(f, ...TAG.CHRISTMAS));

    const genre = getRequiredGenre();
    let filteredFiles = [];
    let genreLabel = "Mix Πρόγραμμα";

    if (genre === 'B') {
        filteredFiles = normalPool.filter(f => hasTag(f, ...TAG.BEATS));
        genreLabel = "Beats (Disco, Dance, Club)";
    } else if (genre === 'R') {
        filteredFiles = normalPool.filter(f => hasTag(f, ...TAG.RADIO));
        genreLabel = "Radio (Κανονική Ροή)";
    } else if (genre === 'P_LZ') {
        filteredFiles = normalPool.filter(f => hasTag(f, ...TAG.PARADOSIAKA) || hasTag(f, ...TAG.LAIKA_ZEIMBEKIKA));
        genreLabel = "Παραδοσιακά & Λαϊκά";
    } else if (genre === 'EASTER_MODE') {
        const easterFiles = normalPool.filter(f => hasTag(f, ...TAG.PARADOSIAKA) || hasTag(f, ...TAG.LAIKA_ZEIMBEKIKA));
        if (easterFiles.length > 0 && Math.random() < 0.20) {
            filteredFiles = easterFiles;
            genreLabel = "Πασχαλινό Πρόγραμμα (Έμφαση στα Παραδοσιακά)";
        } else {
            filteredFiles = normalPool;
            genreLabel = "Πασχαλινό Πρόγραμμα (Mix)";
        }
    } else {
        // genre === 'MIX': ΟΛΟΚΛΗΡΟ το normalPool, όλες οι κατηγορίες μαζί αδιάκριτα
        filteredFiles = normalPool;
        genreLabel = "Mix Πρόγραμμα";
    }

    if (filteredFiles.length === 0) filteredFiles = normalPool.length > 0 ? normalPool : mp3Files;

    if (christmasActive && xFiles.length > 0) {
        const xBoost = isNewYearXBoostWindow(time.month, time.date, time.hour);
        const xProbability = xBoost ? 0.80 : 0.35;
        if (Math.random() < xProbability) {
            filteredFiles = xFiles;
            genreLabel = xBoost ? "Χριστουγεννιάτικο Πρόγραμμα (X) - Πρωτοχρονιά" : "Χριστουγεννιάτικο Πρόγραμμα (X)";
        } else {
            // Στο MIX εκτός boost, τα Χριστουγεννιάτικα ΠΡΟΣΤΙΘΕΝΤΑΙ στο υπόλοιπο mix
            // (δηλ. κατά την περίοδο Χριστουγέννων, MIX = ΚΥΡΙΟΛΕΚΤΙΚΑ όλα μαζί, X included)
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
        shuffleArray(availableFiles);
        randomFile = availableFiles[0];
    }

    globalPlayedSongs.push(randomFile);
    let displayTitle = randomFile.replace(/^[A-ZZΠα-ωήίόύέώ\s]+\s*/i, '').replace('.mp3', '').replace(/_/g, ' ');
    return { file: randomFile, title: displayTitle, genreLabel: genreLabel, isSong: true };
}

function buildNewYearCountdownFilters(spawnTime) {
    // ============================================================
    // TEST MODE: Αν το env var TEST_NEWYEAR είναι 'true' (π.χ. από ένα
    // χειροκίνητο workflow_dispatch run στο GitHub Actions), προσομοιώνουμε
    // ΟΛΟΚΛΗΡΗ την ακολουθία αντίστροφης μέτρησης σε ~55 δευτερόλεπτα αντί να
    // περιμένουμε πραγματικά την 31η Δεκεμβρίου. Δεν επηρεάζει ΚΑΘΟΛΟΥ τη
    // λογική προγράμματος (getRequiredGenre/MIX) — μόνο το οπτικό εφέ αυτού
    // του ffmpeg process. Μόλις τελειώσει το τεστ, το επόμενο run θα
    // ξαναδουλεύει κανονικά, αφού το flag δεν παραμένει μόνιμα ενεργό.
    if (process.env.TEST_NEWYEAR === 'true') {
        return buildCountdownFromOffsets({
            off2350: 5, off2359: 25, off235950: 35, offMidnight: 45, nyEnd: 55,
            nextYear: spawnTime.year + 1
        });
    }

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
    const nyEnd = offMidnight + 10;

    return buildCountdownFromOffsets({ off2350, off2359, off235950, offMidnight, nyEnd, nextYear });
}

// Εξήχθη σε ξεχωριστή συνάρτηση ώστε να τη μοιράζονται το κανονικό flow και το TEST MODE.
function buildCountdownFromOffsets({ off2350, off2359, off235950, offMidnight, nyEnd, nextYear }) {
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

    const nyText = `Καλή Χρονιά ${nextYear}!`.replace(/'/g, '');
    filters.push(`drawtext=${FONT_ARG}text='${nyText}':x=(w-text_w)/2:y=(h-text_h)/2:fontsize=100:fontcolor=0xFFD700:box=1:boxcolor=black@0.5:boxborderw=16:enable='between(t\\,${offMidnight.toFixed(2)}\\,${nyEnd.toFixed(2)})'`);

    return {
        filters,
        blackoutStart: off2359,
        blackoutEnd: offMidnight,
        suppressNormalOverlayFrom: off2359,
        suppressNormalOverlayUntil: nyEnd
    };
}

function athensTargetDate(spawnTime, daysFromNow, hour, minute, second) {
    const target = new Date(spawnTime.raw);
    target.setDate(target.getDate() + daysFromNow);
    target.setHours(hour, minute, second, 0);
    return target;
}

function secondsFromNowTo(spawnTime, targetDate) {
    return Math.max(0, (targetDate - spawnTime.raw) / 1000);
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

    // ΝΕΟ: Γράφει το "τώρα παίζει" στο Supabase ώστε το site (Netlify) να το
    // διαβάζει ΑΠΕΥΘΕΙΑΣ, χωρίς να χρειάζεται δημόσιο URL για το Node server.
    if (supabase) {
        supabase.from('station_status').upsert({
            id: 1,
            title: media.title,
            genre: media.genreLabel,
            updated_at: new Date().toISOString()
        }).then(({ error }) => {
            if (error) console.error('[STATUS SYNC ERROR]', error.message);
        });
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

    // Γραμματοσειρές: κατηγορία/τίτλος μικρότερα & πιο αριστερά (κοντά σε στυλ Century)
    const baseOverlayFilters =
        `drawtext=fontfile='${CATEGORY_FONT}':text='${cleanLabel}':x=18:y=22:fontsize=15:fontcolor=yellow:box=1:boxcolor=black@0.55:boxborderw=6${normalOverlayEnable},` +
        `drawtext=fontfile='${TITLE_FONT}':text='${cleanTitle}':x=18:y=50:fontsize=18:fontcolor=white:box=1:boxcolor=black@0.55:boxborderw=7${normalOverlayEnable},` +
        `drawtext=fontfile='${TIME_FONT}':text='${clockText}':x=w-tw-20:y=22:fontsize=18:fontcolor=black${normalOverlayEnable}`;

    const countdownFilterChain = ny.filters.length > 0 ? ',' + ny.filters.join(', ') : '';
    const vfChain = `scale=854:480${blackoutFilter}, ${baseOverlayFilters}${countdownFilterChain}`;

    const streamKey = process.env.YOUTUBE_STREAM_KEY;
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

    currentFfmpegProcess = ffmpeg;

    ffmpeg.on('close', () => {
        currentFfmpegProcess = null;
        if (!isShuttingDown) startNextMedia();
    });
    ffmpeg.on('error', () => {
        currentFfmpegProcess = null;
        if (!isShuttingDown) startNextMedia();
    });
}

function gracefulShutdown(signal) {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.log(`[SHUTDOWN] Λήψη σήματος ${signal} — ήρεμος τερματισμός για seamless handover.`);
    if (currentFfmpegProcess) {
        currentFfmpegProcess.kill('SIGTERM');
    }
    setTimeout(() => process.exit(0), 2000);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

app.listen(PORT, '0.0.0.0', async () => {
    console.log(`Ο Server ξεκίνησε στο port ${PORT}`);
    await syncSongsToSupabase();
    startNextMedia();
});
