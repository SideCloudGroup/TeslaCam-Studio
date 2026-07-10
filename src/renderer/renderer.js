const cameraDefs = [
    {id: 'front', title: 'Front', missing: 'No front video'},
    {id: 'left_repeater', title: 'Left Repeater', missing: 'No left or left_repeater video'},
    {id: 'left_pillar', title: 'Left B-Pillar', missing: 'No left_pillar video'},
    {id: 'rear', title: 'Rear', missing: 'No rear or back video'},
    {id: 'right_pillar', title: 'Right B-Pillar', missing: 'No right_pillar video'},
    {id: 'right_repeater', title: 'Right Repeater', missing: 'No right or right_repeater video'}
];

const thumbOrder = ['left_repeater', 'left_pillar', 'rear', 'right_pillar', 'right_repeater', 'front'];
const CLIP_DURATION_MS = 60_000;
const panels = {};
const videos = {};
const missing = {};

const state = {
    session: null,
    currentClip: null,
    selectedCamera: 'front',
    globalSeconds: 0,
    playing: false,
    telemetry: [],
    telemetryClipKey: null,
    seeking: false,
    clipInSeconds: null,
    clipOutSeconds: null,
    exportingClip: false
};

const els = {
    mainStage: document.getElementById('mainStage'),
    thumbRail: document.getElementById('thumbRail'),
    panelTemplate: document.getElementById('videoPanelTemplate'),
    openFolderBtn: document.getElementById('openFolderBtn'),
    playPauseBtn: document.getElementById('playPauseBtn'),
    screenshotBtn: document.getElementById('screenshotBtn'),
    markInBtn: document.getElementById('markInBtn'),
    markOutBtn: document.getElementById('markOutBtn'),
    exportClipBtn: document.getElementById('exportClipBtn'),
    clipInLabel: document.getElementById('clipInLabel'),
    clipOutLabel: document.getElementById('clipOutLabel'),
    exportProgress: document.getElementById('exportProgress'),
    exportProgressLabel: document.getElementById('exportProgressLabel'),
    exportProgressPercent: document.getElementById('exportProgressPercent'),
    exportProgressBar: document.getElementById('exportProgressBar'),
    sessionLabel: document.getElementById('sessionLabel'),
    timeline: document.getElementById('timeline'),
    clipStrip: document.getElementById('clipStrip'),
    rangeStart: document.getElementById('rangeStart'),
    rangeEnd: document.getElementById('rangeEnd'),
    currentTimeLabel: document.getElementById('currentTimeLabel'),
    dateLabel: document.getElementById('dateLabel'),
    clockLabel: document.getElementById('clockLabel'),
    speedLabel: document.getElementById('speedLabel'),
    pedalLabel: document.getElementById('pedalLabel'),
    pedalBar: document.getElementById('pedalBar'),
    steeringLabel: document.getElementById('steeringLabel'),
    wheelIcon: document.getElementById('wheelIcon'),
    brakeLabel: document.getElementById('brakeLabel'),
    leftBlinker: document.getElementById('leftBlinker'),
    rightBlinker: document.getElementById('rightBlinker'),
    gearLabel: document.getElementById('gearLabel'),
    autopilotLabel: document.getElementById('autopilotLabel'),
    locationLabel: document.getElementById('locationLabel'),
    headingLabel: document.getElementById('headingLabel'),
    accelLabel: document.getElementById('accelLabel'),
    statusBox: document.getElementById('statusBox')
};

const gearNames = ['P', 'D', 'R', 'N'];
const autopilotNames = ['None', 'Self driving', 'Autosteer', 'TACC'];

