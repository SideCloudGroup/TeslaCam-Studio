const assert = require('node:assert/strict');
const {spawnSync} = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const ffmpeg = require('ffmpeg-static');
const {buildExportArgs} = require('../src/video-export');

function runFfmpeg(args) {
    const result = spawnSync(ffmpeg, args, {encoding: 'utf8'});
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return result;
}

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
        runFfmpeg(buildExportArgs(segments, 'Front', output));

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
