// =============================================================================
// HCC Spotify Bridge — CEC controller for NAD-AVR
// =============================================================================
// Wraps cec-ctl (from v4l-utils) to send HDMI-CEC commands to the AVR.
//
// We claim a Playback logical address ourselves at startup, then send
// User Control Pressed/Released opcodes to the Audio System device (default
// LA 5) to control volume + mute.
//
// NAD T748 quirk: volume-up and volume-down are swapped in firmware. The
// CEC_VOLUME_SWAP env var controls this — set to 1 to swap (default for NAD).
//
// We do not use libcec (cec-client) because the kernel cec-ctl path is
// simpler, has no daemon, and the bridge container already has v4l-utils.
// =============================================================================

const { spawn, execFile } = require('child_process');

class CECController {
    constructor(opts) {
        this.opts = Object.assign({
            device: '/dev/cec0',
            targetLogicalAddress: 5,   // Audio System
            volumeSwap: true,           // NAD swaps up/down
            claimType: 'playback'      // We act as a Playback Device
        }, opts || {});
        this.ready = false;
        this.lastError = null;
        this.lastCommandAt = null;
        this.commandCount = 0;
        this.topology = null;
    }

    log(msg) { /* assigned by parent */ }

    // Run cec-ctl with given args, return promise that resolves with stdout
    cecExec(args, timeoutMs) {
        var self = this;
        return new Promise(function (resolve, reject) {
            var fullArgs = ['-d', self.opts.device].concat(args);
            execFile('cec-ctl', fullArgs, { timeout: timeoutMs || 4000 }, function (err, stdout, stderr) {
                if (err) {
                    self.lastError = err.message + (stderr ? ' | ' + stderr : '');
                    reject(err);
                    return;
                }
                self.lastCommandAt = Date.now();
                self.commandCount++;
                resolve(stdout);
            });
        });
    }

    // Claim a logical address (Playback Device) so we can send commands
    async init() {
        try {
            this.log('CEC: claiming ' + this.opts.claimType + ' logical address on ' + this.opts.device);
            await this.cecExec(['--' + this.opts.claimType]);
            this.ready = true;
            this.log('CEC: ready, target Audio System LA=' + this.opts.targetLogicalAddress);

            // Snapshot topology in the background — non-blocking
            var self = this;
            this.cecExec(['--show-topology'], 6000).then(function (out) {
                self.topology = out.trim();
            }).catch(function () { /* topology probe is best-effort */ });
        } catch (e) {
            this.ready = false;
            this.log('CEC: init failed: ' + e.message);
        }
    }

    // Send a User Control Pressed + Released sequence (one button press)
    async sendKey(uiCmd) {
        if (!this.ready) throw new Error('CEC not ready');
        var to = String(this.opts.targetLogicalAddress);
        await this.cecExec(['--to', to, '--user-control-pressed', 'ui-cmd=' + uiCmd]);
        await this.cecExec(['--to', to, '--user-control-released']);
    }

    async volumeUp() {
        var k = this.opts.volumeSwap ? 'volume-down' : 'volume-up';
        return this.sendKey(k);
    }
    async volumeDown() {
        var k = this.opts.volumeSwap ? 'volume-up' : 'volume-down';
        return this.sendKey(k);
    }
    async mute() {
        return this.sendKey('mute');
    }

    // Press the volume key N times in a row (for "set volume to X" approximations)
    async volumeStep(steps) {
        var fn = steps > 0 ? this.volumeUp.bind(this) : this.volumeDown.bind(this);
        var n = Math.abs(steps);
        for (var i = 0; i < n; i++) {
            try { await fn(); } catch (e) { this.lastError = e.message; break; }
            // Small delay between steps so the AVR can process each one
            await new Promise(function (r) { setTimeout(r, 80); });
        }
    }

    // Power on/off the audio system
    async powerOn() {
        var to = String(this.opts.targetLogicalAddress);
        return this.cecExec(['--to', to, '--image-view-on']);
    }
    async powerOff() {
        var to = String(this.opts.targetLogicalAddress);
        return this.cecExec(['--to', to, '--standby']);
    }

    // Optional: query the AVR's current audio status (volume + mute state)
    // NAD T748 doesn't always reply to this — best-effort.
    async getAudioStatus() {
        var to = String(this.opts.targetLogicalAddress);
        try {
            var out = await this.cecExec(['--to', to, '--give-audio-status'], 3000);
            return out.trim();
        } catch (e) {
            return null;
        }
    }

    getStatus() {
        return {
            ready: this.ready,
            device: this.opts.device,
            targetLA: this.opts.targetLogicalAddress,
            volumeSwap: this.opts.volumeSwap,
            commandCount: this.commandCount,
            lastCommandAt: this.lastCommandAt,
            lastError: this.lastError,
            topology: this.topology
        };
    }
}

module.exports = { CECController };
