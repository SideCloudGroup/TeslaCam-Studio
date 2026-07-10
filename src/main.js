const {app, BrowserWindow, dialog, ipcMain} = require('electron');
const {spawn} = require('child_process');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const {pathToFileURL} = require('url');
const ffmpegStatic = require('ffmpeg-static');
const {buildExportArgs} = require('./video-export');

const CAMERA_ALIASES = new Map([
    ['front', 'front'],
    ['back', 'rear'],
    ['rear', 'rear'],
    ['left_repeater', 'left_repeater'],
    ['left-repeater', 'left_repeater'],
    ['left_fender', 'left_repeater'],
    ['left-fender', 'left_repeater'],
    ['left', 'left_repeater'],
    ['left_pillar', 'left_pillar'],
    ['left-pillar', 'left_pillar'],
    ['left_b_pillar', 'left_pillar'],
    ['left-b-pillar', 'left_pillar'],
    ['right_repeater', 'right_repeater'],
    ['right-repeater', 'right_repeater'],
    ['right_fender', 'right_repeater'],
    ['right-fender', 'right_repeater'],
    ['right', 'right_repeater'],
    ['right_pillar', 'right_pillar'],
    ['right-pillar', 'right_pillar'],
    ['right_b_pillar', 'right_pillar'],
    ['right-b-pillar', 'right_pillar']
]);

function getFfmpegPath() {
    return ffmpegStatic.replace('app.asar', 'app.asar.unpacked');
}

function runFfmpeg(args, onProgress) {
    return new Promise((resolve, reject) => {
        const child = spawn(getFfmpegPath(), args, {windowsHide: true});
        let stdout = '';
        let stderr = '';
        let progressBuffer = '';

        child.stdout.on('data', (chunk) => {
            const text = chunk.toString();
            stdout += text;
            progressBuffer += text;
            const lines = progressBuffer.split(/\r?\n/);
            progressBuffer = lines.pop() || '';
            for (const line of lines) {
                const [key, value] = line.split('=');
                if (!key || value === undefined) continue;
                if (key === 'out_time_ms' || key === 'out_time_us') {
                    onProgress?.(Number(value) / 1_000_000);
                } else if (key === 'out_time') {
                    const match = value.match(/(\d+):(\d+):(\d+(?:\.\d+)?)/);
                    if (match) onProgress?.(Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]));
                }
            }
        });

        child.stderr.on('data', (chunk) => {
            stderr += chunk.toString();
        });

        child.on('error', reject);
        child.on('close', (code) => {
            if (code === 0) {
                resolve({stdout, stderr});
                return;
            }
            reject(new Error(`ffmpeg exited with code ${code}\n${stderr || stdout}`.trim()));
        });
    });
}

function withProgress(args) {
    return [
        ...args.slice(0, -1),
        '-progress', 'pipe:1',
        '-nostats',
        args.at(-1)
    ];
}

function sendExportProgress(sender, payload) {
    if (!sender.isDestroyed()) sender.send('export-video-progress', payload);
}

function createWindow() {
    const win = new BrowserWindow({
        width: 1440,
        height: 960,
        minWidth: 1040,
        minHeight: 720,
        backgroundColor: '#101214',
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false
        }
    });

    win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

async function walk(dir, out = []) {
    const entries = await fs.readdir(dir, {withFileTypes: true});
    await Promise.all(entries.map(async (entry) => {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            await walk(fullPath, out);
            return;
        }

        if (entry.isFile() && entry.name.toLowerCase().endsWith('.mp4')) {
            const stat = await fs.stat(fullPath);
            out.push({
                name: entry.name,
                path: fullPath,
                url: pathToFileURL(fullPath).href,
                size: stat.size,
                modifiedMs: stat.mtimeMs
            });
        }
    }));
    return out;
}

