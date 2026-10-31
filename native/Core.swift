// ProtoArt Wake: the menu-bar app. Owns the hold, the timer, the triggers and the menu-bar tube.
// Everything is event-driven: macOS tells us when apps open or quit, the power source or displays
// change, drives mount, the screen locks, or any app takes or drops a power assertion. A single
// timer is armed only for the next moment something can change (a session ending, a reminder,
// the next schedule edge), so an idle Wake uses no processor time at all.
import AppKit
import ServiceManagement
import UserNotifications
import notify

private let AUDIO_GRACE: Millis = 30_000
private let CPU_GRACE: Millis = 120_000
private let PULSE_EVERY: Millis = 30_000
private let ALIVE_EVERY: Millis = 60_000

final class Core: NSObject, NSMenuDelegate, UNUserNotificationCenterDelegate {
    let settings = Settings.loadFromDisk()
    let sess: Session
    let hold = Hold()
    let hotkey = Hotkey()
    let cpu = CPUMeter()
    var panel: PanelController!
    var statusItem: NSStatusItem!

    var view = Decision()
    var effectiveMode = "display"
    var verified = false
    var others: [String] = []
    var sleepMinutes: Int? = nil, displayMinutes: Int? = nil
    var lastSettingsRead: Millis = 0
    var running: [WatchedApp] = []
    var downloadsActive = false, partialsPresent = false
    var audioOn = false, audioUntil: Millis = 0
    var cpuLoad: Double? = nil, cpuBusyUntil: Millis = 0
    var power = readPower()
    var external = externalDisplayConnected()
    var volumes = mountedVolumes()
    var locked = false
    var lightsOutAt: Millis = 0
    var lastPulse: Millis = 0, lastAlive: Millis = 0
    var remindedFor: Millis? = nil
    var fileState: (url: URL, size: Int, mtime: Date, changedAt: Millis)? = nil
    var wasAwake = false

    private var timer: Timer? = nil
    private var pending = false
    private var saveItem: DispatchWorkItem? = nil
    private var downloadsWatch: DispatchSourceFileSystemObject? = nil
    private var assertionToken: Int32 = 0
    private var powerSource: CFRunLoopSource? = nil
    private var lastStatus = ""

    override init() {
        sess = Session(durationIndex: 0, custom: nil)
        super.init()
        sess.custom = settings.custom
        sess.setDuration(settings.durationIndex)
    }

    // ------------------------------------------------------------------ Start-up

