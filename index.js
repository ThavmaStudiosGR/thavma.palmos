process.env.TZ = 'Europe/Athens';

const express = require('express');
const cors = require('cors');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

let lastAnnouncedHour = getGreekTime().hour; 
let lastAnthemDate = getGreekTime().date; 
let songCounter = 0;
let currentNowPlaying = { title: "Φορτώνει...", genre: "Radio" };

let requestQueue = []; 
let globalPlayedSongs = [];

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

app.post('/api/request', (req, res) => {
    const { filename, requester } = req.body;
    
    if (!filename || !fs.existsSync(path.join(__dirname, filename))) {
        return res.status(400).json({ success: false, message: "Το τραγούδι δεν βρέθηκε." });
    }

    requestQueue.push({ filename: filename, requester: requester || "Άγνωστος" });
    console.log(`[REQUEST ADDED]: Προστέθηκε στην ουρά το ${filename} από τον/την ${requester}`);
    res.json({ success: true, message: "Η παραγγελιά καταχωρήθηκε!" });
});

app.get('/', (req, res) => {
    res.send('Thavma Παλμός Automation System v6.4 (New Release Priority) is Running!');
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`Ο Server ξεκίνησε στο port ${PORT}`);
    startNextMedia();
});

// -- Συναρτήσεις --
function getGreekTime() {
    const date = new Date();
    const greekString = date.toLocaleString("en-US", {timeZone: "Europe/Athens"});
    const greekDate = new Date(greekString);
    return {
        day: greekDate.getDay(),     
        date: greekDate.getDate(),   
        hour: greekDate.getHours(),  
        minute: greekDate.getMinutes()
    };
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
    return /^clock\d+\.mp3$/.test(fileName);
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

function selectNextFile() {
    const time = getGreekTime();
    
    // 1. Εθνικός Ύμνος
    if (time.hour === 0 && lastAnthemDate !== time.date) {
        if (fs.existsSync(path.join(__dirname, 'ethnikos_ymnos.mp3'))) {
            lastAnthemDate = time.date; 
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
            currentNowPlaying = { title: `Η ώρα είναι ${time.hour}:00`, genre: "Ώρα Ελλάδος" };
            return { file: hourFile, title: `Η ώρα είναι ${time.hour}:00`, genreLabel: 'Ώρα Ελλάδος', isHourAnnouncement: true };
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
    if (requestQueue.length > 0) {
        const reqData = requestQueue.shift();
        const requestedFile = reqData.filename;
        
        if (fs.existsSync(path.join(__dirname, requestedFile))) {
            let displayTitle = requestedFile.replace(/^\([A-ZΖΠα-ωήίόύέώ\s]+\)\s*/i, '').replace('.mp3', '').replace(/_/g, ' ');
            let displayGenre = `Παραγγελια Ακροατη [${reqData.requester}]`;
            
            return { file: requestedFile, title: displayTitle, genreLabel: displayGenre, isSong: true, isRequest: true };
        }
    }

    // 5. Κανονικό Τραγούδι (Με εντοπισμό Νέων Κυκλοφοριών!)
    const files = fs.readdirSync(__dirname);
    let mp3Files = files.filter(file => path.extname(file).toLowerCase() === '.mp3' && !isHourFile(file));

    if (mp3Files.length === 0) return null;

    const genre = getRequiredGenre();
    let filteredFiles = [];
    let genreLabel = "Mix Πρόγραμμα";

    if (genre === 'B') {
        filteredFiles = mp3Files.filter(f => f.startsWith('(B)'));
        genreLabel = "Beats (Disco, Club, Trap...)";
    } else if (genre === 'R') {
        filteredFiles = mp3Files.filter(f => f.startsWith('(R)'));
        genreLabel = "Radio";
    } else if (genre === 'P_LZ') {
        filteredFiles = mp3Files.filter(f => f.startsWith('(Π)') || f.startsWith('(ΛΖ)'));
        genreLabel = "Παραδοσιακά & Λαϊκά";
    } else if (genre === 'MIX_PREFER_P') {
        let pFiles = mp3Files.filter(f => f.startsWith('(Π)'));
        if (pFiles.length > 0 && Math.random() < 0.7) filteredFiles = pFiles;
        else filteredFiles = mp3Files;
        genreLabel = "Mix";
    } else {
        filteredFiles = mp3Files;
        genreLabel = "Mix";
    }

    if (filteredFiles.length === 0) filteredFiles = mp3Files;

    let availableFiles = filteredFiles.filter(f => !globalPlayedSongs.includes(f));

    if (availableFiles.length === 0) {
        globalPlayedSongs = globalPlayedSongs.filter(f => !filteredFiles.includes(f));
        availableFiles = filteredFiles;
    }

    // Λογική: Έλεγχος για "Νέο Τραγούδι" (Ηλικία κάτω των 3 ημερών)
    const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;
    const now = Date.now();
    let randomFile;

    let availableNewFiles = availableFiles.filter(f => {
        const filePath = path.join(__dirname, f);
        return fs.existsSync(filePath) && (now - fs.statSync(filePath).mtimeMs) <= THREE_DAYS_MS;
    });

    if (availableNewFiles.length > 0) {
        // Αν υπάρχουν διαθέσιμα νέα τραγούδια, ταξινομούμε με βάση το πιο φρέσκο upload πρώτο!
        availableNewFiles.sort((a, b) => {
            return fs.statSync(path.join(__dirname, b)).mtimeMs - fs.statSync(path.join(__dirname, a)).mtimeMs;
        });
        randomFile = availableNewFiles[0];
        genreLabel = "ΝΕΟ ΤΡΑΓΟΥΔΙ! - " + genreLabel;
    } else {
        // Αν δεν υπάρχουν νέα τραγούδια στο συγκεκριμένο είδος, παίζει κανονικό Shuffle
        randomFile = availableFiles[Math.floor(Math.random() * availableFiles.length)];
    }

    globalPlayedSongs.push(randomFile);

    let displayTitle = randomFile.replace(/^\([A-ZΖΠα-ωήίόύέώ\s]+\)\s*/i, '').replace('.mp3', '').replace(/_/g, ' ');

    return { file: randomFile, title: displayTitle, genreLabel: genreLabel, isSong: true };
}

function startNextMedia() {
    const media = selectNextFile(); 
    
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

    const cleanLabel = media.genreLabel.replace(/'/g, "’").replace(/:/g, "\\\\:").replace(/,/g, "\\\\,");
    const cleanTitle = media.title.replace(/'/g, "’").replace(/:/g, "\\\\:").replace(/,/g, "\\\\,");
    const clockText = "%{localtime\\:%H\\\\\\:%M\\\\\\:%S & %d\\\\\\/%m\\\\\\/%Y}";

    const ffmpeg = spawn('ffmpeg', [
        '-re', '-loop', '1', '-framerate', '2', '-i', 'background.jpg',
        '-i', media.file, 
        '-fflags', '+genpts',
        '-map', '0:v:0', '-map', '1:a:0',
        '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'stillimage', '-threads', '1',
        '-vf', `scale=1280:720, drawtext=text='${cleanLabel}':x=30:y=30:fontsize=20:fontcolor=yellow:box=1:boxcolor=black@0.6:boxborderw=8, drawtext=text='${cleanTitle}':x=30:y=65:fontsize=28:fontcolor=white:box=1:boxcolor=black@0.6:boxborderw=10, drawtext=text='${clockText}':x=w-tw-30:y=30:fontsize=20:fontcolor=black`,
        '-r', '15', '-g', '30', '-b:v', '2500k', '-maxrate', '2500k', '-bufsize', '5000k',
        '-c:a', 'aac', '-b:a', '128k', '-shortest', '-pix_fmt', 'yuv420p', '-f', 'flv',
        `rtmp://a.rtmp.youtube.com/live2/${streamKey}`
    ], { stdio: 'ignore' });

    ffmpeg.on('close', startNextMedia);
    ffmpeg.on('error', startNextMedia);
}