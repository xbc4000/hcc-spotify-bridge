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
            volumeSwap: false,
            claimType: 'playback',     // We act as a Playback Device
            ourPhysAddr: '1.2.0.0'     // Our physical address on the bus (NAD HDMI 2)
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
            if (self.log) self.log('CEC exec: cec-ctl ' + fullArgs.join(' '));
            execFile('cec-ctl', fullArgs, { timeout: timeoutMs || 4000 }, function (err, stdout, stderr) {
                if (err) {
                    self.lastError = err.message + (stderr ? ' | ' + stderr : '');
                    if (self.log) self.log('CEC exec error: ' + self.lastError, 'warn');
                    reject(err);
                    return;
                }
                self.lastCommandAt = Date.now();
                self.commandCount++;
                if (self.log && stdout && stdout.trim()) {
                    self.log('CEC reply: ' + stdout.trim().split('\n').slice(0, 3).join(' | '));
                }
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
        if (this.log) this.log('CEC: volumeUp() → sending ui-cmd=' + k + ' (swap=' + this.opts.volumeSwap + ')');
        return this.sendKey(k);
    }
    async volumeDown() {
        var k = this.opts.volumeSwap ? 'volume-up' : 'volume-down';
        if (this.log) this.log('CEC: volumeDown() → sending ui-cmd=' + k + ' (swap=' + this.opts.volumeSwap + ')');
        return this.sendKey(k);
    }
    setSwap(enabled) {
        this.opts.volumeSwap = !!enabled;
        if (this.log) this.log('CEC: volume swap = ' + this.opts.volumeSwap);
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

    // Power on the audio system.
    // NAD T748 ignores the standard --image-view-on / --text-view-on wake
    // commands when in deep CEC sleep, but reliably wakes on an
    // ACTIVE_SOURCE broadcast announcing our physical address. We use that.
    async powerOn() {
        var pa = this.opts.ourPhysAddr || '1.2.0.0';
        return this.cecExec(['--to', '15', '--active-source', 'phys-addr=' + pa]);
    }
    async powerOff() {
        var to = String(this.opts.targetLogicalAddress);
        return this.cecExec(['--to', to, '--standby']);
    }

    // ── Source/input switching ──
    // Tell the AVR to switch to a specific HDMI input by physical address.
    // physAddr is a CEC physical address like "2.0.0.0" (HDMI 2 on the AVR)
    // For NAD T748: HDMI inputs are 1.0.0.0 / 2.0.0.0 / 3.0.0.0 / etc
    async setStreamPath(physAddr) {
        var to = String(this.opts.targetLogicalAddress);
        return this.cecExec(['--to', to, '--set-stream-path', 'phys-addr=' + physAddr]);
    }

    // Broadcast that this device wants to be the active source — works for
    // making the AVR switch to the Pi's input automatically
    async activeSource(physAddr) {
        physAddr = physAddr || '1.2.0.0';  // default = our discovered phys addr
        return this.cecExec(['--to', '15', '--active-source', 'phys-addr=' + physAddr]);
    }

    // Inactive source = stop being the source (AVR may switch away)
    async inactiveSource(physAddr) {
        physAddr = physAddr || '1.2.0.0';
        var to = String(this.opts.targetLogicalAddress);
        return this.cecExec(['--to', to, '--inactive-source', 'phys-addr=' + physAddr]);
    }

    // Request the AVR to send menu commands
    async menuShow() {
        var to = String(this.opts.targetLogicalAddress);
        return this.sendKey('display-information');
    }

    // ── Send a raw user-control key to the AVR ──
    // Valid ui-cmd values from cec-ctl --user-control-pressed --help:
    //   select, up, down, left, right, root-menu, contents-menu,
    //   exit, page-up, page-down, volume-up, volume-down, mute,
    //   play, stop, pause, record, rewind, fast-forward, eject,
    //   forward, backward, angle, sub-picture, video-on-demand,
    //   electronic-program-guide, timer-programming, initial-config,
    //   number-0..9, dot, enter, clear, channel-up, channel-down,
    //   sound-select, input-select, display-information, help,
    //   power, restore-volume-function, tune,
    //   mute-function, restore-volume, function-tune
    // We expose this generic so the dashboard can fire any of them.
    async key(uiCmd) {
        return this.sendKey(uiCmd);
    }

    // ── Raw CEC opcode for power users ──
    // Lets you send any cec-ctl flag directly. Use carefully.
    async raw(args) {
        if (!Array.isArray(args)) throw new Error('args must be an array');
        return this.cecExec(args);
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