    func start(openedByHand: Bool) {
        panel = PanelController(core: self)
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        if let b = statusItem.button {
            b.target = self
            b.action = #selector(statusClicked(_:))
            b.sendAction(on: [.leftMouseUp, .rightMouseUp])
            b.imagePosition = .imageLeft
            b.font = NSFont.monospacedDigitSystemFont(ofSize: NSFont.systemFontSize, weight: .regular)
        }
        Hotkey.action = { [weak self] in self?.toggleAwake() }
        applyHotkey()
        if #available(macOS 13.0, *) { settings.autoLogin = SMAppService.mainApp.status == .enabled }
        UNUserNotificationCenter.current().delegate = self
        registerNotificationActions()
        observe()
        refreshRunning()
        if settings.startAtLaunch { sess.setPower(true) }
        evaluate()
        if openedByHand { DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) { self.panel.show() } }
    }

    private func observe() {
        let ws = NSWorkspace.shared.notificationCenter
        let poke: (Notification) -> Void = { [weak self] _ in self?.poke() }
        for n in [NSWorkspace.didLaunchApplicationNotification, NSWorkspace.didTerminateApplicationNotification] {
            ws.addObserver(forName: n, object: nil, queue: .main) { [weak self] _ in self?.refreshRunning(); self?.poke() }
        }
        for n in [NSWorkspace.didMountNotification, NSWorkspace.didUnmountNotification, NSWorkspace.didRenameVolumeNotification] {
            ws.addObserver(forName: n, object: nil, queue: .main) { [weak self] _ in self?.volumes = mountedVolumes(); self?.poke() }
        }
        ws.addObserver(forName: NSWorkspace.willSleepNotification, object: nil, queue: .main) { [weak self] _ in self?.willSleep() }
        ws.addObserver(forName: NSWorkspace.didWakeNotification, object: nil, queue: .main) { [weak self] _ in self?.didWake() }
        ws.addObserver(forName: NSWorkspace.sessionDidResignActiveNotification, object: nil, queue: .main) { [weak self] _ in self?.userSwitchedAway() }
        ws.addObserver(forName: NSWorkspace.sessionDidBecomeActiveNotification, object: nil, queue: .main, using: poke)
        NotificationCenter.default.addObserver(forName: NSApplication.didChangeScreenParametersNotification, object: nil, queue: .main) { [weak self] _ in
            self?.external = externalDisplayConnected(); self?.poke()
        }
        let dnc = DistributedNotificationCenter.default()
        dnc.addObserver(forName: NSNotification.Name("com.apple.screenIsLocked"), object: nil, queue: .main) { [weak self] _ in self?.locked = true; self?.poke() }
        dnc.addObserver(forName: NSNotification.Name("com.apple.screenIsUnlocked"), object: nil, queue: .main) { [weak self] _ in self?.locked = false; self?.poke() }

        // Power source changes (plugged in, unplugged, battery level).
        if let src = IOPSNotificationCreateRunLoopSource({ _ in
            DispatchQueue.main.async { guard let c = AppDelegate.core else { return }; c.power = readPower(); c.poke() }
        }, nil)?.takeRetainedValue() {
            CFRunLoopAddSource(CFRunLoopGetMain(), src, .defaultMode)
            powerSource = src
        }
        // Any app taking or dropping a power assertion (audio starting and stopping shows up here).
        notify_register_dispatch("com.apple.system.powermanagement.assertions.anychange", &assertionToken, DispatchQueue.main) { [weak self] _ in self?.poke() }
        watchDownloads()
    }

    /** Watches the Downloads folder's entries (only while the DOWNLOADS trigger is on). */
    func watchDownloads() {
        downloadsWatch?.cancel(); downloadsWatch = nil
        guard settings.autoDownloads, let dir = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask).first else { return }
        let fd = Darwin.open(dir.path, O_EVTONLY)
        guard fd >= 0 else { return }
        let src = DispatchSource.makeFileSystemObjectSource(fileDescriptor: fd, eventMask: [.write, .rename, .delete], queue: .main)
        src.setEventHandler { [weak self] in self?.poke() }
        src.setCancelHandler { Darwin.close(fd) }
        src.resume()
        downloadsWatch = src
    }

    func refreshRunning() {
        var seen = Set<String>()
        running = NSWorkspace.shared.runningApplications.compactMap { a in
            guard a.activationPolicy == .regular, let url = a.bundleURL, url.pathExtension == "app",
                  a.processIdentifier != getpid(), !seen.contains(url.path) else { return nil }
            seen.insert(url.path)
            return WatchedApp(id: url.path, name: a.localizedName ?? url.deletingPathExtension().lastPathComponent)
        }
    }

    // ------------------------------------------------------------------ The decision

    /** Coalesces bursts of events into one evaluation. */
    func poke() {
        if pending { return }
        pending = true
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) { [weak self] in self?.pending = false; self?.evaluate() }
    }

    private func scheduleActive(_ now: Millis) -> Bool {
        guard settings.trigSchedule else { return false }
        let cal = Calendar.current
        let d = Date(timeIntervalSince1970: now / 1000)
        let c = cal.dateComponents([.weekday, .hour, .minute], from: d)
        let m = (c.hour ?? 0) * 60 + (c.minute ?? 0), wd = c.weekday ?? 1
        let s = settings.schedStart, e = settings.schedEnd
        if s == e { return settings.schedDays.contains(wd) }
        if s < e { return settings.schedDays.contains(wd) && m >= s && m < e }
        // overnight: started on the day it began
        if m >= s { return settings.schedDays.contains(wd) }
        let yesterday = wd == 1 ? 7 : wd - 1
        return m < e && settings.schedDays.contains(yesterday)
    }

    private func fileStillDownloading(_ now: Millis) -> Bool {
        guard var f = fileState else { return false }
        guard let v = try? f.url.resourceValues(forKeys: [.fileSizeKey, .contentModificationDateKey]) else { return false }
        let mtime = newestChange(f.url) ?? v.contentModificationDate ?? .distantPast
        let size = v.fileSize ?? 0
        if size != f.size || mtime != f.mtime { f.size = size; f.mtime = mtime; f.changedAt = now; fileState = f }
        let quiet = now - f.changedAt
        return quiet < (isPartialDownload(f.url.lastPathComponent) ? 600_000 : 120_000)
    }

    /** What trigger (if any) wants the Mac awake now, in priority order. */
    private func cause(_ now: Millis) -> String? {
        let runningIds = Set(running.map { $0.id })
        let watched = settings.watched.filter { runningIds.contains($0.id) }.map { $0.name }
        if settings.autoApps && !watched.isEmpty {
            return watched.count == 1 ? "Auto: \(watched[0]) is open" : "Auto: \(watched[0]) +\(watched.count - 1) are open"
        }
        if settings.autoAudio && (audioOn || now < audioUntil) { return "Auto: audio is playing" }
        if settings.autoDownloads && downloadsActive { return "Auto: a download is in progress" }
        if scheduleActive(now) { return "Auto: scheduled hours" }
        if settings.trigPower && power.hasBattery && !power.onBattery { return "Auto: power adapter is connected" }
        if settings.trigDisplay && external { return "Auto: an external display is connected" }
        if settings.trigDrive, let v = volumes.first(where: { settings.trigDrives.contains($0.path) }) { return "Auto: \(v.name) is connected" }
        if settings.trigCPU && now < cpuBusyUntil { return "Auto: the processor is busy" }
        return nil
    }

    func evaluate() {
        let now = nowMs()
        // Unplugged during a session: end it if asked to.
        if settings.endOnUnplug && lastPowerOnBattery == false && power.onBattery && sess.manual != nil {
            sess.setPower(false, now: now); fileState = nil
            notify("Power adapter disconnected", "Session ended. Your Mac can sleep again.")
        }
        lastPowerOnBattery = power.onBattery
        let fileActive = sess.manual?.kind == .file ? fileStillDownloading(now) : false
        if settings.autoDownloads, let dir = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask).first {
            (downloadsActive, partialsPresent) = downloadsInProgress(dir)
        } else { downloadsActive = false; partialsPresent = false }
        let holders = readAssertions()
        audioOn = audioActive(holders)
        if audioOn { audioUntil = now + AUDIO_GRACE }
        if settings.trigCPU {
            if let l = cpu.sample() { cpuLoad = l; if l >= Double(settings.cpuPercent) { cpuBusyUntil = now + CPU_GRACE } }
        } else { cpu.reset(); cpuLoad = nil; cpuBusyUntil = 0 }

        let d = sess.decide(now: now, runningIds: Set(running.map { $0.id }), fileActive: fileActive, cause: cause(now))
        view = d
        if !d.expired.isEmpty { fileState = nil; notify("Session ended", "\(d.expired) Your Mac can sleep again.") }

        // Don't run a laptop flat.
        if d.awake && settings.endBattery > 0 && power.onBattery, let p = power.percent, p <= settings.endBattery {
            sess.setPower(false); fileState = nil
            view = sess.decide(now: now, runningIds: Set(running.map { $0.id }), fileActive: false, cause: cause(now))
            if view.awake { sess.suppressed = true; view = sess.decide(now: now, runningIds: Set(running.map { $0.id }), fileActive: false, cause: cause(now)) }
            notify("Battery low", "Stopped keeping the Mac awake at \(p)%.")
        }

        effectiveMode = settings.mode
        if locked && settings.lockedDisplaySleep { effectiveMode = "system" }
        if view.awake { hold.start(effectiveMode) } else { hold.stop() }
        sessionEdges(now)

        // Ask macOS what it's actually doing: is our hold in place, and who else is holding?
        let after = view.awake ? readAssertions() : holders
        verified = view.awake && holdVerified(after, mode: effectiveMode)
        others = otherHolders(after)

        // Screen saver BLOCK: tell macOS the user is active now and then. Paused after LIGHTS OUT
        // until someone touches the keyboard or mouse again, and while the screen is locked.
        if view.awake && effectiveMode == "display" && settings.screensaver == "block" && !locked && now - lastPulse >= PULSE_EVERY - 1000 {
            var paused = false
            if lightsOutAt > 0 {
                if idleSeconds() * 1000 < now - lightsOutAt { lightsOutAt = 0 } else { paused = true }
            }
            if !paused { hold.declareUserActivity(); lastPulse = now }
        }

        // Drive Alive: a tiny write keeps external drives from spinning down.
        if view.awake && settings.driveAlive && !settings.aliveDrives.isEmpty && now - lastAlive >= ALIVE_EVERY - 1000 {
            lastAlive = now
            let drives = settings.aliveDrives.filter { p in volumes.contains { $0.path == p } }
            DispatchQueue.global(qos: .utility).async {
                for p in drives {
                    let f = URL(fileURLWithPath: p).appendingPathComponent(".protoart-wake-alive")
                    try? Data("\(Int(now / 1000))\n".utf8).write(to: f, options: .atomic)
                }
            }
        }

        // Reminder before a timer runs out.
        if settings.remindMinutes > 0, let e = view.endsAt, remindedFor != e, e - now <= Double(settings.remindMinutes) * 60000, e - now > 5000,
           e - (view.startedAt ?? now) > Double(settings.remindMinutes) * 60000 + 30000 { // not for sessions shorter than the warning
            remindedFor = e
            remind(minutesLeft: Int(((e - now) / 60000).rounded()))
        }

        if panel.isOpen && now - lastSettingsRead > 60000 {
            lastSettingsRead = now
            runTool("/usr/bin/pmset", ["-g"]) { [weak self] text in
                let (s, d) = parsePmsetSettings(text)
                self?.sleepMinutes = s; self?.displayMinutes = d
                self?.pushState()
            }
        }

        pushState()
        updateStatus()
        armTimer(now)
    }

    /** Sounds, statistics and the "started" note when a session begins or ends. */
    private func sessionEdges(_ now: Millis) {
        if view.awake && !wasAwake {
            if settings.sounds { NSSound(named: "Purr")?.play() }
            settings.stats.sessions += 1
            saveSoon()
        }
        if !view.awake && wasAwake {
            if settings.sounds { NSSound(named: "Bottle")?.play() }
            if let since = lastStartedAt {
                let secs = max(0, (now - since) / 1000)
                settings.stats.seconds += secs
                settings.stats.longest = max(settings.stats.longest, secs)
                saveSoon()
            }
            remindedFor = nil
        }
        wasAwake = view.awake
        lastStartedAt = view.startedAt
    }
    private var lastStartedAt: Millis? = nil

    /** One timer, set for the next moment anything can change. */
    private func armTimer(_ now: Millis) {
        var next = Millis.infinity
        func at(_ t: Millis?) { if let t = t, t > now { next = min(next, t) } }
        if let e = view.endsAt {
            at(e + 50)
            if settings.remindMinutes > 0 { at(e - Double(settings.remindMinutes) * 60000) }
            if settings.menuTime { let left = e - now; at(now + left.truncatingRemainder(dividingBy: 60000) + 50) } // the menu bar's minute
        }
        if view.awake && effectiveMode == "display" && settings.screensaver == "block" { at(lastPulse + PULSE_EVERY) }
        if view.awake && settings.driveAlive && !settings.aliveDrives.isEmpty { at(lastAlive + ALIVE_EVERY) }
        if settings.trigCPU { at(now + 10_000) }
        if settings.autoDownloads && partialsPresent { at(now + 15_000) }
        if sess.manual?.kind == .file { at(now + 15_000) }
        if audioUntil > now { at(audioUntil + 100) }
        if cpuBusyUntil > now { at(cpuBusyUntil + 100) }
        if settings.trigSchedule {
            let cal = Calendar.current
            let today = cal.startOfDay(for: Date(timeIntervalSince1970: now / 1000))
            for dayOffset in 0...1 {
                for m in [settings.schedStart, settings.schedEnd] {
                    if let t = cal.date(byAdding: .minute, value: dayOffset * 1440 + m, to: today) { at(t.timeIntervalSince1970 * 1000 + 500) }
                }
            }
        }
        if view.awake { at(now + 300_000) } // a slow check that the hold is still in place
        if panel.isOpen { at(now + 60_000) }

        timer?.invalidate(); timer = nil
        guard next.isFinite else { return }
        let delay = max(0.05, (next - now) / 1000)
        let t = Timer(timeInterval: delay, repeats: false) { [weak self] _ in self?.evaluate() }
        t.tolerance = min(2, max(0.05, delay * 0.05))
        RunLoop.main.add(t, forMode: .common)
        timer = t
    }

    // ------------------------------------------------------------------ Events

    private func willSleep() {
        if settings.endOnSleep && sess.manual != nil { sess.setPower(false); fileState = nil; evaluate() }
    }
    private func didWake() {
        power = readPower(); external = externalDisplayConnected(); volumes = mountedVolumes()
        if settings.startAfterWake && sess.manual == nil { sess.setPower(true) }
        cpu.reset()
        evaluate()
    }
    private func userSwitchedAway() {
        if settings.endOnUserSwitch && sess.manual != nil { sess.setPower(false); fileState = nil }
        evaluate()
    }
    private var lastPowerOnBattery: Bool? = nil

    // ------------------------------------------------------------------ Changes from anywhere

    func toggleAwake() { applyPatch(["awake": !view.awake]) }

    /** One validated change from the panel, the menu or a link. Unknown keys and bad values are ignored. */
    func applyPatch(_ p: [String: Any]) {
        let now = nowMs()
        var awake = boolValue(p["awake"])
        if let c = CustomTime.from(p["custom"]) {
            sess.setCustom(c, now: now, start: awake != false)
            awake = nil
        }
        if let d = intValue(p["durationIndex"]), d >= 0, d <= CUSTOM_INDEX { sess.setDuration(d, now: now) }
        if let a = awake { sess.setPower(a, now: now); if !a { fileState = nil } }
        for (k, (path, allowed)) in Settings.CHOICE_KEYS { if let s = p[k] as? String, allowed.contains(s) { settings[keyPath: path] = s } }
        for (k, (path, range)) in Settings.INT_KEYS { if let n = intValue(p[k]), range.contains(n) { settings[keyPath: path] = n } }
        for (k, path) in Settings.BOOL_KEYS where k != "autoLogin" { if let b = boolValue(p[k]) { settings[keyPath: path] = b } }
        if let d = Settings.days(p["schedDays"]) { settings.schedDays = d }
        if let v = Settings.volumes(p["trigDrives"]) { settings.trigDrives = v }
        if let v = Settings.volumes(p["aliveDrives"]) { settings.aliveDrives = v }
        if p["hotkey"] != nil { applyHotkey() }
        if p["pinned"] != nil { panel.applyPin() }
        if p["autoDownloads"] != nil { watchDownloads() }
        if p["trigCPU"] != nil { cpu.reset() }
        if boolValue(p["notify"]) == true || (intValue(p["remindMinutes"]) ?? 0) > 0 { askNotificationPermission() }
        if let l = boolValue(p["autoLogin"]) { setLoginItem(l) }
        saveNow()
        evaluate()
    }

    func startFor(minutes: Int) { sess.startFor(minutes: minutes); evaluate() }
    func extend(minutes: Int) { guard (1...1440).contains(minutes) else { return }; sess.extend(minutes: minutes); remindedFor = nil; evaluate() }

    func fromPanel(_ cmd: String, _ arg: Any?) {
        switch cmd {
        case "set": if let p = arg as? [String: Any] { applyPatch(p) }
        case "toggle-app":
            guard let id = validAppId(arg) else { return }
            if let i = settings.watched.firstIndex(where: { $0.id == id }) { settings.watched.remove(at: i) }
            else if let r = running.first(where: { $0.id == id }), settings.watched.count < MAX_WATCHED { settings.watched.append(r) }
            else { return }
            saveNow(); evaluate()
        case "start-app":
            guard let id = validAppId(arg), let r = running.first(where: { $0.id == id }) else { return }
            sess.startForApp(id: r.id, name: r.name); evaluate()
        case "pick-file": pickFile()
        case "lights-out": lightsOut()
        case "extend": if let m = intValue(arg) { extend(minutes: m) }
        case "reset-stats": settings.stats = Stats(); saveNow(); pushState()
        case "quit": NSApp.terminate(nil)
        default: break
        }
    }

    func lightsOut() { lightsOutAt = nowMs(); displaySleepNow() }

    func pickFile() {
        let p = NSOpenPanel()
        p.title = "Keep the Mac awake while this file downloads"
        p.prompt = "Watch"
        p.canChooseFiles = true; p.canChooseDirectories = false; p.treatsFilePackagesAsDirectories = true
        p.allowsMultipleSelection = false
        p.directoryURL = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask).first
        NSApp.activate(ignoringOtherApps: true)
        p.begin { [weak self] r in
            guard r == .OK, let url = p.url, let self = self else { return }
            var target = url
            // Inside a Safari .download bundle: watch the bundle itself.
            var probe = url
            while probe.path != "/" { if probe.pathExtension.lowercased() == "download" { target = probe; break }; probe.deleteLastPathComponent() }
            guard let v = try? target.resourceValues(forKeys: [.fileSizeKey]) else { return }
            self.fileState = (target, v.fileSize ?? 0, newestChange(target) ?? Date(), nowMs())
            let name = target.lastPathComponent.replacingOccurrences(of: "\\.(crdownload|download|part|partial|opdownload)$", with: "", options: [.regularExpression, .caseInsensitive])
            self.sess.startForFile(path: target.path, name: name)
            self.evaluate()
        }
    }

    func applyHotkey() { if settings.hotkey { hotkey.register() } else { hotkey.unregister() } }

    private func setLoginItem(_ on: Bool) {
        if #available(macOS 13.0, *) {
            do { if on { try SMAppService.mainApp.register() } else { try SMAppService.mainApp.unregister() } } catch { /* stays as it was */ }
            settings.autoLogin = SMAppService.mainApp.status == .enabled
            if on && SMAppService.mainApp.status == .requiresApproval { SMAppService.openSystemSettingsLoginItems() }
        } else { settings.autoLogin = on }
    }

    // ------------------------------------------------------------------ Saving

    func saveNow() {
        saveItem?.cancel(); saveItem = nil
        settings.custom = sess.custom
        settings.durationIndex = sess.durationIndex
        settings.save()
    }
    func saveSoon() {
        saveItem?.cancel()
        let item = DispatchWorkItem { [weak self] in self?.saveNow() }
        saveItem = item
        DispatchQueue.main.asyncAfter(deadline: .now() + 1, execute: item)
    }

    // ------------------------------------------------------------------ The panel's view of things

    func panelOpened() { lastSettingsRead = 0; evaluate() }

    func publicState() -> [String: Any] {
        let watchedIds = Set(settings.watched.map { $0.id })
        let runningIds = Set(running.map { $0.id })
        var apps: [[String: Any]] = settings.watched.map { ["id": $0.id, "name": $0.name, "watched": true, "running": runningIds.contains($0.id)] }
        apps += running.filter { !watchedIds.contains($0.id) }.map { ["id": $0.id, "name": $0.name, "watched": false, "running": true] }
        if apps.count > 80 { apps = Array(apps.prefix(80)) }
        let n: (Any?) -> Any = { $0 ?? NSNull() }
        var prefs = settings.json
        for k in ["watched", "stats", "pinX", "pinY", "custom", "durationIndex"] { prefs.removeValue(forKey: k) }
        var report: [String: Any] = ["others": others]
        report["sleepMinutes"] = n(sleepMinutes); report["displayMinutes"] = n(displayMinutes)
        let live = view.awake ? (nowMs() - (view.startedAt ?? nowMs())) / 1000 : 0
        return [
            "awake": view.awake, "reason": view.reason, "paused": view.paused,
            "startedAt": n(view.startedAt), "endsAt": n(view.endsAt), "timerFrom": n(view.timerFrom), "verified": verified, "manualKind": view.manualKind,
            "durationIndex": sess.durationIndex, "custom": n(sess.custom?.json), "mode": settings.mode, "screensaver": settings.screensaver,
            "autoApps": settings.autoApps, "autoDownloads": settings.autoDownloads, "autoAudio": settings.autoAudio, "autoLogin": settings.autoLogin,
            "hotkey": settings.hotkey, "pinned": settings.pinned, "downloadsActive": downloadsActive, "audioActive": audioOn,
            "apps": apps, "report": report, "prefs": prefs,
            "volumes": volumes.map { ["path": $0.path, "name": $0.name, "external": $0.external] },
            "stats": ["sessions": settings.stats.sessions, "seconds": settings.stats.seconds + live,
                      "longest": max(settings.stats.longest, live), "since": settings.stats.since],
            "power": ["hasBattery": power.hasBattery, "onBattery": power.onBattery, "percent": n(power.percent)],
            "locked": locked, "cpu": n(cpuLoad.map { Int($0.rounded()) }), "displaySleepsNow": view.awake && effectiveMode != settings.mode,
            "native": true,
        ]
    }

    func pushState() { if panel?.isOpen == true { panel.push(publicState()) } }

    // ------------------------------------------------------------------ Menu-bar tube

    func statusButtonFrame() -> NSRect? {
        guard let b = statusItem.button, let w = b.window else { return nil }
        return w.convertToScreen(b.convert(b.bounds, to: nil))
    }

    private func formatLeft(_ ms: Millis) -> String {
        let m = max(0, Int((ms / 60000).rounded(.up)))
        if settings.menuFormat == "clock" { return "\(m / 60):\(String(format: "%02d", m % 60))" }
        return m >= 60 ? "\(m / 60)h \(String(format: "%02d", m % 60))m" : "\(m)m"
    }

    func updateStatus() {
        guard let b = statusItem?.button else { return }
        var title = ""
        if settings.menuTime && view.awake, let e = view.endsAt { title = " " + formatLeft(e - nowMs()) }
        let key = "\(view.awake)|\(title)|\(settings.dimIdle)|\(view.reason)"
        if key == lastStatus { return }
        lastStatus = key
        let img = NSImage(named: view.awake ? "trayAwakeTemplate" : "trayTemplate")
        img?.isTemplate = true
        b.image = img
        b.title = title
        b.appearsDisabled = settings.dimIdle && !view.awake
        b.toolTip = view.awake ? "ProtoArt Wake: awake\(view.reason.isEmpty ? "" : " (\(view.reason))")" : "ProtoArt Wake: standby"
    }

    @objc private func statusClicked(_ sender: NSStatusBarButton) {
        let e = NSApp.currentEvent
        let secondary = e?.type == .rightMouseUp || e?.modifierFlags.contains(.control) == true
        if secondary { showMenu() }
        else if settings.leftClick == "toggle" { toggleAwake() }
        else { panel.toggle() }
    }

    // ------------------------------------------------------------------ Quick menu (right-click)

    private func item(_ title: String, _ action: @escaping () -> Void, on: Bool = false, enabled: Bool = true) -> NSMenuItem {
        let i = ClosureMenuItem(title: title, handler: action)
        i.state = on ? .on : .off
        i.isEnabled = enabled
        return i
    }
    private func sub(_ title: String, _ items: [NSMenuItem]) -> NSMenuItem {
        let i = NSMenuItem(title: title, action: nil, keyEquivalent: "")
        let m = NSMenu(title: title); m.autoenablesItems = false
        items.forEach { m.addItem($0) }
        i.submenu = m
        return i
    }
    private func label(_ title: String) -> NSMenuItem { let i = NSMenuItem(title: title, action: nil, keyEquivalent: ""); i.isEnabled = false; return i }
    private let hoursLabel: (Int) -> String = { "\($0) hour\($0 == 1 ? "" : "s")" }

    func showMenu() {
        refreshRunning()
        let m = NSMenu(); m.autoenablesItems = false
        let s = settings
        if view.awake {
            var head = "Awake"
            if let e = view.endsAt { head += " · \(formatLeft(e - nowMs())) left" } else if !view.reason.isEmpty { head += " · \(view.reason)" }
            m.addItem(label(head))
            m.addItem(item("End Session", { [weak self] in self?.applyPatch(["awake": false]) }))
            if view.endsAt != nil {
                m.addItem(sub("Extend Session", [15, 30, 60, 120].map { min in
                    item(min < 60 ? "+\(min) minutes" : "+\(self.hoursLabel(min / 60))", { [weak self] in self?.extend(minutes: min) })
                }))
            }
            m.addItem(.separator())
        }
        m.addItem(label("Start New Session:"))
        m.addItem(item("Indefinitely", { [weak self] in self?.applyPatch(["durationIndex": 0, "awake": true]) }))
        m.addItem(sub("Minutes", [5, 10, 15, 20, 30, 45].map { min in item("\(min) minutes", { [weak self] in self?.startFor(minutes: min) }) }))
        m.addItem(sub("Hours", [1, 2, 3, 4, 5, 6, 8, 10, 12].map { h in item(hoursLabel(h), { [weak self] in self?.startFor(minutes: h * 60) }) }))
        m.addItem(item("Other Time / Until…", { [weak self] in self?.panel.show(menu: "custom") }))
        let appsNow = running.sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
        m.addItem(sub("While App Is Running", appsNow.isEmpty ? [label("Open the app first")] : appsNow.map { r in
            item(r.name, { [weak self] in self?.sess.startForApp(id: r.id, name: r.name); self?.evaluate() })
        }))
        m.addItem(item("While File Is Downloading…", { [weak self] in self?.pickFile() }))
        m.addItem(.separator())
        m.addItem(sub("Quick Settings", [
            item("Keep display on", { [weak self] in self?.applyPatch(["mode": "display"]) }, on: s.mode == "display"),
            item("Let display sleep (Mac only)", { [weak self] in self?.applyPatch(["mode": "system"]) }, on: s.mode == "system"),
            .separator(),
            item("Block screen saver", { [weak self] in self?.applyPatch(["screensaver": s.screensaver == "block" ? "allow" : "block"]) }, on: s.screensaver == "block"),
            item("Let display sleep while locked", { [weak self] in self?.applyPatch(["lockedDisplaySleep": !s.lockedDisplaySleep]) }, on: s.lockedDisplaySleep),
            .separator(),
            item("Hotkey ⌃⌥⌘W toggles awake", { [weak self] in self?.applyPatch(["hotkey": !s.hotkey]) }, on: s.hotkey),
            item("Open at login", { [weak self] in self?.applyPatch(["autoLogin": !s.autoLogin]) }, on: s.autoLogin),
        ]))
        m.addItem(sub("Triggers", [
            item("Watched apps are open", { [weak self] in self?.applyPatch(["autoApps": !s.autoApps]) }, on: s.autoApps),
            item("Audio is playing", { [weak self] in self?.applyPatch(["autoAudio": !s.autoAudio]) }, on: s.autoAudio),
            item("A download is in progress", { [weak self] in self?.applyPatch(["autoDownloads": !s.autoDownloads]) }, on: s.autoDownloads),
            item("Scheduled hours", { [weak self] in self?.applyPatch(["trigSchedule": !s.trigSchedule]) }, on: s.trigSchedule),
            item("Power adapter connected", { [weak self] in self?.applyPatch(["trigPower": !s.trigPower]) }, on: s.trigPower, enabled: power.hasBattery),
            item("External display connected", { [weak self] in self?.applyPatch(["trigDisplay": !s.trigDisplay]) }, on: s.trigDisplay),
            item("Processor is busy (≥\(s.cpuPercent)%)", { [weak self] in self?.applyPatch(["trigCPU": !s.trigCPU]) }, on: s.trigCPU),
            .separator(),
            item("Set Up Triggers…", { [weak self] in self?.panel.show(menu: "setup") }),
        ]))
        m.addItem(item("Open Panel", { [weak self] in self?.panel.show() }))
        m.addItem(item("Settings…", { [weak self] in self?.panel.show(menu: "setup") }))
        m.addItem(item("How It Works…", { [weak self] in self?.panel.show(menu: "about") }))
        m.addItem(item("Turn Display Off Now", { [weak self] in self?.lightsOut() }))
        m.addItem(.separator())
        m.addItem(item("Quit ProtoArt Wake", { NSApp.terminate(nil) }))
        statusItem.menu = m
        statusItem.button?.performClick(nil) // pops the menu under the tube
        statusItem.menu = nil                 // so a left click opens the panel again
    }

    // ------------------------------------------------------------------ Notifications

    private func registerNotificationActions() {
        let ext15 = UNNotificationAction(identifier: "extend15", title: "Extend 15 min", options: [])
        let ext60 = UNNotificationAction(identifier: "extend60", title: "Extend 1 hour", options: [])
        let end = UNNotificationAction(identifier: "end", title: "End Now", options: [.destructive])
        let cat = UNNotificationCategory(identifier: "reminder", actions: [ext15, ext60, end], intentIdentifiers: [], options: [])
        UNUserNotificationCenter.current().setNotificationCategories([cat])
    }

    private var askedPermission = false
    private func askNotificationPermission() {
        if askedPermission { return }
        askedPermission = true
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { _, _ in }
    }

    private func post(_ title: String, _ body: String, category: String? = nil) {
        askNotificationPermission()
        let c = UNMutableNotificationContent()
        c.title = "ProtoArt Wake: \(title)"
        c.body = body
        if let cat = category { c.categoryIdentifier = cat }
        UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: UUID().uuidString, content: c, trigger: nil))
    }

    func notify(_ title: String, _ body: String) { if settings.notify { post(title, body) } }

    private func remind(minutesLeft: Int) {
        if settings.sounds { NSSound(named: "Glass")?.play() }
        post("\(minutesLeft) minute\(minutesLeft == 1 ? "" : "s") left", "Your Mac will be allowed to sleep soon.", category: "reminder")
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
                                withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner])
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                                withCompletionHandler completionHandler: @escaping () -> Void) {
        let id = response.actionIdentifier
        DispatchQueue.main.async {
            switch id {
            case "extend15": self.extend(minutes: 15)
            case "extend60": self.extend(minutes: 60)
            case "end": self.applyPatch(["awake": false])
            default: break
            }
        }
        completionHandler()
    }

    // ------------------------------------------------------------------ protoart-wake:// links

    /**
     * protoart-wake://start                      until switched off
     * protoart-wake://start?minutes=90           for a while
     * protoart-wake://start?until=18:30          until a clock time
     * protoart-wake://end · toggle · panel · extend?minutes=30 · lights-out
     */
    func open(url: URL) {
        guard url.scheme?.lowercased() == "protoart-wake" else { return }
        let cmd = (url.host ?? url.path).lowercased().trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        let q = Dictionary(URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.compactMap { i in i.value.map { (i.name, $0) } } ?? [],
                           uniquingKeysWith: { a, _ in a })
        switch cmd {
        case "start":
            if let m = q["minutes"].flatMap({ Int($0) }), (1...1440).contains(m) { startFor(minutes: m) }
            else if let u = q["until"], let c = CustomTime.from(untilDict(u)) { applyPatch(["custom": c.json]) }
            else { sess.startFor(minutes: 0); evaluate() }
        case "end", "stop": applyPatch(["awake": false])
        case "toggle": toggleAwake()
        case "extend": if let m = q["minutes"].flatMap({ Int($0) }) { extend(minutes: m) }
        case "panel": panel.show()
        case "lights-out": lightsOut()
        default: break
        }
    }
    private func untilDict(_ s: String) -> [String: Any]? {
        let p = s.split(separator: ":")
        guard p.count == 2, let h = Int(p[0]), let m = Int(p[1]) else { return nil }
        return ["kind": "until", "hour": h, "minute": m]
    }
}

