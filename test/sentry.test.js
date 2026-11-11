const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const {createRequire} = require('node:module');
const test = require('node:test');

function mainHarness() {
    const handlers = new Map();
    const calls = [];
    let result;
    const electron = {
        app: {getPath: () => 'default-videos', whenReady: () => ({then() {}}), on() {}},
        ipcMain: {handle: (name, handler) => handlers.set(name, handler)},
        dialog: Object.fromEntries(['showOpenDialog', 'showSaveDialog'].map((name) => [name, async (options) => {
            calls.push(options);
            return result;
        }]))
    };
    const filename = path.resolve(__dirname, '../src/main.js');
    const localRequire = createRequire(filename);
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
        require: (name) => name === 'electron' ? electron : localRequire(name),
        __dirname: path.dirname(filename), console, Buffer, process
    });
    return {calls, invoke: (name, payload) => handlers.get(name)({}, payload), reply: (value) => { result = value; }};
}

test('open/save directories are independent, shared by screenshot/video, and cancellation preserves them', async () => {
    const h = mainHarness();
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'teslacam-dialog-'));
    try {
        const input = path.join(directory, 'source');
        h.reply({filePaths: [input]});
        await h.invoke('choose-folder');
        const output = path.join(directory, 'shot.png');
        h.reply({filePath: output});
        await h.invoke('save-screenshot', {fileName: 'shot.png', pngBase64: ''});
        h.reply({canceled: true});
        await h.invoke('export-video-clip', {fileName: 'clip.mp4'});
        assert.equal(h.calls.at(-1).defaultPath, path.join(directory, 'clip.mp4'));
        await h.invoke('choose-folder');
        assert.equal(h.calls.at(-1).defaultPath, input);
        await h.invoke('save-screenshot', {fileName: 'next.png'});
        assert.equal(h.calls.at(-1).defaultPath, path.join(directory, 'next.png'));
        const fresh = mainHarness();
        fresh.reply({canceled: true});
        await fresh.invoke('choose-folder');
        assert.equal(fresh.calls.at(-1).defaultPath, 'default-videos');
    } finally {
        fs.rmSync(directory, {recursive: true, force: true});
    }
});

test('recursive scan associates sentry metadata with its own clips and ignores invalid metadata', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'teslacam-sentry-'));
    try {
        for (const name of ['sentry', 'invalid', 'saved']) fs.mkdirSync(path.join(directory, name));
        fs.writeFileSync(path.join(directory, 'sentry', 'event.json'), JSON.stringify({
            timestamp: '2026-11-08T12:46:39', reason: 'sentry_aware_object_detection', camera: '0'
        }));
        fs.writeFileSync(path.join(directory, 'sentry', '2026-11-08_12-46-23-front.mp4'), '');
        fs.writeFileSync(path.join(directory, 'invalid', 'event.json'), '{');
        fs.writeFileSync(path.join(directory, 'saved', 'event.json'), JSON.stringify({
            timestamp: '2026-11-08T13:00:00', reason: 'user_interaction_honk'
        }));
        const session = await mainHarness().invoke('scan-folder', directory);
        assert.equal(session.events.length, 1);
        assert.equal(session.events[0].camera, '0');
        assert.equal(session.events[0].clipKeys[0], '2026-11-08_12-46-23');
        assert.equal(session.events[0].timestampMs - 5000 - session.clips[0].startMs, 11_000);
    } finally {
        fs.rmSync(directory, {recursive: true, force: true});
    }
});

function rendererHarness() {
    const filename = path.resolve(__dirname, '../src/renderer/renderer.js');
    const source = fs.readFileSync(filename, 'utf8');
    const elements = new Map();
    const context = vm.createContext({
        document: {getElementById: (id) => {
            if (!elements.has(id)) elements.set(id, {value: '0', textContent: ''});
            return elements.get(id);
        }}, console,
        HTMLMediaElement: {HAVE_METADATA: 1}
    });
    vm.runInContext(source.slice(0, source.indexOf('\ncreatePanels();')), context);
    return {run: (code) => vm.runInContext(code, context)};
}

test('event jump crosses clips, pauses and selects trigger camera; unavailable pre-roll is clamped', () => {
    const h = rendererHarness();
    h.run(`
        state.session = {startMs: 0, durationMs: 120000, clips: [
            {key: 'a', startMs: 0, cameras: {front: {}}},
            {key: 'b', startMs: 60000, cameras: {front: {}}}
        ], events: [{timestampMs: 71000, camera: '0', clipKeys: ['a', 'b']}]};
        state.selectedCamera = 'rear';
        state.playing = true;
        setPlaying = (playing) => {state.playing = playing;};
        selectCamera = (camera) => {state.selectedCamera = camera;};
        renderTime = () => {state.currentClip = findClipByGlobalSeconds(state.globalSeconds);};
        jumpToSentryEvent();
    `);
    assert.equal(h.run('state.globalSeconds'), 66);
    assert.equal(h.run('state.currentClip.key'), 'b');
    assert.equal(h.run('state.selectedCamera'), 'front');
    assert.equal(h.run('state.playing'), false);
    h.run('state.session.events[0].timestampMs = 3000; jumpToSentryEvent();');
    assert.equal(h.run('state.globalSeconds'), 0);
    h.run(`state.session.events[0].camera = '999'; state.selectedCamera = 'rear'; jumpToSentryEvent();`);
    assert.equal(h.run('state.selectedCamera'), 'rear');
    assert.match(h.run('els.sentryEventHint.textContent'), /未知/);
    h.run(`sentryCameraMapping.set('999', 'left_pillar'); jumpToSentryEvent();`);
    assert.equal(h.run('state.selectedCamera'), 'left_pillar');
    assert.match(h.run('els.sentryEventHint.textContent'), /缺少/);
});

test('seeking only updates loaded videos belonging to the target clip', () => {
    const h = rendererHarness();
    h.run(`
        state.currentClip = {cameras: {front: {url: 'new-front'}, rear: {url: 'new-rear'}}};
        for (const {id} of cameraDefs) videos[id] = {currentSrc: '', readyState: 0};
        Object.assign(videos.front, {currentSrc: 'new-front', readyState: 1, duration: 60, currentTime: 0});
        Object.assign(videos.rear, {currentSrc: 'old-rear', readyState: 1, duration: 60, currentTime: 0});
        seekVideos(11);
    `);
    assert.equal(h.run('videos.front.currentTime'), 11);
    assert.equal(h.run('videos.rear.currentTime'), 0);
    h.run(`videos.rear.currentSrc = 'new-rear'; seekVideos(11);`);
    assert.equal(h.run('videos.rear.currentTime'), 11);
});
