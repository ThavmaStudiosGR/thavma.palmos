process.env.TZ = 'Europe/Athens';

const express = require('express');
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');
const { createClient } = require('@supabase/supabase-js');

// Όταν επιλέγουμε το επόμενο τραγούδι νωρίτερα (lookahead), οι αποφάσεις ώρας/προγράμματος
// υπολογίζονται για τη στιγμή που θα ακουστεί, όχι για τώρα.
let virtualLeadMs = 0;

const ATHENS_FORMATTER = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Athens', hourCycle: 'h23',
    year: 'numeric', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: 'numeric', second: 'numeric', weekday: 'short'
});
const WEEKDAY_INDEX = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

const app = express();
const PORT = process.env.PORT || 3000;
app.use(express.json());

// ============================================================
// CONFIG
// ============================================================
const AUDIO_EXTENSIONS = new Set(['.mp3', '.wav']);
const CROSSFADE_SECONDS = Math.max(0, Math.min(8, Number(process.env.CROSSFADE_SECONDS || process.env.MIX_CROSSFADE_SECONDS || 3)));
const SELF_HANDOVER_AFTER_MINUTES = Math.max(30, Math.min(350, Number(process.env.SELF_HANDOVER_AFTER_MINUTES || 220)));
const GITHUB_HANDOVER_TOKEN = process.env.GITHUB_TOKEN_FOR_HANDOVER || '';
const GITHUB_REPOSITORY_NAME = process.env.GITHUB_REPOSITORY_NAME || process.env.GITHUB_REPOSITORY || '';
const GITHUB_REF_NAME = process.env.GITHUB_REF_NAME || 'main';
const AD_EVERY_SONGS = Math.max(1, Math.min(50, Number(process.env.AD_EVERY_SONGS || 7)));
// Φόντο ημέρας/νύχτας: ανατολή/δύση ηλίου στην Ελλάδα (προεπιλογή Αθήνα).
const SUN_LAT = Number(process.env.SUN_LAT || 37.9838);
const SUN_LON = Number(process.env.SUN_LON || 23.7275);
const SUN_OFFSET_MINUTES = Number(process.env.SUN_OFFSET_MINUTES || 0); // + = αργότερα και στα δύο
// Χριστουγεννιάτικα: 1 στα 4 τραγούδια, εκτός 22:00-08:00
const XMAS_EVERY_SONGS = Math.max(2, Math.min(20, Number(process.env.XMAS_EVERY_SONGS || 4)));
const XMAS_QUIET_START_HOUR = 22;
const XMAS_QUIET_END_HOUR = 8;
// Anti-stall
const SUPABASE_TIMEOUT_MS = Math.max(3000, Number(process.env.SUPABASE_TIMEOUT_MS || 12000));
const FFMPEG_STALL_SECONDS = Math.max(10, Number(process.env.FFMPEG_STALL_SECONDS || 25));
const FFMPEG_START_GRACE_SECONDS = 40;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY;

// Κάθε κλήση προς Supabase έχει timeout, ώστε ένα "κρεμασμένο" request να μη
// μπλοκάρει ποτέ την αλυσίδα των τραγουδιών (κύρια αιτία του "κολλήματος").
function fetchWithTimeout(url, options = {}) {
    const timeoutSignal = AbortSignal.timeout(SUPABASE_TIMEOUT_MS);
    const signal = options.signal && AbortSignal.any ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;
    return fetch(url, { ...options, signal });
}

const supabase = SUPABASE_URL && SUPABASE_KEY ? createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: fetchWithTimeout }
}) : null;

if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.error('[SUPABASE ERROR] Λείπουν SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY.');
}

const STREAM_OWNER_ID = process.env.STREAM_OWNER_ID || process.env.GITHUB_RUN_ID || `local-${process.pid}-${Date.now()}`;
const STREAM_LEASE_SECONDS = 90;

const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS }
});

const TAG = {
    BEATS: ['B'],
    RADIO: ['R'],
    PARADOSIAKA: ['Π'],
    LAIKA_ZEIMBEKIKA: ['ΛΖ'],
    CHRISTMAS: ['X'],
    ADS: ['ΔΦ']
};

// ============================================================
// RUNTIME STATE
// ============================================================
let lastAnnouncedHour = getGreekTime().hour;
let lastAnthemDate = getGreekTime().date;
let songCounter = 0;
let songsSinceAd = 0;
let songsSinceXmas = 0;
let isStartingMedia = false;
let lastChainActivityAt = Date.now();
let chainWatchdogTimer = null;
let leaseErrorStreak = 0;
let currentNowPlaying = { title: 'Φορτώνει...', genre: 'Radio' };

let currentFfmpegProcess = null;
let currentMedia = null;
let currentCrossfadeTimer = null;
let isShuttingDown = false;
let intentionalStopReason = null;

let ownsStreamLease = false;
let leaseRenewTimer = null;
let clockWriterTimer = null;
let commandPollTimer = null;
let successorDispatchTimer = null;
let lastLeaseWaitLogAt = 0;

let newYearQueue = [];
let lastNewYearSequenceKey = null;
let pendingCrossfadeMedia = null;

let forcedNewYearTest = null;
let forcedNewYearTestQueue = [];
let startupNewYearTestRequested = process.env.TEST_NEWYEAR === 'true';

let categorySettingsCache = { at: 0, map: new Map() };
let songSettingsCache = { at: 0, map: new Map() };
const durationCache = new Map();

const CLOCK_TIME_FILE = path.join(__dirname, '.live_time.txt');
const CLOCK_DATE_FILE = path.join(__dirname, '.live_date.txt');

// ============================================================
// HELPERS
// ============================================================
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function pad2(n) { return String(n).padStart(2, '0'); }

// Ώρα Ελλάδος μέσω Intl (Europe/Athens): η αλλαγή θερινής/χειμερινής ώρας
// (τελευταία Κυριακή Μαρτίου / Οκτωβρίου) γίνεται αυτόματα, χωρίς εξάρτηση από
// το timezone του μηχανήματος.
function getGreekTime(date = new Date(Date.now() + virtualLeadMs)) {
    const p = {};
    for (const part of ATHENS_FORMATTER.formatToParts(date)) p[part.type] = part.value;
    return {
        raw: date,
        year: Number(p.year),
        month: Number(p.month) - 1,
        date: Number(p.day),
        day: WEEKDAY_INDEX[p.weekday] ?? 0,
        hour: Number(p.hour) % 24,
        minute: Number(p.minute),
        second: Number(p.second)
    };
}

// Στιγμή (Date) για συγκεκριμένη "τοίχου" ώρα Αθήνας, με σωστό DST.
function athensWallToDate(year, month, day, hour, minute, second) {
    const wanted = Date.UTC(year, month, day, hour, minute, second);
    let guess = wanted;
    for (let i = 0; i < 3; i++) {
        const t = getGreekTime(new Date(guess));
        const wall = Date.UTC(t.year, t.month, t.date, t.hour, t.minute, t.second);
        const diff = wanted - wall;
        if (diff === 0) break;
        guess += diff;
    }
    return new Date(guess);
}

// Ανατολή/δύση ηλίου (NOAA) για την ημερομηνία Αθήνας του time. Επιστρέφει απόλυτες στιγμές.
function getSunTimes(time = getGreekTime()) {
    const rad = Math.PI / 180;
    const startOfYear = Date.UTC(time.year, 0, 0);
    const doy = Math.round((Date.UTC(time.year, time.month, time.date) - startOfYear) / 86400000);
    const g = (2 * Math.PI / 365) * (doy - 1 + (12 - 12) / 24);
    const eqTime = 229.18 * (0.000075 + 0.001868 * Math.cos(g) - 0.032077 * Math.sin(g) - 0.014615 * Math.cos(2 * g) - 0.040849 * Math.sin(2 * g));
    const decl = 0.006918 - 0.399912 * Math.cos(g) + 0.070257 * Math.sin(g) - 0.006758 * Math.cos(2 * g) + 0.000907 * Math.sin(2 * g) - 0.002697 * Math.cos(3 * g) + 0.00148 * Math.sin(3 * g);
    const latR = SUN_LAT * rad;
    let cosHa = Math.cos(90.833 * rad) / (Math.cos(latR) * Math.cos(decl)) - Math.tan(latR) * Math.tan(decl);
    cosHa = Math.max(-1, Math.min(1, cosHa));
    const haDeg = Math.acos(cosHa) / rad;
    const midnightUtc = Date.UTC(time.year, time.month, time.date);
    const offsetMs = SUN_OFFSET_MINUTES * 60000;
    return {
        sunrise: new Date(midnightUtc + (720 - 4 * (SUN_LON + haDeg) - eqTime) * 60000 + offsetMs),
        sunset: new Date(midnightUtc + (720 - 4 * (SUN_LON - haDeg) - eqTime) * 60000 + offsetMs)
    };
}

function isDaytimeGreece(time = getGreekTime()) {
    const { sunrise, sunset } = getSunTimes(time);
    const now = time.raw.getTime();
    return now >= sunrise.getTime() && now < sunset.getTime();
}

function isAudioFile(fileName) {
    return AUDIO_EXTENSIONS.has(path.extname(String(fileName || '')).toLowerCase());
}

function cleanDisplayTitle(filename) {
    return String(filename || '')
        .replace(/^\([^)]+\)\s*/, '')
        .replace(/\.(mp3|wav)$/i, '')
        .replace(/_/g, ' ')
        .trim();
}

function extractTag(filename) {
    const match = String(filename || '').match(/^\(([^)]+)\)/);
    return match ? match[1] : '';
}

function hasTag(filename, ...variants) {
    const tag = extractTag(filename);
    return variants.includes(tag);
}

function findNamedAudio(baseName) {
    for (const ext of ['.mp3', '.wav']) {
        const candidate = `${baseName}${ext}`;
        if (fs.existsSync(path.join(__dirname, candidate))) return candidate;
    }
    return null;
}

function isSystemFile(fileName) {
    if (!isAudioFile(fileName)) return false;
    const ext = path.extname(fileName);
    const base = path.basename(fileName, ext);
    if (/^clock\d+$/.test(base)) return true;
    return new Set([
        'thavma_palmos_jingle',
        'xmas_thavma_palmos_jingle',
        'thavma_palmos_christmas_jingle',
        'ethnikos_ymnos',
        'ΚαλήΧρονιά',
        'Αρχιμηνιά και Αρχιχρονιά το λάδι 19'
    ]).has(base);
}

function findHourFile(hour) {
    return findNamedAudio(`clock${hour}`);
}

function isChristmasPeriod(month, date) {
    // 17 Νοεμβρίου - 31 Ιανουαρίου
    return (month === 10 && date >= 17) || month === 11 || month === 0;
}

