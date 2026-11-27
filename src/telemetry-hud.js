const PLAY_RES_X = 1920;
const PLAY_RES_Y = 1080;
const PANEL_W = 572;
const PANEL_H = 252;
const MARGIN = 44;
const PANEL_X = PLAY_RES_X - MARGIN - PANEL_W;
const PANEL_Y = PLAY_RES_Y - MARGIN - PANEL_H;
const PANEL_CX = PANEL_X + Math.round(PANEL_W / 2);

function round(value) {
    return Math.round(Number(value) || 0);
}

function formatAssTime(seconds) {
    const totalCs = Math.max(0, Math.round(Number(seconds) * 100));
    const cs = totalCs % 100;
    const totalSeconds = Math.floor(totalCs / 100);
    const s = totalSeconds % 60;
    const totalMinutes = Math.floor(totalSeconds / 60);
    const m = totalMinutes % 60;
    const h = Math.floor(totalMinutes / 60);
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

function normalizePedalPercent(value) {
    if (value === undefined || value === null || Number.isNaN(value)) return null;
    if (value <= 1) return value * 100;
    if (value <= 100) return value;
    if (value <= 255) return (value / 255) * 100;
    return 100;
}

function nearestItem(items, timeMs) {
    if (!items?.length) return null;
    let lo = 0;
    let hi = items.length - 1;
    while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        if (items[mid].timeMs <= timeMs) lo = mid;
        else hi = mid - 1;
    }
    return items[lo];
}

function hudSampleFromItem(item, t) {
    return {
        t,
        speedKph: item.vehicle_speed_mps === undefined ? null : item.vehicle_speed_mps * 3.6,
        pedal: normalizePedalPercent(item.accelerator_pedal_position),
        brake: Boolean(item.brake_applied),
        steer: item.steering_wheel_angle ?? 0,
        left: Boolean(item.blinker_on_left),
        right: Boolean(item.blinker_on_right)
    };
}

function collectHudSamples(segments) {
    const samples = [];
    let cursor = 0;

    for (const segment of segments) {
        const items = segment.items || [];
        const localStartMs = Number(segment.startSeconds) * 1000;
        const durationSeconds = Number(segment.durationSeconds);
        const localEndMs = localStartMs + durationSeconds * 1000;
        const first = nearestItem(items, localStartMs);
        if (first) samples.push(hudSampleFromItem(first, cursor));

        for (const item of items) {
            if (item.timeMs <= localStartMs || item.timeMs >= localEndMs) continue;
            samples.push(hudSampleFromItem(item, cursor + (item.timeMs - localStartMs) / 1000));
        }

        cursor += durationSeconds;
    }

    return samples;
}

function quantizeSample(sample) {
    return {
        speedKph: sample.speedKph === null || sample.speedKph === undefined
            ? null
            : round(sample.speedKph),
        pedal: sample.pedal === null || sample.pedal === undefined ? null : round(sample.pedal),
        brake: Boolean(sample.brake),
        steer: round(Math.max(-540, Math.min(540, sample.steer ?? 0))),
        left: Boolean(sample.left),
        right: Boolean(sample.right)
    };
}

function sampleKey(sample) {
    return [
        sample.speedKph,
        sample.pedal,
        sample.brake ? 1 : 0,
        sample.steer,
        sample.left ? 1 : 0,
        sample.right ? 1 : 0
    ].join('|');
}

function buildHudEvents(samples, durationSeconds) {
    const events = [];
    for (let index = 0; index < samples.length; index += 1) {
        const start = Math.max(0, Number(samples[index].t) || 0);
        const next = samples[index + 1];
        const end = Math.min(
            durationSeconds,
            next ? Number(next.t) || durationSeconds : durationSeconds
        );
        if (end <= start) continue;
        const quantized = quantizeSample(samples[index]);
        const key = sampleKey(quantized);
        const previous = events.at(-1);
        if (previous && previous.key === key) {
            previous.end = Math.max(previous.end, end);
            continue;
        }
        events.push({...quantized, start, end, key});
    }
    return events;
}

// A single 48 × 48 silhouette. The three reverse-wound openings form the spokes.
const WHEEL_PATH = [
    'm 0 24 b 0 11 11 0 24 0 b 37 0 48 11 48 24 b 48 37 37 48 24 48 b 11 48 0 37 0 24',
    'm 5 21 l 43 21 b 42 12 34 5 24 5 b 14 5 6 12 5 21',
    'm 5 27 b 6 35 13 42 21 43 l 21 33 b 21 29 18 27 15 27 l 5 27',
    'm 27 43 b 35 42 42 35 43 27 l 33 27 b 30 27 27 29 27 33 l 27 43'
].join(' ');

