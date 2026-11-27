const assert = require('node:assert/strict');
const {spawnSync} = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const ffmpeg = require('ffmpeg-static');
const {buildHudAss} = require('../src/telemetry-hud');
const {buildExportArgs, ffmpegOutputHasFilter} = require('../src/video-export');

function runFfmpeg(args, options = {}) {
    const result = spawnSync(ffmpeg, args, {encoding: 'utf8', ...options});
    assert.equal(result.status, 0, result.stderr?.toString() || result.error?.message);
    return result;
}

function ffmpegSupportsFilter(filterName) {
    const result = runFfmpeg(['-hide_banner', '-filters']);
    return ffmpegOutputHasFilter(`${result.stdout}\n${result.stderr}`, filterName);
}

test('watermark filters can be omitted when drawtext is unavailable', () => {
    assert.equal(ffmpegOutputHasFilter(' T.C drawtext         V->V', 'drawtext'), true);
    assert.equal(ffmpegOutputHasFilter(' T.. overlay          VV->V', 'drawtext'), false);
    const args = buildExportArgs([
        {filePath: 'input.mp4', startSeconds: 0, durationSeconds: 1, epochSeconds: 1_788_000_000}
    ], 'Front', 'output.mp4', {includeWatermark: false});
    assert.doesNotMatch(args[args.indexOf('-filter_complex') + 1], /drawtext/);
});

test('rendered HUD keeps the wheel on its hub and the pedal fill inside its track', (t) => {
    if (!ffmpegSupportsFilter('ass')) return t.skip('FFmpeg lacks the ASS filter');
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'teslacam-hud-test-'));
    try {
        const samples = [
            {t: 0, steer: 0, pedal: 0},
            {t: 1, steer: 3, pedal: 21},
            {t: 2, steer: 90, pedal: 100},
            {t: 3, steer: -90, pedal: null}
        ];
        fs.writeFileSync(path.join(tempDir, 'hud.ass'), buildHudAss(samples, {durationSeconds: 4}));
        // Crop the controls at script resolution so we can inspect their pixels before encoding.
        const {stdout: frames} = runFfmpeg([
            '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=black:s=1920x1080:r=1:d=4',
            '-vf', 'ass=hud.ass,crop=640:64:1280:950', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'
        ], {cwd: tempDir, encoding: null});
        assert.equal(frames.length, samples.length * 640 * 64 * 3);
        function pixel(frame, x, y) {
            const offset = ((frame * 64 + y) * 640 + x) * 3;
            return frames.subarray(offset, offset + 3);
        }

        const hubX = 96, hubY = 32;
        for (const [frame, sample] of samples.entries()) {
            const wheelAt = (dx, dy) => pixel(frame, hubX + dx, hubY + dy)[0] > 180;
            assert.ok(wheelAt(0, 0) && wheelAt(0, -22) && wheelAt(22, 0), `hub and rim at ${sample.steer}°`);
            const radians = sample.steer * Math.PI / 180;
            const dx = Math.round(-14 * Math.sin(radians));
            const dy = Math.round(14 * Math.cos(radians));
            assert.ok(wheelAt(dx, dy) && !wheelAt(-dx, -dy), `lower spoke at ${sample.steer}°`);

            const bluePixels = [];
            for (let x = 0; x < 640; x++) {
                const [red, green, blue] = pixel(frame, x, 16);
                if (red < 90 && green > 115 && blue > 150) bluePixels.push(x);
            }
            const fillWidth = Math.round(236 * (sample.pedal ?? 0) / 100);
            assert.ok(Math.abs(bluePixels.length - fillWidth) <= 1, `fill width at ${sample.pedal}%`);
            if (fillWidth) assert.ok(Math.abs(bluePixels[0] - 238) <= 1, 'fill starts at the left of the track');
            else assert.equal(bluePixels.length, 0);
        }
    } finally {
        fs.rmSync(tempDir, {recursive: true, force: true});
    }
});

test('cross-file export resets timestamps and keeps a constant playback rate', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'teslacam-export-test-'));
    try {
        const first = path.join(tempDir, 'first.mp4');
        const second = path.join(tempDir, 'second.mp4');
        const output = path.join(tempDir, 'output.mp4');

        runFfmpeg([
            '-y', '-hide_banner', '-loglevel', 'error',
            '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=24',
            '-t', '3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', first
        ]);
        runFfmpeg([
            '-y', '-hide_banner', '-loglevel', 'error',
            '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=36',
            '-t', '3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', second
        ]);

        const segments = [
            {filePath: first, startSeconds: 0.25, durationSeconds: 1.25, epochSeconds: 1_788_000_000},
            {filePath: second, startSeconds: 0.5, durationSeconds: 1.75, epochSeconds: 1_788_000_060}
        ];
        const includeWatermark = ffmpegSupportsFilter('drawtext');
        runFfmpeg(buildExportArgs(segments, 'Front', output, {includeWatermark}));

        const probe = runFfmpeg(['-hide_banner', '-i', output, '-f', 'null', '-']);
        const durationMatch = probe.stderr.match(/Duration:\s+(\d+):(\d+):(\d+(?:\.\d+)?)/);
        assert.ok(durationMatch, probe.stderr);
        const duration = Number(durationMatch[1]) * 3600
            + Number(durationMatch[2]) * 60
            + Number(durationMatch[3]);
        assert.ok(Math.abs(duration - 3) <= 0.05, `expected 3 seconds, received ${duration}`);
        assert.match(probe.stderr, /30 fps/);
    } finally {
        fs.rmSync(tempDir, {recursive: true, force: true});
    }
});
