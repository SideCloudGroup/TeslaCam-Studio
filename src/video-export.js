function seconds(value) {
    return Number(value).toFixed(3);
}

function escapeDrawtextText(text) {
    return String(text)
        .replaceAll('\\', '\\\\')
        .replaceAll(':', '\\:')
        .replaceAll("'", "\\'")
        .replaceAll('%', '\\%')
        .replaceAll(',', '\\,');
}

function buildWatermarkFilter(cameraTitle, epochSeconds) {
    const title = escapeDrawtextText(cameraTitle);
    const timeText = `%{pts\\:localtime\\:${Math.floor(epochSeconds)}\\:%Y-%m-%d %H\\\\\\:%M\\\\\\:%S}`;
    return [
        `drawtext=text='${title}':x=40:y=h-96:fontsize=18:fontcolor=white@0.84:shadowcolor=black@0.85:shadowx=2:shadowy=2`,
        `drawtext=text='${timeText}':x=40:y=h-66:fontsize=34:fontcolor=white:shadowcolor=black@0.9:shadowx=3:shadowy=3`
    ].join(',');
}

function ffmpegOutputHasFilter(output, filterName) {
    const escapedName = filterName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`^\\s*[.A-Z|]+\\s+${escapedName}\\s`, 'm').test(output);
}

function escapeFilterPath(filePath) {
    return String(filePath)
        .replaceAll('\\', '/')
        .replaceAll("'", "\\'")
        .replaceAll(':', '\\:');
}

function buildAssFilter(assPath, fontsDir) {
    const parts = [`filename='${escapeFilterPath(assPath)}'`];
    if (fontsDir) parts.push(`fontsdir='${escapeFilterPath(fontsDir)}'`);
    return `ass=${parts.join(':')}`;
}

function buildExportArgs(segments, cameraTitle, outputPath, {
    includeWatermark = true,
    telemetryAssPath = null,
    fontsDir = null
} = {}) {
    const args = ['-y', '-hide_banner'];
    const filters = [];
    const totalSeconds = segments.reduce((total, segment) => total + Number(segment.durationSeconds), 0);
    const hudFilter = telemetryAssPath ? buildAssFilter(telemetryAssPath, fontsDir) : null;

    segments.forEach((segment, index) => {
        args.push(
            '-ss', seconds(segment.startSeconds),
            '-t', seconds(segment.durationSeconds),
            '-i', segment.filePath
        );
        const segmentFilters = [
            `trim=duration=${seconds(segment.durationSeconds)}`,
            'settb=AVTB',
            'setpts=PTS-STARTPTS'
        ];
        if (includeWatermark) {
            segmentFilters.push(buildWatermarkFilter(cameraTitle, segment.epochSeconds));
        }
        filters.push(`[${index}:v:0]${segmentFilters.join(',')}[v${index}]`);
    });

    if (segments.length === 1) {
        filters.push(hudFilter ? `[v0]${hudFilter}[outv]` : '[v0]null[outv]');
    } else {
        const inputs = segments.map((_segment, index) => `[v${index}]`).join('');
        if (hudFilter) {
            filters.push(`${inputs}concat=n=${segments.length}:v=1:a=0,setpts=PTS-STARTPTS[joined]`);
            filters.push(`[joined]${hudFilter}[outv]`);
        } else {
            filters.push(`${inputs}concat=n=${segments.length}:v=1:a=0,setpts=PTS-STARTPTS[outv]`);
        }
    }

    return [
        ...args,
        '-filter_complex', filters.join(';'),
        '-map', '[outv]',
        '-an',
        '-c:v', 'libx264',
        '-preset', 'medium',
        '-crf', '23',
        '-pix_fmt', 'yuv420p',
        '-r', '30',
        '-fps_mode', 'cfr',
        '-video_track_timescale', '90000',
        '-t', seconds(totalSeconds),
        '-movflags', '+faststart',
        outputPath
    ];
}

module.exports = {buildExportArgs, ffmpegOutputHasFilter, escapeFilterPath};
