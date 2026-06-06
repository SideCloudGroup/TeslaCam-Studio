const { app, BrowserWindow, dialog, ipcMain } = require('electron');
const fs = require('fs/promises');
const path = require('path');
const { pathToFileURL } = require('url');

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
  const entries = await fs.readdir(dir, { withFileTypes: true });
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

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
