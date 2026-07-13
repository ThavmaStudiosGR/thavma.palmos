const express = require('express');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;

// Μετρητής για το jingle ανά 5 τραγούδια
let songCounter = 0;
// Κρατάει την τελευταία ώρα που ανακοινώθηκε για να μην διπλοπαίζει στο ίδιο ωριαίο slot
let lastAnnouncedHour = -1; 

app.get('/', (req, res) => {
    res.send('Thavma Παλμός Automation System Premium v2.0 is Running!');
});

app.listen(PORT, () => {
    console.log(`Server is listening on port ${PORT}`);
    startNextMedia();
});

// Λήψη Ώρας Ελλάδος (Υπολογίζει αυτόματα θερινή/χειμερινή ώρα)
function getGreekTime() {
    const date = new Date();
    const greekString = date.toLocaleString("en-US", {timeZone: "Europe/Athens"});
    const greekDate = new Date(greekString);
    return {
        day: greekDate.getDay(), // 0 = Κυριακή, 1 = Δευτέρα... 6 = Σάββατο
        hour: greekDate.getHours(),
        minute: greekDate.getMinutes()
    };
}

// Λήψη του σωστού είδους μουσικής βάσει του προγράμματός σου
function getRequiredGenre() {
    const time = getGreekTime();
    const d = time.day;
    const h = time.hour;

    // Σαββατοκύριακο (0 = Κυριακή, 6 = Σάββατο)
    if (d === 0 || d === 6) {
        if ((h >= 12 && h < 16) || (h >= 20 && h < 24)) return 'MIX_PREFER_P';
        return 'MIX';
    }

    // Δευτέρα (1), Τετάρτη (3), Παρασκευή (5)
    if (d === 1 || d === 3 || d === 5) {
        if (h >= 2 && h < 7) return 'B';
        if (h >= 7 && h < 12) return 'R';
        if (h >= 12 && h < 17) return 'P_LZ';
        if (h >= 17 && h < 20) return 'R';
        return 'MIX'; // 20:00 - 02:00
    }

    // Τρίτη (2), Πέμπτη (4)
    if (d === 2 || d === 4) {
        if (h >= 0 && h < 8) return 'B';
        if (h >= 8 && h < 12) return 'R';
        if (h >= 12 && h < 16) return 'P_LZ';
        if (h >= 16 && h < 20) return 'R';
        return 'MIX'; // 20:00 - 00:00
    }

    return 'MIX';
}

// Διάλεξε το επόμενο αρχείο ήχου που πρέπει να παίξει
function selectNextFile() {
    const time = getGreekTime();
    
    // 1. Έλεγχος για Εθνικό Ύμνο (Μεσάνυχτα 00:00)
    if (time.hour === 0 && lastAnnouncedHour !== 0) {
        if (fs.existsSync(path.join(__dirname, 'ethnikos_ymnos.mp3'))) {
            lastAnnouncedHour = 0;
            return { file: 'ethnikos_ymnos.mp3', title: 'ΕΘΝΙΚΟΣ ΥΜΝΟΣ' };
        }
    }

    // 2. Έλεγχος για Αναγγελία Ώρας (Κάθε ακριβώς)
    if (lastAnnouncedHour !== time.hour) {
        let fileHour = time.hour % 12;
        let altHour = fileHour + 12;
        let hourFileName = `${fileHour} - ${altHour}.mp3`;

        if (fs.existsSync(path.join(__dirname, hourFileName))) {
            lastAnnouncedHour = time.hour;
            return { file: hourFileName, title: `Η ώρα είναι ${time.hour}:00`, isHourAnnouncement: true };
        }
    }

    // 3. Έλεγχος για Jingle ανά 5 τραγούδια
    if (songCounter >= 5) {
        if (fs.existsSync(path.join(__dirname, 'thavma_palmos_jingle.mp3'))) {
            songCounter = 0;
            return { file: 'thavma_palmos_jingle.mp3', title: 'Thavma Παλμός Jingle' };
        }
    }

    // 4. Φιλτράρισμα και επιλογή κανονικού τραγουδιού
    const files = fs.readdirSync(__dirname);
    let mp3Files = files.filter(file => path.extname(file).toLowerCase() === '.mp3' 
        && !file.includes(' - ') 
        && file !== 'thavma_palmos_jingle.mp3' 
        && file !== 'ethnikos_ymnos.mp3'
    );

    if (mp3Files.length === 0) return null;

    const genre = getRequiredGenre();
    let filteredFiles = [];

    if (genre === 'B') {
        filteredFiles = mp3Files.filter(f => f.startsWith('(B)'));
    } else if (genre === 'R') {
        filteredFiles = mp3Files.filter(f => f.startsWith('(R)'));
    } else if (genre === 'P_LZ') {
        filteredFiles = mp3Files.filter(f => f.startsWith('(Π)') || f.startsWith('(ΛΖ)'));
    } else if (genre === 'MIX_PREFER_P') {
        // Σαββατοκύριακο: 70% πιθανότητα να διαλέξει Παραδοσιακό, 30% οτιδήποτε άλλο
        let pFiles = mp3Files.filter(f => f.startsWith('(Π)'));
        if (pFiles.length > 0 && Math.random() < 0.7) {
            filteredFiles = pFiles;
        } else {
            filteredFiles = mp3Files;
        }
    }

    // Αν δεν βρει τραγούδι της συγκεκριμένης κατηγορίας, παίρνει από τα διαθέσιμα για να μην κολλήσει
    if (filteredFiles.length === 0) {
        filteredFiles = mp3Files;
    }

    const randomFile = filteredFiles[Math.floor(Math.random() * filteredFiles.length)];
    
    // Καθαρισμός του τίτλου από τα (Π), (Β) και το .mp3 για να φαίνεται όμορφα στην οθόνη
    let displayTitle = randomFile.replace(/^\([A-ZΖΠα-ωήίόύέώ\s]+\)\s*/i, '').replace('.mp3', '').replace(/_/g, ' ');

    songCounter++;
    return { file: randomFile, title: displayTitle };
}