// Ζώνη Χριστουγεννιάτικων: παντού εκτός 22:00-08:00
function isXmasSongWindow(time) {
    return isChristmasPeriod(time.month, time.date) && time.hour >= XMAS_QUIET_END_HOUR && time.hour < XMAS_QUIET_START_HOUR;
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

function getRequiredGenreForDate(date) {
    const t = getGreekTime(date);
    const d = t.day;
    const h = t.hour;

    if (isEasterPeriod(t)) return 'EASTER_MODE';
    if (d === 0 || d === 6) return 'WEEKEND_MIX'; // Mix μόνο από B, R, ΛΖ

    // Δευτέρα, Τετάρτη, Παρασκευή
    if (d === 1 || d === 3 || d === 5) {
        if (h >= 21 || h < 2) return 'B';
        if (h >= 2 && h < 7) return 'MIX';
        if (h >= 7 && h < 13) return 'R';
        if (h >= 13 && h < 16) return 'P_LZ';
        return 'R'; // 16:00 - 21:00
    }

    // Τρίτη, Πέμπτη
    if (d === 2 || d === 4) {
        if (h < 7) return 'MIX';
        if (h >= 7 && h < 13) return 'R';
        if (h >= 13 && h < 15) return 'P';
        if (h >= 15 && h < 16) return 'LZ';
        if (h >= 16 && h < 21) return 'R';
        return 'B'; // 21:00 - 00:00
    }

    return 'MIX';
}

function getRequiredGenre() { return getRequiredGenreForDate(new Date(Date.now() + virtualLeadMs)); }

function shuffleArray(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
}

function escapeDrawtextText(value) {
    return String(value || '')
        .replace(/\\/g, '\\\\')
        .replace(/'/g, '’')
        .replace(/:/g, ' — ')
        .replace(/%/g, '％');
}

function firstExisting(paths) {
    for (const p of paths) if (fs.existsSync(p)) return p;
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

const CUSTOM_FONT_DIR = '/usr/share/fonts/truetype/custom';
function resolveNamedFont(names) {
    for (const name of names) {
        const p = path.join(CUSTOM_FONT_DIR, name);
        if (fs.existsSync(p)) return p;
    }
    return null;
}

const TIME_FONT = resolveNamedFont(['Century.ttf', 'CENTURY.TTF', 'Century Regular.ttf']) || FALLBACK_BOLD;
const TITLE_FONT = resolveNamedFont(['CenturyGothic.ttf', 'GOTHIC.TTF', 'Century Gothic.ttf']) || FALLBACK_REGULAR;
const CATEGORY_FONT = resolveNamedFont(['CenturyGothicBold.ttf', 'GOTHICB.TTF', 'Century Gothic Bold.ttf']) || FALLBACK_BOLD;
const FONT_ARG = `fontfile='${FALLBACK_REGULAR}':`;

const GREEK_WEEKDAYS = ['Κυριακή','Δευτέρα','Τρίτη','Τετάρτη','Πέμπτη','Παρασκευή','Σάββατο'];

function atomicWriteTextFile(target, text) {
    const tmp = `${target}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, text, 'utf8');
    fs.renameSync(tmp, target);
}

function updateClockOverlayFiles() {
    const t = getGreekTime(new Date());
    const timeText = `${pad2(t.hour)}:${pad2(t.minute)}:${pad2(t.second)}`;
    const dateText = `${GREEK_WEEKDAYS[t.day]}  ${pad2(t.date)}/${pad2(t.month + 1)}/${t.year}`;
    try {
        // Atomic rename prevents FFmpeg reload=1 from ever reading a half-written/empty file.
        atomicWriteTextFile(CLOCK_TIME_FILE, timeText);
        atomicWriteTextFile(CLOCK_DATE_FILE, dateText);
    } catch (error) {
        console.error('[CLOCK FILE ERROR]', error.message);
    }
}

function startClockOverlayWriter() {
    updateClockOverlayFiles();
    if (clockWriterTimer) clearInterval(clockWriterTimer);
    clockWriterTimer = setInterval(updateClockOverlayFiles, 1000);
}

function selectBackgroundSpec(time = getGreekTime(), media = null) {
    // A queued/advertising visual wins over the normal station background.
    if (media?.visualFile) {
        const visual = String(media.visualFile);
        if (fs.existsSync(path.join(__dirname, visual))) {
            return { file: visual, nightFx: false, isVisual: true };
        }
    }

    const isDay = isDaytimeGreece(time); // ανατολή → δύση ηλίου Ελλάδος
    const preferred = isDay ? 'background_day' : 'background_night';
    const fallback = isDay ? 'background_night' : 'background_day';

    for (const ext of ['.jpg', '.jpeg', '.png', '.webp']) {
        const candidate = `${preferred}${ext}`;
        if (fs.existsSync(path.join(__dirname, candidate))) return { file: candidate, nightFx: false, isVisual: false };
    }

    // V6: if no dedicated night image exists, night mode is generated live with
    // a real colour grade instead of silently using the daytime background unchanged.
    for (const ext of ['.jpg', '.jpeg', '.png', '.webp']) {
        const candidate = `${fallback}${ext}`;
        if (fs.existsSync(path.join(__dirname, candidate))) return { file: candidate, nightFx: !isDay, isVisual: false };
    }

    for (const candidate of ['background.jpg','background.png']) {
        if (fs.existsSync(path.join(__dirname, candidate))) return { file: candidate, nightFx: !isDay, isVisual: false };
    }
    return null;
}

function getAudioDuration(filename) {
    const key = `${filename}`;
    if (durationCache.has(key)) return durationCache.get(key);
    try {
        const out = execFileSync('ffprobe', [
            '-v', 'error',
            '-show_entries', 'format=duration',
            '-of', 'default=noprint_wrappers=1:nokey=1',
            path.join(__dirname, filename)
        ], { encoding: 'utf8', timeout: 6000 }).trim();
        const duration = Number.parseFloat(out);
        const valid = Number.isFinite(duration) ? duration : null;
        durationCache.set(key, valid);
        return valid;
    } catch (_) {
        durationCache.set(key, null);
        return null;
    }
}

// ============================================================
// SITE/API COMPATIBILITY
// ============================================================
app.post('/api/request-song', async (req, res) => {
    const { song, requester, category, email, deviceId, vipCode } = req.body;
    if (!song || !requester || !deviceId) return res.status(400).json({ error: 'Λείπουν υποχρεωτικά πεδία.' });
    if (!supabase) return res.status(503).json({ error: 'Supabase not configured' });
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
        if (!data?.ok) return res.status(data?.code === 'cooldown' ? 429 : 400).json({ error: data?.message || 'Η παραγγελία δεν έγινε δεκτή.' });
        res.json({ success: true, isVip: !!data.is_vip });
    } catch (error) {
        console.error('[REQUEST API ERROR]', error.message);
        res.status(500).json({ error: 'Σφάλμα παραγγελίας' });
    }
});

app.get('/api/now-playing', (req, res) => res.json(currentNowPlaying));

// ============================================================
// SUPABASE SYNC / CACHES
// ============================================================
async function syncSongsToSupabase() {
    if (!supabase) return;
    try {
        const files = fs.readdirSync(__dirname);
        const catalogFiles = files
            .filter(f => isAudioFile(f) && !isSystemFile(f) && !hasTag(f, ...TAG.ADS))
            .sort((a, b) => a.localeCompare(b, 'el'));

        const syncedAt = new Date().toISOString();
        if (catalogFiles.length) {
            const { error } = await supabase.from('songs').upsert(
                catalogFiles.map(filename => ({ filename, synced_at: syncedAt })),
                { onConflict: 'filename' }
            );
            if (error) throw error;
        }

        const { data: dbSongs, error: listError } = await supabase.from('songs').select('filename');
        if (listError) throw listError;
        const local = new Set(catalogFiles);
        const stale = (dbSongs || []).map(r => r.filename).filter(Boolean).filter(f => !local.has(f));
        if (stale.length) {
            const { error } = await supabase.from('songs').delete().in('filename', stale);
            if (error) throw error;
        }

        categorySettingsCache.at = 0;
        songSettingsCache.at = 0;
        console.log(`[SUPABASE SYNC] ${catalogFiles.length} MP3/WAV διαθέσιμα για παραγγελίες. Οι (ΔΦ) διαφημίσεις εξαιρούνται από το site.`);
    } catch (error) {
        console.error('[SYNC ERROR]', error.message);
    }
}


function findVisualForAudio(filename) {
    const ext = path.extname(filename);
    const base = path.basename(filename, ext);
    const cleanBase = base.replace(/^\([^)]+\)\s*/, '').trim();
    const roots = ['', 'ads', 'images', 'visuals'];
    const names = [...new Set([base, cleanBase])];
    for (const root of roots) {
        for (const name of names) {
            for (const imageExt of ['.jpg', '.jpeg', '.png', '.webp']) {
                const rel = root ? path.join(root, `${name}${imageExt}`) : `${name}${imageExt}`;
                if (fs.existsSync(path.join(__dirname, rel))) return rel.replace(/\\/g, '/');
            }
        }
    }
    return null;
}

async function syncMediaCatalog() {
    if (!supabase) return;
    try {
        const files = fs.readdirSync(__dirname).filter(f => isAudioFile(f) && !isSystemFile(f));
        const syncedAt = new Date().toISOString();
        const rows = files.map(filename => ({
            filename,
            media_type: hasTag(filename, ...TAG.ADS) ? 'ad' : 'song',
            tag: extractTag(filename) || null,
            visual_file: findVisualForAudio(filename),
            is_active: true,
            synced_at: syncedAt
        }));

        if (rows.length) {
            const { error } = await supabase.from('station_media').upsert(rows, { onConflict: 'filename' });
            if (error) throw error;
        }

        const { data: dbRows, error: listError } = await supabase.from('station_media').select('filename');
        if (listError) throw listError;
        const local = new Set(files);
        const stale = (dbRows || []).map(r => r.filename).filter(Boolean).filter(f => !local.has(f));
        if (stale.length) {
            const { error } = await supabase.from('station_media').update({ is_active: false }).in('filename', stale);
            if (error) throw error;
        }
        console.log(`[MEDIA SYNC] ${rows.length} media files • songs + (ΔΦ) ads • optional visuals detected.`);
    } catch (error) {
        console.error('[MEDIA SYNC ERROR]', error.message);
    }
}

async function getMediaCatalogRow(filename) {
    if (!supabase || !filename) return null;
    try {
        const { data, error } = await supabase.from('station_media').select('*').eq('filename', filename).maybeSingle();
        if (error) throw error;
        return data || null;
    } catch (_) { return null; }
}

async function getCategorySettings(force = false) {
    if (!supabase) return new Map();
    if (!force && Date.now() - categorySettingsCache.at < 15000) return categorySettingsCache.map;
    try {
        const { data, error } = await supabase.from('category_settings').select('category_key,label,is_locked,lock_reason');
        if (error) throw error;
        categorySettingsCache = {
            at: Date.now(),
            map: new Map((data || []).map(row => [row.category_key, row]))
        };
    } catch (error) {
        console.error('[CATEGORY SETTINGS ERROR]', error.message);
    }
    return categorySettingsCache.map;
}

async function getSongSettings(force = false) {
    if (!supabase) return new Map();
    if (!force && Date.now() - songSettingsCache.at < 15000) return songSettingsCache.map;
    try {
        const { data, error } = await supabase.from('songs').select('filename,is_requestable,request_disabled_reason');
        if (error) throw error;
        songSettingsCache = {
            at: Date.now(),
            map: new Map((data || []).map(row => [row.filename, row]))
        };
    } catch (error) {
        console.error('[SONG SETTINGS ERROR]', error.message);
    }
    return songSettingsCache.map;
}

// ============================================================
// REQUESTS: invalid request is skipped ONCE, then continue
// ============================================================
const requestSkipLogged = new Set();

async function markRequestSkipped(id, reason, note = null) {
    if (!supabase) return false;
    const now = new Date().toISOString();
    const { data, error } = await supabase.from('song_requests').update({
        status: 'skipped', failure_reason: reason, admin_note: note,
        decided_at: now, claimed_at: null
    }).eq('id', id).in('status', ['pending', 'checking', 'reserved', 'playing']).select('id');
    if (error) {
        console.error(`[REQUEST SKIP ERROR #${id}] ${error.message}`);
        return false;
    }
    if (!requestSkipLogged.has(id)) {
        requestSkipLogged.add(id);
        console.log(`[REQUEST SKIP #${id}] ${reason}${note ? ` — ${note}` : ''}`);
    }
    return !!data?.length;
}

async function recoverStaleRequests() {
    if (!supabase) return;
    const staleBefore = new Date(Date.now() - 15 * 60 * 1000).toISOString();
    const { error } = await supabase.from('song_requests').update({
        status: 'pending', claimed_at: null, decided_at: null
    }).in('status', ['checking', 'reserved', 'playing']).lt('claimed_at', staleBefore);
    if (error) console.error('[REQUEST RECOVERY ERROR]', error.message);
}

async function hasPendingRequestQuick() {
    if (!supabase) return false;
    try {
        const { data, error } = await supabase.from('song_requests').select('id').eq('status', 'pending').limit(1);
        if (error) throw error;
        return !!(data && data.length);
    } catch (_) { return false; }
}

async function sendRequestPlayingMail(media) {
    if (!media?.requestEmail || !process.env.EMAIL_USER || !process.env.EMAIL_PASS || media.requestMailSent) return;
    media.requestMailSent = true;
    transporter.sendMail({
        to: media.requestEmail,
        from: process.env.EMAIL_USER,
        subject: 'Το τραγούδι σας αναμεταδίδεται! 🎵',
        html: `<h2>Γεια σας!</h2><p>Το τραγούδι "${media.file}" μεταδίδεται τώρα στο Thavma Παλμός.</p>`
    }).catch(err => console.error('[EMAIL ERROR]', err.message));
}

async function activateRequestMedia(media) {
    if (!supabase || !media?.requestId || media.requestActivated) return true;
    const { data, error } = await supabase.from('song_requests').update({
        status: 'playing', failure_reason: null, decided_at: new Date().toISOString()
    }).eq('id', media.requestId).in('status', ['checking', 'reserved']).select('id');
    if (error) {
        console.error(`[REQUEST PLAY ERROR #${media.requestId}]`, error.message);
        return false;
    }
    if (!data?.length) return false;
    media.requestActivated = true;
    await sendRequestPlayingMail(media);
    return true;
}

async function rollbackReservedRequest(media) {
    if (!supabase || !media?.requestId || media.requestActivated) return;
    await supabase.from('song_requests').update({ status: 'pending', claimed_at: null, decided_at: null })
        .eq('id', media.requestId).eq('status', 'reserved');
}

async function checkSupabaseRequest({ reserveOnly = false } = {}) {
    if (!supabase) return null;
    try {
        const { data, error } = await supabase.from('song_requests').select('*')
            .eq('status', 'pending').order('created_at', { ascending: true }).limit(25);
        if (error || !data?.length) return null;

        const files = fs.readdirSync(__dirname);
        const fileMap = new Map(files.filter(isAudioFile).map(f => [f.toLowerCase(), f]));
        const categorySettings = await getCategorySettings();
        const songSettings = await getSongSettings();
        const time = getGreekTime();

        for (const request of data) {
            const claimedAt = new Date().toISOString();
            const { data: claimRows, error: claimError } = await supabase.from('song_requests')
                .update({ status: reserveOnly ? 'reserved' : 'checking', claimed_at: claimedAt, failure_reason: null })
                .eq('id', request.id).eq('status', 'pending').select('*');
            if (claimError) { console.error(`[REQUEST CLAIM ERROR #${request.id}] ${claimError.message}`); continue; }
            if (!claimRows?.length) continue;

            const claimedRequest = claimRows[0];
            const category = extractTag(claimedRequest.song) || claimedRequest.category || '';
            const categoryRow = categorySettings.get(category);
            const songRow = songSettings.get(claimedRequest.song);

            if (categoryRow?.is_locked) {
                await markRequestSkipped(claimedRequest.id, 'category_locked', categoryRow.lock_reason || 'Η κατηγορία κλειδώθηκε από admin.');
                continue;
            }
            if (category === 'X' && !isChristmasPeriod(time.month, time.date)) {
                await markRequestSkipped(claimedRequest.id, 'out_of_season', 'Χριστουγεννιάτικο εκτός εορταστικής περιόδου.');
                continue;
            }
            if (!songRow || songRow.is_requestable === false) {
                await markRequestSkipped(claimedRequest.id, 'song_blocked', 'Το τραγούδι αφαιρέθηκε από τις παραγγελίες.');
                continue;
            }
            const match = fileMap.get(String(claimedRequest.song || '').toLowerCase());
            if (!match) {
                await markRequestSkipped(claimedRequest.id, 'not_found', 'Το αρχείο δεν υπάρχει στον ενεργό broadcaster.');
                continue;
            }

            const media = {
                file: match,
                title: cleanDisplayTitle(match),
                genreLabel: `Παραγγελία Ακροατή [${claimedRequest.requester}]`,
                isSong: true, isRequest: true,
                requestId: claimedRequest.id,
                requestEmail: claimedRequest.email || null,
                requestActivated: false,
                crossfadeEligible: true
            };

            if (!reserveOnly) {
                const ok = await activateRequestMedia(media);
                if (!ok) continue;
            }
            console.log(`[LIVE REQUEST #${claimedRequest.id}] ${match} από ${claimedRequest.requester}${reserveOnly ? ' • reserved for crossfade' : ''}`);
            return media;
        }
        return null;
    } catch (error) {
        console.error('[REQUEST CHECK ERROR]', error.message);
        return null;
    }
}

// ============================================================
// ADMIN MANUAL QUEUE
// ============================================================
async function recoverStaleQueue() {
    if (!supabase) return;
    const staleBefore = new Date(Date.now() - 15 * 60 * 1000).toISOString();
    const { error } = await supabase.from('station_queue').update({
        status: 'queued', reserved_at: null, started_at: null
    }).in('status', ['reserved', 'playing']).lt('reserved_at', staleBefore);
    if (error) console.error('[QUEUE RECOVERY ERROR]', error.message);
}

async function activateQueueMedia(media) {
    if (!supabase || !media?.queueId || media.queueActivated) return true;
    const { data, error } = await supabase.from('station_queue').update({
        status: 'playing', started_at: new Date().toISOString()
    }).eq('id', media.queueId).eq('status', 'reserved').select('id');
    if (error) { console.error(`[QUEUE PLAY ERROR #${media.queueId}]`, error.message); return false; }
    if (!data?.length) return false;
    media.queueActivated = true;
    return true;
}

async function rollbackReservedQueue(media) {
    if (!supabase || !media?.queueId || media.queueActivated) return;
    await supabase.from('station_queue').update({ status: 'queued', reserved_at: null, started_at: null })
        .eq('id', media.queueId).eq('status', 'reserved');
}

async function checkManualQueue({ reserveOnly = false } = {}) {
    if (!supabase) return null;
    try {
        const { data, error } = await supabase.from('station_queue').select('*')
            .eq('status', 'queued').order('sort_order', { ascending: true }).order('created_at', { ascending: true }).limit(10);
        if (error || !data?.length) return null;
        for (const row of data) {
            const { data: claimed, error: claimError } = await supabase.from('station_queue').update({
                status: 'reserved', reserved_at: new Date().toISOString()
            }).eq('id', row.id).eq('status', 'queued').select('*');
            if (claimError || !claimed?.length) continue;
            const item = claimed[0];
            if (!fs.existsSync(path.join(__dirname, item.filename)) || !isAudioFile(item.filename)) {
                await supabase.from('station_queue').update({ status: 'skipped', note: 'missing_file', played_at: new Date().toISOString() }).eq('id', item.id);
                console.log(`[QUEUE SKIP #${item.id}] missing_file ${item.filename}`);
                continue;
            }
            const media = {
                file: item.filename,
                title: cleanDisplayTitle(item.filename),
                genreLabel: item.media_type === 'ad' ? 'Διαφημιστικό Διάλειμμα' : 'Mix',
                isSong: item.media_type !== 'ad',
                isAd: item.media_type === 'ad',
                isManualQueue: true,
                queueId: item.id,
                queueActivated: false,
                visualFile: item.visual_file || findVisualForAudio(item.filename),
                crossfadeEligible: true
            };
            if (!reserveOnly) {
                const ok = await activateQueueMedia(media);
                if (!ok) continue;
            }
            console.log(`[ADMIN QUEUE #${item.id}] ${item.filename}${reserveOnly ? ' • reserved for crossfade' : ''}`);
            return media;
        }
        return null;
    } catch (error) {
        console.error('[QUEUE ERROR]', error.message);
        return null;
    }
}

async function rollbackReservedMedia(media) {
    if (!media) return;
    await rollbackReservedRequest(media);
    await rollbackReservedQueue(media);
}

async function activateReservedMedia(media) {
    if (!media) return true;
    if (media.requestId && !(await activateRequestMedia(media))) return false;
    if (media.queueId && !(await activateQueueMedia(media))) return false;
    return true;
}

// ============================================================
// ROTATION / HISTORY
// ============================================================
async function getRecentPlayedFilenames(limit = 5) {
    if (!supabase) return [];
    try {
        const { data, error } = await supabase.from('play_history').select('filename').order('played_at', { ascending: false }).limit(limit);
        if (error) throw error;
        return [...new Set((data || []).map(r => r.filename).filter(Boolean))];
    } catch (_) { return []; }
}

// Fallback μνήμης αν το Supabase δεν απαντά.
const memoryCycle = new Map();

// Κύκλος ανά κατηγορία: κανένα τραγούδι δεν ξαναπαίζει μέχρι να παιχτούν
// όλα τα τραγούδια της κατηγορίας. Η κατάσταση υπολογίζεται από το
// play_history στο Supabase, άρα επιβιώνει των restarts του workflow.
async function claimRotationSong(rotationKey, candidates) {
    const pool = [...new Set((candidates || []).filter(Boolean))];
    if (!pool.length) return null;
    const inPool = new Set(pool);

    let played = new Set();
    let lastPlayed = null;
    let loaded = false;

    if (supabase) {
        try {
            const { data, error } = await supabase.from('play_history')
                .select('filename')
                .eq('rotation_key', rotationKey)
                .order('played_at', { ascending: false })
                .limit(Math.max(1000, pool.length * 3));
            if (error) throw error;

            // Επανάληψη της ιστορίας από το παλιότερο στο νεότερο
            for (const row of (data || []).reverse()) {
                const f = row.filename;
                if (!inPool.has(f)) continue;
                if (played.has(f)) played = new Set();            // επανάληψη => νέος κύκλος
                played.add(f);
                lastPlayed = f;
                if (played.size >= pool.length) played = new Set(); // ο κύκλος ολοκληρώθηκε
            }
            loaded = true;
        } catch (error) {
            console.error(`[ROTATION ERROR ${rotationKey}]`, error.message);
        }
    }

    if (!loaded) {
        const mem = memoryCycle.get(rotationKey) || { played: new Set(), last: null };
        played = new Set([...mem.played].filter(f => inPool.has(f)));
        lastPlayed = mem.last;
    }

    let remaining = pool.filter(f => !played.has(f));
    if (!remaining.length) remaining = pool;
    if (!played.size && pool.length > 1 && lastPlayed) {
        // Μόλις ξεκινά νέος κύκλος: να μην παίξει αμέσως το ίδιο τραγούδι
        remaining = remaining.filter(f => f !== lastPlayed);
    }

    const pick = shuffleArray([...remaining])[0] || null;

    if (!loaded && pick) {
        const mem = memoryCycle.get(rotationKey) || { played: new Set(), last: null };
        mem.played.add(pick);
        if (mem.played.size >= pool.length) mem.played = new Set();
        mem.last = pick;
        memoryCycle.set(rotationKey, mem);
    }
    return pick;
}

async function logPlayHistory(filename, rotationKey = null, source = 'auto') {
    if (!supabase || !filename) return;
    const { error } = await supabase.from('play_history').insert([{ filename, rotation_key: rotationKey, source, played_at: new Date().toISOString() }]);
    if (error) console.error('[HISTORY LOG ERROR]', error.message);
}

// ============================================================
// NEW YEAR REAL + ADMIN TEST
// ============================================================
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

function buildNewYearSpecialSequence(label = 'Πρωτοχρονιάτικη Ακολουθία') {
    const seq = [];
    const clock0 = findHourFile(0);
    if (clock0) seq.push({ file: clock0, title: 'Η ώρα είναι 00.00', genreLabel: label, isHourAnnouncement: true, isSystem: true });

    const bases = ['ΚαλήΧρονιά'];
    const xmasJingle = findNamedAudio('xmas_thavma_palmos_jingle') || findNamedAudio('thavma_palmos_christmas_jingle');
    for (const base of bases) {
        const f = findNamedAudio(base);
        if (f) seq.push({ file: f, title: cleanDisplayTitle(f), genreLabel: label, isSystem: true });
    }
    if (xmasJingle) seq.push({ file: xmasJingle, title: cleanDisplayTitle(xmasJingle), genreLabel: label, isSystem: true });
    const carol = findNamedAudio('Αρχιμηνιά και Αρχιχρονιά το λάδι 19');
    if (carol) seq.push({ file: carol, title: cleanDisplayTitle(carol), genreLabel: label, isSystem: true });
    return seq;
}

async function prepareRealNewYearSequence(time) {
    if (!(time.month === 0 && time.date === 1 && time.hour === 0 && time.minute < 15)) return;
    if (newYearQueue.length) return;
    const eventKey = `newyear-${time.year}`;
    if (lastNewYearSequenceKey === eventKey) return;
    const claimed = await claimStationEvent(eventKey);
    lastNewYearSequenceKey = eventKey;
    if (!claimed) return;

    newYearQueue = buildNewYearSpecialSequence();
    lastAnnouncedHour = 0;
    lastAnthemDate = time.date;
    songCounter = 0;
    console.log(`[NEW YEAR] Προγραμματίστηκε η πραγματική ακολουθία ${eventKey}.`);
}

function chooseCountdownTestAudio() {
    const files = fs.readdirSync(__dirname)
        .filter(f => isAudioFile(f) && !isSystemFile(f) && !hasTag(f, ...TAG.ADS));
    return files[0] || findNamedAudio('thavma_palmos_jingle') || null;
}

async function finishAdminCommand(id, result = 'ok') {
    if (!supabase || !id) return;
    await supabase.from('station_commands').update({
        status: 'processed', processed_at: new Date().toISOString(), result
    }).eq('id', id);
}

async function beginForcedNewYearTest(commandId, source = 'admin') {
    if (forcedNewYearTest) return;
    forcedNewYearTest = { commandId, source, phase: 'countdown_pending' };
    forcedNewYearTestQueue = [];
    if (pendingCrossfadeMedia) { await restorePendingCrossfadeAfterAbort(pendingCrossfadeMedia); pendingCrossfadeMedia = null; }
    console.log(`[NEW YEAR TEST] Ενεργοποιήθηκε από ${source}.`);

    if (currentFfmpegProcess) {
        intentionalStopReason = 'newyear_test';
        currentFfmpegProcess.kill('SIGTERM');
    }
}

async function pollAdminCommands() {
    if (!supabase || isShuttingDown || forcedNewYearTest) return;
    try {
        const { data, error } = await supabase.from('station_commands')
            .select('*').eq('status', 'pending').order('created_at', { ascending: true }).limit(1);
        if (error) throw error;
        if (!data || !data.length) return;
        const cmd = data[0];

        if (cmd.command === 'test_newyear') {
            const { data: claimed, error: claimError } = await supabase.from('station_commands')
                .update({ status: 'running', started_at: new Date().toISOString() })
                .eq('id', cmd.id).eq('status', 'pending').select('id');
            if (claimError) throw claimError;
            if (claimed && claimed.length) await beginForcedNewYearTest(cmd.id, 'admin panel');
        } else {
            await finishAdminCommand(cmd.id, `unknown command: ${cmd.command}`);
        }
    } catch (error) {
        console.error('[ADMIN COMMAND ERROR]', error.message);
    }
}

async function hasPendingAdminCommandQuick() {
    if (!supabase) return false;
    try {
        const { data, error } = await supabase.from('station_commands').select('id').eq('status', 'pending').limit(1);
        if (error) throw error;
        return !!(data && data.length);
    } catch (_) { return false; }
}

// ============================================================
// MEDIA SELECTION
// ============================================================
function isNewYearXBoostWindow(month, date, hour) {
    return month === 0 && date === 1 && hour >= 0 && hour < 2;
}

async function selectAutoProgramMedia() {
    const time = getGreekTime();
    const files = fs.readdirSync(__dirname);
    const programFiles = files.filter(f => isAudioFile(f) && !isSystemFile(f));
    const adFiles = programFiles.filter(f => hasTag(f, ...TAG.ADS));
    const musicFiles = programFiles.filter(f => !hasTag(f, ...TAG.ADS));
    const xFiles = musicFiles.filter(f => hasTag(f, ...TAG.CHRISTMAS));
    const normalPool = musicFiles.filter(f => !hasTag(f, ...TAG.CHRISTMAS));

    if (songsSinceAd >= AD_EVERY_SONGS && adFiles.length) {
        const ad = await claimRotationSong('ADS', adFiles);
        if (ad) {
            await logPlayHistory(ad, 'ADS', 'ad');
            const row = await getMediaCatalogRow(ad);
            return {
                file: ad, title: cleanDisplayTitle(ad), genreLabel: 'Διαφημιστικό Διάλειμμα',
                isAd: true, rotationKey: 'ADS', visualFile: row?.visual_file || findVisualForAudio(ad),
                crossfadeEligible: true
            };
        }
    }

    let genre = getRequiredGenre();
    let filtered = [];
    let rotationKey = 'MIX';
    let genreLabel = 'Mix';

    if (genre === 'B') {
        filtered = normalPool.filter(f => hasTag(f, ...TAG.BEATS));
        rotationKey = 'B'; genreLabel = 'Beats (Disco, Dance, Club)';
    } else if (genre === 'R') {
        filtered = normalPool.filter(f => hasTag(f, ...TAG.RADIO));
        rotationKey = 'R'; genreLabel = 'Radio (Κανονική Ροή)';
    } else if (genre === 'P_LZ') {
        filtered = normalPool.filter(f => hasTag(f, ...TAG.PARADOSIAKA) || hasTag(f, ...TAG.LAIKA_ZEIMBEKIKA));
        rotationKey = 'P_LZ'; genreLabel = 'Παραδοσιακά & Ζεϊμπέκικα-Λαϊκά';
    } else if (genre === 'P') {
        filtered = normalPool.filter(f => hasTag(f, ...TAG.PARADOSIAKA));
        rotationKey = 'P'; genreLabel = 'Παραδοσιακά';
    } else if (genre === 'LZ') {
        filtered = normalPool.filter(f => hasTag(f, ...TAG.LAIKA_ZEIMBEKIKA));
        rotationKey = 'LZ'; genreLabel = 'Ζεϊμπέκικα-Λαϊκά';
    } else if (genre === 'EASTER_MODE') {
        const easter = normalPool.filter(f => hasTag(f, ...TAG.PARADOSIAKA) || hasTag(f, ...TAG.LAIKA_ZEIMBEKIKA));
        if (easter.length && Math.random() < 0.20) {
            filtered = easter; rotationKey = 'P_LZ'; genreLabel = 'Πασχαλινό Πρόγραμμα (Έμφαση στα Παραδοσιακά)';
        } else {
            filtered = normalPool; rotationKey = 'MIX'; genreLabel = 'Πασχαλινό Πρόγραμμα (Mix)';
        }
    } else if (genre === 'WEEKEND_MIX') {
        // Σαββατοκύριακο: Mix μόνο από Beat (B), Radio (R) και Λαϊκά-Ζεϊμπέκικα (ΛΖ)
        filtered = normalPool.filter(f => hasTag(f, ...TAG.BEATS) || hasTag(f, ...TAG.RADIO) || hasTag(f, ...TAG.LAIKA_ZEIMBEKIKA));
        rotationKey = 'WMIX'; genreLabel = 'Mix';
    } else {
        filtered = normalPool; rotationKey = 'MIX'; genreLabel = 'Mix';
    }

    if (!filtered.length) {
        filtered = normalPool.length ? normalPool : musicFiles;
        rotationKey = 'MIX'; genreLabel = 'Mix';
    }

    // 17/11 - 31/1, εκτός 22:00-08:00: 1 Χριστουγεννιάτικο ανά 4 τραγούδια άλλου είδους.
    if (isXmasSongWindow(time) && xFiles.length && songsSinceXmas >= XMAS_EVERY_SONGS) {
        filtered = xFiles; rotationKey = 'X'; genreLabel = 'Χριστουγεννιάτικο Πρόγραμμα (X)';
    }

    const file = await claimRotationSong(rotationKey, filtered);
    if (!file) return null;
    await logPlayHistory(file, rotationKey, 'auto');
    return {
        file, title: cleanDisplayTitle(file), genreLabel,
        isSong: true, rotationKey, candidatePool: filtered,
        crossfadeEligible: true
    };
}

async function selectNextFile() {
    const time = getGreekTime();

    if (forcedNewYearTest) {
        if (forcedNewYearTest.phase === 'countdown_pending') {
            const file = chooseCountdownTestAudio();
            if (!file) {
                await finishAdminCommand(forcedNewYearTest.commandId, 'No audio file available for test');
                forcedNewYearTest = null;
            } else {
                forcedNewYearTest.phase = 'countdown_running';
                return { file, title: 'TEST ΑΝΤΙΣΤΡΟΦΗΣ ΜΕΤΡΗΣΗΣ', genreLabel: 'TEST Πρωτοχρονιάς', isSystem: true, isNewYearTestCountdown: true, crossfadeEligible: false };
            }
        }
        if (forcedNewYearTest && forcedNewYearTest.phase === 'sequence') {
            if (forcedNewYearTestQueue.length) return forcedNewYearTestQueue.shift();
            await finishAdminCommand(forcedNewYearTest.commandId, 'New Year test completed');
            console.log('[NEW YEAR TEST] Ολοκληρώθηκε. Επιστροφή στην κανονική ροή.');
            forcedNewYearTest = null;
        }
    }

    await prepareRealNewYearSequence(time);
    if (newYearQueue.length) return newYearQueue.shift();

    if (time.hour === 0 && lastAnthemDate !== time.date) {
        const anthem = findNamedAudio('ethnikos_ymnos');
        if (anthem) {
            lastAnthemDate = time.date;
            return { file: anthem, title: 'ΕΘΝΙΚΟΣ ΥΜΝΟΣ', genreLabel: 'Ειδική Μετάδοση', isSystem: true, isAnthem: true, crossfadeEligible: false };
        }
    }

    if (lastAnnouncedHour !== time.hour) {
        const hourFile = findHourFile(time.hour);
        if (hourFile) {
            lastAnnouncedHour = time.hour;
            songCounter = 0;
            return { file: hourFile, title: `Η ώρα είναι ${pad2(time.hour)}.00`, genreLabel: 'Ώρα Ελλάδος', isHourAnnouncement: true, isSystem: true, crossfadeEligible: false };
        }
    }

    if (songCounter >= 5) {
        const christmasActive = isChristmasPeriod(time.month, time.date);
        const jingle = christmasActive
            ? (findNamedAudio('xmas_thavma_palmos_jingle') || findNamedAudio('thavma_palmos_jingle'))
            : findNamedAudio('thavma_palmos_jingle');
        if (jingle) {
            songCounter = 0;
            return {
                file: jingle,
                title: christmasActive && path.basename(jingle).startsWith('xmas_') ? 'Thavma Παλμός Xmas Jingle' : 'Thavma Παλμός Jingle',
                genreLabel: christmasActive ? 'Χριστουγεννιάτικο Σήμα Σταθμού' : 'Σήμα Σταθμού',
                isSystem: true, isJingle: true, crossfadeEligible: false
            };
        }
    }

    // The next media has already been heard for the first CROSSFADE_SECONDS in
    // the previous ffmpeg process. Continue from that exact offset.
    if (pendingCrossfadeMedia) {
        const media = pendingCrossfadeMedia;
        pendingCrossfadeMedia = null;
        return media;
    }

    const manual = await checkManualQueue();
    if (manual) return manual;

    const request = await checkSupabaseRequest();
    if (request) return request;

    return selectAutoProgramMedia();
}

function crossesHourBoundary(spawnTime, remainingSeconds) {
    if (!Number.isFinite(remainingSeconds) || remainingSeconds <= 0) return true;
    const end = getGreekTime(new Date(spawnTime.raw.getTime() + remainingSeconds * 1000));
    return end.year !== spawnTime.year || end.month !== spawnTime.month ||
        end.date !== spawnTime.date || end.hour !== spawnTime.hour;
}

async function selectCrossfadeNextMedia() {
    // Manual sequencing has highest musical priority, then listener requests,
    // then the normal automatic schedule / ads.
    const manual = await checkManualQueue({ reserveOnly: true });
    if (manual) return manual;
    const request = await checkSupabaseRequest({ reserveOnly: true });
    if (request) return request;
    return selectAutoProgramMedia();
}

async function maybePrepareCrossfade(media, spawnTime) {
    if (CROSSFADE_SECONDS <= 0) return;
    if (!media || media.isSystem || media.isHourAnnouncement || media.isAnthem || media.isJingle || media.isNewYearTestCountdown) return;
    if (media.crossfadeEligible === false) return;
    if (!isAudioFile(media.file)) return;
    if (songCounter >= 5) return; // next item must be station jingle
    if (await hasPendingAdminCommandQuick()) return;

    const duration = getAudioDuration(media.file);
    const resumeOffset = Number(media.resumeOffsetSec || 0);
    const remaining = duration ? duration - resumeOffset : null;
    if (!remaining || remaining <= CROSSFADE_SECONDS + 4) return;
    if (crossesHourBoundary(spawnTime, remaining)) return; // the hour / anthem must be clean
    if (spawnTime.month === 11 && spawnTime.date === 31 && spawnTime.hour === 23) return;

    const next = await selectCrossfadeNextMedia();
    if (!next) return;
    if (next.isSystem || next.isHourAnnouncement || next.isAnthem || next.isJingle) {
        await rollbackReservedMedia(next);
        return;
    }
    const nextDuration = getAudioDuration(next.file);
    if (!nextDuration || nextDuration <= CROSSFADE_SECONDS + 2) {
        await rollbackReservedMedia(next);
        return;
    }

    next.resumeOffsetSec = CROSSFADE_SECONDS;
    next.wasCrossfaded = true;
    media.crossfadeNext = next;
    pendingCrossfadeMedia = next;
    console.log(`[CROSSFADE] ${media.title} -> ${next.title} (${CROSSFADE_SECONDS}s)`);
}

// ============================================================
// COUNTDOWN VIDEO FILTERS
// ============================================================
function athensTargetDate(spawnTime, daysFromNow, hour, minute, second) {
    const day = new Date(Date.UTC(spawnTime.year, spawnTime.month, spawnTime.date + daysFromNow));
    return athensWallToDate(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), hour, minute, second);
}
function secondsFromNowTo(spawnTime, targetDate) { return (targetDate - spawnTime.raw) / 1000; }

function buildCountdownFromOffsets({ off2350, off2359, off235950, offMidnight, nyEnd, nextYear }) {
    const filters = [];
    const remainingExpr = `(${offMidnight.toFixed(2)}-t)`;

    if (off2359 > 0) {
        const mmssText = `%{eif\\:trunc(${remainingExpr}/60)\\:d\\:2}\\:%{eif\\:mod(trunc(${remainingExpr})\\,60)\\:d\\:2}`;
        filters.push(`drawtext=${FONT_ARG}text='${mmssText}':x=(w-text_w)/2:y=90:fontsize=68:fontcolor=0xFFD700:box=1:boxcolor=black@0.58:boxborderw=14:enable='between(t\\,${Math.max(0, off2350).toFixed(2)}\\,${off2359.toFixed(2)})'`);
    }

    if (off235950 > 0) {
        const secText = `%{eif\\:ceil(${remainingExpr})\\:d\\:2}`;
        filters.push(`drawtext=${FONT_ARG}text='${secText}':x=(w-text_w)/2:y=(h-text_h)/2:fontsize=145:fontcolor=0xFFD700:box=1:boxcolor=black@0.45:boxborderw=18:enable='between(t\\,${Math.max(0, off2359).toFixed(2)}\\,${off235950.toFixed(2)})'`);
    }

    if (offMidnight > 0) {
        const lastText = `%{eif\\:ceil(${remainingExpr})\\:d}`;
        filters.push(`drawtext=${FONT_ARG}text='${lastText}':x=(w-text_w)/2:y=(h-text_h)/2:fontsize=220:fontcolor=0xFFD700:enable='between(t\\,${Math.max(0, off235950).toFixed(2)}\\,${offMidnight.toFixed(2)})'`);
    }

    const nyText = `Καλή Χρονιά ${nextYear}!`;
    if (nyEnd > 0) {
        filters.push(`drawtext=${FONT_ARG}text='${nyText}':x=(w-text_w)/2:y=(h-text_h)/2:fontsize=100:fontcolor=0xFFD700:box=1:boxcolor=black@0.55:boxborderw=18:enable='between(t\\,${Math.max(0, offMidnight).toFixed(2)}\\,${nyEnd.toFixed(2)})'`);
    }

    return {
        filters,
        blackoutStart: off235950,
        blackoutEnd: nyEnd,
        suppressNormalOverlayFrom: off235950,
        suppressNormalOverlayUntil: nyEnd,
        testEnd: null
    };
}

function buildNewYearCountdownFilters(spawnTime, forceTest = false) {
    if (forceTest) {
        const x = buildCountdownFromOffsets({
            off2350: 5, off2359: 25, off235950: 35, offMidnight: 45, nyEnd: 60,
            nextYear: spawnTime.year + 1
        });
        x.testEnd = 60;
        return x;
    }

    const isDec31Window = spawnTime.month === 11 && spawnTime.date === 31 && spawnTime.hour === 23 && spawnTime.minute >= 40;
    const isEarlyJan1 = spawnTime.month === 0 && spawnTime.date === 1 && spawnTime.hour === 0 && spawnTime.minute === 0 && spawnTime.second < 20;
    if (!isDec31Window && !isEarlyJan1) {
        return { filters: [], blackoutStart: null, blackoutEnd: null, suppressNormalOverlayFrom: null, suppressNormalOverlayUntil: null, testEnd: null };
    }

    if (isEarlyJan1) {
        const midnight = athensTargetDate(spawnTime, 0, 0, 0, 0);
        const offMidnight = secondsFromNowTo(spawnTime, midnight);
        return buildCountdownFromOffsets({ off2350: -999, off2359: -999, off235950: -999, offMidnight, nyEnd: offMidnight + 15, nextYear: spawnTime.year });
    }

    const target2350 = athensTargetDate(spawnTime, 0, 23, 50, 0);
    const target2359 = athensTargetDate(spawnTime, 0, 23, 59, 0);
    const target235950 = athensTargetDate(spawnTime, 0, 23, 59, 50);
    const targetMidnight = athensTargetDate(spawnTime, 1, 0, 0, 0);
    return buildCountdownFromOffsets({
        off2350: secondsFromNowTo(spawnTime, target2350),
        off2359: secondsFromNowTo(spawnTime, target2359),
        off235950: secondsFromNowTo(spawnTime, target235950),
        offMidnight: secondsFromNowTo(spawnTime, targetMidnight),
        nyEnd: secondsFromNowTo(spawnTime, targetMidnight) + 15,
        nextYear: spawnTime.year + 1
    });
}

function secondsUntilNewYearMidnight(spawnTime) {
    if (!(spawnTime.month === 11 && spawnTime.date === 31 && spawnTime.hour === 23 && spawnTime.minute >= 40)) return null;
    return Math.max(0, secondsFromNowTo(spawnTime, athensTargetDate(spawnTime, 1, 0, 0, 0)));
}

// ============================================================
// STATUS / FFMPEG
// ============================================================
async function updateStationStatus(title, genre) {
    currentNowPlaying = { title, genre };
    if (!supabase) return;
    try {
        const now = new Date().toISOString();
        const { error } = await supabase.from('station_status').upsert({
            id: 1, title, genre, updated_at: now, heartbeat_at: now, stream_owner: STREAM_OWNER_ID
        });
        if (error) console.error('[STATUS ERROR]', error.message);
    } catch (e) {
        console.error('[STATUS ERROR]', e.message);
    }
}

async function restorePendingCrossfadeAfterAbort(media) {
    if (!supabase || !media) return;
    try {
        if (media.requestId) {
            await supabase.from('song_requests').update({ status: 'pending', claimed_at: null, decided_at: null })
                .eq('id', media.requestId).in('status', ['reserved', 'playing']);
            media.requestActivated = false;
        }
        if (media.queueId) {
            await supabase.from('station_queue').update({ status: 'queued', reserved_at: null, started_at: null })
                .eq('id', media.queueId).in('status', ['reserved', 'playing']);
            media.queueActivated = false;
        }
    } catch (error) {
        console.error('[CROSSFADE ROLLBACK ERROR]', error.message);
    }
}

async function finalizePlayedMedia(media, code, intentional) {
    if (!supabase || !media) return;
    if (media.requestId) {
        if (code === 0 && !intentional) {
            await supabase.from('song_requests').update({ status: 'played', claimed_at: null, failure_reason: null }).eq('id', media.requestId);
        } else if (intentional) {
            await supabase.from('song_requests').update({ status: 'pending', claimed_at: null, decided_at: null }).eq('id', media.requestId);
        } else {
            await markRequestSkipped(media.requestId, 'playback_error', `FFmpeg code ${code ?? 'unknown'}`);
        }
    }
    if (media.queueId) {
        if (code === 0 && !intentional) {
            await supabase.from('station_queue').update({ status: 'played', played_at: new Date().toISOString() }).eq('id', media.queueId);
        } else if (intentional) {
            await supabase.from('station_queue').update({ status: 'queued', reserved_at: null, started_at: null }).eq('id', media.queueId);
        } else {
            await supabase.from('station_queue').update({ status: 'skipped', note: `playback_error_${code ?? 'unknown'}`, played_at: new Date().toISOString() }).eq('id', media.queueId);
        }
    }
}

// Wrapper: ό,τι σφάλμα κι αν συμβεί (Supabase, δίκτυο, ffprobe κ.λπ.) η αλυσίδα
// ΔΕΝ πεθαίνει ποτέ, ξαναδοκιμάζει μετά από λίγο.
async function startNextMedia() {
    if (isShuttingDown || (supabase && !ownsStreamLease)) return;
    if (currentFfmpegProcess) return;
    if (PERSISTENT_ENCODER) { await enginePump(); return; }
    if (isStartingMedia) return;
    isStartingMedia = true;
    lastChainActivityAt = Date.now();
    try {
        await startNextMediaInner();
    } catch (error) {
        console.error('[START MEDIA ERROR]', error && error.stack ? error.stack : error);
        if (!isShuttingDown && (!supabase || ownsStreamLease)) setTimeout(startNextMedia, 3000);
    } finally {
        isStartingMedia = false;
        lastChainActivityAt = Date.now();
    }
}

// Εποπτεία: αν δεν παίζει τίποτα και η αλυσίδα έχει "σωπάσει", την ξαναξεκινά.
function startChainWatchdog() {
    if (chainWatchdogTimer) clearInterval(chainWatchdogTimer);
    chainWatchdogTimer = setInterval(() => {
        if (isShuttingDown || (supabase && !ownsStreamLease)) return;
        if (currentFfmpegProcess || enc) { lastChainActivityAt = Date.now(); return; }
        if (enginePumping && Date.now() - enginePumpStartedAt > 60000) { enginePumping = false; }
        if (Date.now() - lastChainActivityAt > 45000) {
            console.error('[WATCHDOG] Δεν παίζει τίποτα για >45s. Επανεκκίνηση αλυσίδας.');
            isStartingMedia = false;
            lastChainActivityAt = Date.now();
            startNextMedia();
        }
    }, 10000);
}

async function startNextMediaInner(preselected = null) {
    const media = preselected || await selectNextFile();
    const spawnTime = getGreekTime();
    const bgSpec = selectBackgroundSpec(spawnTime, media);

    if (!media || !bgSpec || !fs.existsSync(path.join(__dirname, media.file))) {
        setTimeout(startNextMedia, 2000);
        return;
    }

    if (!(await activateReservedMedia(media))) {
        console.error('[MEDIA ACTIVATE] Η reserved εγγραφή δεν μπόρεσε να ενεργοποιηθεί. Προχωράμε παρακάτω.');
        setTimeout(startNextMedia, 700);
        return;
    }

    currentMedia = media;
    if (media.isHourAnnouncement) songCounter = 0;
    else if (media.isSong) songCounter++;
    if (media.isAd) songsSinceAd = 0;
    else if (media.isSong) songsSinceAd++;
    if (media.isSong) {
        if (media.rotationKey === 'X') songsSinceXmas = 0;
        else if (isXmasSongWindow(spawnTime)) songsSinceXmas++;
        else songsSinceXmas = 0; // εκτός ζώνης: ο μετρητής ξεκινά από το 0
    }

    await maybePrepareCrossfade(media, spawnTime);
    await updateStationStatus(media.title, media.genreLabel);

    const streamKey = process.env.YOUTUBE_STREAM_KEY;
    if (!streamKey) {
        console.error('[YOUTUBE ERROR] Λείπει YOUTUBE_STREAM_KEY.');
        setTimeout(startNextMedia, 5000);
        return;
    }

    const ny = buildNewYearCountdownFilters(spawnTime, !!media.isNewYearTestCountdown);
    const cleanLabel = escapeDrawtextText(media.genreLabel);
    const cleanTitle = escapeDrawtextText(media.title);

    let blackoutFilter = '';
    if (ny.blackoutStart !== null && ny.blackoutEnd !== null && ny.blackoutEnd > 0) {
        blackoutFilter = `,drawbox=x=0:y=0:w=iw:h=ih:color=black:t=fill:enable='between(t\\,${Math.max(0, ny.blackoutStart).toFixed(2)}\\,${ny.blackoutEnd.toFixed(2)})'`;
    }

    let normalOverlayEnable = '';
    if (ny.suppressNormalOverlayFrom !== null && ny.suppressNormalOverlayUntil !== null && ny.suppressNormalOverlayUntil > 0) {
        normalOverlayEnable = `:enable='not(between(t\\,${Math.max(0, ny.suppressNormalOverlayFrom).toFixed(2)}\\,${ny.suppressNormalOverlayUntil.toFixed(2)}))'`;
    }

    // V6: clock/date returns to the original visual language: transparent burgundy,
    // upper-left. Track/category move to the lower-left so they never collide.
    // Track/category: no semi-transparent box, black outline instead.
    const baseOverlayFilters =
        `drawtext=fontfile='${TIME_FONT}':textfile='${CLOCK_TIME_FILE}':reload=1:x=18:y=14:fontsize=26:fontcolor=0xFFD700@1.0:borderw=1:bordercolor=black@0.25,` +
        `drawtext=fontfile='${TIME_FONT}':textfile='${CLOCK_DATE_FILE}':reload=1:x=18:y=48:fontsize=14:fontcolor=0xFFD700@1.0:borderw=1:bordercolor=black@0.20,` +
        `drawtext=fontfile='${CATEGORY_FONT}':text='${cleanLabel}':x=18:y=h-58:fontsize=14:fontcolor=yellow:borderw=2:bordercolor=black${normalOverlayEnable},` +
        `drawtext=fontfile='${TITLE_FONT}':text='${cleanTitle}':x=18:y=h-34:fontsize=17:fontcolor=white:borderw=2:bordercolor=black${normalOverlayEnable}`;

    const countdownChain = ny.filters.length ? ',' + ny.filters.join(',') : '';
    const fitBase = bgSpec.isVisual
        ? `scale=854:480:force_original_aspect_ratio=decrease,pad=854:480:(ow-iw)/2:(oh-ih)/2:color=black`
        : `scale=854:480`;
    const nightGrade = bgSpec.nightFx
        ? `,eq=brightness=-0.28:contrast=1.12:saturation=0.66:gamma=0.84,colorbalance=bs=.16:bm=.08:rs=-.05,vignette=PI/5`
        : '';
    const vfChain = `${fitBase}${nightGrade}${blackoutFilter},${baseOverlayFilters}${countdownChain}`;

    // Αν κάποια παλιά (κολλημένη) προσπάθεια είχε ήδη ξεκινήσει encoder, μην ξεκινήσεις δεύτερο.
    if (currentFfmpegProcess) return;

    const args = [
        '-hide_banner', '-loglevel', 'warning', '-nostats', '-progress', 'pipe:1',
        '-re', '-fflags', '+genpts',
        '-thread_queue_size', '1024',
        '-loop', '1', '-framerate', '15', '-i', bgSpec.file
    ];

    const resumeOffset = Number(media.resumeOffsetSec || 0);
    if (resumeOffset > 0) args.push('-ss', resumeOffset.toFixed(3));
    args.push('-thread_queue_size', '1024', '-i', media.file);

    if (media.crossfadeNext) {
        args.push('-t', (CROSSFADE_SECONDS + 0.35).toFixed(2), '-thread_queue_size', '1024', '-i', media.crossfadeNext.file);
        const audioFilter =
            `[1:a]aresample=44100,aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo,asetpts=PTS-STARTPTS[a1];` +
            `[2:a]atrim=start=0:end=${(CROSSFADE_SECONDS + 0.10).toFixed(3)},aresample=44100,aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo,asetpts=PTS-STARTPTS[a2];` +
            `[a1][a2]acrossfade=d=${CROSSFADE_SECONDS.toFixed(3)}:c1=tri:c2=tri[aout]`;
        args.push('-filter_complex', audioFilter, '-map', '0:v:0', '-map', '[aout]');
    } else {
        args.push('-map', '0:v:0', '-map', '1:a:0', '-af', 'aresample=async=1:first_pts=0');
    }

    args.push(
        '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'stillimage', '-threads', '2', '-bf', '0',
        '-vf', vfChain,
        // Σταθερό (CBR) bitrate + keyframe ανά 2s: ομαλότερη παραλαβή από το YouTube, λιγότερα "κολλήματα".
        '-r', '15', '-g', '30', '-keyint_min', '30', '-sc_threshold', '0',
        '-b:v', '1500k', '-minrate', '1500k', '-maxrate', '1500k', '-bufsize', '1500k',
        '-x264-params', 'nal-hrd=cbr:force-cfr=1',
        '-c:a', 'aac', '-b:a', '160k', '-ar', '44100', '-ac', '2',
        '-max_muxing_queue_size', '4096', '-shortest'
    );

    const cutAtMidnight = secondsUntilNewYearMidnight(spawnTime);
    if (media.isNewYearTestCountdown && ny.testEnd) args.push('-t', String(ny.testEnd));
    else if (cutAtMidnight !== null && cutAtMidnight > 0.25) args.push('-t', cutAtMidnight.toFixed(3));

    args.push('-pix_fmt', 'yuv420p', '-f', 'flv', `rtmp://a.rtmp.youtube.com/live2/${streamKey}`);

    console.log(`[PLAY] ${media.title} | ${media.genreLabel} | BG=${bgSpec.file}${bgSpec.nightFx ? ' [AUTO NIGHT]' : ''}${media.visualFile ? ' [VISUAL]' : ''}${media.crossfadeNext ? ` | crossfade->${media.crossfadeNext.title}` : ''}`);

    const ffmpeg = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    currentFfmpegProcess = ffmpeg;
    lastChainActivityAt = Date.now();
    let stderrTail = '';
    ffmpeg.stderr?.on('data', chunk => { stderrTail = (stderrTail + chunk.toString()).slice(-1600); });

    // Anti-stall: το -progress στέλνει στατιστικά κάθε ~0.5s. Αν σταματήσουν,
    // ο encoder είναι κολλημένος -> τον σκοτώνουμε και προχωράμε στο επόμενο.
    const startedAt = Date.now();
    let lastProgressAt = 0;
    let perf = { speed: null, drop: 0, dup: 0 };
    ffmpeg.stdout?.on('data', chunk => {
        lastProgressAt = Date.now();
        const text = chunk.toString();
        const sp = text.match(/speed=\s*([\d.]+)x/g);
        if (sp) perf.speed = parseFloat(sp[sp.length - 1].replace(/[^\d.]/g, ''));
        const dr = text.match(/drop_frames=(\d+)/g);
        if (dr) perf.drop = Number(dr[dr.length - 1].split('=')[1]);
        const du = text.match(/dup_frames=(\d+)/g);
        if (du) perf.dup = Number(du[du.length - 1].split('=')[1]);
    });
    let perfTick = 0;
    const trackDuration = getAudioDuration(media.file);
    const maxRuntimeMs = trackDuration ? (trackDuration + 90) * 1000 : null;
    const stallTimer = setInterval(() => {
        if (currentFfmpegProcess !== ffmpeg) return;
        const now = Date.now();
        // Διάγνωση: αν ο encoder δεν προλαβαίνει (speed<0.97) ή χάνει frames, γράφεται στο log.
        if (++perfTick % 6 === 0 && perf.speed !== null && (perf.speed < 0.97 || perf.drop > 0)) {
            console.warn(`[PERF] speed=${perf.speed}x drop_frames=${perf.drop} dup_frames=${perf.dup} | ${media.title}`);
        }
        const stalled = lastProgressAt
            ? (now - lastProgressAt) > FFMPEG_STALL_SECONDS * 1000
            : (now - startedAt) > FFMPEG_START_GRACE_SECONDS * 1000;
        const overran = maxRuntimeMs !== null && (now - startedAt) > maxRuntimeMs;
        if (stalled || overran) {
            console.error(`[STALL] ffmpeg κόλλησε (${stalled ? 'χωρίς progress' : 'υπέρβαση διάρκειας'}) στο "${media.title}". Επανεκκίνηση.`);
            intentionalStopReason = 'stall';
            try { ffmpeg.kill('SIGKILL'); } catch (_) {}
        }
    }, 5000);

    if (media.crossfadeNext) {
        const duration = trackDuration;
        if (duration) {
            const delay = Math.max(0, (duration - resumeOffset - CROSSFADE_SECONDS) * 1000);
            currentCrossfadeTimer = setTimeout(async () => {
                try {
                    const next = media.crossfadeNext;
                    const ok = await activateReservedMedia(next);
                    if (ok) await updateStationStatus(next.title, `${next.genreLabel} • Crossfade`);
                } catch (error) {
                    console.error('[CROSSFADE TIMER ERROR]', error.message);
                }
            }, delay);
        }
    }

    let finished = false;

    ffmpeg.on('close', async (code, signal) => {
        if (finished) return;
        finished = true;
        clearInterval(stallTimer);
        if (currentCrossfadeTimer) clearTimeout(currentCrossfadeTimer);
        currentCrossfadeTimer = null;
        currentFfmpegProcess = null;
        currentMedia = null;
        lastChainActivityAt = Date.now();

        const intentional = intentionalStopReason;
        intentionalStopReason = null;

        try {
            await finalizePlayedMedia(media, code, intentional);

            if (media.isNewYearTestCountdown && code === 0 && !intentional) {
                forcedNewYearTestQueue = buildNewYearSpecialSequence('TEST Πρωτοχρονιάς');
                if (forcedNewYearTest) forcedNewYearTest.phase = 'sequence';
            }

            if ((code !== 0 || intentional) && media.crossfadeNext && pendingCrossfadeMedia === media.crossfadeNext) {
                await restorePendingCrossfadeAfterAbort(media.crossfadeNext);
                pendingCrossfadeMedia = null;
            }

            if ((code && code !== 0) && !intentional && !isShuttingDown) {
                console.error(`[FFMPEG CLOSE] ${media.file} code=${code} signal=${signal || '-'} | ${stderrTail.replace(/\s+/g, ' ').slice(-1100)}`);
            }
        } catch (error) {
            console.error('[FFMPEG CLOSE HANDLER ERROR]', error.message);
            if (pendingCrossfadeMedia && pendingCrossfadeMedia === media.crossfadeNext) pendingCrossfadeMedia = null;
        } finally {
            // Ό,τι κι αν έγινε παραπάνω, το επόμενο τραγούδι ΠΑΝΤΑ προγραμματίζεται.
            if (!isShuttingDown && (!supabase || ownsStreamLease)) {
                setTimeout(startNextMedia, intentional ? 180 : (code === 0 ? 120 : 1300));
            }
        }
    });

    ffmpeg.on('error', async error => {
        if (finished) return;
        finished = true;
        clearInterval(stallTimer);
        if (currentCrossfadeTimer) clearTimeout(currentCrossfadeTimer);
        currentCrossfadeTimer = null;
        currentFfmpegProcess = null;
        currentMedia = null;
        lastChainActivityAt = Date.now();
        console.error('[FFMPEG SPAWN ERROR]', error.message);
        try {
            await finalizePlayedMedia(media, 1, false);
            if (media.crossfadeNext && pendingCrossfadeMedia === media.crossfadeNext) {
                await restorePendingCrossfadeAfterAbort(media.crossfadeNext);
                pendingCrossfadeMedia = null;
            }
        } catch (e) {
            console.error('[FFMPEG ERROR HANDLER ERROR]', e.message);
        } finally {
            if (!isShuttingDown && (!supabase || ownsStreamLease)) setTimeout(startNextMedia, 1800);
        }
    });
}

// ============================================================
// PERSISTENT ENCODER — ΜΙΑ σύνδεση προς YouTube, χωρίς reconnect σε κάθε τραγούδι
// ============================================================
// Ένας ffmpeg (encoder) μένει συνεχώς ανοιχτός και παίρνει PCM ήχο από stdin.
// Κάθε τραγούδι αποκωδικοποιείται από ξεχωριστό, μικρό ffmpeg (decoder) και ο ήχος
// του μπαίνει στην ουρά. Ο τίτλος/κατηγορία αλλάζουν μέσω αρχείων (drawtext reload),
// άρα δεν υπάρχει πια "πάγωμα" στην αλλαγή τραγουδιού. Ειδικές περιπτώσεις
// (εικόνα διαφήμισης, αντίστροφη μέτρηση Πρωτοχρονιάς) περνούν από το παλιό
// per-song ffmpeg, και αλλαγή φόντου ημέρας/νύχτας κάνει ένα ελεγχόμενο restart.
const PERSISTENT_ENCODER = process.env.PERSISTENT_ENCODER !== 'false';
const PCM_BYTES_PER_SEC = 44100 * 4; // s16le, stereo
const PCM_BUFFER_MAX = PCM_BYTES_PER_SEC * 12;
const OVERLAY_LABEL_FILE = path.join(__dirname, '.live_label.txt');
const OVERLAY_TITLE_FILE = path.join(__dirname, '.live_title.txt');
const OUTPUT_URL_OVERRIDE = process.env.RTMP_OUTPUT_URL_OVERRIDE || '';

let enc = null;              // { proc, bgFile, nightFx, graceful, ... }
let decoder = null;          // { proc, media, sentFirst }
let pcmQueue = [];           // { buf, media, first, last, code, announced }
let pcmQueuedBytes = 0;
let pcmWritten = 0;
let pcmClockStart = 0;
let pcmTimer = null;
let enginePumping = false;
let enginePumpStartedAt = 0;
let nextPumpAllowedAt = 0;
const engineMedia = new Set(); // media που έχουν ενεργοποιηθεί και δεν έχουν τελειώσει

function writeOverlayTexts(media) {
    try {
        atomicWriteTextFile(OVERLAY_LABEL_FILE, String(media?.genreLabel || ''));
        atomicWriteTextFile(OVERLAY_TITLE_FILE, String(media?.title || ''));
    } catch (error) {
        console.error('[OVERLAY FILE ERROR]', error.message);
    }
}

function buildEncoderArgs(bgSpec, streamKey) {
    const nightGrade = bgSpec.nightFx
        ? `,eq=brightness=-0.28:contrast=1.12:saturation=0.66:gamma=0.84,colorbalance=bs=.16:bm=.08:rs=-.05,vignette=PI/5`
        : '';
    const vf =
        `scale=854:480${nightGrade},` +
        `drawtext=fontfile='${TIME_FONT}':textfile='${CLOCK_TIME_FILE}':reload=1:x=18:y=14:fontsize=26:fontcolor=0xFFD700@1.0:borderw=1:bordercolor=black@0.25,` +
        `drawtext=fontfile='${TIME_FONT}':textfile='${CLOCK_DATE_FILE}':reload=1:x=18:y=48:fontsize=14:fontcolor=0xFFD700@1.0:borderw=1:bordercolor=black@0.20,` +
        `drawtext=fontfile='${CATEGORY_FONT}':textfile='${OVERLAY_LABEL_FILE}':reload=1:expansion=none:x=18:y=h-58:fontsize=14:fontcolor=yellow:borderw=2:bordercolor=black,` +
        `drawtext=fontfile='${TITLE_FONT}':textfile='${OVERLAY_TITLE_FILE}':reload=1:expansion=none:x=18:y=h-34:fontsize=17:fontcolor=white:borderw=2:bordercolor=black`;
    return [
        '-hide_banner', '-loglevel', 'warning', '-nostats', '-progress', 'pipe:1',
        '-re', '-fflags', '+genpts', '-thread_queue_size', '1024',
        '-loop', '1', '-framerate', '15', '-i', bgSpec.file,
        '-thread_queue_size', '1024', '-f', 's16le', '-ar', '44100', '-ac', '2', '-i', 'pipe:0',
        '-map', '0:v:0', '-map', '1:a:0',
        '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'stillimage', '-threads', '2', '-bf', '0',
        '-vf', vf,
        '-r', '15', '-g', '30', '-keyint_min', '30', '-sc_threshold', '0',
        '-b:v', '1500k', '-minrate', '1500k', '-maxrate', '1500k', '-bufsize', '1500k',
        '-x264-params', 'nal-hrd=cbr:force-cfr=1',
        '-c:a', 'aac', '-b:a', '160k', '-ar', '44100', '-ac', '2',
        '-max_muxing_queue_size', '4096', '-shortest',
        '-pix_fmt', 'yuv420p', '-f', 'flv',
        OUTPUT_URL_OVERRIDE || `rtmp://a.rtmp.youtube.com/live2/${streamKey}`
    ];
}

function startEncoder(bgSpec) {
    const streamKey = process.env.YOUTUBE_STREAM_KEY;
    if (!streamKey && !OUTPUT_URL_OVERRIDE) {
        console.error('[YOUTUBE ERROR] Λείπει YOUTUBE_STREAM_KEY.');
        return false;
    }
    if (!fs.existsSync(OVERLAY_LABEL_FILE)) writeOverlayTexts({ genreLabel: '', title: '' });

    const proc = spawn('ffmpeg', buildEncoderArgs(bgSpec, streamKey), { stdio: ['pipe', 'pipe', 'pipe'] });
    const e = {
        proc, bgFile: bgSpec.file, nightFx: !!bgSpec.nightFx, graceful: false,
        startedAt: Date.now(), lastProgressAt: 0, perf: { speed: null, drop: 0, dup: 0 }, perfTick: 0, stderrTail: '', timer: null
    };
    enc = e;
    pcmQueue = []; pcmQueuedBytes = 0; pcmWritten = 0; pcmClockStart = Date.now();
    console.log(`[ENCODER] Έναρξη μόνιμου encoder | BG=${bgSpec.file}${bgSpec.nightFx ? ' [AUTO NIGHT]' : ''}`);

    proc.stdin.on('error', () => {});
    proc.stderr.on('data', chunk => { e.stderrTail = (e.stderrTail + chunk.toString()).slice(-1600); });
    proc.stdout.on('data', chunk => {
        e.lastProgressAt = Date.now();
        const text = chunk.toString();
        const sp = text.match(/speed=\s*([\d.]+)x/g);
        if (sp) e.perf.speed = parseFloat(sp[sp.length - 1].replace(/[^\d.]/g, ''));
        const dr = text.match(/drop_frames=(\d+)/g);
        if (dr) e.perf.drop = Number(dr[dr.length - 1].split('=')[1]);
        const du = text.match(/dup_frames=(\d+)/g);
        if (du) e.perf.dup = Number(du[du.length - 1].split('=')[1]);
    });

    e.timer = setInterval(() => {
        if (enc !== e) return;
        const now = Date.now();
        if (++e.perfTick % 6 === 0 && e.perf.speed !== null && (e.perf.speed < 0.97 || e.perf.drop > 0)) {
            console.warn(`[PERF] speed=${e.perf.speed}x drop_frames=${e.perf.drop} dup_frames=${e.perf.dup}`);
        }
        const stalled = e.lastProgressAt
            ? (now - e.lastProgressAt) > FFMPEG_STALL_SECONDS * 1000
            : (now - e.startedAt) > FFMPEG_START_GRACE_SECONDS * 1000;
        if (stalled) {
            console.error('[STALL] Ο μόνιμος encoder κόλλησε. Επανεκκίνηση.');
            try { proc.kill('SIGKILL'); } catch (_) {}
        }
    }, 5000);

    proc.on('close', async (code, signal) => {
        clearInterval(e.timer);
        if (enc === e) enc = null;
        if (pcmTimer && !enc) { clearInterval(pcmTimer); pcmTimer = null; }
        lastChainActivityAt = Date.now();

        if (!e.graceful) {
            // Απρόβλεπτος τερματισμός: καθάρισε decoder/ουρά και δώσε πίσω ό,τι δεν ακούστηκε.
            if (decoder) { try { decoder.proc.kill('SIGKILL'); } catch (_) {} decoder = null; }
            pcmQueue = []; pcmQueuedBytes = 0;
            const abortedByUs = !!e.abortReason;
            if (!abortedByUs) console.error(`[ENCODER CLOSE] code=${code} signal=${signal || '-'} | ${e.stderrTail.replace(/\s+/g, ' ').slice(-900)}`);
            const unfinished = [...engineMedia];
            engineMedia.clear();
            currentMedia = null;
            for (const m of unfinished) {
                try { await finalizePlayedMedia(m, abortedByUs ? 0 : 1, abortedByUs || m !== unfinished[0] ? true : false); } catch (_) {}
            }
            try {
                if (pendingCrossfadeMedia) { await restorePendingCrossfadeAfterAbort(pendingCrossfadeMedia); pendingCrossfadeMedia = null; }
            } catch (_) {}
            if (!isShuttingDown && (!supabase || ownsStreamLease) && !e.abortReason) setTimeout(startNextMedia, 1300);
        }
    });
    proc.on('error', error => { console.error('[ENCODER SPAWN ERROR]', error.message); });

    if (pcmTimer) clearInterval(pcmTimer);
    pcmTimer = setInterval(pcmTick, 20);
    return true;
}

function stopEncoderGracefully() {
    return new Promise(resolve => {
        const e = enc;
        if (!e) return resolve();
        e.graceful = true;
        e.proc.once('close', () => resolve());
        try { e.proc.stdin.end(); } catch (_) {}
        setTimeout(() => { try { e.proc.kill('SIGKILL'); } catch (_) {} }, 15000);
    });
}

function engineAbort(reason) {
    if (enc) { enc.abortReason = reason; try { enc.proc.kill('SIGTERM'); } catch (_) {} }
    if (decoder) { try { decoder.proc.kill('SIGKILL'); } catch (_) {} decoder = null; }
    pcmQueue = []; pcmQueuedBytes = 0;
}

function onMediaAudible(media) {
    currentMedia = media;
    writeOverlayTexts(media);
    updateStationStatus(media.title, media.genreLabel).catch(() => {});
}

function onMediaFinished(media, code) {
    engineMedia.delete(media);
    if (!media.announcedAudible) { /* απέτυχε πριν ακουστεί */ }
    finalizePlayedMedia(media, code, false).catch(error => console.error('[FINALIZE ERROR]', error.message));
    if (currentMedia === media) currentMedia = null;
}

// Ρολόι πραγματικού χρόνου: στέλνει στον encoder ακριβώς όσο ήχο αντιστοιχεί στον χρόνο
// που πέρασε. Αν δεν υπάρχει ήχος διαθέσιμος, συμπληρώνει σιωπή (ποτέ διακοπή ροής).
function pcmTick() {
    const e = enc;
    if (!e || !e.proc.stdin.writable) return;

    let due = Math.floor(((Date.now() - pcmClockStart) / 1000) * PCM_BYTES_PER_SEC / 4) * 4 - pcmWritten;
    const maxBurst = Math.floor(PCM_BYTES_PER_SEC * 0.5 / 4) * 4;
    if (due > maxBurst) { pcmClockStart += ((due - maxBurst) / PCM_BYTES_PER_SEC) * 1000; due = maxBurst; }
    let need = Math.max(0, due);

    const out = [];
    while (pcmQueue.length) {
        const it = pcmQueue[0];
        if (it.buf.length === 0) {
            pcmQueue.shift();
            if (it.last) {
                if (!it.announced && it.first) onMediaAudible(it.media);
                onMediaFinished(it.media, it.code);
            }
            continue;
        }
        if (need <= 0) break;
        if (it.first && !it.announced) { it.announced = true; onMediaAudible(it.media); }
        const n = Math.min(need, it.buf.length);
        out.push(it.buf.subarray(0, n));
        it.buf = it.buf.subarray(n);
        pcmQueuedBytes -= n;
        need -= n;
        if (it.buf.length === 0) { pcmQueue.shift(); }
    }
    if (need > 0) out.push(Buffer.alloc(need)); // σιωπή

    const total = Math.max(0, due);
    if (total > 0) {
        try { e.proc.stdin.write(Buffer.concat(out, total)); } catch (_) {}
        pcmWritten += total;
    }

    if (decoder && decoder.paused && pcmQueuedBytes < PCM_BUFFER_MAX / 2) {
        decoder.paused = false;
        try { decoder.proc.stdout.resume(); } catch (_) {}
    }
    if (!decoder && !enginePumping && Date.now() >= nextPumpAllowedAt && pcmQueuedBytes < PCM_BUFFER_MAX * 0.8 && !isShuttingDown) {
        enginePump().catch(error => console.error('[ENGINE PUMP ERROR]', error.message));
    }
}

function buildDecoderArgs(media) {
    const args = ['-hide_banner', '-loglevel', 'error', '-nostdin'];
    const resumeOffset = Number(media.resumeOffsetSec || 0);
    if (resumeOffset > 0) args.push('-ss', resumeOffset.toFixed(3));
    args.push('-i', media.file);
    if (media.crossfadeNext) {
        args.push('-t', (CROSSFADE_SECONDS + 0.35).toFixed(2), '-i', media.crossfadeNext.file);
        const audioFilter =
            `[0:a]aresample=44100,aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo,asetpts=PTS-STARTPTS[a1];` +
            `[1:a]atrim=start=0:end=${(CROSSFADE_SECONDS + 0.10).toFixed(3)},aresample=44100,aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo,asetpts=PTS-STARTPTS[a2];` +
            `[a1][a2]acrossfade=d=${CROSSFADE_SECONDS.toFixed(3)}:c1=tri:c2=tri[aout]`;
        args.push('-filter_complex', audioFilter, '-map', '[aout]');
    } else {
        args.push('-map', '0:a:0');
    }
    args.push('-f', 's16le', '-ar', '44100', '-ac', '2', 'pipe:1');
    return args;
}

function startDecoder(media) {
    const proc = spawn('ffmpeg', buildDecoderArgs(media), { stdio: ['ignore', 'pipe', 'pipe'] });
    const d = { proc, media, sentFirst: false, paused: false, stderrTail: '' };
    decoder = d;
    let carry = Buffer.alloc(0);
    proc.stderr.on('data', chunk => { d.stderrTail = (d.stderrTail + chunk.toString()).slice(-800); });
    proc.stdout.on('data', chunk => {
        let buf = carry.length ? Buffer.concat([carry, chunk]) : chunk;
        const usable = buf.length - (buf.length % 4);
        carry = buf.subarray(usable);
        buf = buf.subarray(0, usable);
        if (!buf.length) return;
        pcmQueue.push({ buf, media, first: !d.sentFirst, last: false });
        d.sentFirst = true;
        pcmQueuedBytes += buf.length;
        if (pcmQueuedBytes > PCM_BUFFER_MAX && !d.paused) { d.paused = true; proc.stdout.pause(); }
    });
    proc.on('close', code => {
        if (decoder === d) decoder = null;
        if (code !== 0) console.error(`[DECODER] ${media.file} code=${code} | ${d.stderrTail.replace(/\s+/g, ' ')}`);
        if (enc) {
            pcmQueue.push({ buf: Buffer.alloc(0), media, first: !d.sentFirst, last: true, code: code === 0 ? 0 : (code ?? 1) });
        } else {
            engineMedia.delete(media);
        }
        nextPumpAllowedAt = 0;
    });
    proc.on('error', error => console.error('[DECODER SPAWN ERROR]', error.message));
}

async function waitForPcmDrain() {
    for (let i = 0; i < 6000 && !isShuttingDown; i++) {
        if (!pcmQueue.length && !engineMedia.size) break;
        await sleep(100);
    }
    await sleep(400); // μικρό περιθώριο για να φτάσει ο ήχος στην έξοδο
}

async function enginePump() {
    if (isShuttingDown || (supabase && !ownsStreamLease)) return;
    if (enginePumping || decoder || currentFfmpegProcess) return;
    enginePumping = true; enginePumpStartedAt = Date.now(); lastChainActivityAt = Date.now();
    try {
        const lead = enc ? (pcmQueuedBytes / PCM_BYTES_PER_SEC) * 1000 : 0;
        let media = null, bgSpec = null, spawnTime = null;
        virtualLeadMs = lead;
        try {
            media = await selectNextFile();
            spawnTime = getGreekTime(new Date(Date.now() + lead));
            bgSpec = media ? selectBackgroundSpec(spawnTime, media) : null;
        } finally { virtualLeadMs = 0; }

        if (!media || !bgSpec || !fs.existsSync(path.join(__dirname, media.file))) {
            nextPumpAllowedAt = Date.now() + 2000;
            return;
        }

        const ny = buildNewYearCountdownFilters(spawnTime, !!media.isNewYearTestCountdown);
        const midnightCut = secondsUntilNewYearMidnight(spawnTime);
        const needsLegacy = !!(bgSpec.isVisual || media.isNewYearTestCountdown || ny.filters.length || midnightCut !== null);

        if (needsLegacy) {
            // Ειδική μετάδοση: μετά το τέλος του ήχου που ήδη παίζει, παίζει το παλιό per-song ffmpeg.
            await waitForPcmDrain();
            await stopEncoderGracefully();
            isStartingMedia = true;
            try { await startNextMediaInner(media); }
            finally { isStartingMedia = false; }
            return;
        }

        if (enc && (enc.bgFile !== bgSpec.file || enc.nightFx !== !!bgSpec.nightFx)) {
            // Αλλαγή φόντου (ανατολή/δύση): ελεγχόμενο restart του encoder στο όριο τραγουδιού.
            console.log(`[ENCODER] Αλλαγή φόντου → ${bgSpec.file}${bgSpec.nightFx ? ' [AUTO NIGHT]' : ''}`);
            await waitForPcmDrain();
            await stopEncoderGracefully();
        }
        if (!enc && !startEncoder(bgSpec)) {
            await rollbackReservedMedia(media);
            nextPumpAllowedAt = Date.now() + 5000;
            return;
        }

        if (!(await activateReservedMedia(media))) {
            console.error('[MEDIA ACTIVATE] Η reserved εγγραφή δεν μπόρεσε να ενεργοποιηθεί. Προχωράμε παρακάτω.');
            nextPumpAllowedAt = Date.now() + 700;
            return;
        }

        if (media.isHourAnnouncement) songCounter = 0;
        else if (media.isSong) songCounter++;
        if (media.isAd) songsSinceAd = 0;
        else if (media.isSong) songsSinceAd++;
        if (media.isSong) {
            if (media.rotationKey === 'X') songsSinceXmas = 0;
            else if (isXmasSongWindow(spawnTime)) songsSinceXmas++;
            else songsSinceXmas = 0;
        }

        virtualLeadMs = lead;
        try { await maybePrepareCrossfade(media, spawnTime); } finally { virtualLeadMs = 0; }

        engineMedia.add(media);
        console.log(`[PLAY] ${media.title} | ${media.genreLabel} | BG=${bgSpec.file}${bgSpec.nightFx ? ' [AUTO NIGHT]' : ''}${media.crossfadeNext ? ` | crossfade->${media.crossfadeNext.title}` : ''} | queued=${(lead / 1000).toFixed(1)}s`);
        startDecoder(media);
    } catch (error) {
        console.error('[ENGINE ERROR]', error && error.stack ? error.stack : error);
        nextPumpAllowedAt = Date.now() + 3000;
    } finally {
        virtualLeadMs = 0;
        enginePumping = false;
        lastChainActivityAt = Date.now();
    }
}

// ============================================================
// STREAM LEASE / HEARTBEAT
// ============================================================
async function acquireStreamLease() {
    if (!supabase) return true;
    let data, error;
    try {
        ({ data, error } = await supabase.rpc('acquire_stream_lease', { p_owner_id: STREAM_OWNER_ID, p_lease_seconds: STREAM_LEASE_SECONDS }));
    } catch (e) { error = e; }
    if (error) {
        console.error('[LEASE ERROR]', error.message || error);
        return false;
    }
    ownsStreamLease = data === true;
    return ownsStreamLease;
}

async function renewStreamLease() {
    if (!supabase || !ownsStreamLease || isShuttingDown) return;
    let data = null, error = null;
    try {
        ({ data, error } = await supabase.rpc('renew_stream_lease', { p_owner_id: STREAM_OWNER_ID, p_lease_seconds: STREAM_LEASE_SECONDS }));
    } catch (e) { error = e; }

    // Προσωρινό σφάλμα δικτύου/timeout ΔΕΝ σημαίνει χαμένο lease: το lease κρατά 90s
    // και ανανεώνεται ανά 30s, άρα αντέχουμε 2 αποτυχίες χωρίς να κόψουμε τη μετάδοση.
    if (error) {
        leaseErrorStreak++;
        console.error(`[LEASE RENEW ERROR ${leaseErrorStreak}/3]`, error.message || error);
        if (leaseErrorStreak < 3) return;
    } else {
        leaseErrorStreak = 0;
    }

    if (error || data !== true) {
        console.error('[LEASE LOST] Χάθηκε το lease. Σταματά ο encoder.');
        leaseErrorStreak = 0;
        ownsStreamLease = false;
        if (currentFfmpegProcess) {
            intentionalStopReason = 'lease_lost';
            currentFfmpegProcess.kill('SIGTERM');
        }
        engineAbort('lease_lost');
        if (leaseRenewTimer) clearInterval(leaseRenewTimer);
        leaseRenewTimer = null;
        setTimeout(() => { if (!isShuttingDown) waitForLeaseAndStart(); }, 5000);
    }
}

async function releaseStreamLease() {
    if (!supabase || !ownsStreamLease) return;
    try { await supabase.rpc('release_stream_lease', { p_owner_id: STREAM_OWNER_ID }); } catch (_) {}
    ownsStreamLease = false;
}

async function startHeartbeat() {
    if (!supabase || !ownsStreamLease || isShuttingDown) return;
    try {
        const now = new Date().toISOString();
        const { error } = await supabase.from('station_status').upsert({ id: 1, heartbeat_at: now, stream_owner: STREAM_OWNER_ID, updated_at: now });
        if (error) console.error('[HEARTBEAT ERROR]', error.message);
    } catch (e) {
        console.error('[HEARTBEAT ERROR]', e.message);
    }
}

async function logLeaseHolder() {
    try {
        const { data } = await supabase.from('station_runtime_lock').select('owner_id,lease_until').eq('id', 1).maybeSingle();
        console.log(`[LEASE WAIT] broadcaster=${data?.owner_id || 'unknown'} lease_until=${data?.lease_until || 'unknown'} — αναμονή handover.`);
    } catch (_) {
        console.log('[LEASE WAIT] Υπάρχει ενεργός broadcaster — αναμονή handover.');
    }
}

async function waitForLeaseAndStart() {
    if (!supabase) {
        console.warn('[LEASE] Supabase unavailable. Start without distributed lock.');
        startChainWatchdog();
        startNextMedia();
        return;
    }

    while (!isShuttingDown) {
        if (await acquireStreamLease()) {
            console.log(`[LEASE] ${STREAM_OWNER_ID} έγινε ο ενεργός broadcaster.`);
            successorDispatched = false;
            scheduleSuccessorDispatch();
            await startHeartbeat();
            if (leaseRenewTimer) clearInterval(leaseRenewTimer);
            leaseRenewTimer = setInterval(async () => {
                try {
                    await renewStreamLease();
                    if (ownsStreamLease) await startHeartbeat();
                } catch (e) {
                    console.error('[LEASE TIMER ERROR]', e.message);
                }
            }, 30000);
            startChainWatchdog();
            startNextMedia();
            return;
        }

        if (Date.now() - lastLeaseWaitLogAt > 60000) {
            lastLeaseWaitLogAt = Date.now();
            await logLeaseHolder();
        }
        await sleep(10000);
    }
}

// ============================================================
// GITHUB SELF-HANDOVER
// ============================================================
let successorDispatched = false;

async function dispatchSuccessorWorkflow(reason = 'scheduled-handover') {
    if (successorDispatched) return true;
    if (!GITHUB_HANDOVER_TOKEN || !GITHUB_REPOSITORY_NAME) {
        console.warn('[HANDOVER] Δεν υπάρχουν GITHUB_TOKEN_FOR_HANDOVER / repository metadata. Το watchdog workflow παραμένει fallback.');
        return false;
    }
    const url = `https://api.github.com/repos/${GITHUB_REPOSITORY_NAME}/actions/workflows/live.yml/dispatches`;
    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Accept': 'application/vnd.github+json',
                'Authorization': `Bearer ${GITHUB_HANDOVER_TOKEN}`,
                'X-GitHub-Api-Version': '2022-11-28',
                'Content-Type': 'application/json',
                'User-Agent': 'Thavma-Palmos-V6'
            },
            signal: AbortSignal.timeout(20000),
            body: JSON.stringify({
                ref: GITHUB_REF_NAME,
                inputs: { handover_from: STREAM_OWNER_ID, handover_reason: reason, test_newyear: 'false' }
            })
        });
        if (!response.ok) {
            const body = await response.text();
            console.error(`[HANDOVER DISPATCH ERROR] HTTP ${response.status} ${body.slice(0, 500)}`);
            return false;
        }
        successorDispatched = true;
        console.log(`[HANDOVER] Νέο live.yml workflow ζητήθηκε αυτόματα (${reason}). Το νέο job θα περιμένει το lease.`);
        return true;
    } catch (error) {
        console.error('[HANDOVER DISPATCH ERROR]', error.message);
        return false;
    }
}

