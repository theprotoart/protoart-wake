// Talking to macOS directly: power assertions (the keep-awake hold), who else holds one, the
// power source, idle time, processor load, displays and drives. No helper programs run in the
// background; `pmset` runs only for LIGHTS OUT and, while the panel is open, once a minute to read
// the Mac's normal sleep settings.
import AppKit
import IOKit
import IOKit.pwr_mgt
import IOKit.ps

// ------------------------------------------------------------------ The hold

/**
 * The keep-awake hold: macOS power assertions owned by this process. If the app quits or crashes,
 * macOS drops them by itself, so a Mac can never be left stuck awake.
 */
final class Hold {
    private(set) var systemID: IOPMAssertionID = 0
    private(set) var displayID: IOPMAssertionID = 0
    private(set) var mode: String? = nil
    private var activityID: IOPMAssertionID = 0
    var active: Bool { systemID != 0 }

    private func take(_ type: String, _ name: String) -> IOPMAssertionID {
        var id: IOPMAssertionID = 0
        let r = IOPMAssertionCreateWithName(type as CFString, IOPMAssertionLevel(kIOPMAssertionLevelOn), name as CFString, &id)
        return r == kIOReturnSuccess ? id : 0
    }

    /** mode: "display" keeps the screen and the Mac awake; "system" lets the screen sleep. */
    func start(_ mode: String) {
        if active && self.mode == mode { return }
        if systemID == 0 { systemID = take("PreventUserIdleSystemSleep", "ProtoArt Wake: keeping the Mac awake") }
        if mode == "display" {
            if displayID == 0 { displayID = take("PreventUserIdleDisplaySleep", "ProtoArt Wake: keeping the display on") }
        } else if displayID != 0 {
            IOPMAssertionRelease(displayID); displayID = 0
        }
        self.mode = mode
    }

    func stop() {
        if systemID != 0 { IOPMAssertionRelease(systemID); systemID = 0 }
        if displayID != 0 { IOPMAssertionRelease(displayID); displayID = 0 }
        mode = nil
    }

    /** Tells macOS the user is active (resets the screen-saver and lock timers). */
    func declareUserActivity() {
        var id = activityID
        if IOPMAssertionDeclareUserActivity("ProtoArt Wake: screen saver blocked" as CFString, kIOPMUserActiveLocal, &id) == kIOReturnSuccess {
            activityID = id
        }
    }
}

// ------------------------------------------------------------------ What macOS reports

struct AssertionHolder { var pid: Int32; var name: String; var types: Set<String> }

private let HOLD_TYPES: Set<String> = ["PreventUserIdleSystemSleep", "PreventUserIdleDisplaySleep", "PreventSystemSleep",
                                       "NoIdleSleepAssertion", "NoDisplaySleepAssertion"]
private let SYSTEM_OWNERS: Set<String> = ["powerd", "WindowServer", "kernel_task", "coreaudiod", "hidd"]

func processName(_ pid: Int32) -> String {
    if let app = NSRunningApplication(processIdentifier: pid), let n = app.localizedName { return n }
    var buf = [CChar](repeating: 0, count: 256)
    let n = proc_name(pid, &buf, UInt32(buf.count))
    return n > 0 ? String(cString: buf) : "pid \(pid)"
}

/** Every process holding a power assertion right now, from macOS itself (a fast in-memory query). */
func readAssertions() -> [AssertionHolder] {
    var ref: Unmanaged<CFDictionary>? = nil
    guard IOPMCopyAssertionsByProcess(&ref) == kIOReturnSuccess, let dict = ref?.takeRetainedValue() as NSDictionary? else { return [] }
    var out: [AssertionHolder] = []
    for (k, v) in dict {
        guard let pid = (k as? NSNumber)?.int32Value, let list = v as? [[String: Any]] else { continue }
        var types = Set<String>()
        var name = ""
        for a in list {
            if let t = a["AssertType"] as? String { types.insert(t) }
            if name.isEmpty, let p = a["Process Name"] as? String { name = p }
        }
        if name.isEmpty { name = processName(pid) }
        out.append(AssertionHolder(pid: pid, name: name, types: types))
    }
    return out
}