function startNextMedia() {
    const media = selectNextFile();
    
    if (!media) {
        console.error("No audio files found! Retrying in 5 seconds...");
        setTimeout(startNextMedia, 5000);
        return;
    }

    const streamKey = process.env.YOUTUBE_STREAM_KEY;
    if (!streamKey) {
        console.error("YOUTUBE_STREAM_KEY is missing!");
        return;
    }

    console.log(`[PLAYING]: ${media.title}`);

    // Ροή FFmpeg με εντολή drawtext για εμφάνιση του τίτλου ζωντανά στην οθόνη του YouTube
    const ffmpeg = spawn('ffmpeg', [
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
        // Σχεδίαση τίτλου στο κάτω μέρος της οθόνης με μαύρο ημιδιάφανο φόντο
        '-vf', `drawtext=text='${media.title}':x=(w-text_w)/2:y=h-120:fontsize=42:fontcolor=white:box=1:boxcolor=black@0.6:boxborderw=15`,
        '-r', '15',
        '-g', '30',
        '-b:v', '150k',
        '-maxrate', '150k',
        '-bufsize', '300k',
        '-c:a', 'aac',
        '-b:a', '128k',
        '-shortest',
        '-pix_fmt', 'yuv420p',
        '-f', 'flv',
        `rtmp://a.rtmp.youtube.com/live2/${streamKey}`
    ]);

    ffmpeg.on('close', (code) => {
        // Αν μόλις τελείωσε αναγγελία ώρας, επιβάλλουμε να παιχτεί ΑΜΕΣΩΣ το jingle
        if (media.isHourAnnouncement) {
            console.log("Hour announcement finished. Forcing immediate Jingle...");
            forceJingleNext();
        } else {
            startNextMedia();
        }
    });
}

// Συνάρτηση που αναγκάζει το jingle να παίξει καπάκι μετά την ώρα
function forceJingleNext() {
    const streamKey = process.env.YOUTUBE_STREAM_KEY;
    if (!fs.existsSync(path.join(__dirname, 'thavma_palmos_jingle.mp3')) || !streamKey) {
        startNextMedia();
        return;
    }

    const ffmpeg = spawn('ffmpeg', [
        '-loop', '1', '-framerate', '2', '-i', 'background.jpg',
        '-re', '-i', 'thavma_palmos_jingle.mp3',
        '-map', '0:v:0', '-map', '1:a:0',
        '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'stillimage',
        '-vf', "drawtext=text='Thavma Παλμός Jingle':x=(w-text_w)/2:y=h-120:fontsize=42:fontcolor=white:box=1:boxcolor=black@0.6:boxborderw=15",
        '-r', '15', '-g', '30', '-b:v', '150k', '-maxrate', '150k', '-bufsize', '300k',
        '-c:a', 'aac', '-b:a', '128k', '-shortest', '-pix_fmt', 'yuv420p', '-f', 'flv',
        `rtmp://a.rtmp.youtube.com/live2/${streamKey}`
    ]);

    ffmpeg.on('close', () => {
        songCounter = 0; // Μηδενισμός του μετρητή αφού μόλις ακούστηκε jingle
        startNextMedia();
    });
}