function roundedRectPath(x, y, w, h, r) {
    const radius = Math.max(0, Math.min(r, w / 2, h / 2));
    const k = 0.5522847498 * radius;
    const p = (value) => round(value);
    const x0 = p(x);
    const y0 = p(y);
    const x1 = p(x + w);
    const y1 = p(y + h);
    const x0r = p(x + radius);
    const y0r = p(y + radius);
    const x1r = p(x + w - radius);
    const y1r = p(y + h - radius);
    return [
        `m ${x0r} ${y0}`,
        `l ${x1r} ${y0}`,
        `b ${p(x1r + k)} ${y0} ${x1} ${p(y0r - k)} ${x1} ${y0r}`,
        `l ${x1} ${y1r}`,
        `b ${x1} ${p(y1r + k)} ${p(x1r + k)} ${y1} ${x1r} ${y1}`,
        `l ${x0r} ${y1}`,
        `b ${p(x0r - k)} ${y1} ${x0} ${p(y1r + k)} ${x0} ${y1r}`,
        `l ${x0} ${y0r}`,
        `b ${x0} ${p(y0r - k)} ${p(x0r - k)} ${y0} ${x0r} ${y0}`
    ].join(' ');
}

function dialogue(start, end, style, text, layer = 0) {
    let startTime = formatAssTime(start);
    let endTime = formatAssTime(end);
    if (endTime <= startTime) {
        endTime = formatAssTime(start + 0.01);
    }
    return `Dialogue: ${layer},${startTime},${endTime},${style},,0,0,0,,${text}`;
}

function chevronPath(direction, width, height) {
    const tip = direction === 'left' ? 0 : width;
    const back = width - tip;
    return `m ${tip} ${height / 2} l ${back} 0 ${back} ${height}`;
}

function buildEventLines(event) {
    const {start, end, speedKph, pedal, brake, steer, left, right} = event;
    const speedText = speedKph === null ? '--' : String(speedKph);
    const pedalValue = pedal === null ? 0 : Math.max(0, Math.min(100, pedal));
    const pedalText = pedal === null ? '--%' : `${pedalValue}%`;
    const steerText = `${steer}°`;
    const barX = PANEL_X + 214;
    const barY = PANEL_Y + 176;
    const barW = 236;
    const barH = 12;
    const fillW = Math.round(barW * pedalValue / 100);
    const lines = [];

    // libass lays adjacent drawing runs out as text. Give each overlay its own anchor.
    function addDrawing(layer, x, y, path, color, alpha = '00', transform = '') {
        const tags = `\\an7\\pos(${x},${y})${transform}\\p1\\c${color}\\alpha&H${alpha}&\\bord0\\shad0`;
        lines.push(dialogue(start, end, 'Draw', `{${tags}}${path}{\\p0}`, layer));
    }

    const panelPath = roundedRectPath(0, 0, PANEL_W, PANEL_H, 22);
    addDrawing(0, PANEL_X + 8, PANEL_Y + 10, panelPath, '&H00000000&', '88');
    addDrawing(1, PANEL_X, PANEL_Y, panelPath, '&H00101418&', '46');
    addDrawing(2, PANEL_X + 24, PANEL_Y, roundedRectPath(0, 0, PANEL_W - 48, 4, 2), '&H003D55F2&');
    addDrawing(2, PANEL_X + 22, PANEL_Y + 16, roundedRectPath(0, 0, PANEL_W - 44, 1, 0), '&H00FFFFFF&', 'C8');

    const addBlinker = (on, x, direction) => {
        const y = PANEL_Y + 86;
        if (on) addDrawing(2, x - 23, y - 20, chevronPath(direction, 46, 40), '&H0042C8F7&', 'B0');
        addDrawing(3, x - 17, y - 15, chevronPath(direction, 34, 30), on ? '&H0042C8F7&' : '&H00646C74&', on ? '00' : '55');
    };
    addBlinker(left, PANEL_X + 86, 'left');
    addBlinker(right, PANEL_X + PANEL_W - 86, 'right');

    lines.push(dialogue(
        start,
        end,
        'Speed',
        `{\\an5\\pos(${PANEL_CX},${PANEL_Y + 78})}${speedText}`,
        4
    ));
    lines.push(dialogue(
        start,
        end,
        'Unit',
        `{\\an5\\pos(${PANEL_CX},${PANEL_Y + 118})}km/h`,
        4
    ));

    const wheelX = PANEL_X + 72;
    const wheelY = PANEL_Y + 198;
    // ASS rotates counterclockwise. Match the clockwise CSS rotation in the viewer.
    addDrawing(3, wheelX - 24, wheelY - 24, WHEEL_PATH, '&H00E8EEF2&', '00', `\\org(${wheelX},${wheelY})\\frz${-steer}`);
    lines.push(dialogue(
        start,
        end,
        'Value',
        `{\\an4\\pos(${PANEL_X + 112},${wheelY})}${steerText}`,
        4
    ));

    lines.push(dialogue(start, end, 'Label', `{\\an4\\pos(${barX},${barY - 18})}ACC`, 4));
    addDrawing(2, barX, barY, roundedRectPath(0, 0, barW, barH, 6), '&H002A3138&', '20');
    if (fillW) addDrawing(3, barX, barY, roundedRectPath(0, 0, fillW, barH, 6), '&H00D8A82A&');
    lines.push(dialogue(
        start,
        end,
        'Value',
        `{\\an4\\pos(${barX + barW + 12},${barY + barH / 2})}${pedalText}`,
        4
    ));

    const brakeX = barX;
    const brakeY = PANEL_Y + 208;
    lines.push(dialogue(start, end, 'Label', `{\\an4\\pos(${brakeX},${brakeY})}BRK`, 4));
    addDrawing(3, brakeX + 52, brakeY - 8, roundedRectPath(0, 0, 88, 26, 13),
        brake ? '&H003D55F2&' : '&H002A3138&', brake ? '00' : '30');
    lines.push(dialogue(
        start,
        end,
        brake ? 'BrakeOn' : 'BrakeOff',
        `{\\an5\\pos(${brakeX + 96},${brakeY + 5})}${brake ? 'ON' : 'OFF'}`,
        4
    ));

    return lines;
}

