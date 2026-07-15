'hello'

process.env.TZ = 'Europe/Athens';

const express = require('express');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;

let lastAnnouncedHour = getGreekTime().hour; 
let lastAnthemDate = getGreekTime().date; 
let songCounter = 0;
let currentNowPlaying = { title: "Φορτώνει...", genre: "Radio" };

// Ιστορικό για να μην επαναλαμβάνονται τα τραγούδια
let playedSongs = {
    'B': [],
    'R': [],
    'P_LZ': [],
    'MIX_PREFER_P': [],
    'MIX': []
};

app.get('/api/now-playing', (req, res) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.json(currentNowPlaying);
});


app.get('/', (req, res) => {
    res.send('Thavma Παλμός Automation System v6.1 is Running!');
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server is listening on port ${PORT}`);
    startNextMedia();
});

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

    // 4. Κανονικό Τραγούδι
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

    // Έλεγχος μνήμης Shuffle
    if (!playedSongs[genre]) playedSongs[genre] = [];
    let availableFiles = filteredFiles.filter(f => !playedSongs[genre].includes(f));

    if (availableFiles.length === 0) {
        playedSongs[genre] = [];
        availableFiles = filteredFiles;
    }

    const randomFile = availableFiles[Math.floor(Math.random() * availableFiles.length)];
    playedSongs[genre].push(randomFile);

    let displayTitle = randomFile.replace(/^\([A-ZΖΠα-ωήίόύέώ\s]+\)\s*/i, '').replace('.mp3', '').replace(/_/g, ' ');

    return { file: randomFile, title: displayTitle, genreLabel: genreLabel, isSong: true };
}

function startNextMedia() {
    const media = selectNextFile();
    
    if (!media || !fs.existsSync(path.join(__dirname, 'background.jpg'))) {
        console.log("Λείπει το background. Ξαναδοκιμάζω σε 5 δευτερόλεπτα...");
        setTimeout(startNextMedia, 5000);
        return;
    }

    if (media.isHourAnnouncement) {
        songCounter = 0; 
    } else if (media.isSong) {
        songCounter++;
    }

    currentNowPlaying = { title: media.title, genre: media.genreLabel };

    const streamKey = process.env.YOUTUBE_STREAM_KEY;
    if (!streamKey) {
        console.error("Λείπει το YOUTUBE_STREAM_KEY!");
        setTimeout(startNextMedia, 5000);
        return;
    }

    const cleanLabel = media.genreLabel.replace(/'/g, "’");
    const cleanTitle = media.title.replace(/'/g, "’");

    console.log(`[PLAYING]: ${media.title}`);

    const clockText = "%{localtime\\:%H\\\\\\:%M\\\\\\:%S & %d\\\\\\/%m\\\\\\/%Y}";

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
        '-vf', `scale=1280:720, drawtext=text='${cleanLabel}':x=30:y=30:fontsize=20:fontcolor=yellow:box=1:boxcolor=black@0.6:boxborderw=8, drawtext=text='${cleanTitle}':x=30:y=65:fontsize=28:fontcolor=white:box=1:boxcolor=black@0.6:boxborderw=10, drawtext=text='${clockText}':x=w-tw-30:y=30:fontsize=20:fontcolor=white:box=1:boxcolor=black@0.6:boxborderw=8`,
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
        // Τέλος η καθυστέρηση! Ξεκινάει αμέσως το επόμενο τραγούδι για να μην κοπεί η ροή στο YT
        startNextMedia(); 
    });

    ffmpeg.on('error', (err) => {
        console.error('Σφάλμα FFmpeg:', err);
        startNextMedia();
    });
}process.env.TZ = 'Europe/Athens';

const express = require('express');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;

let lastAnnouncedHour = getGreekTime().hour; 
let lastAnthemDate = getGreekTime().date; 
let songCounter = 0;
let currentNowPlaying = { title: "Φορτώνει...", genre: "Radio" };

// Ιστορικό για να μην επαναλαμβάνονται τα τραγούδια
let playedSongs = {
    'B': [],
    'R': [],
    'P_LZ': [],
    'MIX_PREFER_P': [],
    'MIX': []
};

app.get('/api/now-playing', (req, res) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.json(currentNowPlaying);
});

app.get('/', (req, res) => {
    res.send('Thavma Παλμός Automation System v6.1 is Running!');
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server is listening on port ${PORT}`);
    startNextMedia();
});

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

    // 4. Κανονικό Τραγούδι
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

    // Έλεγχος μνήμης Shuffle
    if (!playedSongs[genre]) playedSongs[genre] = [];
    let availableFiles = filteredFiles.filter(f => !playedSongs[genre].includes(f));

    if (availableFiles.length === 0) {
        playedSongs[genre] = [];
        availableFiles = filteredFiles;
    }

    const randomFile = availableFiles[Math.floor(Math.random() * availableFiles.length)];
    playedSongs[genre].push(randomFile);

    let displayTitle = randomFile.replace(/^\([A-ZΖΠα-ωήίόύέώ\s]+\)\s*/i, '').replace('.mp3', '').replace(/_/g, ' ');

    return { file: randomFile, title: displayTitle, genreLabel: genreLabel, isSong: true };
}

function startNextMedia() {
    const media = selectNextFile();
    
    if (!media || !fs.existsSync(path.join(__dirname, 'background.jpg'))) {
        console.log("Λείπει το background. Ξαναδοκιμάζω σε 5 δευτερόλεπτα...");
        setTimeout(startNextMedia, 5000);
        return;
    }

    if (media.isHourAnnouncement) {
        songCounter = 0; 
    } else if (media.isSong) {
        songCounter++;
    }

    currentNowPlaying = { title: media.title, genre: media.genreLabel };

    const streamKey = process.env.YOUTUBE_STREAM_KEY;
    if (!streamKey) {
        console.error("Λείπει το YOUTUBE_STREAM_KEY!");
        setTimeout(startNextMedia, 5000);
        return;
    }

    const cleanLabel = media.genreLabel.replace(/'/g, "’");
    const cleanTitle = media.title.replace(/'/g, "’");

    console.log(`[PLAYING]: ${media.title}`);

    const clockText = "%{localtime\\:%H\\\\\\:%M\\\\\\:%S & %d\\\\\\/%m\\\\\\/%Y}";

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
        '-vf', `scale=1280:720, drawtext=text='${cleanLabel}':x=30:y=30:fontsize=20:fontcolor=yellow:box=1:boxcolor=black@0.6:boxborderw=8, drawtext=text='${cleanTitle}':x=30:y=65:fontsize=28:fontcolor=white:box=1:boxcolor=black@0.6:boxborderw=10, drawtext=text='${clockText}':x=w-tw-30:y=30:fontsize=20:fontcolor=white:box=1:boxcolor=black@0.6:boxborderw=8`,
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
        // Τέλος η καθυστέρηση! Ξεκινάει αμέσως το επόμενο τραγούδι για να μην κοπεί η ροή στο YT
        startNextMedia(); 
    });

    ffmpeg.on('error', (err) => {
        console.error('Σφάλμα FFmpeg:', err);
        startNextMedia();
    });
}