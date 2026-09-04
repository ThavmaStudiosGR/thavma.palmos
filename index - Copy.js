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

let lastAnnouncedHour = getGreekTime().hour; 
let lastAnthemDate = getGreekTime().date; 
let songCounter = 0;
let currentNowPlaying = { title: "Φορτώνει...", genre: "Radio" };

let requestQueue = []; 
let globalPlayedSongs = [];
let specialSequenceQueue = []; // Ουρά για ειδικές αλληλουχίες (Πρωτοχρονιά)

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
    res.send('Thavma Παλμός Automation System v6.5 (FFmpeg Chime Fix) is Running!');
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
        month: greekDate.getMonth(), // 0 = Ιανουάριος, 10 = Νοέμβριος, 11 = Δεκέμβριος
        hour: greekDate.getHours(),  
        minute: greekDate.getMinutes()
    };
}

// Έλεγχος αν είμαστε στη Χριστουγεννιάτικη περίοδο (18 Νοεμβρίου έως 31 Ιανουαρίου)
function isChristmasSeason(time) {
    const { month, date } = time;
    if (month === 10 && date >= 18) return true; // 18 - 30 Νοεμβρίου
    if (month === 11) return true;               // 1 - 31 Δεκεμβρίου
    if (month === 0 && date <= 31) return true;  // 1 - 31 Ιανουαρίου
    return false;
}

// Έλεγχος αν είμαστε στις 2 πρώτες ώρες της 1ης Ιανουαρίου (00:00 - 01:59)
function isJan1FirstTwoHours(time) {
    return time.month === 0 && time.date === 1 && (time.hour === 0 || time.hour === 1);
}

function findHourFile(hour) {
    const expectedFile = `clock${hour}.mp3`; 
    if (fs.existsSync(path.join(__dirname, expectedFile))) {
        return expectedFile;
    }
    return null;
}