function createPanels() {
    for (const def of cameraDefs) {
        const panel = els.panelTemplate.content.firstElementChild.cloneNode(true);
        const video = panel.querySelector('video');
        const empty = panel.querySelector('.missing');
        panel.dataset.camera = def.id;
        panel.querySelector('.video-title').textContent = def.title;
        panel.querySelector('.video-swap').addEventListener('click', () => selectCamera(def.id));
        empty.textContent = def.missing;
        panels[def.id] = panel;
        videos[def.id] = video;
        missing[def.id] = empty;
    }
    layoutPanels();
}

function layoutPanels() {
    const selectedPanel = panels[state.selectedCamera];
    if (selectedPanel && selectedPanel.parentElement !== els.mainStage) {
        els.mainStage.appendChild(selectedPanel);
    }

    for (const camera of thumbOrder) {
        if (camera === state.selectedCamera) continue;
        const panel = panels[camera];
        if (panel) els.thumbRail.appendChild(panel);
    }
}

function selectCamera(camera) {
    if (!panels[camera] || state.selectedCamera === camera) return;
    state.selectedCamera = camera;
    layoutPanels();
}

function formatClock(ms) {
    if (ms === null || Number.isNaN(ms)) return '--';
    return new Intl.DateTimeFormat('zh-CN', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
    }).format(new Date(ms));
}

function formatDate(ms) {
    if (ms === null || Number.isNaN(ms)) return '--';
    return new Intl.DateTimeFormat('zh-CN', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        weekday: 'short'
    }).format(new Date(ms));
}

function formatDateTime(ms) {
    if (ms === null || Number.isNaN(ms)) return '--';
    return new Intl.DateTimeFormat('zh-CN', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
    }).format(new Date(ms));
}

function formatFileStamp(ms) {
    const date = new Date(ms);
    const pad = (value) => String(value).padStart(2, '0');
    return [
        date.getFullYear(),
        pad(date.getMonth() + 1),
        pad(date.getDate())
    ].join('-') + '_' + [
        pad(date.getHours()),
        pad(date.getMinutes()),
        pad(date.getSeconds())
    ].join('-');
}

function setStatus(message) {
    els.statusBox.textContent = message;
}

function updateSidebarTime(ms) {
    els.dateLabel.textContent = formatDate(ms);
    els.clockLabel.textContent = formatClock(ms);
}

function setExportProgress({percent = 0, stage = 'Exporting'}) {
    const clamped = Math.max(0, Math.min(100, Math.round(percent)));
    els.exportProgress.hidden = false;
    els.exportProgressLabel.textContent = stage;
    els.exportProgressPercent.textContent = `${clamped}%`;
    els.exportProgressBar.style.width = `${clamped}%`;
}

function resetExportProgress() {
    els.exportProgress.hidden = true;
    els.exportProgressLabel.textContent = 'Exporting';
    els.exportProgressPercent.textContent = '0%';
    els.exportProgressBar.style.width = '0';
}

function updateClipExportUi() {
    const hasSession = Boolean(state.session?.clips.length);
    els.markInBtn.disabled = !hasSession || state.exportingClip;
    els.markOutBtn.disabled = !hasSession || state.exportingClip;
    els.exportClipBtn.disabled = !hasSession
        || state.exportingClip
        || state.clipInSeconds === null
        || state.clipOutSeconds === null
        || state.clipOutSeconds <= state.clipInSeconds;

    els.clipInLabel.textContent = state.clipInSeconds === null
        ? '--'
        : formatClock(state.session.startMs + state.clipInSeconds * 1000);
    els.clipOutLabel.textContent = state.clipOutSeconds === null
        ? '--'
        : formatClock(state.session.startMs + state.clipOutSeconds * 1000);
}

function markClipIn() {
    if (!state.session || state.exportingClip) return;
    state.clipInSeconds = state.globalSeconds;
    if (state.clipOutSeconds !== null && state.clipOutSeconds <= state.clipInSeconds) {
        state.clipOutSeconds = null;
    }
    updateClipExportUi();
    setStatus('Clip in point marked');
}

