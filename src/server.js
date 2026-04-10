// =============================================================================
// HCC Spotify Bridge — HTTP / WebSocket server
// =============================================================================
// Endpoints:
//   GET  /health           — liveness probe
//   GET  /status           — full status JSON (stats + state + opts)
//   GET  /logs             — last N log lines
//   POST /restart          — manually restart librespot
//   POST /event            — internal: called by --onevent hook script
//   WS   /ws               — live status + log stream
// =============================================================================

const express = require('express');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const { LibrespotSupervisor } = require('./supervisor');
const { CECController } = require('./cec');

const PORT = parseInt(process.env.BRIDGE_PORT || '3081');
const CACHE_DIR = process.env.LIBRESPOT_CACHE || '/app/data/librespot';

// Ensure cache dir exists
try { fs.mkdirSync(CACHE_DIR, { recursive: true }); } catch (e) {}

// Build supervisor options from env
var supOpts = {
    bin: process.env.LIBRESPOT_BIN || '/usr/local/bin/librespot',
    name: process.env.LIBRESPOT_NAME || 'NAD-AVR',
    device: process.env.LIBRESPOT_DEVICE || 'hw:0,0',
    deviceType: process.env.LIBRESPOT_DEVICE_TYPE || 'avr',
    bitrate: parseInt(process.env.LIBRESPOT_BITRATE || '320'),
    format: process.env.LIBRESPOT_FORMAT || 'S32',
    initialVolume: parseInt(process.env.LIBRESPOT_INITIAL_VOLUME || '100'),
    volumeCtrl: process.env.LIBRESPOT_VOLUME_CTRL || 'log',
    zeroconfPort: parseInt(process.env.LIBRESPOT_ZEROCONF_PORT || '36879'),
    cache: CACHE_DIR,
    onEventScript: '/app/scripts/librespot-event.sh',
    bridgePort: PORT,
    disableDiscovery: process.env.LIBRESPOT_DISABLE_DISCOVERY === 'on'
};

var sup = new LibrespotSupervisor(supOpts);

// CEC controller — claims a Playback LA, sends volume/mute to NAD AVR
var cec = new CECController({
    device: process.env.CEC_DEVICE || '/dev/cec0',
    targetLogicalAddress: parseInt(process.env.CEC_TARGET_LA || '5'),
    volumeSwap: (process.env.CEC_VOLUME_SWAP || '1') === '1',
    claimType: 'playback'
});
cec.log = function (msg) { sup.log(msg, 'info'); };

// CEC bridge mode: when librespot's volume changes, also fire CEC steps
// so phone slider drives the actual NAD volume.
var cecBridgeVolume = (process.env.CEC_BRIDGE_VOLUME || 'on') === 'on';
var lastSpotifyVolume = null;

// In-memory ring buffer of recent log lines
var LOG_BUFFER_SIZE = 500;
var logBuffer = [];

sup.on('log', function (entry) {
    logBuffer.push(entry);
    if (logBuffer.length > LOG_BUFFER_SIZE) logBuffer.shift();
    broadcast({ type: 'log', data: entry });
});

sup.on('state', function (state) {
    broadcast({ type: 'state', data: state });
});

sup.on('started', function () {
    broadcast({ type: 'event', data: { event: 'spawned', stats: sup.stats } });
});

sup.on('exited', function (info) {
    broadcast({ type: 'event', data: { event: 'exited', info: info, stats: sup.stats } });
});

// HTTP server
const app = express();
app.use(express.json({ limit: '64kb' }));
app.use(express.urlencoded({ extended: true, limit: '64kb' }));

app.get('/health', function (req, res) {
    res.json({ ok: true, running: sup.stats.running });
});

app.get('/status', function (req, res) {
    var s = sup.getStatus();
    s.cec = cec.getStatus();
    res.json(s);
});

app.get('/logs', function (req, res) {
    var n = Math.min(parseInt(req.query.n || '100'), LOG_BUFFER_SIZE);
    res.json({ logs: logBuffer.slice(-n) });
});

app.post('/restart', function (req, res) {
    sup.log('restart requested via API', 'info');
    sup.stop();
    // wait briefly then re-allow spawning
    setTimeout(function () {
        sup.stopRequested = false;
        sup.spawn();
    }, 1500);
    res.json({ ok: true });
});

// Internal: called by the --onevent hook script
// librespot passes event data via env vars; the shell hook re-posts as JSON
app.post('/event', function (req, res) {
    var event = req.body && req.body.event;
    var data = (req.body && req.body.data) || {};
    if (event) {
        try {
            sup.updateState(event, data);
        } catch (e) {
            sup.log('event handler error: ' + e.message, 'warn');
        }

        // CEC bridge: translate librespot volume_changed into NAD CEC steps.
        // The phone Spotify slider is the user input; we drop the librespot
        // digital volume on the floor (we're bit-perfect at slider=100) and
        // instead fire CEC volume up/down on the AVR. This makes the phone
        // slider drive the actual NAD analog amplifier directly.
        if (cecBridgeVolume && cec.ready && (event === 'volume_changed' || event === 'volume_set')) {
            var newVol = sup.state.volume;  // already 0-100
            if (typeof newVol === 'number' && lastSpotifyVolume !== null) {
                var diff = newVol - lastSpotifyVolume;
                // Each Spotify slider tick of ~3% = 1 NAD CEC step
                var steps = Math.round(diff / 3);
                if (steps !== 0) {
                    sup.log('CEC bridge: vol ' + lastSpotifyVolume + '%→' + newVol + '% (Δ=' + diff + '), sending ' + Math.abs(steps) + ' step(s) ' + (steps > 0 ? 'UP' : 'DOWN'), 'info');
                    // volumeStep already uses volumeUp/volumeDown internally, which respect CEC_VOLUME_SWAP
                    cec.volumeStep(steps).catch(function (e) {
                        sup.log('CEC step error: ' + e.message, 'warn');
                    });
                }
            }
            if (typeof newVol === 'number') lastSpotifyVolume = newVol;
        }
    }
    res.json({ ok: true });
});