async function dispatchSuccessorWithRetry(reason = 'self-handover') {
    for (let attempt = 1; attempt <= 6 && !isShuttingDown && !successorDispatched; attempt++) {
        const ok = await dispatchSuccessorWorkflow(reason);
        if (ok) return true;
        console.warn(`[HANDOVER] Αποτυχία dispatch ${attempt}/6. Νέα προσπάθεια σε 2 λεπτά.`);
        await sleep(2 * 60 * 1000);
    }
    return successorDispatched;
}

function scheduleSuccessorDispatch() {
    if (successorDispatchTimer) clearTimeout(successorDispatchTimer);
    const delay = SELF_HANDOVER_AFTER_MINUTES * 60 * 1000;
    successorDispatchTimer = setTimeout(() => {
        dispatchSuccessorWithRetry('self-handover').catch(error => console.error('[HANDOVER RETRY ERROR]', error.message));
    }, delay);
    console.log(`[HANDOVER] successor dispatch σε ${SELF_HANDOVER_AFTER_MINUTES} λεπτά.`);
}

// ============================================================
// SHUTDOWN / STARTUP
// ============================================================
async function gracefulShutdown(signal) {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.log(`[SHUTDOWN] ${signal} — τερματισμός encoder και release lease.`);

    if (leaseRenewTimer) clearInterval(leaseRenewTimer);
    if (chainWatchdogTimer) clearInterval(chainWatchdogTimer);
    if (clockWriterTimer) clearInterval(clockWriterTimer);
    if (commandPollTimer) clearInterval(commandPollTimer);
    if (currentCrossfadeTimer) clearTimeout(currentCrossfadeTimer);
    if (successorDispatchTimer) clearTimeout(successorDispatchTimer);

    if (currentFfmpegProcess) {
        intentionalStopReason = 'shutdown';
        currentFfmpegProcess.kill('SIGTERM');
    }
    engineAbort('shutdown');

    await releaseStreamLease();
    setTimeout(() => process.exit(0), 1200);
}