function isHourFile(fileName) {
    const systemFiles = [
        'thavma_palmos_jingle.mp3', 
        'thavma_palmos_christmas_jingle.mp3', 
        'ethnikos_ymnos.mp3',
        'ΚαλήΧρονιά.mp3',
        'Αρχιμηνιά και Αρχιχρονιά το λάδι 19.mp3'
    ];
    if (systemFiles.includes(fileName)) return true;
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

    // 0. ΕΙΔΙΚΗ ΑΚΟΛΟΥΘΙΑ (Π.χ. Πρωτοχρονιάτικα αρχεία στη σειρά)
    if (specialSequenceQueue.length > 0) {
        const nextItem = specialSequenceQueue.shift();
        if (fs.existsSync(path.join(__dirname, nextItem.file))) {
            currentNowPlaying = { title: nextItem.title, genre: nextItem.genreLabel };
            return { file: nextItem.file, title: nextItem.title, genreLabel: nextItem.genreLabel, isSystem: true };
        }
    }
    
    // 1. ΕΘΝΙΚΟΣ ΥΜΝΟΣ (00:00)
    if (time.hour === 0 && lastAnthemDate !== time.date) {
        if (fs.existsSync(path.join(__dirname, 'ethnikos_ymnos.mp3'))) {
            lastAnthemDate = time.date; 
            currentNowPlaying = { title: "ΕΘΝΙΚΟΣ ΥΜΝΟΣ", genre: "Ειδική Μετάδοση" };
            return { file: 'ethnikos_ymnos.mp3', title: 'ΕΘΝΙΚΟΣ ΥΜΝΟΣ', genreLabel: 'Ειδική Μετάδοση', isSystem: true };
        }
    }

    // 2. ΑΝΑΓΓΕΛΙΑ ΩΡΑΣ
    if (lastAnnouncedHour !== time.hour) {
        const hourFile = findHourFile(time.hour);
        if (hourFile) {
            console.log(`[TIME CHIME] Βρέθηκε το αρχείο ώρας: ${hourFile}`);
            lastAnnouncedHour = time.hour;
            let hourString = time.hour < 10 ? `0${time.hour}.00` : `${time.hour}.00`;

            // Ειδική ακολουθία αμέσως μετά την αναγγελία 00:00 της 1ης Ιανουαρίου
            if (time.month === 0 && time.date === 1 && time.hour === 0) {
                specialSequenceQueue = [
                    { file: 'ΚαλήΧρονιά.mp3', title: 'Καλή Χρονιά!', genreLabel: 'Πρωτοχρονιάτικο Μήνυμα' },
                    { file: 'thavma_palmos_christmas_jingle.mp3', title: 'Thavma Παλμός Christmas Jingle', genreLabel: 'Χριστουγεννιάτικο Σήμα' },
                    { file: 'Αρχιμηνιά και Αρχιχρονιά το λάδι 19.mp3', title: 'Αρχιμηνιά και Αρχιχρονιά (Το Λάδι 19)', genreLabel: 'Πρωτοχρονιάτικα Κάλαντα' }
                ];
            }

            currentNowPlaying = { title: `Η ώρα είναι ${hourString}`, genre: "Ώρα Ελλάδος" };
            return { file: hourFile, title: `Η ώρα είναι ${hourString}`, genreLabel: 'Ώρα Ελλάδος', isHourAnnouncement: true };
        }
    }

    // 3. JINGLE ΑΝΑ 5 ΤΡΑΓΟΥΔΙΑ (Χριστουγεννιάτικο jingle στη σεζόν)
    if (songCounter >= 5) {
        const jingleFile = isChristmasSeason(time) && fs.existsSync(path.join(__dirname, 'thavma_palmos_christmas_jingle.mp3'))
            ? 'thavma_palmos_christmas_jingle.mp3'
            : 'thavma_palmos_jingle.mp3';

        if (fs.existsSync(path.join(__dirname, jingleFile))) {
            songCounter = 0;
            currentNowPlaying = { title: "Thavma Παλμός Jingle", genre: "Σήμα Σταθμού" };
            return { file: jingleFile, title: 'Thavma Παλμός Jingle', genreLabel: 'Σήμα Σταθμού', isSystem: true };
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

    // 5. ΚΑΝΟΝΙΚΟ ΤΡΑΓΟΥΔΙ
    const files = fs.readdirSync(__dirname);
    let mp3Files = files.filter(file => path.extname(file).toLowerCase() === '.mp3' && !isHourFile(file));

    if (mp3Files.length === 0) return null;

    const isChristmas = isChristmasSeason(time);
    const isJan1SpecialHours = isJan1FirstTwoHours(time);

    let filteredFiles = [];
    let genreLabel = "Mix Πρόγραμμα";

    const xFiles = mp3Files.filter(f => f.startsWith('(X)'));

    // Ειδικός κανόνας 1ης Ιανουαρίου (00:00 - 02:00): 80% (X), 20% λοιπό πρόγραμμα
    if (isJan1SpecialHours && xFiles.length > 0 && Math.random() < 0.8) {
        filteredFiles = xFiles;
        genreLabel = "Χριστουγεννιάτικα (Πρωτοχρονιάτικο Mix)";
    } else {
        const genre = getRequiredGenre();

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

        // Κατά τη Χριστουγεννιάτικη περίοδο (18 Νοε - 31 Ιαν):
        // 35% πιθανότητα να παίξει αμιγώς (X), αλλιώς ανάμειξη των (X) στο τρέχον πρόγραμμα
        if (isChristmas && xFiles.length > 0) {
            if (Math.random() < 0.35) {
                filteredFiles = xFiles;
                genreLabel = "Χριστουγεννιάτικα (X)";
            } else {
                filteredFiles = [...new Set([...filteredFiles, ...xFiles])];
            }
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

    const cleanLabel = media.genreLabel.replace(/'/g, "’").replace(/:/g, " — ").replace(/,/g, " ");
    const cleanTitle = media.title.replace(/'/g, "’").replace(/:/g, ".").replace(/,/g, " ");
    const clockText = "%{localtime\\:%H\\\\\\:%M\\\\\\:%S & %d\\\\\\/%m\\\\\\/%Y}";

    const ffmpeg = spawn('ffmpeg', [
        '-fflags', '+genpts',
        '-loop', '1', '-framerate', '2', '-i', 'background.jpg',
        '-re', '-i', media.file, 
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