function markClipOut() {
    if (!state.session || state.exportingClip) return;
    state.clipOutSeconds = state.globalSeconds;
    if (state.clipInSeconds !== null && state.clipOutSeconds <= state.clipInSeconds) {
        setStatus('Out point must be later than in point');
    } else {
        setStatus('Clip out point marked');
    }
    updateClipExportUi();
}

function clipsInRange(startSeconds, endSeconds) {
    const startMs = state.session.startMs + startSeconds * 1000;
    const endMs = state.session.startMs + endSeconds * 1000;
    return state.session.clips.filter((clip, index) => {
        const next = state.session.clips[index + 1];
        const clipEndMs = Math.min(clip.startMs + CLIP_DURATION_MS, next?.startMs ?? Infinity);
        return clip.startMs < endMs && clipEndMs > startMs;
    });
}

function setClipExporting(exporting) {
    state.exportingClip = exporting;
    els.playPauseBtn.disabled = exporting || !state.session?.clips.length;
    els.screenshotBtn.disabled = exporting || !state.session?.clips.length;
    els.timeline.disabled = exporting || !state.session?.clips.length;
    els.openFolderBtn.disabled = exporting;
    updateClipExportUi();
}

function drawWatermark(ctx, canvas, text, cameraTitle) {
    const scale = Math.max(1, canvas.width / 1280);
    const margin = Math.round(22 * scale);
    const titleSize = Math.round(18 * scale);
    const timeSize = Math.round(34 * scale);
    const x = margin;
    const y = canvas.height - margin - timeSize;

    ctx.shadowColor = 'rgba(0, 0, 0, 0.9)';
    ctx.shadowBlur = Math.round(4 * scale);
    ctx.shadowOffsetX = Math.round(2 * scale);
    ctx.shadowOffsetY = Math.round(2 * scale);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.78)';
    ctx.font = `700 ${titleSize}px Segoe UI, Arial, sans-serif`;
    ctx.fillText(cameraTitle, x, y - Math.round(10 * scale));
    ctx.fillStyle = '#fff';
    ctx.font = `800 ${timeSize}px Segoe UI, Arial, sans-serif`;
    ctx.fillText(text, x, y + timeSize);
    ctx.shadowColor = 'transparent';
}

function findClipByGlobalSeconds(globalSeconds) {
    if (!state.session) return null;
    const timeMs = state.session.startMs + globalSeconds * 1000;
    const activeClip = state.session.clips.find((clip, index) => {
        const next = state.session.clips[index + 1];
        const end = Math.min(clip.startMs + CLIP_DURATION_MS, next?.startMs ?? Infinity);
        return timeMs >= clip.startMs && timeMs < end;
    });
    if (activeClip) return activeClip;
    return state.session.clips.find((clip) => clip.startMs > timeMs) ?? state.session.clips.at(-1);
}

function localSecondsForClip(clip, globalSeconds) {
    return Math.max(0, (state.session.startMs + globalSeconds * 1000 - clip.startMs) / 1000);
}

function loadClip(clip) {
    if (!clip || state.currentClip?.key === clip.key) return;
    state.currentClip = clip;
    state.telemetry = [];
    state.telemetryClipKey = null;

    cameraDefs.forEach(({id}) => {
        const file = clip.cameras[id];
        const video = videos[id];
        if (file) {
            if (video.src !== file.url) {
                video.src = file.url;
                video.load();
            }
            video.style.visibility = 'visible';
            missing[id].hidden = true;
        } else {
            video.removeAttribute('src');
            video.load();
            video.style.visibility = 'hidden';
            missing[id].hidden = false;
        }
    });

    if (clip.cameras.front) {
        state.telemetryClipKey = clip.key;
        setStatus('Reading front telemetry...');
        window.teslaCam.readFileBuffer(clip.cameras.front.path)
            .then((buffer) => DashcamMp4.readTelemetry(buffer))
            .then((items) => {
                if (state.telemetryClipKey !== clip.key) return;
                state.telemetry = items;
                setStatus(items.length ? `Read ${items.length} front telemetry frames` : 'No SEI telemetry found in front video');
                updateTelemetry();
            })
            .catch((error) => {
                console.error(error);
                if (state.telemetryClipKey === clip.key) setStatus(`Telemetry read failed: ${error.message}`);
            });
    } else {
        setStatus('Current clip has no front video, telemetry is unavailable');
    }
}