// Κανένα απρόβλεπτο σφάλμα δεν πρέπει να ρίχνει ή να παγώνει τον broadcaster.
process.on('uncaughtException', error => { console.error('[UNCAUGHT EXCEPTION]', error && error.stack ? error.stack : error); });
process.on('unhandledRejection', reason => { console.error('[UNHANDLED REJECTION]', reason && reason.stack ? reason.stack : reason); });

process.on('SIGTERM', () => { gracefulShutdown('SIGTERM'); });
process.on('SIGINT', () => { gracefulShutdown('SIGINT'); });

app.listen(PORT, '0.0.0.0', async () => {
    console.log(`Thavma Palmos V6 server στο port ${PORT}`);
    console.log(`[STREAM OWNER] ${STREAM_OWNER_ID}`);
    console.log(`[CONFIG] crossfade=${CROSSFADE_SECONDS}s (all non-system audio) | ad every=${AD_EVERY_SONGS} songs | bg=sunrise/sunset Ελλάδας | xmas=1/${XMAS_EVERY_SONGS} | self-handover=${SELF_HANDOVER_AFTER_MINUTES}m`);

    startClockOverlayWriter();
    // Κάθε βήμα εκκίνησης προστατεύεται: αν αποτύχει ένα, η μετάδοση ξεκινά έτσι κι αλλιώς.
    for (const step of [syncSongsToSupabase, syncMediaCatalog, recoverStaleRequests, recoverStaleQueue]) {
        try { await step(); } catch (e) { console.error(`[STARTUP ${step.name} ERROR]`, e.message); }
    }

    commandPollTimer = setInterval(() => { pollAdminCommands().catch(e => console.error('[ADMIN POLL ERROR]', e.message)); }, 5000);
    if (startupNewYearTestRequested) {
        startupNewYearTestRequested = false;
        await beginForcedNewYearTest(null, 'GitHub workflow test');
    }

    await waitForLeaseAndStart();
});
