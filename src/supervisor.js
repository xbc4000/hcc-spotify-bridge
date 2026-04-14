// =============================================================================
// HCC Spotify Bridge — librespot supervisor
// =============================================================================
// Wraps librespot as a managed subprocess with:
//   - exponential backoff restart on crash (1s → 2s → 4s → 8s → 30s max)
//   - structured event log
//   - SIGTERM handoff so the container shuts down cleanly
//   - state cache (the librespot --onevent script writes JSON here)
//   - control commands routed via librespot's stdin (it doesn't actually take
//     commands that way — for control we use the Spotify Web API from HCC main)
// =============================================================================

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');

class LibrespotSupervisor extends EventEmitter {
    constructor(opts) {
        super();
        this.opts = opts;
        this.proc = null;
        this.restartAttempt = 0;
        this.restartDelays = [1000, 2000, 4000, 8000, 16000, 30000];
        this.stopRequested = false;
        this.lastSpawnAt = 0;
        this.totalRestarts = 0;
        this.startedAt = null;
        this.stats = {
            startedAt: null,
            lastSpawnAt: null,
            totalRestarts: 0,
            lastExitCode: null,
            lastExitSignal: null,
            lastError: null,
            running: false
        };
        // Live state from --onevent hooks (track, position, volume, etc.)
        this.state = {
            event: 'idle',
            track: null,
            artist: null,
            album: null,
            duration_ms: null,
            position_ms: null,
            volume: null,
            playing: false,
            updated_at: 0
        };
    }

    log(msg, level) {
        var ts = new Date().toISOString();
        var line = '[' + ts + '] [' + (level || 'info') + '] ' + msg;
        console.log(line);
        this.emit('log', { ts: Date.now(), level: level || 'info', msg: msg });
    }

    buildArgs() {
        var o = this.opts;
        var args = [
            '--name', o.name,
            '--bitrate', String(o.bitrate),
            '--device-type', o.deviceType,
            '--backend', 'alsa',
            '--device', o.device,
            '--format', o.format,
            '--initial-volume', String(o.initialVolume),
            '--volume-ctrl', o.volumeCtrl,    // 'log' = phone slider works AND fires volume_changed events for CEC bridge
            '--cache', o.cache,
            '--system-cache', o.cache,
            '--zeroconf-port', String(o.zeroconfPort),  // pinned for firewall
            '--quiet'
        ];

        // Volume normalisation — OFF by default for bit-perfect output.
        // When ON, librespot attenuates loud tracks toward Spotify's -14 LUFS
        // target, which noticeably reduces the digital level feeding the AVR.
        // Pregain (dB) adds headroom back; 0 = pure attenuation, +6 ≈ Spotify's
        // "Loud" preset. Tune via LIBRESPOT_NORMALISATION / _PREGAIN env vars.
        if (o.normalisation) {
            args.push('--enable-volume-normalisation');
            args.push('--normalisation-pregain', String(o.normalisationPregain));
        }

        // The onevent hook script — librespot calls it on every state change
        if (o.onEventScript) {
            args.push('--onevent', o.onEventScript);
        }

        // Optional zeroconf disable (we want it ON for first-time claim
        // but it's also fine to leave on permanently — librespot handles both)
        // Default: leave zeroconf on so other devices on same broadcast can also see us
        if (o.disableDiscovery) {
            args.push('--disable-discovery');
        }

        return args;
    }