/** A menu item that runs a closure. */
final class ClosureMenuItem: NSMenuItem {
    private let handler: () -> Void
    init(title: String, handler: @escaping () -> Void) {
        self.handler = handler
        super.init(title: title, action: #selector(run), keyEquivalent: "")
        target = self
    }
    required init(coder: NSCoder) { fatalError("not used") }
    @objc private func run() { handler() }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    static var core: Core? = nil
    let core = Core()

    func applicationDidFinishLaunching(_ n: Notification) {
        AppDelegate.core = core
        // Opened at login (or by a link): stay quiet. Opened by hand: show the panel.
        let event = NSAppleEventManager.shared().currentAppleEvent
        let atLogin = event?.eventID == AEEventID(kAEOpenApplication) &&
            event?.paramDescriptor(forKeyword: AEKeyword(keyAEPropData))?.enumCodeValue == OSType(keyAELaunchedAsLogInItem)
        core.start(openedByHand: !atLogin && !launchedByLink)
    }
    private var launchedByLink = false
    func applicationWillFinishLaunching(_ n: Notification) {
        if let e = NSAppleEventManager.shared().currentAppleEvent, e.eventClass == AEEventClass(kInternetEventClass) { launchedByLink = true }
    }

    // Opened again from Applications, Launchpad or Spotlight while running: show the panel.
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        core.panel?.show()
        return false
    }

    func application(_ application: NSApplication, open urls: [URL]) {
        for u in urls.prefix(4) { core.open(url: u) }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }
    func applicationWillTerminate(_ n: Notification) { core.hold.stop(); core.saveNow() }
}
