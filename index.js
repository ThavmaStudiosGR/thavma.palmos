process.env.TZ = 'Europe/Athens'; // Επιβάλλει την ώρα Ελλάδος σε όλο τον server και στο FFmpeg

const express = require('express');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;

// Αρχικό κλείδωμα της ώρας και της ημέρας κατά την εκκίνηση του server
let lastAnnouncedHour = getGreekTime().hour; 
let lastAnthemDate = getGreekTime().date; 
let songCounter = 0;
let currentNowPlaying = { title: "Φορτώνει...", genre: "Radio" };

// Έξυπνο "Shuffle" χωρίς επαναλήψεις - Ιστορικό ανά κατηγορία
let playedSongs = {
    'B': [],
    'R': [],
    'P_LZ': [],
    'MIX_PREFER_P': [],
    'MIX': []
};

// API για την ιστοσελίδα
app.get('/api/now-playing', (req, res) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.json(currentNowPlaying);
});

app.get('/', (req, res) => {
    res.send('Thavma Παλμός Automation System v5.0 (Smart Queue & Live Clock) is Running!');
});

app.listen(PORT, () => {
    console.log(`Server is listening on port ${PORT}`);
    startNextMedia();
});

function getGreekTime() {
    const date = new Date();
    const greekString = date.toLocaleString("en-US", {timeZone: "Europe/Athens"});
    const greekDate = new Date(greekString);
    return {
        day: greekDate.getDay(),     // 0-6 (Κυριακή-Σάββατο)
        date: greekDate.getDate(),   // 1-31 (Ημέρα μήνα)
        hour: greekDate.getHours(),  // 0-23
        minute: greekDate.getMinutes()
    };
}

