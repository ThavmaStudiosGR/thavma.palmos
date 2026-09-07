process.env.TZ = 'Europe/Athens';

const express = require('express');
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 3000;
app.use(express.json());

// ============================================================
// CONFIG
// ============================================================
const AUDIO_EXTENSIONS = new Set(['.mp3', '.wav']);
const CROSSFADE_SECONDS = Math.max(0, Math.min(8, Number(process.env.MIX_CROSSFADE_SECONDS || 3)));
const AD_EVERY_SONGS = Math.max(1, Math.min(50, Number(process.env.AD_EVERY_SONGS || 7)));
const DAY_BG_START_HOUR = Math.max(0, Math.min(23, Number(process.env.DAY_BG_START_HOUR || 7)));
const NIGHT_BG_START_HOUR = Math.max(0, Math.min(23, Number(process.env.NIGHT_BG_START_HOUR || 20)));

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY;
const supabase = SUPABASE_URL && SUPABASE_KEY ? createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false }
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
let lastLeaseWaitLogAt = 0;

let newYearQueue = [];
let lastNewYearSequenceKey = null;
let pendingMixMedia = null;

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

function getGreekTime(date = new Date()) {
    return {
        raw: date,
        year: date.getFullYear(),
        month: date.getMonth(),
        date: date.getDate(),
        day: date.getDay(),
        hour: date.getHours(),
        minute: date.getMinutes(),
        second: date.getSeconds()
    };
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
    return (month === 10 && date >= 18) || month === 11 || month === 0;
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
    if (d === 0 || d === 6) return 'MIX';

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

function getRequiredGenre() { return getRequiredGenreForDate(new Date()); }

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
    const t = getGreekTime();
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

function selectBackgroundFile(time = getGreekTime()) {
    const isDay = time.hour >= DAY_BG_START_HOUR && time.hour < NIGHT_BG_START_HOUR;
    const bases = isDay ? ['background_day', 'background_night'] : ['background_night', 'background_day'];
    for (const base of bases) {
        for (const ext of ['.jpg', '.jpeg', '.png', '.webp']) {
            const candidate = `${base}${ext}`;
            if (fs.existsSync(path.join(__dirname, candidate))) return candidate;
        }
    }
    for (const fallback of ['background.jpg','background.png']) {
        if (fs.existsSync(path.join(__dirname, fallback))) return fallback;
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
        status: 'skipped',
        failure_reason: reason,
        admin_note: note,
        decided_at: now,
        claimed_at: null
    }).eq('id', id).in('status', ['pending', 'checking', 'playing']).select('id');

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
    }).in('status', ['checking', 'playing']).lt('claimed_at', staleBefore);
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