    spawn() {
        if (this.stopRequested) return;
        if (this.proc) {
            this.log('spawn called but process already running, ignoring', 'warn');
            return;
        }

        var args = this.buildArgs();
        this.log('spawning librespot: ' + this.opts.bin + ' ' + args.join(' '));
        this.lastSpawnAt = Date.now();
        this.stats.lastSpawnAt = this.lastSpawnAt;
        if (!this.startedAt) {
            this.startedAt = this.lastSpawnAt;
            this.stats.startedAt = this.lastSpawnAt;
        }

        try {
            this.proc = spawn('nice', ['-n', '-10', this.opts.bin].concat(args), {
                env: Object.assign({}, process.env, {
                    // Pass to onevent hook so it can post back to us
                    HCC_BRIDGE_PORT: String(this.opts.bridgePort || 3081),
                    HCC_BRIDGE_HOST: '127.0.0.1'
                }),
                stdio: ['ignore', 'pipe', 'pipe']
            });
        } catch (e) {
            this.log('spawn failed: ' + e.message, 'error');
            this.stats.lastError = e.message;
            this.scheduleRestart();
            return;
        }

        this.stats.running = true;
        this.emit('started');

        var self = this;

        this.proc.stdout.on('data', function (chunk) {
            chunk.toString().split('\n').forEach(function (line) {
                if (line.trim()) self.log('librespot: ' + line.trim(), 'librespot');
            });
        });

        this.proc.stderr.on('data', function (chunk) {
            chunk.toString().split('\n').forEach(function (line) {
                if (line.trim()) self.log('librespot: ' + line.trim(), 'librespot');
            });
        });

        this.proc.on('exit', function (code, signal) {
            self.proc = null;
            self.stats.running = false;
            self.stats.lastExitCode = code;
            self.stats.lastExitSignal = signal;
            self.log('librespot exited (code=' + code + ', signal=' + signal + ')', code === 0 ? 'info' : 'warn');
            self.emit('exited', { code: code, signal: signal });

            if (self.stopRequested) {
                self.log('stop was requested, not restarting', 'info');
                self.emit('stopped');
                return;
            }
            self.scheduleRestart();
        });

        this.proc.on('error', function (err) {
            self.log('process error: ' + err.message, 'error');
            self.stats.lastError = err.message;
        });

        // Reset restart counter if we ran cleanly for at least 60s
        // (means whatever was wrong is past, not in a crash loop)
        setTimeout(function () {
            if (self.proc && self.lastSpawnAt && (Date.now() - self.lastSpawnAt > 55000)) {
                if (self.restartAttempt > 0) {
                    self.log('stable for >60s, resetting restart counter', 'info');
                    self.restartAttempt = 0;
                }
            }
        }, 60000);
    }

    scheduleRestart() {
        if (this.stopRequested) return;
        var idx = Math.min(this.restartAttempt, this.restartDelays.length - 1);
        var delay = this.restartDelays[idx];
        this.restartAttempt++;
        this.totalRestarts++;
        this.stats.totalRestarts = this.totalRestarts;
        this.log('restarting in ' + delay + 'ms (attempt #' + this.restartAttempt + ')', 'info');
        var self = this;
        setTimeout(function () { self.spawn(); }, delay);
    }

    stop() {
        this.stopRequested = true;
        if (this.proc) {
            this.log('stopping librespot...', 'info');
            try {
                this.proc.kill('SIGTERM');
                // Force-kill after 5s if it doesn't exit
                var p = this.proc;
                setTimeout(function () {
                    if (p && !p.killed) {
                        try { p.kill('SIGKILL'); } catch (e) {}
                    }
                }, 5000);
            } catch (e) {
                this.log('error stopping: ' + e.message, 'error');
            }
        }
    }

    // Called by the onevent hook when librespot reports a state change
    updateState(event, data) {
        this.state.event = event;
        this.state.updated_at = Date.now();
        if (data) {
            if (data.TRACK_ID || data.track_id) this.state.track_id = data.TRACK_ID || data.track_id;
            if (data.NAME) this.state.track = data.NAME;
            // ARTISTS is a delimited string from librespot — split and rejoin
            // with comma+space for human display. librespot uses '\u001D' (group
            // separator) as the delimiter; the event hook strips control chars
            // first which may collapse them, so handle both cases.
            if (data.ARTISTS) {
                var artists = String(data.ARTISTS);
                // Try splitting on common Spotify multi-artist delimiters
                if (artists.indexOf('\u001D') !== -1) {
                    artists = artists.split('\u001D').filter(Boolean).join(', ');
                }
                this.state.artist = artists;
            }
            if (data.ALBUM) this.state.album = data.ALBUM;
            if (data.DURATION_MS) this.state.duration_ms = parseInt(data.DURATION_MS);
            if (data.POSITION_MS) this.state.position_ms = parseInt(data.POSITION_MS);
            // librespot volume is 0-65535, normalize to 0-100
            if (data.VOLUME) {
                var raw = parseInt(data.VOLUME);
                this.state.volume = Math.round((raw / 65535) * 100);
            }
            if (event === 'playing') this.state.playing = true;
            if (event === 'paused' || event === 'stopped') this.state.playing = false;
        }
        this.emit('state', this.state);
    }

    getStatus() {
        return {
            stats: this.stats,
            state: this.state,
            opts: {
                name: this.opts.name,
                device: this.opts.device,
                bitrate: this.opts.bitrate,
                format: this.opts.format,
                deviceType: this.opts.deviceType
            },
            uptime_ms: this.startedAt ? (Date.now() - this.startedAt) : 0,
            running: this.stats.running,
            restartAttempt: this.restartAttempt,
            totalRestarts: this.totalRestarts
        };
    }
}

module.exports = { LibrespotSupervisor };