function findHourFile(hour) {
    const files = fs.readdirSync(__dirname);
    const expectedFile = `clock${hour}.mp3`; 
    
    if (files.includes(expectedFile)) {
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
    
    // 1. Εθνικός Ύμνος ακριβώς στις 00:00 (Μία φορά την ημέρα)
    if (time.hour === 0 && lastAnthemDate !== time.date) {
        if (fs.existsSync(path.join(__dirname, 'ethnikos_ymnos.mp3'))) {
            lastAnthemDate = time.date; 
            currentNowPlaying = { title: "ΕΘΝΙΚΟΣ ΥΜΝΟΣ", genre: "Ειδική Μετάδοση" };
            return { file: 'ethnikos_ymnos.mp3', title: 'ΕΘΝΙΚΟΣ ΥΜΝΟΣ', genreLabel: 'Ειδική Μετάδοση' };
        }
    }

    // 2. Αναγγελία Ώρας (Μόλις αλλάξει η ώρα)
    if (lastAnnouncedHour !== time.hour) {
        const hourFile = findHourFile(time.hour);
        if (hourFile) {
            lastAnnouncedHour = time.hour;
            currentNowPlaying = { title: `Η ώρα είναι ${time.hour}:00`, genre: "Ώρα Ελλάδος" };
            return { file: hourFile, title: `Η ώρα είναι ${time.hour}:00`, isHourAnnouncement: true, genreLabel: 'Ώρα Ελλάδος' };
        }
    }

    // 3. Jingle ανά 5 τραγούδια
    if (songCounter >= 5) {
        if (fs.existsSync(path.join(__dirname, 'thavma_palmos_jingle.mp3'))) {
            songCounter = 0;
            currentNowPlaying = { title: "Thavma Παλμός Jingle", genre: "Σήμα Σταθμού" };
            return { file: 'thavma_palmos_jingle.mp3', title: 'Thavma Παλμός Jingle', genreLabel: 'Σήμα Σταθμού' };
        }
    }

    // 4. Επιλογή Τραγουδιού
    const files = fs.readdirSync(__dirname);
    let mp3Files = files.filter(file => 
        path.extname(file).toLowerCase() === '.mp3' && !isHourFile(file)
    );

    if (mp3Files.length === 0) return null;

    const genre = getRequiredGenre();
    let filteredFiles = [];
    let genreLabel = "Mix Πρόγραμμα";

    if (genre === 'B') {
        filteredFiles = mp3Files.filter(f => f.startsWith('(B)'));
        genreLabel = "Beats (Disco, Dance, Club)";
    } else if (genre === 'R') {
        filteredFiles = mp3Files.filter(f => f.startsWith('(R)'));
        genreLabel = "Radio (Κανονική Ροή)";
    } else if (genre === 'P_LZ') {
        filteredFiles = mp3Files.filter(f => f.startsWith('(Π)') || f.startsWith('(ΛΖ)'));
        genreLabel = "Παραδοσιακά & Λαϊκά";
    } else if (genre === 'MIX_PREFER_P') {
        let pFiles = mp3Files.filter(f => f.startsWith('(Π)'));
        if (pFiles.length > 0 && Math.random() < 0.7) filteredFiles = pFiles;
        else filteredFiles = mp3Files;
        genreLabel = "Mix (Έμφαση στα Παραδοσιακά)";
    } else {
        filteredFiles = mp3Files;
        genreLabel = "Mix Πρόγραμμα";
    }

    if (filteredFiles.length === 0) filteredFiles = mp3Files;

    // Έξυπνο Queue (Shuffle χωρίς επαναλήψεις)
    if (!playedSongs[genre]) playedSongs[genre] = [];
    
    // Φιλτράρουμε μόνο τα τραγούδια που ΔΕΝ έχουν παιχτεί ακόμα σε αυτή την κατηγορία
    let availableFiles = filteredFiles.filter(f => !playedSongs[genre].includes(f));

    // Αν παίχτηκαν όλα, μηδενίζουμε το ιστορικό της κατηγορίας για να ξαναρχίσει ο κύκλος
    if (availableFiles.length === 0) {
        playedSongs[genre] = [];
        availableFiles = filteredFiles;
    }

    const randomFile = availableFiles[Math.floor(Math.random() * availableFiles.length)];
    
    // Προσθήκη στο ιστορικό
    playedSongs[genre].push(randomFile);

    let displayTitle = randomFile.replace(/^\([A-ZΖΠα-ωήίόύέώ\s]+\)\s*/i, '').replace('.mp3', '').replace(/_/g, ' ');

    songCounter++;
    currentNowPlaying = { title: displayTitle, genre: genreLabel };
    
    return { file: randomFile, title: displayTitle, genreLabel: genreLabel };
}

function startNextMedia() {
    const media = selectNextFile();
    
    if (!media || !fs.existsSync(path.join(__dirname, 'background.jpg'))) {
        console.log("Λείπει αρχείο! Ξαναδοκιμάζω σε 5 δευτερόλεπτα...");
        setTimeout(startNextMedia, 5000);
        return;
    }

    const streamKey = process.env.YOUTUBE_STREAM_KEY;
    if (!streamKey) return;

    const cleanLabel = media.genreLabel.replace(/'/g, "’");
    const cleanTitle = media.title.replace(/'/g, "’");

    console.log(`[PLAYING]: ${media.title}`);

    const ffmpeg = spawn('ffmpeg', [
        '-re',
        '-loop', '1', 
        '-framerate', '2',
        '-i', 'background.jpg',
        '-re', 
        '-i', media.file,
        '-map', '0:v:0',
        '-map', '1:a:0',
        '-c:v', 'libx264',
        '-preset', 'ultrafast',
        '-tune', 'stillimage',
        '-threads', '1', 
        '-vf', `scale=1280:720, drawtext=fontfile=Century.ttf:text='${cleanLabel}':x=30:y=30:fontsize=20:fontcolor=yellow:box=1:boxcolor=black@0.6:boxborderw=8, drawtext=fontfile=CenturyGothic.ttf:text='${cleanTitle}':x=30:y=65:fontsize=28:fontcolor=white:box=1:boxcolor=black@0.6:boxborderw=10, drawtext=fontfile=CenturyGothic.ttf:text='%{localtime\\:%H\\\\:%M\\\\:%S & %d/%m/%Y}':x=w-tw-30:y=30:fontsize=20:fontcolor=white:box=1:boxcolor=black@0.6:boxborderw=8`,
        '-r', '15', 
        '-g', '30', 
        '-b:v', '2500k',       
        '-maxrate', '2500k',
        '-bufsize', '5000k',
        '-c:a', 'aac',
        '-b:a', '128k',
        '-shortest',
        '-pix_fmt', 'yuv420p',
        '-f', 'flv',
        `rtmp://a.rtmp.youtube.com/live2/${streamKey}`
    ], {
        stdio: 'ignore' 
    });

    ffmpeg.on('close', () => {
        startNextMedia(); // Ξεκινάει απευθείας το επόμενο τραγούδι
    });

    ffmpeg.on('error', (err) => {
        console.error('Σφάλμα FFmpeg:', err);
        startNextMedia();
    });
}