async function checkSupabaseRequest() {
    if (!supabase) return null;
    try {
        const { data, error } = await supabase
            .from('song_requests')
            .select('*')
            .eq('status', 'pending')
            .order('created_at', { ascending: true })
            .limit(25);

        if (error || !data || data.length === 0) return null;

        const files = fs.readdirSync(__dirname);
        const fileMap = new Map(files.filter(isAudioFile).map(f => [f.toLowerCase(), f]));
        const categorySettings = await getCategorySettings();
        const songSettings = await getSongSettings();
        const time = getGreekTime();

        for (const request of data) {
            // Claim first. A bad request can therefore never be examined hundreds of times.
            const claimedAt = new Date().toISOString();
            const { data: claimRows, error: claimError } = await supabase
                .from('song_requests')
                .update({ status: 'checking', claimed_at: claimedAt, failure_reason: null })
                .eq('id', request.id)
                .eq('status', 'pending')
                .select('*');

            if (claimError) {
                console.error(`[REQUEST CLAIM ERROR #${request.id}] ${claimError.message}`);
                continue;
            }
            if (!claimRows?.length) continue;
            
            const claimedRequest = claimRows[0];
            const targetSongFile = claimedRequest.song || ''; 
            const category = extractTag(targetSongFile) || claimedRequest.category || '';
            const categoryRow = categorySettings.get(category);
            const songRow = songSettings.get(targetSongFile);
            
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

            const { data: playingRows, error: playingError } = await supabase
                .from('song_requests')
                .update({ status: 'playing', failure_reason: null, decided_at: new Date().toISOString() })
                .eq('id', claimedRequest.id)
                .eq('status', 'checking')
                .select('id');

            if (playingError) throw playingError;
            if (!playingRows?.length) continue;

            console.log(`[LIVE REQUEST #${claimedRequest.id}] ${match} από ${claimedRequest.requester}`);

            if (claimedRequest.email && process.env.EMAIL_USER && process.env.EMAIL_PASS) {
                transporter.sendMail({
                    to: claimedRequest.email,
                    from: process.env.EMAIL_USER,
                    subject: 'Το τραγούδι σας αναμεταδίδεται! 🎵',
                    html: `<h2>Γεια σας!</h2><p>Το τραγούδι "${claimedRequest.song}" μεταδίδεται τώρα στο Thavma Παλμός.</p>`
                }).catch(err => console.error('[EMAIL ERROR]', err.message));
            }

            return {
                file: match,
                title: cleanDisplayTitle(match),
                genreLabel: `Παραγγελία Ακροατή [${claimedRequest.requester}]`,
                isSong: true,
                isRequest: true,
                requestId: claimedRequest.id
            };
        }

        return null;
    } catch (error) {
        console.error('[REQUEST CHECK ERROR]', error.message);
        return null;
    }
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

async function claimRotationSong(rotationKey, candidates) {
    const unique = [...new Set((candidates || []).filter(Boolean))];
    if (!unique.length) return null;
    if (supabase) {
        const recent = await getRecentPlayedFilenames(5);
        const { data, error } = await supabase.rpc('claim_rotation_song', {
            p_rotation_key: rotationKey,
            p_candidates: unique,
            p_recent: recent
        });
        if (!error && data) return data;
        if (error) console.error(`[ROTATION ERROR ${rotationKey}]`, error.message);
    }
    return shuffleArray([...unique])[0] || null;
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
    pendingMixMedia = null;
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

    // Ads are a separate non-requestable rotation.
    if (songsSinceAd >= AD_EVERY_SONGS && adFiles.length) {
        const ad = await claimRotationSong('ADS', adFiles);
        if (ad) {
            await logPlayHistory(ad, 'ADS', 'ad');
            return { file: ad, title: cleanDisplayTitle(ad), genreLabel: 'Διαφημιστικό Διάλειμμα', isAd: true, rotationKey: 'ADS' };
        }
    }

    let genre = getRequiredGenre();
    let filtered = [];
    let rotationKey = 'MIX';
    let genreLabel = 'Mix Πρόγραμμα';

    if (genre === 'B') {
        filtered = normalPool.filter(f => hasTag(f, ...TAG.BEATS));
        rotationKey = 'B'; genreLabel = 'Beats (Disco, Dance, Club)';
    } else if (genre === 'R') {
        filtered = normalPool.filter(f => hasTag(f, ...TAG.RADIO));
        rotationKey = 'R'; genreLabel = 'Radio (Κανονική Ροή)';
    } else if (genre === 'P_LZ') {
        filtered = normalPool.filter(f => hasTag(f, ...TAG.PARADOSIAKA) || hasTag(f, ...TAG.LAIKA_ZEIMBEKIKA));
        rotationKey = 'P_LZ'; genreLabel = 'Παραδοσιακά & Λαϊκά';
    } else if (genre === 'EASTER_MODE') {
        const easter = normalPool.filter(f => hasTag(f, ...TAG.PARADOSIAKA) || hasTag(f, ...TAG.LAIKA_ZEIMBEKIKA));
        if (easter.length && Math.random() < 0.20) {
            filtered = easter; rotationKey = 'P_LZ'; genreLabel = 'Πασχαλινό Πρόγραμμα (Έμφαση στα Παραδοσιακά)';
        } else {
            filtered = normalPool; rotationKey = 'MIX'; genreLabel = 'Πασχαλινό Πρόγραμμα (Mix)';
        }
    } else {
        filtered = normalPool; rotationKey = 'MIX'; genreLabel = 'Mix Πρόγραμμα';
    }

    if (!filtered.length) {
        filtered = normalPool.length ? normalPool : musicFiles;
        rotationKey = 'MIX'; genreLabel = 'Mix Πρόγραμμα';
    }

    if (isChristmasPeriod(time.month, time.date) && xFiles.length) {
        const xProb = isNewYearXBoostWindow(time.month, time.date, time.hour) ? 0.80 : 0.35;
        if (Math.random() < xProb) {
            filtered = xFiles;
            rotationKey = 'X';
            genreLabel = 'Χριστουγεννιάτικο Πρόγραμμα (X)';
        }
    }

    const file = await claimRotationSong(rotationKey, filtered);
    if (!file) return null;
    await logPlayHistory(file, rotationKey, 'auto');
    return {
        file, title: cleanDisplayTitle(file), genreLabel,
        isSong: true, rotationKey, candidatePool: filtered
    };
}

async function selectNextFile() {
    const time = getGreekTime();

    // Forced admin/workflow New Year test has highest priority.
    if (forcedNewYearTest) {
        if (forcedNewYearTest.phase === 'countdown_pending') {
            const file = chooseCountdownTestAudio();
            if (!file) {
                await finishAdminCommand(forcedNewYearTest.commandId, 'No audio file available for test');
                forcedNewYearTest = null;
            } else {
                forcedNewYearTest.phase = 'countdown_running';
                return {
                    file,
                    title: 'TEST ΑΝΤΙΣΤΡΟΦΗΣ ΜΕΤΡΗΣΗΣ',
                    genreLabel: 'TEST Πρωτοχρονιάς',
                    isSystem: true,
                    isNewYearTestCountdown: true
                };
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

    // A pre-crossfaded MIX song must continue from second 3.
    if (pendingMixMedia) {
        if (getRequiredGenre() === 'MIX') {
            const media = pendingMixMedia;
            pendingMixMedia = null;
            return media;
        }
        pendingMixMedia = null;
    }

    if (time.hour === 0 && lastAnthemDate !== time.date) {
        const anthem = findNamedAudio('ethnikos_ymnos');
        if (anthem) {
            lastAnthemDate = time.date;
            return { file: anthem, title: 'ΕΘΝΙΚΟΣ ΥΜΝΟΣ', genreLabel: 'Ειδική Μετάδοση', isSystem: true };
        }
    }

    if (lastAnnouncedHour !== time.hour) {
        const hourFile = findHourFile(time.hour);
        if (hourFile) {
            lastAnnouncedHour = time.hour;
            songCounter = 0;
            return { file: hourFile, title: `Η ώρα είναι ${pad2(time.hour)}.00`, genreLabel: 'Ώρα Ελλάδος', isHourAnnouncement: true, isSystem: true };
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
                isSystem: true
            };
        }
    }

    const request = await checkSupabaseRequest();
    if (request) return request;

    return selectAutoProgramMedia();
}

async function maybePrepareMixCrossfade(media, spawnTime) {
    if (CROSSFADE_SECONDS <= 0) return;
    if (!media?.isSong || media.isRequest || media.isAd || media.isSystem) return;
    if (media.rotationKey !== 'MIX') return;
    if (!Array.isArray(media.candidatePool) || media.candidatePool.length < 2) return;
    if (spawnTime.minute >= 55) return;
    if (getRequiredGenreForDate(new Date(Date.now() + 5 * 60 * 1000)) !== 'MIX') return;
    if (songCounter >= 5 || songsSinceAd >= AD_EVERY_SONGS) return;
    if (await hasPendingRequestQuick()) return;
    if (await hasPendingAdminCommandQuick()) return;

    const currentDuration = getAudioDuration(media.file);
    if (!currentDuration || currentDuration - Number(media.resumeOffsetSec || 0) <= CROSSFADE_SECONDS + 4) return;

    const viable = media.candidatePool.filter(f => {
        if (f === media.file) return false;
        const d = getAudioDuration(f);
        return d && d > CROSSFADE_SECONDS + 4;
    });
    if (!viable.length) return;

    const nextFile = await claimRotationSong('MIX', viable);
    if (!nextFile || nextFile === media.file) return;

    await logPlayHistory(nextFile, 'MIX', 'auto-crossfade-preload');
    const nextMedia = {
        file: nextFile,
        title: cleanDisplayTitle(nextFile),
        genreLabel: 'Mix Πρόγραμμα',
        isSong: true,
        rotationKey: 'MIX',
        candidatePool: media.candidatePool,
        resumeOffsetSec: CROSSFADE_SECONDS
    };
    media.crossfadeNext = nextMedia;
    pendingMixMedia = nextMedia;
}

// ============================================================
// COUNTDOWN VIDEO FILTERS
// ============================================================
function athensTargetDate(spawnTime, daysFromNow, hour, minute, second) {
    const target = new Date(spawnTime.raw);
    target.setDate(target.getDate() + daysFromNow);
    target.setHours(hour, minute, second, 0);
    return target;
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
    const now = new Date().toISOString();
    const { error } = await supabase.from('station_status').upsert({
        id: 1, title, genre, updated_at: now, heartbeat_at: now, stream_owner: STREAM_OWNER_ID
    });
    if (error) console.error('[STATUS ERROR]', error.message);
}

async function startNextMedia() {
    if (isShuttingDown || (supabase && !ownsStreamLease)) return;

    const media = await selectNextFile();
    const spawnTime = getGreekTime();
    const background = selectBackgroundFile(spawnTime);

    if (!media || !background || !fs.existsSync(path.join(__dirname, media.file))) {
        setTimeout(startNextMedia, 2000);
        return;
    }

    currentMedia = media;

    if (media.isHourAnnouncement) songCounter = 0;
    else if (media.isSong && !media.isRequest) songCounter++;

    // ΠΡΟΣΘΗΚΗ: Ενημερώνει το Supabase για το τι παίζει τώρα στο site
    await updateStationStatus(media.title, media.genreLabel);

    if (media.isAd) songsSinceAd = 0;
    else if (media.isSong) songsSinceAd++;

    await maybePrepareMixCrossfade(media, spawnTime);
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

    // V5: time/date are two independent, always-on overlays. They are rendered AFTER blackout/countdown background filters.
    const baseOverlayFilters =
        `drawtext=fontfile='${CATEGORY_FONT}':text='${cleanLabel}':x=18:y=22:fontsize=15:fontcolor=yellow:box=1:boxcolor=black@0.55:boxborderw=6${normalOverlayEnable},` +
        `drawtext=fontfile='${TITLE_FONT}':text='${cleanTitle}':x=18:y=50:fontsize=18:fontcolor=white:box=1:boxcolor=black@0.55:boxborderw=7${normalOverlayEnable},` +
        `drawtext=fontfile='${TIME_FONT}':textfile='${CLOCK_TIME_FILE}':reload=1:x=w-tw-20:y=16:fontsize=26:fontcolor=0xFFD76A:box=1:boxcolor=black@0.72:boxborderw=10,` +
        `drawtext=fontfile='${TIME_FONT}':textfile='${CLOCK_DATE_FILE}':reload=1:x=w-tw-20:y=58:fontsize=15:fontcolor=white:box=1:boxcolor=black@0.62:boxborderw=7`;

    const countdownChain = ny.filters.length ? ',' + ny.filters.join(',') : '';
    const vfChain = `scale=854:480${blackoutFilter},${baseOverlayFilters}${countdownChain}`;

    const args = [
        '-hide_banner', '-loglevel', 'warning',
        '-re', '-fflags', '+genpts',
        '-loop', '1', '-framerate', '12', '-i', background
    ];

    const resumeOffset = Number(media.resumeOffsetSec || 0);
    if (resumeOffset > 0) args.push('-ss', resumeOffset.toFixed(3));
    args.push('-i', media.file);

    if (media.crossfadeNext) {
        args.push('-t', (CROSSFADE_SECONDS + 0.25).toFixed(2), '-i', media.crossfadeNext.file);
        const audioFilter =
            `[1:a]aresample=44100,aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo,asetpts=PTS-STARTPTS[a1];` +
            `[2:a]atrim=start=0:end=${CROSSFADE_SECONDS.toFixed(3)},aresample=44100,aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo,asetpts=PTS-STARTPTS[a2];` +
            `[a1][a2]acrossfade=d=${CROSSFADE_SECONDS.toFixed(3)}:c1=tri:c2=tri[aout]`;
        args.push('-filter_complex', audioFilter, '-map', '0:v:0', '-map', '[aout]');
    } else {
        args.push('-map', '0:v:0', '-map', '1:a:0', '-af', 'aresample=async=1:first_pts=0');
    }

    args.push(
        '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'stillimage', '-threads', '1',
        '-vf', vfChain,
        '-r', '12', '-g', '24', '-b:v', '2500k', '-maxrate', '2500k', '-bufsize', '5000k',
        '-c:a', 'aac', '-b:a', '192k',
        '-max_muxing_queue_size', '4096', '-shortest'
    );

    const cutAtMidnight = secondsUntilNewYearMidnight(spawnTime);
    if (media.isNewYearTestCountdown && ny.testEnd) {
        args.push('-t', String(ny.testEnd));
    } else if (cutAtMidnight !== null && cutAtMidnight > 0.25) {
        args.push('-t', cutAtMidnight.toFixed(3));
    }

    args.push('-pix_fmt', 'yuv420p', '-f', 'flv', `rtmp://a.rtmp.youtube.com/live2/${streamKey}`);

    console.log(`[PLAY] ${media.title} | ${media.genreLabel} | BG=${background}${media.crossfadeNext ? ` | crossfade->${media.crossfadeNext.title}` : ''}`);

    const ffmpeg = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    currentFfmpegProcess = ffmpeg;
    let stderrTail = '';
    ffmpeg.stderr?.on('data', chunk => { stderrTail = (stderrTail + chunk.toString()).slice(-1200); });

    if (media.crossfadeNext) {
        const duration = getAudioDuration(media.file);
        if (duration) {
            const delay = Math.max(0, (duration - resumeOffset - CROSSFADE_SECONDS) * 1000);
            currentCrossfadeTimer = setTimeout(() => {
                updateStationStatus(media.crossfadeNext.title, 'Mix Πρόγραμμα • Crossfade').catch(() => {});
            }, delay);
        }
    }

    ffmpeg.on('close', async (code, signal) => {
        if (currentCrossfadeTimer) clearTimeout(currentCrossfadeTimer);
        currentCrossfadeTimer = null;
        currentFfmpegProcess = null;
        currentMedia = null;

        const intentional = intentionalStopReason;
        intentionalStopReason = null;

        if (media.requestId && supabase) {
            if (code === 0 && !intentional) {
                await supabase.from('song_requests').update({ status: 'played', claimed_at: null, failure_reason: null }).eq('id', media.requestId);
            } else if (intentional) {
                // Handover / admin test: keep the listener's request for the next broadcaster.
                await supabase.from('song_requests').update({ status: 'pending', claimed_at: null }).eq('id', media.requestId);
            } else {
                // A corrupt/unplayable requested file is skipped ONCE instead of causing an endless retry loop.
                await markRequestSkipped(media.requestId, 'playback_error', `FFmpeg code ${code ?? 'unknown'}`);
            }
        }

        if (media.isNewYearTestCountdown && code === 0) {
            forcedNewYearTestQueue = buildNewYearSpecialSequence('TEST Πρωτοχρονιάς');
            if (forcedNewYearTest) forcedNewYearTest.phase = 'sequence';
        }

        if ((code && code !== 0) && !intentional && !isShuttingDown) {
            console.error(`[FFMPEG CLOSE] ${media.file} code=${code} signal=${signal || '-'} | ${stderrTail.replace(/\s+/g, ' ').slice(-900)}`);
            if (media.crossfadeNext) pendingMixMedia = null;
        }

        if (!isShuttingDown && (!supabase || ownsStreamLease)) {
            setTimeout(startNextMedia, intentional ? 150 : (code === 0 ? 150 : 1500));
        }
    });

    ffmpeg.on('error', async error => {
        if (currentCrossfadeTimer) clearTimeout(currentCrossfadeTimer);
        currentCrossfadeTimer = null;
        currentFfmpegProcess = null;
        currentMedia = null;
        pendingMixMedia = null;
        console.error('[FFMPEG SPAWN ERROR]', error.message);
        if (media.requestId && supabase) await markRequestSkipped(media.requestId, 'playback_error', `FFmpeg spawn: ${error.message}`);
        if (!isShuttingDown && (!supabase || ownsStreamLease)) setTimeout(startNextMedia, 2000);
    });
}

// ============================================================
// STREAM LEASE / HEARTBEAT
// ============================================================
async function acquireStreamLease() {
    if (!supabase) return true;
    const { data, error } = await supabase.rpc('acquire_stream_lease', { p_owner_id: STREAM_OWNER_ID, p_lease_seconds: STREAM_LEASE_SECONDS });
    if (error) {
        console.error('[LEASE ERROR]', error.message);
        return false;
    }
    ownsStreamLease = data === true;
    return ownsStreamLease;
}

async function renewStreamLease() {
    if (!supabase || !ownsStreamLease || isShuttingDown) return;
    const { data, error } = await supabase.rpc('renew_stream_lease', { p_owner_id: STREAM_OWNER_ID, p_lease_seconds: STREAM_LEASE_SECONDS });
    if (error || data !== true) {
        console.error('[LEASE LOST] Χάθηκε το lease. Σταματά ο encoder.');
        ownsStreamLease = false;
        if (currentFfmpegProcess) {
            intentionalStopReason = 'lease_lost';
            currentFfmpegProcess.kill('SIGTERM');
        }
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
    const now = new Date().toISOString();
    const { error } = await supabase.from('station_status').upsert({ id: 1, heartbeat_at: now, stream_owner: STREAM_OWNER_ID, updated_at: now });
    if (error) console.error('[HEARTBEAT ERROR]', error.message);
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
        startNextMedia();
        return;
    }

    while (!isShuttingDown) {
        if (await acquireStreamLease()) {
            console.log(`[LEASE] ${STREAM_OWNER_ID} έγινε ο ενεργός broadcaster.`);
            await startHeartbeat();
            if (leaseRenewTimer) clearInterval(leaseRenewTimer);
            leaseRenewTimer = setInterval(async () => {
                await renewStreamLease();
                if (ownsStreamLease) await startHeartbeat();
            }, 30000);
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
// SHUTDOWN / STARTUP
// ============================================================
async function gracefulShutdown(signal) {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.log(`[SHUTDOWN] ${signal} — τερματισμός encoder και release lease.`);

    if (leaseRenewTimer) clearInterval(leaseRenewTimer);
    if (clockWriterTimer) clearInterval(clockWriterTimer);
    if (commandPollTimer) clearInterval(commandPollTimer);
    if (currentCrossfadeTimer) clearTimeout(currentCrossfadeTimer);

    if (currentFfmpegProcess) {
        intentionalStopReason = 'shutdown';
        currentFfmpegProcess.kill('SIGTERM');
    }

    await releaseStreamLease();
    setTimeout(() => process.exit(0), 1200);
}

process.on('SIGTERM', () => { gracefulShutdown('SIGTERM'); });
process.on('SIGINT', () => { gracefulShutdown('SIGINT'); });

app.listen(PORT, '0.0.0.0', async () => {
    console.log(`Thavma Palmos V5 server στο port ${PORT}`);
    console.log(`[STREAM OWNER] ${STREAM_OWNER_ID}`);
    console.log(`[CONFIG] MIX crossfade=${CROSSFADE_SECONDS}s | ad every=${AD_EVERY_SONGS} songs | day=${DAY_BG_START_HOUR}:00-${NIGHT_BG_START_HOUR}:00`);

    startClockOverlayWriter();
    await syncSongsToSupabase();
    await recoverStaleRequests();

    commandPollTimer = setInterval(pollAdminCommands, 5000);
    if (startupNewYearTestRequested) {
        startupNewYearTestRequested = false;
        await beginForcedNewYearTest(null, 'GitHub workflow test');
    }

    await waitForLeaseAndStart();
});