/** True when macOS lists the expected assertion types for us. */
func holdVerified(_ holders: [AssertionHolder], mode: String) -> Bool {
    guard let me = holders.first(where: { $0.pid == getpid() }) else { return false }
    if !me.types.contains("PreventUserIdleSystemSleep") { return false }
    return mode != "display" || me.types.contains("PreventUserIdleDisplaySleep")
}

/** Friendly names of other processes keeping the Mac awake (not us, not macOS housekeeping). */
func otherHolders(_ holders: [AssertionHolder]) -> [String] {
    var names: [String] = []
    for h in holders.sorted(by: { $0.pid < $1.pid }) {
        if h.pid == getpid() || SYSTEM_OWNERS.contains(h.name) || h.types.isDisjoint(with: HOLD_TYPES) { continue }
        // only apps you'd recognise (and Terminal's caffeinate), not macOS's own background services
        let app = NSRunningApplication(processIdentifier: h.pid)
        if h.name != "caffeinate" && (app == nil || app?.bundleURL?.pathExtension != "app") { continue }
        var n = NSRunningApplication(processIdentifier: h.pid)?.localizedName ?? h.name
        if n == "caffeinate" { n = "caffeinate (Terminal)" }
        if n == "AddressBookSourceSync" { n = "Contacts sync" }
        if !names.contains(n) { names.append(n) }
    }
    return names
}

/** Audio is playing or recording: macOS's audio daemon holds an assertion while any device runs. */
func audioActive(_ holders: [AssertionHolder]) -> Bool {
    holders.contains { $0.name == "coreaudiod" && !$0.types.isDisjoint(with: HOLD_TYPES) }
}

// ------------------------------------------------------------------ Power source

struct PowerState { var onBattery: Bool; var percent: Int?; var hasBattery: Bool }

func readPower() -> PowerState {
    guard let info = IOPSCopyPowerSourcesInfo()?.takeRetainedValue() else { return PowerState(onBattery: false, percent: nil, hasBattery: false) }
    let providing = (IOPSGetProvidingPowerSourceType(info)?.takeUnretainedValue()).map { $0 as String } ?? "AC Power"
    var percent: Int? = nil
    var hasBattery = false
    if let arr = IOPSCopyPowerSourcesList(info)?.takeRetainedValue() {
        for ps in (arr as NSArray as [AnyObject]) {
            guard let d = IOPSGetPowerSourceDescription(info, ps)?.takeUnretainedValue() as? [String: Any] else { continue }
            if (d["Type"] as? String) == "InternalBattery" {
                hasBattery = true
                if let cur = d["Current Capacity"] as? Int, let max = d["Max Capacity"] as? Int, max > 0 {
                    percent = Int((Double(cur) / Double(max) * 100).rounded())
                }
            }
        }
    }
    return PowerState(onBattery: providing == "Battery Power", percent: percent, hasBattery: hasBattery)
}

// ------------------------------------------------------------------ Input, processor, displays, drives

/** Seconds since the last keyboard or mouse input. */
func idleSeconds() -> Double {
    CGEventSource.secondsSinceLastEventType(.combinedSessionState, eventType: CGEventType(rawValue: ~0)!)
}

/** Processor load between calls (0–100), from the kernel's tick counters. */
final class CPUMeter {
    private var last: (busy: UInt64, total: UInt64)? = nil
    func sample() -> Double? {
        var info = host_cpu_load_info_data_t()
        var count = mach_msg_type_number_t(MemoryLayout<host_cpu_load_info_data_t>.stride / MemoryLayout<integer_t>.stride)
        let r = withUnsafeMutablePointer(to: &info) {
            $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) { host_statistics(mach_host_self(), HOST_CPU_LOAD_INFO, $0, &count) }
        }
        guard r == KERN_SUCCESS else { return nil }
        let user = UInt64(info.cpu_ticks.0), sys = UInt64(info.cpu_ticks.1), idle = UInt64(info.cpu_ticks.2), nice = UInt64(info.cpu_ticks.3)
        let busy = user + sys + nice, total = busy + idle
        defer { last = (busy, total) }
        guard let l = last, total > l.total else { return nil }
        return Double(busy - l.busy) / Double(total - l.total) * 100
    }
    func reset() { last = nil }
}

func externalDisplayConnected() -> Bool {
    NSScreen.screens.contains { s in
        guard let n = s.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber else { return false }
        return CGDisplayIsBuiltin(CGDirectDisplayID(n.uint32Value)) == 0
    }
}

