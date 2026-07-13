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
        '-framerate', '2',
        '-i', 'background.jpg',
        '-re',                        // ΑΥΤΟ ΕΔΩ ΑΝΑΓΚΑΖΕΙ ΤΟΝ Server ΝΑ ΠΑΙΖΕΙ ΣΕ ΠΡΑΓΜΑΤΙΚΟ ΧΡΟΝΟ
        '-f', 'concat',
        '-stream_loop', '-1',
        '-safe', '0',
        '-i', 'playlist.txt',
        '-map', '0:v:0',
        '-map', '1:a:0',
        '-c:v', 'libx264',
        '-preset', 'ultrafast',
        '-tune', 'stillimage',
        '-r', '15',
        '-g', '30',
        '-b:v', '150k',
        '-maxrate', '150k',
        '-bufsize', '300k',
        '-c:a', 'aac',
        '-b:a', '128k',
        '-af', 'aresample=async=1',
        '-pix_fmt', 'yuv420p',
        '-f', 'flv',
        `rtmp://a.rtmp.youtube.com/live2/${streamKey}`
    ]);

    ffmpeg.stderr.on('data', (data) => {
        console.log(`FFmpeg: ${data.toString().trim()}`);
    });

    ffmpeg.on('close', (code) => {
        console.log(`Stream disconnected (Code ${code}). Restarting in 5 seconds...`);
        setTimeout(generatePlaylistAndStart, 5000);
    });
}