function seekVideos(localSeconds) {
    cameraDefs.forEach(({id}) => {
        const video = videos[id];
        if (!video.src || video.readyState < HTMLMediaElement.HAVE_METADATA || !Number.isFinite(video.duration)) return;
        const target = Math.min(Math.max(localSeconds, 0), Math.max(video.duration - 0.05, 0));
        if (Math.abs(video.currentTime - target) > 0.35) video.currentTime = target;
    });
}

function isCurrentClipVideo(camera, video) {
    const file = state.currentClip?.cameras[camera];
    return Boolean(file && video.currentSrc === file.url);
}

function playLoadedVideos() {
    if (!state.playing || !state.currentClip) return;
    cameraDefs.forEach(({id}) => {
        const video = videos[id];
        if (!isCurrentClipVideo(id, video) || video.readyState < HTMLMediaElement.HAVE_METADATA) return;
        video.play().catch((error) => {
            if (error?.name !== 'AbortError') console.error(`Unable to play ${id} video`, error);
        });
    });
}

function setPlaying(playing) {
    state.playing = playing;
    els.playPauseBtn.textContent = playing ? '\u6682\u505c' : '\u64ad\u653e';
    cameraDefs.forEach(({id}) => {
        const video = videos[id];
        if (!video.src) return;
        if (playing) {
            if (isCurrentClipVideo(id, video) && video.readyState >= HTMLMediaElement.HAVE_METADATA) {
                video.play().catch((error) => {
                    if (error?.name !== 'AbortError') console.error(`Unable to play ${id} video`, error);
                });
            }
        } else {
            video.pause();
        }
    });
}

async function exportMainScreenshot() {
    if (!state.session || !state.currentClip) {
        setStatus('Open a TeslaCam folder before exporting a screenshot');
        return;
    }

    const camera = state.selectedCamera;
    const video = videos[camera];
    if (!video || !video.src || !video.videoWidth || !video.videoHeight) {
        setStatus('Current main camera has no video frame to export');
        return;
    }

    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    const absoluteMs = state.session.startMs + state.globalSeconds * 1000;
    const cameraTitle = cameraDefs.find((def) => def.id === camera)?.title ?? camera;
    drawWatermark(ctx, canvas, formatDateTime(absoluteMs), cameraTitle);

    const pngBase64 = canvas.toDataURL('image/png').replace(/^data:image\/png;base64,/, '');
    const fileName = `TeslaCam-Studio_${formatFileStamp(absoluteMs)}_${camera}.png`;
    const result = await window.teslaCam.saveScreenshot({fileName, pngBase64});
    if (result.saved) {
        setStatus(`Screenshot saved: ${result.filePath}`);
    } else {
        setStatus('Screenshot export canceled');
    }
}