// ── CEC routes ──
app.post('/cec/vol/up', async function (req, res) {
    try { await cec.volumeUp(); res.json({ ok: true }); }
    catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/cec/vol/down', async function (req, res) {
    try { await cec.volumeDown(); res.json({ ok: true }); }
    catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/cec/mute', async function (req, res) {
    try { await cec.mute(); res.json({ ok: true }); }
    catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/cec/key', async function (req, res) {
    var key = req.body && req.body.key;
    if (!key) return res.status(400).json({ error: 'missing key' });
    try { await cec.sendKey(key); res.json({ ok: true }); }
    catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/cec/power/on', async function (req, res) {
    try { await cec.powerOn(); res.json({ ok: true }); }
    catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/cec/power/off', async function (req, res) {
    try { await cec.powerOff(); res.json({ ok: true }); }
    catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Source / input switching ──
app.post('/cec/source/active', async function (req, res) {
    try {
        var pa = req.body && req.body.phys_addr;
        await cec.activeSource(pa);
        res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/cec/source/inactive', async function (req, res) {
    try { await cec.inactiveSource(req.body && req.body.phys_addr); res.json({ ok: true }); }
    catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/cec/source/set', async function (req, res) {
    var pa = req.body && req.body.phys_addr;
    if (!pa) return res.status(400).json({ error: 'missing phys_addr' });
    try { await cec.setStreamPath(pa); res.json({ ok: true }); }
    catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Generic remote key (any User Control opcode) ──
app.post('/cec/remote/:key', async function (req, res) {
    try { await cec.key(req.params.key); res.json({ ok: true }); }
    catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Raw passthrough for power users ──
app.post('/cec/raw', async function (req, res) {
    var args = req.body && req.body.args;
    if (!Array.isArray(args)) return res.status(400).json({ error: 'args must be an array' });
    try {
        var out = await cec.raw(args);
        res.json({ ok: true, output: out });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/cec/status', function (req, res) {
    res.json(cec.getStatus());
});

// Toggle / set the volume up-down swap at runtime (no restart needed)
app.post('/cec/swap', function (req, res) {
    var newVal;
    if (req.body && typeof req.body.enabled === 'boolean') {
        newVal = req.body.enabled;
    } else {
        // Toggle
        newVal = !cec.opts.volumeSwap;
    }
    cec.setSwap(newVal);
    res.json({ ok: true, volumeSwap: cec.opts.volumeSwap });
});

// Global error handler — prevents bad webhook JSON from crashing the supervisor
app.use(function (err, req, res, next) {
    sup.log('HTTP error on ' + req.method + ' ' + req.url + ': ' + err.message, 'warn');
    if (res.headersSent) return next(err);
    res.status(400).json({ error: 'bad request', message: err.message });
});

const server = http.createServer(app);

// WebSocket
const wss = new WebSocketServer({ server: server, path: '/ws' });
var wsClients = new Set();

wss.on('connection', function (ws) {
    wsClients.add(ws);
    // Send current status snapshot on connect
    ws.send(JSON.stringify({ type: 'snapshot', data: sup.getStatus() }));
    // Send last 50 log lines as history
    ws.send(JSON.stringify({ type: 'log_history', data: logBuffer.slice(-50) }));
    ws.on('close', function () { wsClients.delete(ws); });
    ws.on('error', function () { wsClients.delete(ws); });
});

function broadcast(msg) {
    var payload = JSON.stringify(msg);
    wsClients.forEach(function (ws) {
        if (ws.readyState === 1) {
            try { ws.send(payload); } catch (e) {}
        }
    });
}

// Graceful shutdown
function shutdown(sig) {
    sup.log('received ' + sig + ', shutting down', 'info');
    sup.stop();
    setTimeout(function () { process.exit(0); }, 6000);
}
process.on('SIGTERM', function () { shutdown('SIGTERM'); });
process.on('SIGINT',  function () { shutdown('SIGINT'); });
process.on('uncaughtException', function (err) {
    sup.log('uncaughtException: ' + err.message + '\n' + err.stack, 'error');
});
process.on('unhandledRejection', function (err) {
    sup.log('unhandledRejection: ' + (err && err.message ? err.message : err), 'error');
});

server.listen(PORT, '0.0.0.0', function () {
    sup.log('HCC Spotify Bridge listening on port ' + PORT, 'info');
    sup.log('librespot binary: ' + supOpts.bin, 'info');
    sup.log('device name: "' + supOpts.name + '" (' + supOpts.deviceType + ')', 'info');
    sup.log('audio device: ' + supOpts.device + ' format=' + supOpts.format + ' bitrate=' + supOpts.bitrate, 'info');
    sup.log('cache: ' + supOpts.cache, 'info');

    // Initialize CEC controller — best-effort, won't block librespot
    cec.init().catch(function (e) {
        sup.log('CEC init error (audio still works without CEC): ' + e.message, 'warn');
    });

    // Spawn librespot
    sup.spawn();
});
