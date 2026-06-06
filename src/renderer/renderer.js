const cameraDefs = [
  { id: 'front', title: 'Front', missing: 'No front video' },
  { id: 'left_repeater', title: 'Left Repeater', missing: 'No left or left_repeater video' },
  { id: 'left_pillar', title: 'Left B-Pillar', missing: 'No left_pillar video' },
  { id: 'rear', title: 'Rear', missing: 'No rear or back video' },
  { id: 'right_pillar', title: 'Right B-Pillar', missing: 'No right_pillar video' },
  { id: 'right_repeater', title: 'Right Repeater', missing: 'No right or right_repeater video' }
];

const thumbOrder = ['left_repeater', 'left_pillar', 'rear', 'right_pillar', 'right_repeater', 'front'];
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
  seeking: false
};

const els = {
  mainStage: document.getElementById('mainStage'),
  thumbRail: document.getElementById('thumbRail'),
  panelTemplate: document.getElementById('videoPanelTemplate'),
  openFolderBtn: document.getElementById('openFolderBtn'),
  playPauseBtn: document.getElementById('playPauseBtn'),
  sessionLabel: document.getElementById('sessionLabel'),
  timeline: document.getElementById('timeline'),
  clipStrip: document.getElementById('clipStrip'),
  rangeStart: document.getElementById('rangeStart'),
  rangeEnd: document.getElementById('rangeEnd'),
  currentTimeLabel: document.getElementById('currentTimeLabel'),
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

function setStatus(message) {
  els.statusBox.textContent = message;
}

function findClipByGlobalSeconds(globalSeconds) {
  if (!state.session) return null;
  const timeMs = state.session.startMs + globalSeconds * 1000;
  return state.session.clips.find((clip, index) => {
    const next = state.session.clips[index + 1];
    const end = next?.startMs ?? clip.startMs + 60_000;
    return timeMs >= clip.startMs && timeMs < end;
  }) ?? state.session.clips.at(-1);
}

function localSecondsForClip(clip, globalSeconds) {
  return Math.max(0, (state.session.startMs + globalSeconds * 1000 - clip.startMs) / 1000);
}

function loadClip(clip) {
  if (!clip || state.currentClip?.key === clip.key) return;
  state.currentClip = clip;
  state.telemetry = [];
  state.telemetryClipKey = null;

  cameraDefs.forEach(({ id }) => {
    const file = clip.cameras[id];
    const video = videos[id];
    if (file) {
      if (video.src !== file.url) video.src = file.url;
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
  cameraDefs.forEach(({ id }) => {
    const video = videos[id];
    if (!video.src || Number.isNaN(video.duration)) return;
    const target = Math.min(Math.max(localSeconds, 0), Math.max(video.duration - 0.05, 0));
    if (Math.abs(video.currentTime - target) > 0.35) video.currentTime = target;
  });
}

function setPlaying(playing) {
  state.playing = playing;
  els.playPauseBtn.textContent = playing ? '\u6682\u505c' : '\u64ad\u653e';
  cameraDefs.forEach(({ id }) => {
    const video = videos[id];
    if (!video.src) return;
    if (playing) {
      video.play().catch(() => setPlaying(false));
    } else {
      video.pause();
    }
  });
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
  els.clockLabel.textContent = formatClock(absoluteMs);

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

  els.sessionLabel.textContent = `${session.folderName} | ${session.clips.length} clips`;
  els.playPauseBtn.disabled = session.clips.length === 0;
  els.timeline.disabled = session.clips.length === 0;
  els.timeline.max = String(session.durationMs / 1000);
  els.timeline.value = '0';
  els.rangeStart.textContent = formatClock(session.startMs);
  els.rangeEnd.textContent = formatClock(session.endMs);
  updateClipStrip();

  if (!session.clips.length) {
    setStatus('No TeslaCam MP4 files were recognized');
    return;
  }

  setStatus(`Scanned ${session.clips.length} clips, ${session.unrecognized.length} MP4 files unrecognized`);
  renderTime();
}

createPanels();

els.openFolderBtn.addEventListener('click', openFolder);
els.playPauseBtn.addEventListener('click', () => setPlaying(!state.playing));
els.timeline.addEventListener('input', (event) => {
  state.seeking = true;
  jumpTo(Number(event.target.value));
});
els.timeline.addEventListener('change', () => {
  state.seeking = false;
  if (state.playing) setPlaying(true);
});

videos.front.addEventListener('timeupdate', () => {
  if (!state.session || !state.currentClip || state.seeking) return;
  state.globalSeconds = (state.currentClip.startMs - state.session.startMs) / 1000 + videos.front.currentTime;
  els.timeline.value = String(state.globalSeconds);
  els.currentTimeLabel.textContent = formatClock(state.session.startMs + state.globalSeconds * 1000);
  updateTelemetry();
});

videos.front.addEventListener('ended', () => {
  if (!state.session || !state.currentClip) return;
  const nextSeconds = (state.currentClip.startMs - state.session.startMs) / 1000 + 60;
  if (nextSeconds < state.session.durationMs / 1000) {
    jumpTo(nextSeconds);
    if (state.playing) setPlaying(true);
  } else {
    setPlaying(false);
  }
});