async function exportMainVideoClip() {
    if (!state.session || !state.currentClip || state.exportingClip) return;
    if (state.clipInSeconds === null || state.clipOutSeconds === null || state.clipOutSeconds <= state.clipInSeconds) {
        setStatus('Mark a valid in/out range before exporting');
        return;
    }

    const camera = state.selectedCamera;
    const cameraTitle = cameraDefs.find((def) => def.id === camera)?.title ?? camera;
    const rangeClips = clipsInRange(state.clipInSeconds, state.clipOutSeconds);
    if (!rangeClips.length) {
        setStatus('No clips found in the selected range');
        return;
    }

    const missingClip = rangeClips.find((clip) => !clip.cameras[camera]);
    if (missingClip) {
        setStatus(`Cannot export: ${cameraTitle} is missing at ${formatClock(missingClip.startMs)}`);
        return;
    }

    setPlaying(false);
    setClipExporting(true);

    try {
        resetExportProgress();
        setExportProgress({percent: 0, stage: 'Waiting for save location'});
        setStatus('Exporting MP4 with ffmpeg...');
        const segments = rangeClips.map((clip) => {
            const segmentStartMs = Math.max(clip.startMs, state.session.startMs + state.clipInSeconds * 1000);
            const clipIndex = state.session.clips.indexOf(clip);
            const next = state.session.clips[clipIndex + 1];
            const clipEndMs = Math.min(clip.startMs + CLIP_DURATION_MS, next?.startMs ?? Infinity);
            const segmentEndMs = Math.min(clipEndMs, state.session.startMs + state.clipOutSeconds * 1000);
            const localStartSeconds = Math.max(0, (segmentStartMs - clip.startMs) / 1000);
            const durationSeconds = (segmentEndMs - segmentStartMs) / 1000;
            return {
                filePath: clip.cameras[camera].path,
                startSeconds: localStartSeconds,
                durationSeconds,
                epochSeconds: segmentStartMs / 1000
            };
        }).filter((segment) => segment.durationSeconds > 0);
        const startMs = state.session.startMs + state.clipInSeconds * 1000;
        const endMs = state.session.startMs + state.clipOutSeconds * 1000;
        const fileName = `TeslaCam-Studio_${formatFileStamp(startMs)}_${formatFileStamp(endMs)}_${camera}.mp4`;
        const result = await window.teslaCam.exportVideoClip({fileName, segments, cameraTitle});
        if (result.saved) {
            setExportProgress({percent: 100, stage: 'Export complete'});
            const watermarkNote = result.watermarkApplied === false
                ? ' (saved without watermark: bundled FFmpeg does not support text rendering)'
                : '';
            setStatus(`Video clip saved${watermarkNote}: ${result.filePath}`);
        } else {
            resetExportProgress();
            setStatus('Video clip export canceled');
        }
        jumpTo(state.clipOutSeconds);
    } catch (error) {
        console.error(error);
        setExportProgress({percent: 0, stage: 'Export failed'});
        setStatus(`Video clip export failed: ${error.message}`);
    } finally {
        setClipExporting(false);
    }
}

function updateClipStrip() {
    els.clipStrip.innerHTML = '';
    if (!state.session || !state.session.durationMs) return;
    for (const clip of state.session.clips) {
        const marker = document.createElement('button');
        marker.type = 'button';
        marker.className = 'clip-marker';
        marker.title = `${formatClock(clip.startMs)} | ${Object.keys(clip.cameras).join(', ')}`;
        marker.style.left = `${((clip.startMs - state.session.startMs) / state.session.durationMs) * 100}%`;
        marker.style.width = `${Math.max(0.4, 60_000 / state.session.durationMs * 100)}%`;
        marker.addEventListener('click', () => {
            jumpTo((clip.startMs - state.session.startMs) / 1000);
        });
        els.clipStrip.appendChild(marker);
    }
}

function nearestTelemetry(localSeconds) {
    if (!state.telemetry.length) return null;
    const timeMs = localSeconds * 1000;
    let lo = 0;
    let hi = state.telemetry.length - 1;
    while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        if (state.telemetry[mid].timeMs <= timeMs) lo = mid;
        else hi = mid - 1;
    }
    return state.telemetry[lo];
}

function setBrake(active) {
    els.brakeLabel.textContent = active ? 'ON' : 'OFF';
    els.brakeLabel.classList.toggle('active', active);
}

function setPedalPercent(value) {
    const percent = value === null ? null : Math.max(0, Math.min(100, value));
    const level = percent === null ? 0 : percent;
    els.pedalLabel.textContent = percent === null ? '--%' : `${Math.round(percent)}%`;
    els.pedalBar.parentElement.style.setProperty('--level', `${level}%`);
}

