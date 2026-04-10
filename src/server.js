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
    cache: CACHE_DIR,
    onEventScript: '/app/scripts/librespot-event.sh',
    bridgePort: PORT,
    disableDiscovery: process.env.LIBRESPOT_DISABLE_DISCOVERY === 'on'
};

var sup = new LibrespotSupervisor(supOpts);

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
    res.json(sup.getStatus());
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
    var event = req.body.event;
    var data = req.body.data || {};
    if (event) {
        sup.updateState(event, data);
    }
    res.json({ ok: true });
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
    // Spawn librespot
    sup.spawn();
});