function parseClipName(file) {
    const base = path.basename(file.name, path.extname(file.name));
    const match = base.match(/^(\d{4}-\d{2}-\d{2})_(\d{2}-\d{2}-\d{2})-(.+)$/);
    if (!match) return null;

    const [, date, time, rawCamera] = match;
    const normalizedCamera = rawCamera.toLowerCase();
    const camera = CAMERA_ALIASES.get(normalizedCamera) || normalizedCamera;
    const isoTime = `${date}T${time.replaceAll('-', ':')}`;
    const startMs = Date.parse(isoTime);
    if (Number.isNaN(startMs)) return null;

    return {
        clipKey: `${date}_${time}`,
        camera,
        startMs
    };
}

function buildSession(files) {
    const clips = new Map();
    const unrecognized = [];

    for (const file of files) {
        const parsed = parseClipName(file);
        if (!parsed) {
            unrecognized.push(file);
            continue;
        }

        const clip = clips.get(parsed.clipKey) || {
            key: parsed.clipKey,
            startMs: parsed.startMs,
            cameras: {}
        };
        clip.cameras[parsed.camera] = file;
        clips.set(parsed.clipKey, clip);
    }

    const sortedClips = [...clips.values()].sort((a, b) => a.startMs - b.startMs);
    const startMs = sortedClips[0]?.startMs ?? null;
    const endMs = sortedClips.length ? sortedClips.at(-1).startMs + 60_000 : null;

    return {
        folderName: '',
        clips: sortedClips,
        unrecognized,
        startMs,
        endMs,
        durationMs: startMs === null ? 0 : Math.max(0, endMs - startMs)
    };
}

ipcMain.handle('choose-folder', async () => {
    const result = await dialog.showOpenDialog({
        title: 'Open TeslaCam folder',
        properties: ['openDirectory']
    });

    if (result.canceled || !result.filePaths[0]) return null;
    return result.filePaths[0];
});

ipcMain.handle('scan-folder', async (_event, folderPath) => {
    const files = await walk(folderPath);
    const session = buildSession(files);
    session.folderName = path.basename(folderPath);
    session.folderPath = folderPath;
    return session;
});

ipcMain.handle('read-file-buffer', async (_event, filePath) => {
    const buffer = await fs.readFile(filePath);
    return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
});

ipcMain.handle('save-screenshot', async (_event, {fileName, pngBase64}) => {
    const result = await dialog.showSaveDialog({
        title: 'Save screenshot',
        defaultPath: fileName,
        filters: [
            {name: 'PNG Image', extensions: ['png']}
        ]
    });

    if (result.canceled || !result.filePath) return {saved: false};
    await fs.writeFile(result.filePath, Buffer.from(pngBase64, 'base64'));
    return {saved: true, filePath: result.filePath};
});

ipcMain.handle('export-video-clip', async (event, {fileName, segments, cameraTitle}) => {
    const result = await dialog.showSaveDialog({
        title: 'Save video clip',
        defaultPath: fileName,
        filters: [
            {name: 'MP4 Video', extensions: ['mp4']}
        ]
    });

    if (result.canceled || !result.filePath) return {saved: false};

    if (!Array.isArray(segments) || !segments.length) {
        throw new Error('No video segments were selected for export');
    }

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'teslacam-studio-'));
    const outputPath = path.join(tempDir, 'export.mp4');
    const totalSeconds = segments.reduce((sum, segment) => sum + segment.durationSeconds, 0);
    try {
        sendExportProgress(event.sender, {percent: 0, stage: 'Preparing export'});
        const args = buildExportArgs(segments, cameraTitle, outputPath);
        await runFfmpeg(withProgress(args), (progressSeconds) => {
            const done = Math.min(totalSeconds, Math.max(0, progressSeconds));
            const percent = totalSeconds ? Math.min(96, Math.round((done / totalSeconds) * 96)) : 0;
            sendExportProgress(event.sender, {
                percent,
                stage: `Encoding ${segments.length} segment${segments.length === 1 ? '' : 's'}`
            });
        });

        sendExportProgress(event.sender, {percent: 98, stage: 'Saving MP4'});
        await fs.copyFile(outputPath, result.filePath);

        sendExportProgress(event.sender, {percent: 100, stage: 'Export complete'});
        return {saved: true, filePath: result.filePath};
    } finally {
        await fs.rm(tempDir, {recursive: true, force: true});
    }
});

app.whenReady().then(() => {
    createWindow();

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});
