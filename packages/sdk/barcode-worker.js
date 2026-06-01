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
        const { requestId, sampledAt, bitmap } = msg;
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
            const raw = codes.length ? (codes[0].rawValue || '').trim() : '';
            self.postMessage({ kind: 'result', requestId, sampledAt, rawValue: raw, found: raw.length > 0 });
        } catch (err) {
            try { bitmap.close?.(); } catch (_) {}
            self.postMessage({ kind: 'error', requestId, error: String(err?.message ?? err) });
        } finally {
            busy = false;
        }
    }
};
