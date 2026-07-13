const express = require('express');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;

let songCounter = 0;
let lastAnnouncedHour = -1; 

// Μεταβλητή που κρατάει το τρέχον τραγούδι για να το στέλνει στο site σου
let currentNowPlaying = { title: "Φορτώνει...", genre: "Radio" };

// API Endpoint για την ιστοσελίδα σου (Επιτρέπει στο site να τραβάει τα δεδομένα)
app.get('/api/now-playing', (req, res) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.json(currentNowPlaying);
});

app.get('/', (req, res) => {
    res.send('Thavma Παλμός Automation System v3.0 (Stable) is Running!');
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
        day: greekDate.getDay(),
        hour: greekDate.getHours(),
        minute: greekDate.getMinutes()
    };
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
    
    if (time.hour === 0 && lastAnnouncedHour !== 0) {
        if (fs.existsSync(path.join(__dirname, 'ethnikos_ymnos.mp3'))) {
            lastAnnouncedHour = 0;
            currentNowPlaying = { title: "ΕΘΝΙΚΟΣ ΥΜΝΟΣ", genre: "Ειδική Μετάδοση" };
            return { file: 'ethnikos_ymnos.mp3', title: 'ΕΘΝΙΚΟΣ ΥΜΝΟΣ', genreLabel: 'Ειδική Μετάδοση' };
        }
    }

    if (lastAnnouncedHour !== time.hour) {
        let fileHour = time.hour % 12;
        let altHour = fileHour + 12;
        let hourFileName = `${fileHour} - ${altHour}.mp3`;

        if (fs.existsSync(path.join(__dirname, hourFileName))) {
            lastAnnouncedHour = time.hour;
            currentNowPlaying = { title: `Η ώρα είναι ${time.hour}:00`, genre: "Ώρα Ελλάδος" };
            return { file: hourFileName, title: `Η ώρα είναι ${time.hour}:00`, isHourAnnouncement: true, genreLabel: 'Ώρα Ελλάδος' };
        }
    }

    if (songCounter >= 5) {
        if (fs.existsSync(path.join(__dirname, 'thavma_palmos_jingle.mp3'))) {
            songCounter = 0;
            currentNowPlaying = { title: "Thavma Παλμός Jingle", genre: "Σήμα Σταθμού" };
            return { file: 'thavma_palmos_jingle.mp3', title: 'Thavma Παλμός Jingle', genreLabel: 'Σήμα Σταθμού' };
        }
    }

    const files = fs.readdirSync(__dirname);
    let mp3Files = files.filter(file => path.extname(file).toLowerCase() === '.mp3' 
        && !file.includes(' - ') 
        && file !== 'thavma_palmos_jingle.mp3' 
        && file !== 'ethnikos_ymnos.mp3'
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
        if (pFiles.length > 0 && Math.random() < 0.7) {
            filteredFiles = pFiles;
        } else {
            filteredFiles = mp3Files;
        }
        genreLabel = "Mix (Έμφαση στα Παραδοσιακά)";
    }

    if (filteredFiles.length === 0) {
        filteredFiles = mp3Files;
    }

    const randomFile = filteredFiles[Math.floor(Math.random() * filteredFiles.length)];
    let displayTitle = randomFile.replace(/^\([A-ZΖΠα-ωήίόύέώ\s]+\)\s*/i, '').replace('.mp3', '').replace(/_/g, ' ');

    songCounter++;
    
    // Ανανεώνει τα δεδομένα για το site σου
    currentNowPlaying = { title: displayTitle, genre: genreLabel };
    
    return { file: randomFile, title: displayTitle, genreLabel: genreLabel };
}

function startNextMedia() {
    const media = selectNextFile();
    
    if (!media) {
        setTimeout(startNextMedia, 5000);
        return;
    }

    const streamKey = process.env.YOUTUBE_STREAM_KEY;
    if (!streamKey) return;

    const cleanLabel = media.genreLabel.replace(/'/g, "’");
    const cleanTitle = media.title.replace(/'/g, "’");

    const ffmpeg = spawn('ffmpeg', [
        '-loop', '1',
        '-framerate', '10', 
        '-i', 'background.jpg',
        '-re',
        '-i', media.file,
        '-map', '0:v:0',
        '-map', '1:a:0',
        '-c:v', 'libx264',
        '-preset', 'veryfast', 
        '-tune', 'stillimage',
        '-threads', '2', 
        '-vf', `scale=1280:720,drawtext=text='${cleanLabel}':x=30:y=30:fontsize=20:fontcolor=yellow:box=1:boxcolor=black@0.6:boxborderw=8, drawtext=text='${cleanTitle}':x=30:y=65:fontsize=28:fontcolor=white:box=1:boxcolor=black@0.6:boxborderw=10`,
        '-b:v', '400k', // Σταματάει το θόλωμα
        '-maxrate', '400k',
        '-bufsize', '800k', // Σταθεροποιεί τη ροή
        '-c:a', 'aac',
        '-b:a', '128k',
        '-shortest',
        '-pix_fmt', 'yuv420p',
        '-f', 'flv',
        `rtmp://a.rtmp.youtube.com/live2/${streamKey}`
    ]);

    ffmpeg.on('close', (code) => {
        if (media.isHourAnnouncement) {
            forceJingleNext();
        } else {
            startNextMedia();
        }
    });
}

function forceJingleNext() {
    const streamKey = process.env.YOUTUBE_STREAM_KEY;
    if (!fs.existsSync(path.join(__dirname, 'thavma_palmos_jingle.mp3')) || !streamKey) {
        startNextMedia();
        return;
    }
    
    currentNowPlaying = { title: "Thavma Παλμός Jingle", genre: "Σήμα Σταθμού" };

    const ffmpeg = spawn('ffmpeg', [
        '-loop', '1', 
        '-framerate', '10', 
        '-i', 'background.jpg',
        '-re', 
        '-i', 'thavma_palmos_jingle.mp3',
        '-map', '0:v:0', 
        '-map', '1:a:0',
        '-c:v', 'libx264', 
        '-preset', 'veryfast', 
        '-tune', 'stillimage',
        '-threads', '2',
        '-vf', "scale=1280:720,drawtext=text='Σήμα Σταθμού':x=30:y=30:fontsize=20:fontcolor=yellow:box=1:boxcolor=black@0.6:boxborderw=8, drawtext=text='Thavma Παλμός Jingle':x=30:y=65:fontsize=28:fontcolor=white:box=1:boxcolor=black@0.6:boxborderw=10",
        '-b:v', '400k', 
        '-maxrate', '400k', 
        '-bufsize', '800k',
        '-c:a', 'aac', 
        '-b:a', '128k', 
        '-shortest', 
        '-pix_fmt', 'yuv420p', 
        '-f', 'flv',
        `rtmp://a.rtmp.youtube.com/live2/${streamKey}`
    ]);

    ffmpeg.on('close', () => {
        songCounter = 0; 
        startNextMedia();
    });
}