function normalizePedalPercent(value) {
    if (value === undefined || value === null || Number.isNaN(value)) return null;
    if (value <= 1) return value * 100;
    if (value <= 100) return value;
    if (value <= 255) return (value / 255) * 100;
    return 100;
}

function updateTelemetry() {
    if (!state.session || !state.currentClip) return;
    const localSeconds = localSecondsForClip(state.currentClip, state.globalSeconds);
    const item = nearestTelemetry(localSeconds);
    const absoluteMs = state.session.startMs + state.globalSeconds * 1000;
    updateSidebarTime(absoluteMs);

    if (!item) {
        els.speedLabel.textContent = '--';
        setPedalPercent(null);
        els.steeringLabel.textContent = '-- deg';
        els.wheelIcon.style.transform = 'rotate(0deg)';
        setBrake(false);
        els.leftBlinker.classList.remove('active');
        els.rightBlinker.classList.remove('active');
        els.gearLabel.textContent = '--';
        els.autopilotLabel.textContent = '--';
        els.locationLabel.textContent = '--';
        els.headingLabel.textContent = '--';
        els.accelLabel.textContent = '--';
        return;
    }

    const speedKph = item.vehicle_speed_mps === undefined ? null : item.vehicle_speed_mps * 3.6;
    const pedal = normalizePedalPercent(item.accelerator_pedal_position);
    const steering = item.steering_wheel_angle ?? 0;
    els.speedLabel.textContent = speedKph === null ? '--' : Math.round(speedKph).toString();
    setPedalPercent(pedal);
    els.steeringLabel.textContent = `${Math.round(steering)} deg`;
    els.wheelIcon.style.transform = `rotate(${Math.max(-540, Math.min(540, steering))}deg)`;
    setBrake(Boolean(item.brake_applied));
    els.leftBlinker.classList.toggle('active', Boolean(item.blinker_on_left));
    els.rightBlinker.classList.toggle('active', Boolean(item.blinker_on_right));
    els.gearLabel.textContent = gearNames[item.gear_state] ?? '--';
    els.autopilotLabel.textContent = autopilotNames[item.autopilot_state] ?? '--';
    els.locationLabel.textContent = item.latitude_deg && item.longitude_deg
        ? `${item.latitude_deg.toFixed(6)}, ${item.longitude_deg.toFixed(6)}`
        : '--';
    els.headingLabel.textContent = item.heading_deg === undefined ? '--' : `${Math.round(item.heading_deg)} deg`;
    const acc = [item.linear_acceleration_mps2_x, item.linear_acceleration_mps2_y, item.linear_acceleration_mps2_z];
    els.accelLabel.textContent = acc.every((v) => v !== undefined)
        ? acc.map((v) => v.toFixed(2)).join(' / ')
        : '--';
}

function renderTime() {
    if (!state.session) return;
    const clip = findClipByGlobalSeconds(state.globalSeconds);
    loadClip(clip);
    const localSeconds = localSecondsForClip(clip, state.globalSeconds);
    seekVideos(localSeconds);

    els.timeline.value = String(state.globalSeconds);
    const currentMs = state.session.startMs + state.globalSeconds * 1000;
    els.currentTimeLabel.textContent = formatClock(currentMs);
    updateTelemetry();
}

function jumpTo(seconds) {
    if (!state.session) return;
    state.globalSeconds = Math.max(0, Math.min(seconds, state.session.durationMs / 1000));
    renderTime();
}

