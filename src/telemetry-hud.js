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

function circlePath(cx, cy, r) {
    const k = 0.5522847498 * r;
    const p = (value) => round(value);
    return [
        `m ${p(cx - r)} ${p(cy)}`,
        `b ${p(cx - r)} ${p(cy - k)} ${p(cx - k)} ${p(cy - r)} ${p(cx)} ${p(cy - r)}`,
        `b ${p(cx + k)} ${p(cy - r)} ${p(cx + r)} ${p(cy - k)} ${p(cx + r)} ${p(cy)}`,
        `b ${p(cx + r)} ${p(cy + k)} ${p(cx + k)} ${p(cy + r)} ${p(cx)} ${p(cy + r)}`,
        `b ${p(cx - k)} ${p(cy + r)} ${p(cx - r)} ${p(cy + k)} ${p(cx - r)} ${p(cy)}`
    ].join(' ');
}

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

function draw(path, color, alpha = '00') {
    return `{\\p1\\c${color}\\alpha&H${alpha}&\\bord0\\shad0}${path}{\\p0}`;
}

function dialogue(start, end, style, text, layer = 0) {
    let startTime = formatAssTime(start);
    let endTime = formatAssTime(end);
    if (endTime <= startTime) {
        endTime = formatAssTime(start + 0.01);
    }
    return `Dialogue: ${layer},${startTime},${endTime},${style},,0,0,0,,${text}`;
}

function chevronPath(direction, scale = 1) {
    const sign = direction === 'left' ? -1 : 1;
    const tip = round(22 * scale) * sign;
    const back = round(-12 * scale) * sign;
    const height = round(15 * scale);
    return `m ${tip} 0 l ${back} ${-height} ${back} ${height}`;
}

function wheelPathSet(steer) {
    const x = PANEL_X + 72;
    const y = PANEL_Y + 198;
    const rotate = `\\an5\\pos(${x},${y})\\org(${x},${y})\\frz${steer}\\shad0`;
    return [
        `{${rotate}\\bord5\\1a&HFF&\\3c&H00E8EEF2&\\3a&H00&\\p1}${circlePath(0, 0, 21)}{\\p0}`,
        `{${rotate}\\bord0\\c&H00E8EEF2&\\alpha&H00&\\p1}m -16 -3 l 16 -3 16 3 -16 3{\\p0}`,
        `{${rotate}\\bord0\\c&H00E8EEF2&\\alpha&H00&\\p1}m -3 0 l 3 0 3 16 -3 16{\\p0}`,
        `{${rotate}\\bord0\\c&H00E8EEF2&\\alpha&H00&\\p1}m -2 -21 l 2 -21 2 -13 -2 -13{\\p0}`,
        `{${rotate}\\bord0\\c&H00E8EEF2&\\alpha&H00&\\p1}${circlePath(0, 0, 5)}{\\p0}`
    ].join('');
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
    const fillW = Math.max(pedalValue > 0 ? 8 : 0, Math.round(barW * (pedalValue / 100)));
    const lines = [];

    lines.push(dialogue(start, end, 'Draw', [
        `{\\an7\\pos(${PANEL_X + 8},${PANEL_Y + 10})}`,
        draw(roundedRectPath(0, 0, PANEL_W, PANEL_H, 22), '&H00000000&', '88')
    ].join(''), 0));
    lines.push(dialogue(start, end, 'Draw', [
        `{\\an7\\pos(${PANEL_X},${PANEL_Y})}`,
        draw(roundedRectPath(0, 0, PANEL_W, PANEL_H, 22), '&H00101418&', '46'),
        draw(roundedRectPath(24, 0, PANEL_W - 48, 4, 2), '&H003D55F2&', '00'),
        draw(roundedRectPath(22, 16, PANEL_W - 44, 1, 0), '&H00FFFFFF&', 'C8')
    ].join(''), 1));

    const blinker = (on, x, direction) => {
        const glow = on ? draw(chevronPath(direction, 1.35), '&H0042C8F7&', 'B0') : '';
        const fill = draw(chevronPath(direction), on ? '&H0042C8F7&' : '&H00646C74&', on ? '00' : '55');
        return dialogue(start, end, 'Draw', `{\\an5\\pos(${x},${PANEL_Y + 86})}${glow}${fill}`, on ? 3 : 2);
    };
    lines.push(blinker(left, PANEL_X + 86, 'left'));
    lines.push(blinker(right, PANEL_X + PANEL_W - 86, 'right'));

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

    lines.push(dialogue(start, end, 'Draw', wheelPathSet(steer), 3));
    lines.push(dialogue(
        start,
        end,
        'Value',
        `{\\an4\\pos(${PANEL_X + 112},${PANEL_Y + 186})}${steerText}`,
        4
    ));

    lines.push(dialogue(start, end, 'Label', `{\\an4\\pos(${barX},${barY - 18})}ACC`, 4));
    lines.push(dialogue(start, end, 'Draw', [
        `{\\an7\\pos(${barX},${barY})}`,
        draw(roundedRectPath(0, 0, barW, barH, 6), '&H002A3138&', '20'),
        fillW ? draw(roundedRectPath(0, 0, fillW, barH, 6), '&H00D8A82A&', '00') : ''
    ].join(''), 3));
    lines.push(dialogue(
        start,
        end,
        'Value',
        `{\\an6\\pos(${barX + barW + 48},${barY + 6})}${pedalText}`,
        4
    ));

    const brakeX = barX;
    const brakeY = PANEL_Y + 208;
    lines.push(dialogue(start, end, 'Label', `{\\an4\\pos(${brakeX},${brakeY})}BRK`, 4));
    lines.push(dialogue(start, end, 'Draw', [
        `{\\an7\\pos(${brakeX + 52},${brakeY - 8})}`,
        draw(roundedRectPath(0, 0, 88, 26, 13), brake ? '&H003D55F2&' : '&H002A3138&', brake ? '00' : '30')
    ].join(''), 3));
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
