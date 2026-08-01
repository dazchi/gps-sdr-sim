// Playback ticker that keeps firing at the requested rate even when the parent
// tab is backgrounded (main-thread setInterval throttles to ~1 Hz on inactive
// tabs; workers do not).
let intervalId = null;

self.onmessage = (e) => {
    const msg = e.data;
    if (msg.type === 'start') {
        if (intervalId !== null) clearInterval(intervalId);
        intervalId = setInterval(() => self.postMessage({ type: 'tick' }), msg.intervalMs);
    } else if (msg.type === 'stop') {
        if (intervalId !== null) { clearInterval(intervalId); intervalId = null; }
    }
};
