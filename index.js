const express = require('express');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
    res.send('Thavma Παλμός Live Stream is Running Automatically!');
});

app.listen(PORT, () => {
    console.log(`Server is listening on port ${PORT}`);
    generatePlaylistAndStart();
});

function generatePlaylistAndStart() {
    console.log("Scanning directory for MP3 files...");
    const files = fs.readdirSync(__dirname);
    let mp3Files = files.filter(file => path.extname(file).toLowerCase() === '.mp3');

    if (mp3Files.length === 0) {
        console.error("ERROR: No MP3 files found!");
        return;
    }

    // Ανακάτεμα τραγουδιών (Shuffle)
    mp3Files.sort(() => Math.random() - 0.5);
    console.log(`Found ${mp3Files.length} songs. Generating playlist...`);

    const playlistContent = mp3Files.map(file => `file '${file}'`).join('\n');
    fs.writeFileSync(path.join(__dirname, 'playlist.txt'), playlistContent);

    startStreaming();
}

function startStreaming() {
    const streamKey = process.env.YOUTUBE_STREAM_KEY;
    if (!streamKey) {
        console.error("ERROR: YOUTUBE_STREAM_KEY is missing!");
        return;
    }

    console.log("Starting FFmpeg stream to YouTube...");
    const ffmpeg = spawn('ffmpeg', [
        '-loop', '1',
        '-i', 'background.jpg',
        '-f', 'concat',
        '-stream_loop', '-1',
        '-safe', '0',
        '-i', 'playlist.txt',
        '-map', '0:v:0',  // Εξαναγκασμός: Πάρε βίντεο ΜΟΝΟ από το background.jpg (αγνοεί τα εξώφυλλα των MP3)
        '-map', '1:a:0',  // Εξαναγκασμός: Πάρε ήχο ΜΟΝΟ από τα κομμάτια της λίστας
        '-c:v', 'libx264',
        '-tune', 'stillimage',
        '-c:a', 'aac',
        '-b:a', '192k',
        '-pix_fmt', 'yuv420p',
        '-f', 'flv',
        `rtmp://a.rtmp.youtube.com/live2/${streamKey}`
    ]);

    // Εμφάνιση των πραγματικών μηνυμάτων και λαθών του FFmpeg στα logs του Render
    ffmpeg.stderr.on('data', (data) => {
        console.log(`FFmpeg: ${data.toString().trim()}`);
    });

    ffmpeg.on('close', (code) => {
        console.log(`Stream disconnected (Code ${code}). Restarting in 5 seconds...`);
        setTimeout(generatePlaylistAndStart, 5000);
    });
}