struct Volume { var path: String; var name: String; var external: Bool }

/** Mounted drives other than the startup disk. */
func mountedVolumes() -> [Volume] {
    let keys: [URLResourceKey] = [.volumeNameKey, .volumeIsInternalKey, .volumeIsRootFileSystemKey, .volumeIsBrowsableKey, .volumeIsReadOnlyKey]
    let urls = FileManager.default.mountedVolumeURLs(includingResourceValuesForKeys: keys, options: [.skipHiddenVolumes]) ?? []
    return urls.compactMap { u in
        guard u.path.hasPrefix("/Volumes/"), let v = try? u.resourceValues(forKeys: Set(keys)) else { return nil }
        // skip the startup disk, hidden volumes and read-only ones (opened disk images such as installers)
        if v.volumeIsRootFileSystem == true || v.volumeIsBrowsable == false || v.volumeIsReadOnly == true { return nil }
        return Volume(path: u.path, name: v.volumeName ?? u.lastPathComponent, external: v.volumeIsInternal != true)
    }
}

// ------------------------------------------------------------------ Downloads

private let PARTIAL = try! NSRegularExpression(pattern: "\\.(crdownload|download|part|partial|opdownload)$", options: .caseInsensitive)
func isPartialDownload(_ name: String) -> Bool { PARTIAL.firstMatch(in: name, range: NSRange(name.startIndex..., in: name)) != nil }

private func modified(_ url: URL) -> Date? { (try? url.resourceValues(forKeys: [.contentModificationDateKey]))?.contentModificationDate }

/** Newest change inside a path (a Safari .download is a folder holding the growing file). */
func newestChange(_ url: URL) -> Date? {
    var newest = modified(url)
    if (try? url.resourceValues(forKeys: [.isDirectoryKey]))?.isDirectory == true,
       let inner = try? FileManager.default.contentsOfDirectory(at: url, includingPropertiesForKeys: [.contentModificationDateKey]) {
        for f in inner.prefix(50) { if let m = modified(f), m > (newest ?? .distantPast) { newest = m } }
    }
    return newest
}

/**
 * (inProgress, partialsPresent): a partial-download entry in the folder (Chrome .crdownload, Safari
 * .download, Firefox .part, …) that changed in the last two minutes. Only names and dates are read.
 */
func downloadsInProgress(_ dir: URL, now: Date = Date()) -> (Bool, Bool) {
    guard let names = try? FileManager.default.contentsOfDirectory(atPath: dir.path) else { return (false, false) }
    var present = false
    for n in names where isPartialDownload(n) {
        present = true
        if let m = newestChange(dir.appendingPathComponent(n)), now.timeIntervalSince(m) < 120 { return (true, true) }
    }
    return (false, present)
}

// ------------------------------------------------------------------ pmset (rare)

/** Runs a fixed system program with arguments (no shell) and returns what it printed. */
@discardableResult
func runTool(_ path: String, _ args: [String], completion: ((String) -> Void)? = nil) -> Process? {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: path)
    p.arguments = args
    p.environment = ["PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "LANG": "en_US.UTF-8"]
    let pipe = Pipe()
    p.standardOutput = pipe
    p.standardError = FileHandle.nullDevice
    p.standardInput = FileHandle.nullDevice
    p.terminationHandler = { _ in
        let data = (try? pipe.fileHandleForReading.readToEnd()) ?? Data()
        let text = String(decoding: data.prefix(1 << 20), as: UTF8.self)
        DispatchQueue.main.async { completion?(text) }
    }
    do { try p.run() } catch { return nil }
    return p
}

/** Parses `pmset -g`: (sleepMinutes, displayMinutes), 0 = never. */
func parsePmsetSettings(_ text: String) -> (Int?, Int?) {
    func num(_ key: String) -> Int? {
        for line in text.split(separator: "\n") {
            let parts = line.split(whereSeparator: { $0 == " " || $0 == "\t" })
            if parts.count >= 2, parts[0] == key, let n = Int(parts[1]) { return n }
        }
        return nil
    }
    return (num("sleep"), num("displaysleep"))
}

func displaySleepNow() { runTool("/usr/bin/pmset", ["displaysleepnow"]) }
