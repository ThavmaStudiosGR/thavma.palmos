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
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY;

const supabase = SUPABASE_URL && SUPABASE_KEY ? createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false }
}) : null;

if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.error('[SUPABASE ERROR] Λείπουν τα SUPABASE_URL και/ή SUPABASE_SERVICE_ROLE_KEY (ή το παλιό SUPABASE_KEY) από τα GitHub Secrets!');
}

const STREAM_OWNER_ID = process.env.STREAM_OWNER_ID || process.env.GITHUB_RUN_ID || `local-${process.pid}-${Date.now()}`;
const STREAM_LEASE_SECONDS = 90;
let leaseRenewTimer = null;
let ownsStreamLease = false;

const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
    }
});

app.post('/api/request-song', async (req, res) => {
    const { song, requester, category, email, deviceId, vipCode } = req.body;
    if (!song || !requester || !deviceId) {
        return res.status(400).json({ error: 'Λείπουν υποχρεωτικά πεδία (όνομα, τραγούδι, deviceId)' });
    }
    if (!supabase) {
        return res.status(503).json({ error: 'Supabase not configured' });
    }

    try {
        const { data, error } = await supabase.rpc('submit_song_request', {
            p_song: song,
            p_requester: requester,
            p_category: category || null,
            p_device_id: deviceId,
            p_vip_code: vipCode || null,
            p_email: email || null
        });
        if (error) throw error;
        if (!data?.ok) {
            const status = data?.code === 'cooldown' ? 429 : 400;
            return res.status(status).json({ error: data?.message || 'Η παραγγελία δεν έγινε δεκτή.' });
        }
        res.json({ success: true, isVip: !!data.is_vip });
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
        const mp3Files = files
            .filter(f => path.extname(f).toLowerCase() === '.mp3' && !isHourFile(f))
            .sort((a, b) => a.localeCompare(b, 'el'));

        const syncedAt = new Date().toISOString();
        if (mp3Files.length > 0) {
            const { error: upsertError } = await supabase.from('songs').upsert(
                mp3Files.map(f => ({ filename: f, synced_at: syncedAt })),
                { onConflict: 'filename' }
            );
            if (upsertError) throw upsertError;
        }

        // Σβήνουμε από τη βάση τραγούδια που δεν υπάρχουν πλέον στο repository,
        // ώστε το site να μη δίνει παραγγελία για ανύπαρκτο αρχείο.
        const { data: dbSongs, error: listError } = await supabase.from('songs').select('filename');
        if (listError) throw listError;

        const localSet = new Set(mp3Files);
        const stale = (dbSongs || []).map(r => r.filename).filter(Boolean).filter(f => !localSet.has(f));
        if (stale.length > 0) {
            const { error: deleteError } = await supabase.from('songs').delete().in('filename', stale);
            if (deleteError) throw deleteError;
            console.log(`[SUPABASE SYNC] Αφαιρέθηκαν ${stale.length} παλιά entries από το songs.`);
        }

        console.log(`[SUPABASE SYNC] Η λίστα songs είναι ακριβές mirror των ${mp3Files.length} τοπικών τραγουδιών.`);
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

        const files = fs.readdirSync(__dirname);
        const match = files.find(f =>
            path.extname(f).toLowerCase() === '.mp3' &&
            f.toLowerCase() === String(request.song || '').toLowerCase()
        );

        if (!match) {
            await supabase.from('song_requests')
                .update({ status: 'rejected' })
                .eq('id', request.id);
            console.error(`[REQUEST] Το ζητούμενο αρχείο δεν υπάρχει πλέον: ${request.song}`);
            return null;
        }

        const { error: updateErr } = await supabase.from('song_requests')
            .update({ status: 'playing' })
            .eq('id', request.id)
            .eq('status', 'pending');

        if (updateErr) throw updateErr;

        console.log(`[LIVE REQUEST] Αναπαράγεται: ${match} (από ${request.requester})`);

        if (request.email && process.env.EMAIL_USER && process.env.EMAIL_PASS) {
            try {
                await transporter.sendMail({
                    to: request.email,
                    from: process.env.EMAIL_USER,
                    subject: 'Το τραγούδι σας αναμεταδίδεται! 🎵',
                    html: `<h2>Γεια σας!</h2><p>Το τραγούδι "${request.song}" αναμεταδίδεται τώρα στο Thavma Παλμός! 🎧</p>`
                });
            } catch (mailErr) {
                console.error('[EMAIL ERROR]', mailErr.message);
            }
        }

        return { filename: match, requester: request.requester, requestId: request.id };
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
    const d = time.day;
    const h = time.hour;

    if (isEasterPeriod(time)) {
        return 'EASTER_MODE';
    }

    if (d === 0 || d === 6) {
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
        if (h >= 2 && h < 8) return 'B';
        if (h >= 8 && h < 12) return 'R';
        if (h >= 12 && h < 16) return 'P_LZ';
        if (h >= 16 && h < 20) return 'R';
        return 'MIX';
    }

    return 'MIX';
}

let lastAnnouncedHour = getGreekTime().hour;
let lastAnthemDate = getGreekTime().date;
let songCounter = 0;
let currentNowPlaying = { title: "Φορτώνει...", genre: "Radio" };

let newYearQueue = [];
let lastNewYearSequenceKey = null;

let currentFfmpegProcess = null;
let isShuttingDown = false;

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function cleanDisplayTitle(filename) {
    return String(filename || '')
        .replace(/^\([^)]+\)\s*/, '')
        .replace(/\.mp3$/i, '')
        .replace(/_/g, ' ')
        .trim();
}

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


async function acquireStreamLease() {
    if (!supabase) return true;
    const { data, error } = await supabase.rpc('acquire_stream_lease', {
        p_owner_id: STREAM_OWNER_ID,
        p_lease_seconds: STREAM_LEASE_SECONDS
    });
    if (error) {
        console.error('[LEASE ERROR] Δεν μπόρεσα να αποκτήσω stream lease:', error.message);
        return false;
    }
    ownsStreamLease = data === true;
    return ownsStreamLease;
}

async function renewStreamLease() {
    if (!supabase || !ownsStreamLease || isShuttingDown) return;
    const { data, error } = await supabase.rpc('renew_stream_lease', {
        p_owner_id: STREAM_OWNER_ID,
        p_lease_seconds: STREAM_LEASE_SECONDS
    });
    if (error || data !== true) {
        console.error('[LEASE LOST] Χάθηκε το stream lease. Σταματά ο encoder για να μην υπάρχουν δύο jobs μαζί.');
        ownsStreamLease = false;
        if (currentFfmpegProcess) currentFfmpegProcess.kill('SIGTERM');
        if (leaseRenewTimer) clearInterval(leaseRenewTimer);
        leaseRenewTimer = null;
        setTimeout(() => { if (!isShuttingDown) waitForLeaseAndStart(); }, 5000);
    }
}

async function releaseStreamLease() {
    if (!supabase || !ownsStreamLease) return;
    try {
        await supabase.rpc('release_stream_lease', { p_owner_id: STREAM_OWNER_ID });
    } catch (_) {}
    ownsStreamLease = false;
}

async function claimStationEvent(eventKey) {
    if (!supabase) {
        if (lastNewYearSequenceKey === eventKey) return false;
        lastNewYearSequenceKey = eventKey;
        return true;
    }

    const { data, error } = await supabase.rpc('claim_station_event', { p_event_key: eventKey });
    if (error) {
        console.error('[EVENT CLAIM ERROR]', error.message);
        return false;
    }
    return data === true;
}

async function getRecentPlayedFilenames(limit = 5) {
    if (!supabase) return [];
    try {
        const { data, error } = await supabase
            .from('play_history')
            .select('filename')
            .order('played_at', { ascending: false })
            .limit(limit);
        if (error) throw error;
        return [...new Set((data || []).map(r => r.filename).filter(Boolean))];
    } catch (error) {
        console.error('[HISTORY RECENT ERROR]', error.message);
        return [];
    }
}

async function claimRotationSong(rotationKey, candidates) {
    const uniqueCandidates = [...new Set((candidates || []).filter(Boolean))];
    if (uniqueCandidates.length === 0) return null;

    if (supabase) {
        const recent = await getRecentPlayedFilenames(5);
        const { data, error } = await supabase.rpc('claim_rotation_song', {
            p_rotation_key: rotationKey,
            p_candidates: uniqueCandidates,
            p_recent: recent
        });
        if (!error && data) return data;
        if (error) console.error(`[ROTATION RPC ERROR ${rotationKey}]`, error.message);
    }

    // Fallback μόνο για να μη σταματήσει ο σταθμός αν λείπει προσωρινά το RPC.
    const fallback = shuffleArray([...uniqueCandidates]);
    return fallback[0] || null;
}

async function prepareNewYearSequence(time) {
    // Επιτρέπουμε recovery για τα πρώτα 15 λεπτά της 1ης Ιανουαρίου.
    if (!(time.month === 0 && time.date === 1 && time.hour === 0 && time.minute < 15)) return;
    if (newYearQueue.length > 0) return;

    const eventKey = `newyear-${time.year}`;
    if (lastNewYearSequenceKey === eventKey) return;

    const claimed = await claimStationEvent(eventKey);
    lastNewYearSequenceKey = eventKey;
    if (!claimed) return;

    const seq = [];
    const clock0 = findHourFile(0);
    if (clock0) {
        seq.push({ file: clock0, title: 'Η ώρα είναι 00.00', genreLabel: 'Ώρα Ελλάδος', isHourAnnouncement: true });
    }

    const specialFiles = [
        'ΚαλήΧρονιά.mp3',
        'thavma_palmos_christmas_jingle.mp3',
        'Αρχιμηνιά και Αρχιχρονιά το λάδι 19.mp3'
    ];
    for (const file of specialFiles) {
        if (fs.existsSync(path.join(__dirname, file))) {
            seq.push({ file, title: cleanDisplayTitle(file), genreLabel: 'Πρωτοχρονιάτικη Ακολουθία', isSystem: true });
        }
    }

    newYearQueue = seq;
    lastAnnouncedHour = 0;
    lastAnthemDate = time.date; // Δεν αφήνουμε τον ύμνο να καθυστερήσει την Πρωτοχρονιάτικη ακολουθία.
    songCounter = 0;
    console.log(`[NEW YEAR] Κλειδώθηκε και προγραμματίστηκε η ακολουθία ${eventKey} (${newYearQueue.length} αρχεία).`);
}

function firstExisting(paths) {
    for (const p of paths) {
        if (fs.existsSync(p)) return p;
    }
    return null;
}

const FALLBACK_REGULAR = firstExisting([
    '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf',
    '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'
]) || '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf';

const FALLBACK_BOLD = firstExisting([
    '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf',
    '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'
]) || FALLBACK_REGULAR;

const FONT_PATH = FALLBACK_REGULAR;
console.log('[FONT] Εφεδρική γραμματοσειρά (regular): ' + FALLBACK_REGULAR);
console.log('[FONT] Εφεδρική γραμματοσειρά (bold): ' + FALLBACK_BOLD);

const FONT_ARG = FONT_PATH ? `fontfile='${FONT_PATH}':` : '';

const CUSTOM_FONT_DIR = '/usr/share/fonts/truetype/custom';

function resolveNamedFont(candidateFileNames) {
    for (const name of candidateFileNames) {
        const p = path.join(CUSTOM_FONT_DIR, name);
        if (fs.existsSync(p)) return p;
    }
    return null;
}

const TIME_FONT = resolveNamedFont(['Century.ttf', 'CENTURY.TTF', 'Century Regular.ttf']) || FALLBACK_REGULAR;
const TITLE_FONT = resolveNamedFont(['CenturyGothic.ttf', 'GOTHIC.TTF', 'Century Gothic.ttf']) || FALLBACK_REGULAR;
const CATEGORY_FONT = resolveNamedFont(['CenturyGothicBold.ttf', 'GOTHICB.TTF', 'Century Gothic Bold.ttf']) || FALLBACK_BOLD;

function isNewYearXBoostWindow(month, date, hour) {
    return month === 0 && date === 1 && hour >= 0 && hour < 2;
}

async function selectNextFile() {
    const time = getGreekTime();

    // Πρωτοχρονιά: ανεξάρτητη από το αν το process ξεκίνησε πριν ή μετά τις 00:00.
    await prepareNewYearSequence(time);
    if (newYearQueue.length > 0) {
        return newYearQueue.shift();
    }

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
            const hourString = time.hour < 10 ? `0${time.hour}.00` : `${time.hour}.00`;
            return { file: hourFile, title: `Η ώρα είναι ${hourString}`, genreLabel: 'Ώρα Ελλάδος', isHourAnnouncement: true };
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
        return {
            file: liveRequest.filename,
            title: cleanDisplayTitle(liveRequest.filename),
            genreLabel: `Παραγγελία Ακροατή [${liveRequest.requester}]`,
            isSong: true,
            isRequest: true,
            requestId: liveRequest.requestId
        };
    }

    const files = fs.readdirSync(__dirname);
    const mp3Files = files.filter(file => path.extname(file).toLowerCase() === '.mp3' && !isHourFile(file));
    if (mp3Files.length === 0) return null;

    const christmasActive = isChristmasPeriod(time.month, time.date);
    const xFiles = mp3Files.filter(f => hasTag(f, ...TAG.CHRISTMAS));
    const normalPool = mp3Files.filter(f => !hasTag(f, ...TAG.CHRISTMAS));

    const genre = getRequiredGenre();
    let filteredFiles = [];
    let genreLabel = 'Mix Πρόγραμμα';
    let rotationKey = 'MIX';

    if (genre === 'B') {
        filteredFiles = normalPool.filter(f => hasTag(f, ...TAG.BEATS));
        genreLabel = 'Beats (Disco, Dance, Club)';
        rotationKey = 'B';
    } else if (genre === 'R') {
        filteredFiles = normalPool.filter(f => hasTag(f, ...TAG.RADIO));
        genreLabel = 'Radio (Κανονική Ροή)';
        rotationKey = 'R';
    } else if (genre === 'P_LZ') {
        filteredFiles = normalPool.filter(f => hasTag(f, ...TAG.PARADOSIAKA) || hasTag(f, ...TAG.LAIKA_ZEIMBEKIKA));
        genreLabel = 'Παραδοσιακά & Λαϊκά';
        rotationKey = 'P_LZ';
    } else if (genre === 'EASTER_MODE') {
        const easterFiles = normalPool.filter(f => hasTag(f, ...TAG.PARADOSIAKA) || hasTag(f, ...TAG.LAIKA_ZEIMBEKIKA));
        if (easterFiles.length > 0 && Math.random() < 0.20) {
            filteredFiles = easterFiles;
            genreLabel = 'Πασχαλινό Πρόγραμμα (Έμφαση στα Παραδοσιακά)';
            rotationKey = 'P_LZ';
        } else {
            filteredFiles = normalPool;
            genreLabel = 'Πασχαλινό Πρόγραμμα (Mix)';
            rotationKey = 'MIX';
        }
    } else {
        filteredFiles = normalPool;
        genreLabel = 'Mix Πρόγραμμα';
        rotationKey = 'MIX';
    }

    if (filteredFiles.length === 0) {
        filteredFiles = normalPool.length > 0 ? normalPool : mp3Files;
        rotationKey = 'MIX';
        genreLabel = 'Mix Πρόγραμμα';
    }

    // Τα Χριστουγεννιάτικα είναι δική τους κατηγορία/rotation.
    // Δεν τα συγχωνεύουμε στο MIX, γιατί αυτό χαλούσε τον κανόνα "μία φορά μέχρι να τελειώσει η κατηγορία".
    if (christmasActive && xFiles.length > 0) {
        const xBoost = isNewYearXBoostWindow(time.month, time.date, time.hour);
        const xProbability = xBoost ? 0.80 : 0.35;
        if (Math.random() < xProbability) {
            filteredFiles = xFiles;
            rotationKey = 'X';
            genreLabel = xBoost
                ? 'Χριστουγεννιάτικο Πρόγραμμα (X) - Πρωτοχρονιά'
                : 'Χριστουγεννιάτικο Πρόγραμμα (X)';
        }
    }

    const randomFile = await claimRotationSong(rotationKey, filteredFiles);
    if (!randomFile) return null;

    await logPlayHistory(randomFile, rotationKey, 'auto');
    return {
        file: randomFile,
        title: cleanDisplayTitle(randomFile),
        genreLabel,
        isSong: true,
        rotationKey
    };
}