function defaultFontName(platform = process.platform) {
    if (platform === 'darwin') return 'Helvetica Neue';
    if (platform === 'win32') return 'Segoe UI';
    return 'DejaVu Sans';
}

function defaultFontsDir(platform = process.platform) {
    if (platform === 'darwin') return '/System/Library/Fonts';
    if (platform === 'win32') return 'C:/Windows/Fonts';
    return '/usr/share/fonts';
}

function buildHudAss(samples, {durationSeconds, fontName = defaultFontName()} = {}) {
    const events = buildHudEvents(samples, durationSeconds);
    if (!events.length) return null;

    const header = [
        '[Script Info]',
        'Title: TeslaCam Studio HUD',
        'ScriptType: v4.00+',
        'WrapStyle: 0',
        'ScaledBorderAndShadow: yes',
        'YCbCr Matrix: None',
        `PlayResX: ${PLAY_RES_X}`,
        `PlayResY: ${PLAY_RES_Y}`,
        // Apply rotations in HUD coordinates before scaling to the camera's aspect ratio.
        `LayoutResX: ${PLAY_RES_X}`,
        `LayoutResY: ${PLAY_RES_Y}`,
        '',
        '[V4+ Styles]',
        'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
        `Style: Draw,Arial,8,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,7,0,0,0,1`,
        `Style: Speed,${fontName},68,&H00F7F4F2,&H000000FF,&H66101418,&H00000000,-1,0,0,0,100,100,0,0,1,3,0,5,0,0,0,1`,
        `Style: Unit,${fontName},18,&H00B1A79D,&H000000FF,&H66101418,&H00000000,0,0,0,0,100,100,0,0,1,1,0,5,0,0,0,1`,
        `Style: Label,${fontName},15,&H00A8B0B8,&H000000FF,&H66101418,&H00000000,1,0,0,0,100,100,1.2,0,1,1,0,4,0,0,0,1`,
        `Style: Value,${fontName},22,&H00F7F4F2,&H000000FF,&H66101418,&H00000000,-1,0,0,0,100,100,0,0,1,1,0,4,0,0,0,1`,
        `Style: BrakeOn,${fontName},14,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,-1,0,0,0,100,100,0.8,0,1,0,0,5,0,0,0,1`,
        `Style: BrakeOff,${fontName},14,&H00A8B0B8,&H000000FF,&H00000000,&H00000000,1,0,0,0,100,100,0.8,0,1,0,0,5,0,0,0,1`,
        '',
        '[Events]',
        'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text'
    ];

    const body = events.flatMap((event) => buildEventLines(event));
    return `${header.concat(body).join('\n')}\n`;
}

module.exports = {
    buildHudAss,
    collectHudSamples,
    defaultFontName,
    defaultFontsDir,
    formatAssTime,
    normalizePedalPercent
};
