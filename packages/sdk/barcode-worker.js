let detector = null;
let busy = false;
let supported = true;

function ensureDetector() {
    if (detector) return detector;
    if (typeof BarcodeDetector === 'undefined') {
        supported = false;
        return null;
    }
    detector = new BarcodeDetector({ formats: ['qr_code'] });
    return detector;
}

self.onmessage = async (e) => {
    const msg = e.data;
    if (msg.kind === 'init') {
        const d = ensureDetector();
        if (!d) self.postMessage({ kind: 'error', error: 'BarcodeDetector not supported in this browser' });
        else self.postMessage({ kind: 'ready' });
        return;
    }
    if (msg.kind === 'recognize') {
        const { requestId, sampledAt, localN, bitmap } = msg;
        if (busy) {
            try { bitmap.close?.(); } catch (_) {}
            self.postMessage({ kind: 'dropped', requestId });
            return;
        }
        const d = ensureDetector();
        if (!d) {
            try { bitmap.close?.(); } catch (_) {}
            self.postMessage({ kind: 'error', requestId, error: 'BarcodeDetector not supported' });
            return;
        }
        busy = true;
        try {
            const codes = await d.detect(bitmap);
            try { bitmap.close?.(); } catch (_) {}
            let remoteN = NaN;
            let found = false;
            for (const c of codes) {
                const v = c.rawValue?.trim();
                if (v && /^\d+$/.test(v)) {
                    remoteN = parseInt(v, 10);
                    found = true;
                    break;
                }
            }
            self.postMessage({ kind: 'result', requestId, sampledAt, localN, remoteN, found });
        } catch (err) {
            try { bitmap.close?.(); } catch (_) {}
            self.postMessage({ kind: 'error', requestId, error: String(err?.message ?? err) });
        } finally {
            busy = false;
        }
    }
};