function buildNewYearCountdownFilters(spawnTime) {
    if (process.env.TEST_NEWYEAR === 'true') {
        return buildCountdownFromOffsets({
            off2350: 5,
            off2359: 25,
            off235950: 35,
            offMidnight: 45,
            nyEnd: 60,
            nextYear: spawnTime.year + 1
        });
    }

    const isDec31Window = (
        spawnTime.month === 11 &&
        spawnTime.date === 31 &&
        (spawnTime.hour > 23 || (spawnTime.hour === 23 && spawnTime.minute >= 45))
    );
    const isEarlyJan1 = (
        spawnTime.month === 0 &&
        spawnTime.date === 1 &&
        spawnTime.hour === 0 &&
        spawnTime.minute === 0 &&
        spawnTime.second < 20
    );

    if (!isDec31Window && !isEarlyJan1) {
        return {
            filters: [],
            blackoutStart: null,
            blackoutEnd: null,
            suppressNormalOverlayFrom: null,
            suppressNormalOverlayUntil: null
        };
    }

    if (isEarlyJan1) {
        const midnight = athensTargetDate(spawnTime, 0, 0, 0, 0);
        const offMidnight = secondsFromNowTo(spawnTime, midnight);
        return buildCountdownFromOffsets({
            off2350: -999,
            off2359: -999,
            off235950: -999,
            offMidnight,
            nyEnd: offMidnight + 15,
            nextYear: spawnTime.year
        });
    }

    const target2350 = athensTargetDate(spawnTime, 0, 23, 50, 0);
    const target2359 = athensTargetDate(spawnTime, 0, 23, 59, 0);
    const target235950 = athensTargetDate(spawnTime, 0, 23, 59, 50);
    const targetMidnight = athensTargetDate(spawnTime, 1, 0, 0, 0);

    const off2350 = secondsFromNowTo(spawnTime, target2350);
    const off2359 = secondsFromNowTo(spawnTime, target2359);
    const off235950 = secondsFromNowTo(spawnTime, target235950);
    const offMidnight = secondsFromNowTo(spawnTime, targetMidnight);
    const nextYear = spawnTime.year + 1;
    const nyEnd = offMidnight + 15;

    return buildCountdownFromOffsets({ off2350, off2359, off235950, offMidnight, nyEnd, nextYear });
}