async function openFolder() {
    const folder = await window.teslaCam.chooseFolder();
    if (!folder) return;
    setPlaying(false);
    setStatus('Scanning folder...');
    const session = await window.teslaCam.scanFolder(folder);
    state.session = session;
    state.currentClip = null;
    state.globalSeconds = 0;
    state.telemetry = [];
    state.clipInSeconds = null;
    state.clipOutSeconds = null;
    resetExportProgress();

    els.sessionLabel.textContent = `${session.folderName} | ${session.clips.length} clips`;
    els.playPauseBtn.disabled = session.clips.length === 0;
    els.screenshotBtn.disabled = session.clips.length === 0;
    els.markInBtn.disabled = session.clips.length === 0;
    els.markOutBtn.disabled = session.clips.length === 0;
    els.exportClipBtn.disabled = true;
    els.timeline.disabled = session.clips.length === 0;
    els.timeline.max = String(session.durationMs / 1000);
    els.timeline.value = '0';
    els.rangeStart.textContent = formatClock(session.startMs);
    els.rangeEnd.textContent = formatClock(session.endMs);
    updateSidebarTime(session.startMs);
    updateClipStrip();
    updateClipExportUi();

    if (!session.clips.length) {
        setStatus('No TeslaCam MP4 files were recognized');
        return;
    }

    setStatus(`Scanned ${session.clips.length} clips, ${session.unrecognized.length} MP4 files unrecognized`);
    renderTime();
}

createPanels();

window.teslaCam.onExportVideoProgress((payload) => {
    if (!state.exportingClip) return;
    setExportProgress(payload);
    if (payload.stage) setStatus(`${payload.stage} ${payload.percent ?? 0}%`);
});

els.openFolderBtn.addEventListener('click', openFolder);
els.playPauseBtn.addEventListener('click', () => setPlaying(!state.playing));
els.screenshotBtn.addEventListener('click', exportMainScreenshot);
els.markInBtn.addEventListener('click', markClipIn);
els.markOutBtn.addEventListener('click', markClipOut);
els.exportClipBtn.addEventListener('click', exportMainVideoClip);
els.timeline.addEventListener('input', (event) => {
    state.seeking = true;
    jumpTo(Number(event.target.value));
});
els.timeline.addEventListener('change', () => {
    state.seeking = false;
    if (state.playing) setPlaying(true);
});

cameraDefs.forEach(({id}) => {
    videos[id].addEventListener('loadedmetadata', () => {
        const video = videos[id];
        if (!isCurrentClipVideo(id, video)) return;
        seekVideos(localSecondsForClip(state.currentClip, state.globalSeconds));
        playLoadedVideos();
    });
});

function playbackClockCamera() {
    if (!state.currentClip) return null;
    if (state.currentClip.cameras.front) return 'front';
    return cameraDefs.find(({id}) => state.currentClip.cameras[id])?.id ?? null;
}

function handlePlaybackTimeUpdate(camera) {
    if (!state.session || !state.currentClip || state.seeking) return;
    const video = videos[camera];
    if (camera !== playbackClockCamera() || !isCurrentClipVideo(camera, video)) return;
    state.globalSeconds = (state.currentClip.startMs - state.session.startMs) / 1000 + video.currentTime;
    els.timeline.value = String(state.globalSeconds);
    els.currentTimeLabel.textContent = formatClock(state.session.startMs + state.globalSeconds * 1000);
    updateTelemetry();
}

function handlePlaybackEnded(camera) {
    if (!state.session || !state.currentClip) return;
    const video = videos[camera];
    if (camera !== playbackClockCamera() || !isCurrentClipVideo(camera, video)) return;
    const currentIndex = state.session.clips.findIndex((clip) => clip.key === state.currentClip.key);
    const nextClip = state.session.clips[currentIndex + 1];
    if (!nextClip) {
        setPlaying(false);
        return;
    }
    jumpTo((nextClip.startMs - state.session.startMs) / 1000);
}

cameraDefs.forEach(({id}) => {
    videos[id].addEventListener('timeupdate', () => handlePlaybackTimeUpdate(id));
    videos[id].addEventListener('ended', () => handlePlaybackEnded(id));
});
