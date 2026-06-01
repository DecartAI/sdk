const QP_MAX = { H264: 51, VP8: 127, VP9: 255, AV1: 255 };

function qpMaxForCodec(codec) {
    const key = (codec || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (key.includes('H264') || key.includes('AVC')) return QP_MAX.H264;
    if (key.includes('VP8')) return QP_MAX.VP8;
    if (key.includes('VP9')) return QP_MAX.VP9;
    if (key.includes('AV1')) return QP_MAX.AV1;
    return null;
}

function normalizeQp(value, codec) {
    if (value == null || !Number.isFinite(value)) return null;
    const max = qpMaxForCodec(codec);
    if (!max) return null;
    return (value / max) * 100;
}

const MAX_POINTS_PER_SERIES = 120;

function downsample(arr) {
    const n = arr.length;
    if (n <= MAX_POINTS_PER_SERIES) return arr;
    const step = n / MAX_POINTS_PER_SERIES;
    const out = new Array(MAX_POINTS_PER_SERIES);
    for (let i = 0; i < MAX_POINTS_PER_SERIES; i++) out[i] = arr[Math.floor(i * step)];
    return out;
}

function buildDatasets(runs) {
    const datasets = {
        fpsTx: [], fpsRx: [],
        bitrateTx: [], bitrateRx: [],
        rtt: [], loss: [],
        nackTx: [], nackRx: [],
        keyframesTx: [], keyframesRx: [],
        qpTx: [], qpRx: [],
        bppTx: [], bppRx: [],
        ocrLatency: [],
        jitter: [],
    };

    runs.forEach((run) => {
        const { color, label, samples, ocrLatency, startedAtMs } = run;
        const points = downsample(samples).map((s) => ({ x: +(s.tMs / 1000).toFixed(2), d: s.derived }));
        const outCodec = points.find((p) => p.d.outboundCodec)?.d.outboundCodec ?? '?';
        const inCodec = points.find((p) => p.d.inboundCodec)?.d.inboundCodec ?? '?';
        const lineBase = { borderColor: color, backgroundColor: color, spanGaps: true, pointRadius: 0 };
        const ocrPoints = ocrLatency && ocrLatency.length
            ? downsample(ocrLatency).map((e) => ({ x: +((e.tMsAbs - startedAtMs) / 1000).toFixed(2), y: e.latencyMs }))
            : [];
        datasets.ocrLatency.push({ label, ...lineBase, pointRadius: 2, data: ocrPoints });
        datasets.jitter.push({ label, ...lineBase, data: points.map((p) => ({ x: p.x, y: p.d.jitterMs })) });
        datasets.fpsTx.push({ label, ...lineBase, data: points.map((p) => ({ x: p.x, y: p.d.senderFps })) });
        datasets.fpsRx.push({ label, ...lineBase, data: points.map((p) => ({ x: p.x, y: p.d.receiverFps })) });
        datasets.bitrateTx.push({ label, ...lineBase, data: points.map((p) => ({ x: p.x, y: p.d.senderBitrateBps != null ? p.d.senderBitrateBps / 1000 : null })) });
        datasets.bitrateRx.push({ label, ...lineBase, data: points.map((p) => ({ x: p.x, y: p.d.receiverBitrateBps != null ? p.d.receiverBitrateBps / 1000 : null })) });
        datasets.rtt.push({ label, ...lineBase, data: points.map((p) => ({ x: p.x, y: p.d.rtt })) });
        datasets.loss.push({ label, ...lineBase, data: points.map((p) => ({ x: p.x, y: p.d.cumulativeLossPct })) });
        datasets.nackTx.push({ label, ...lineBase, data: points.map((p) => ({ x: p.x, y: p.d.nackOutDelta })) });
        datasets.nackRx.push({ label, ...lineBase, data: points.map((p) => ({ x: p.x, y: p.d.nackInDelta })) });
        datasets.keyframesTx.push({ label, ...lineBase, data: points.map((p) => ({ x: p.x, y: p.d.keyFramesOutDelta })) });
        datasets.keyframesRx.push({ label, ...lineBase, data: points.map((p) => ({ x: p.x, y: p.d.keyFramesInDelta })) });
        const qpOutRaw = points.map((p) => p.d.avgQpOut);
        const qpInRaw = points.map((p) => p.d.avgQpIn);
        datasets.qpTx.push({
            label: `${label} (${outCodec})`,
            ...lineBase,
            yAxisID: 'y',
            data: points.map((p) => ({ x: p.x, y: normalizeQp(p.d.avgQpOut, outCodec) })),
            _qpRaw: qpOutRaw,
            _qpCodec: outCodec,
        });
        datasets.qpRx.push({
            label: `${label} (${inCodec})`,
            ...lineBase,
            yAxisID: 'y',
            data: points.map((p) => ({ x: p.x, y: normalizeQp(p.d.avgQpIn, inCodec) })),
            _qpRaw: qpInRaw,
            _qpCodec: inCodec,
        });
        datasets.bppTx.push({ label, ...lineBase, yAxisID: 'y', data: points.map((p) => ({ x: p.x, y: p.d.bppOut })) });
        datasets.bppRx.push({ label, ...lineBase, yAxisID: 'y', data: points.map((p) => ({ x: p.x, y: p.d.bppIn })) });
    });

    return datasets;
}

const CSV_HEADER = [
    'run', 'profile', 'sessionId', 'tMs',
    'outboundCodec', 'inboundCodec',
    'receiverFps', 'receiverKbps', 'senderKbps', 'senderFps',
    'outFrameWidth', 'outFrameHeight', 'inFrameWidth', 'inFrameHeight', 'inFps',
    'bppOut', 'bppIn',
    'qpSumOutTotal', 'framesEncodedTotal', 'avgQpOut',
    'qpSumInTotal', 'framesDecodedTotal', 'avgQpIn',
    'totalEncodeTimeSec', 'avgEncodeMs',
    'rttMs', 'packetsLostDelta', 'cumulativeLossPct',
    'nackOutDelta', 'nackInDelta',
    'keyFramesOutTotal', 'keyFramesOutDelta', 'keyFramesInTotal', 'keyFramesInDelta',
    'framesDroppedInTotal', 'framesDroppedInDelta',
    'freezeCountTotal', 'freezeCountDelta', 'totalFreezesDurationSec',
    'pauseCountTotal', 'pauseCountDelta',
    'qlReasonOut',
    'ocrLatencyMs', 'ocrStampId',
];

const OCR_JOIN_WINDOW_MS = 1000;

function findNearestOcr(series, sampleAbsMs) {
    if (!series || !series.length) return null;
    let best = null;
    let bestDiff = Infinity;
    for (const e of series) {
        const diff = Math.abs(e.tMsAbs - sampleAbsMs);
        if (diff < bestDiff) { bestDiff = diff; best = e; }
    }
    return bestDiff <= OCR_JOIN_WINDOW_MS ? best : null;
}

function buildCsv(runs) {
    const rows = [CSV_HEADER.join(',')];
    runs.forEach((run, idx) => {
        run.samples.forEach((s) => {
            const d = s.derived;
            const sampleAbsMs = run.startedAtMs + s.tMs;
            const ocr = findNearestOcr(run.ocrLatency, sampleAbsMs);
            rows.push([
                idx + 1,
                run.profile,
                run.sessionId ?? '',
                s.tMs,
                d.outboundCodec ?? '',
                d.inboundCodec ?? '',
                d.receiverFps?.toFixed(3) ?? '',
                d.receiverBitrateBps != null ? (d.receiverBitrateBps / 1000).toFixed(2) : '',
                d.senderBitrateBps != null ? (d.senderBitrateBps / 1000).toFixed(2) : '',
                d.senderFps?.toFixed(3) ?? '',
                d.outFrameWidth ?? '',
                d.outFrameHeight ?? '',
                d.inFrameWidth ?? '',
                d.inFrameHeight ?? '',
                d.inFps != null ? d.inFps.toFixed(3) : '',
                d.bppOut != null ? d.bppOut.toFixed(6) : '',
                d.bppIn != null ? d.bppIn.toFixed(6) : '',
                d.qpSumOutTotal ?? '',
                d.framesEncodedTotal ?? '',
                d.avgQpOut != null ? d.avgQpOut.toFixed(3) : '',
                d.qpSumInTotal ?? '',
                d.framesDecodedTotal ?? '',
                d.avgQpIn != null ? d.avgQpIn.toFixed(3) : '',
                d.totalEncodeTimeSec != null ? d.totalEncodeTimeSec.toFixed(4) : '',
                d.avgEncodeMs != null ? d.avgEncodeMs.toFixed(3) : '',
                d.rtt?.toFixed(2) ?? '',
                d.packetsLostDelta ?? '',
                d.cumulativeLossPct?.toFixed(4) ?? '',
                d.nackOutDelta ?? '',
                d.nackInDelta ?? '',
                d.keyFramesOutTotal ?? '',
                d.keyFramesOutDelta ?? '',
                d.keyFramesInTotal ?? '',
                d.keyFramesInDelta ?? '',
                d.framesDroppedInTotal ?? '',
                d.framesDroppedInDelta ?? '',
                d.freezeCountTotal ?? '',
                d.freezeCountDelta ?? '',
                d.totalFreezesDurationSec != null ? d.totalFreezesDurationSec.toFixed(3) : '',
                d.pauseCountTotal ?? '',
                d.pauseCountDelta ?? '',
                d.qlReasonOut ?? '',
                ocr ? ocr.latencyMs.toFixed(2) : '',
                ocr ? ocr.stampId : '',
            ].join(','));
        });
    });
    return rows.join('\n');
}

self.onmessage = (e) => {
    const msg = e.data;
    if (msg.kind === 'datasets') {
        const datasets = buildDatasets(msg.runs);
        self.postMessage({ kind: 'datasets', requestId: msg.requestId, datasets });
        return;
    }
    if (msg.kind === 'csv') {
        const text = buildCsv(msg.runs);
        self.postMessage({ kind: 'csv', requestId: msg.requestId, text });
        return;
    }
};