function buildCountdownFromOffsets({ off2350, off2359, off235950, offMidnight, nyEnd, nextYear }) {
    const filters = [];
    const remainingExpr = `(${offMidnight.toFixed(2)}-t)`;

    // 23:50 - 23:59: MM:SS. Ένα δυναμικό drawtext αντί για δεκάδες filters.
    if (off2359 > 0) {
        const mmssText = `%{eif\:trunc(${remainingExpr}/60)\:d\:2}\:%{eif\:mod(trunc(${remainingExpr})\,60)\:d\:2}`;
        filters.push(
            `drawtext=${FONT_ARG}text='${mmssText}':x=(w-text_w)/2:y=90:fontsize=68:` +
            `fontcolor=0xFFD700:box=1:boxcolor=black@0.58:boxborderw=14:` +
            `enable='between(t\,${Math.max(0, off2350).toFixed(2)}\,${off2359.toFixed(2)})'`
        );
    }

    // 23:59:00 - 23:59:50: 60...11 δευτερόλεπτα.
    if (off235950 > 0) {
        const secondsText = `%{eif\:ceil(${remainingExpr})\:d\:2}`;
        filters.push(
            `drawtext=${FONT_ARG}text='${secondsText}':x=(w-text_w)/2:y=(h-text_h)/2:` +
            `fontsize=145:fontcolor=0xFFD700:box=1:boxcolor=black@0.45:boxborderw=18:` +
            `enable='between(t\,${Math.max(0, off2359).toFixed(2)}\,${off235950.toFixed(2)})'`
        );
    }

    // Τελευταία 10 δευτερόλεπτα: full-screen μαύρο και πολύ μεγάλος αριθμός.
    if (offMidnight > 0) {
        const lastSecondsText = `%{eif\:ceil(${remainingExpr})\:d}`;
        filters.push(
            `drawtext=${FONT_ARG}text='${lastSecondsText}':x=(w-text_w)/2:y=(h-text_h)/2:` +
            `fontsize=220:fontcolor=0xFFD700:` +
            `enable='between(t\,${Math.max(0, off235950).toFixed(2)}\,${offMidnight.toFixed(2)})'`
        );
    }

    const nyText = `Καλή Χρονιά ${nextYear}!`.replace(/'/g, '');
    if (nyEnd > 0) {
        filters.push(
            `drawtext=${FONT_ARG}text='${nyText}':x=(w-text_w)/2:y=(h-text_h)/2:` +
            `fontsize=100:fontcolor=0xFFD700:box=1:boxcolor=black@0.55:boxborderw=18:` +
            `enable='between(t\,${Math.max(0, offMidnight).toFixed(2)}\,${nyEnd.toFixed(2)})'`
        );
    }

    return {
        filters,
        blackoutStart: off235950,
        blackoutEnd: nyEnd,
        suppressNormalOverlayFrom: off235950,
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
    return (targetDate - spawnTime.raw) / 1000;
}

function secondsUntilNewYearMidnight(spawnTime) {
    if (!(spawnTime.month === 11 && spawnTime.date === 31 && spawnTime.hour === 23 && spawnTime.minute >= 50)) {
        return null;
    }
    const targetMidnight = athensTargetDate(spawnTime, 1, 0, 0, 0);
    return Math.max(0, secondsFromNowTo(spawnTime, targetMidnight));
}

async function startNextMedia() {
    if (isShuttingDown || (supabase && !ownsStreamLease)) return;

    const media = await selectNextFile();

    if (!media || !fs.existsSync(path.join(__dirname, 'background.jpg'))) {
        setTimeout(startNextMedia, 5000);
        return;
    }

    console.log(`Playing [${media.title}]`);

    if (media.isHourAnnouncement) songCounter = 0;
    else if (media.isSong && !media.isRequest) songCounter++;

    currentNowPlaying = { title: media.title, genre: media.genreLabel };

    if (supabase) {
        supabase.from('station_status').upsert({
            id: 1,
            title: media.title,
            genre: media.genreLabel,
            updated_at: new Date().toISOString(),
            heartbeat_at: new Date().toISOString(),
            stream_owner: STREAM_OWNER_ID
        }).then(({ error }) => {
            if (error) console.error('[STATUS SYNC ERROR]', error.message);
        });
    }

    const streamKey = process.env.YOUTUBE_STREAM_KEY;
    if (!streamKey) {
        console.error('[YOUTUBE ERROR] Λείπει το YOUTUBE_STREAM_KEY.');
        setTimeout(startNextMedia, 5000);
        return;
    }

    const cleanLabel = media.genreLabel.replace(/'/g, '’').replace(/:/g, ' — ').replace(/,/g, ' ');
    const cleanTitle = media.title.replace(/'/g, '’').replace(/:/g, '.').replace(/,/g, ' ');
    const clockText = "%{localtime\:%H\\\:%M\\\:%S & %d\\\/%m\\\/%Y}";

    const spawnTime = getGreekTime();
    const ny = buildNewYearCountdownFilters(spawnTime);

    let blackoutFilter = '';
    if (ny.blackoutStart !== null && ny.blackoutEnd !== null && ny.blackoutEnd > 0) {
        blackoutFilter = `,drawbox=x=0:y=0:w=iw:h=ih:color=black:t=fill:enable='between(t\,${Math.max(0, ny.blackoutStart).toFixed(2)}\,${ny.blackoutEnd.toFixed(2)})'`;
    }

    let normalOverlayEnable = '';
    if (ny.suppressNormalOverlayFrom !== null && ny.suppressNormalOverlayUntil !== null && ny.suppressNormalOverlayUntil > 0) {
        normalOverlayEnable = `:enable='not(between(t\,${Math.max(0, ny.suppressNormalOverlayFrom).toFixed(2)}\,${ny.suppressNormalOverlayUntil.toFixed(2)}))'`;
    }

    const baseOverlayFilters =
        `drawtext=fontfile='${CATEGORY_FONT}':text='${cleanLabel}':x=18:y=22:fontsize=15:fontcolor=yellow:box=1:boxcolor=black@0.55:boxborderw=6${normalOverlayEnable},` +
        `drawtext=fontfile='${TITLE_FONT}':text='${cleanTitle}':x=18:y=50:fontsize=18:fontcolor=white:box=1:boxcolor=black@0.55:boxborderw=7${normalOverlayEnable},` +
        `drawtext=fontfile='${TIME_FONT}':text='${clockText}':x=w-tw-20:y=22:fontsize=18:fontcolor=black${normalOverlayEnable}`;

    const countdownFilterChain = ny.filters.length > 0 ? ',' + ny.filters.join(',') : '';
    const vfChain = `scale=854:480${blackoutFilter},${baseOverlayFilters}${countdownFilterChain}`;

    const ffmpegArgs = [
        '-hide_banner', '-loglevel', 'warning',
        '-re', '-fflags', '+genpts', '-loop', '1', '-framerate', '12', '-i', 'background.jpg',
        '-i', media.file,
        '-map', '0:v:0', '-map', '1:a:0',
        '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'stillimage', '-threads', '1',
        '-vf', vfChain,
        '-r', '12', '-g', '24', '-b:v', '2500k', '-maxrate', '2500k', '-bufsize', '5000k',
        '-c:a', 'aac', '-b:a', '192k',
        '-af', 'aresample=async=1:min_hard_comp=0.100000:first_pts=0',
        '-max_muxing_queue_size', '4096',
        '-shortest'
    ];

    // Από 23:50 στις 31/12, αν κάποιο τραγούδι περνά τα μεσάνυχτα,
    // το output κόβεται ΑΚΡΙΒΩΣ στα 00:00 ώστε να ξεκινήσει αμέσως η ειδική ακολουθία.
    const cutAtMidnight = secondsUntilNewYearMidnight(spawnTime);
    if (cutAtMidnight !== null && cutAtMidnight > 0.25) {
        ffmpegArgs.push('-t', cutAtMidnight.toFixed(3));
    }

    ffmpegArgs.push(
        '-pix_fmt', 'yuv420p', '-f', 'flv',
        `rtmp://a.rtmp.youtube.com/live2/${streamKey}`
    );

    const ffmpeg = spawn('ffmpeg', ffmpegArgs, { stdio: ['ignore', 'ignore', 'pipe'] });
    currentFfmpegProcess = ffmpeg;

    let stderrTail = '';
    ffmpeg.stderr?.on('data', chunk => {
        stderrTail = (stderrTail + chunk.toString()).slice(-5000);
    });

    ffmpeg.on('close', async (code, signal) => {
        currentFfmpegProcess = null;

        if (media.requestId && supabase) {
            const status = code === 0 ? 'played' : 'pending';
            await supabase.from('song_requests').update({ status }).eq('id', media.requestId);
        }

        if (code && code !== 0 && !isShuttingDown) {
            console.error(`[FFMPEG CLOSE] code=${code} signal=${signal || '-'}
${stderrTail}`);
        }

        if (!isShuttingDown && (!supabase || ownsStreamLease)) {
            setTimeout(startNextMedia, code === 0 ? 250 : 2000);
        }
    });

    ffmpeg.on('error', async (error) => {
        currentFfmpegProcess = null;
        console.error('[FFMPEG SPAWN ERROR]', error.message);
        if (media.requestId && supabase) {
            await supabase.from('song_requests').update({ status: 'pending' }).eq('id', media.requestId);
        }
        if (!isShuttingDown && (!supabase || ownsStreamLease)) {
            setTimeout(startNextMedia, 3000);
        }
    });
}

async function gracefulShutdown(signal) {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.log(`[SHUTDOWN] Λήψη σήματος ${signal} — τερματισμός encoder και παράδοση lease.`);

    if (leaseRenewTimer) {
        clearInterval(leaseRenewTimer);
        leaseRenewTimer = null;
    }

    if (currentFfmpegProcess) {
        currentFfmpegProcess.kill('SIGTERM');
    }

    await releaseStreamLease();
    setTimeout(() => process.exit(0), 1200);
}

async function logPlayHistory(filename, rotationKey = null, source = 'auto') {
    if (!supabase) return;
    try {
        const { error } = await supabase.from('play_history').insert([{
            filename,
            rotation_key: rotationKey,
            source,
            played_at: new Date().toISOString()
        }]);
        if (error) throw error;
    } catch (error) {
        console.error('[HISTORY LOG ERROR]', error.message);
    }
}

async function startHeartbeat() {
    if (!supabase || !ownsStreamLease || isShuttingDown) return;
    const now = new Date().toISOString();
    const { error } = await supabase.from('station_status').upsert({
        id: 1,
        heartbeat_at: now,
        stream_owner: STREAM_OWNER_ID,
        updated_at: now
    });
    if (error) console.error('[HEARTBEAT ERROR]', error.message);
}

async function waitForLeaseAndStart() {
    if (!supabase) {
        console.warn('[LEASE] Supabase δεν είναι διαθέσιμο. Εκκίνηση χωρίς distributed lock.');
        startNextMedia();
        return;
    }

    while (!isShuttingDown) {
        const acquired = await acquireStreamLease();
        if (acquired) {
            console.log(`[LEASE] Το job ${STREAM_OWNER_ID} έγινε ο ενεργός broadcaster.`);
            await startHeartbeat();
            leaseRenewTimer = setInterval(async () => {
                await renewStreamLease();
                if (ownsStreamLease) await startHeartbeat();
            }, 30000);
            startNextMedia();
            return;
        }

        console.log('[LEASE] Υπάρχει ήδη ενεργό job. Το νέο job περιμένει για καθαρό handover...');
        await sleep(10000);
    }
}

process.on('SIGTERM', () => { gracefulShutdown('SIGTERM'); });
process.on('SIGINT', () => { gracefulShutdown('SIGINT'); });

app.listen(PORT, '0.0.0.0', async () => {
    console.log(`Ο Server ξεκίνησε στο port ${PORT}`);
    console.log(`[STREAM OWNER] ${STREAM_OWNER_ID}`);
    await syncSongsToSupabase();
    await waitForLeaseAndStart();
});
