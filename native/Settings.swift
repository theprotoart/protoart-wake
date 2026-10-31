// Settings: kept as JSON in ~/Library/Application Support/ProtoArt Wake/settings.json (the same file
// the Electron version used, so nothing is lost on upgrade). Every value is checked on load and on
// every change from the panel, the menu or a protoart-wake:// link.
import Foundation

/// Knob stops in minutes; 0 = until switched off. (Version 2.0.x had 10 stops; see OLD_DURATIONS.)
let DURATION_MINUTES = [0, 5, 10, 15, 20, 30, 45, 60, 90, 120, 180, 240, 360, 480, 720]
let OLD_DURATIONS = [0, 15, 30, 60, 120, 180, 240, 360, 480, 720]
let CUSTOM_INDEX = DURATION_MINUTES.count                              // the knob's SET position
let MAX_WATCHED = 50

/** A custom time: for N minutes (1–1440) or until a clock time. */
enum CustomTime: Equatable {
    case forMinutes(Int)
    case until(hour: Int, minute: Int)

    static func from(_ v: Any?) -> CustomTime? {
        guard let d = v as? [String: Any], let kind = d["kind"] as? String else { return nil }
        if kind == "for", let m = intValue(d["minutes"]), (1...1440).contains(m) { return .forMinutes(m) }
        if kind == "until", let h = intValue(d["hour"]), let m = intValue(d["minute"]), (0...23).contains(h), (0...59).contains(m) {
            return .until(hour: h, minute: m)
        }
        return nil
    }
    var json: [String: Any] {
        switch self {
        case .forMinutes(let m): return ["kind": "for", "minutes": m]
        case .until(let h, let m): return ["kind": "until", "hour": h, "minute": m]
        }
    }
}

/** A JSON number that is a whole number (JSONSerialization gives NSNumber; booleans are not numbers). */
func intValue(_ v: Any?) -> Int? {
    guard let n = v as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID() else { return nil }
    let d = n.doubleValue
    guard d.isFinite, d == d.rounded(), abs(d) < 1e9 else { return nil }
    return Int(d)
}
func boolValue(_ v: Any?) -> Bool? {
    guard let n = v as? NSNumber, CFGetTypeID(n) == CFBooleanGetTypeID() else { return nil }
    return n.boolValue
}
func validAppId(_ v: Any?) -> String? {
    guard let s = v as? String, s.count < 1024, !s.contains("\0"), s.hasPrefix("/"), s.hasSuffix(".app"),
          !s.split(separator: "/").contains("..") else { return nil }
    return s
}
func validVolume(_ v: Any?) -> String? {
    guard let s = v as? String, s.count < 1024, !s.contains("\0"), s.hasPrefix("/Volumes/"),
          !s.split(separator: "/").contains("..") else { return nil }
    return s
}

struct WatchedApp: Equatable { var id: String; var name: String }

struct Stats {
    var sessions = 0
    var seconds = 0.0
    var longest = 0.0
    var since = Date().timeIntervalSince1970 * 1000
}

final class Settings {
    // From version 1 (the panel's controls)
    var durationIndex = 0
    var custom: CustomTime? = nil
    var mode = "display"            // display | system
    var screensaver = "allow"       // allow | block
    var autoApps = false, autoDownloads = false, autoAudio = false, autoLogin = false
    var hotkey = true
    var pinned = false
    var pinX: Int? = nil, pinY: Int? = nil
    var watched: [WatchedApp] = []

    // Triggers (stay awake on their own)
    var trigSchedule = false
    var schedDays: [Int] = [2, 3, 4, 5, 6]   // 1 = Sunday … 7 = Saturday
    var schedStart = 9 * 60, schedEnd = 17 * 60 // minutes after midnight; end before start = overnight
    var trigPower = false                      // while the power adapter is connected
    var trigDisplay = false                    // while an external display is connected
    var trigDrive = false                      // while one of these drives is mounted
    var trigDrives: [String] = []
    var trigCPU = false                        // while the processor is busy
    var cpuPercent = 40

    // Session rules
    var endBattery = 10                        // end below this % on battery (0 = never)
    var endOnUnplug = false
    var endOnSleep = false                     // the Mac was put to sleep anyway (lid, menu)
    var endOnUserSwitch = false
    var lockedDisplaySleep = false             // let the display sleep while the screen is locked
    var startAtLaunch = false
    var startAfterWake = false

    // Reminders, sounds, menu bar
    var remindMinutes = 0                      // notify this long before a timer ends (0 = off)
    var notify = true
    var sounds = false
    var menuTime = true                        // show the time left next to the tube
    var menuFormat = "short"                   // short (1h 05m) | clock (1:05)
    var dimIdle = false                        // grey the tube in standby
    var leftClick = "panel"                    // panel | toggle

    // Drive Alive: keep these external drives from spinning down while awake
    var driveAlive = false
    var aliveDrives: [String] = []

    var stats = Stats()

    static let BOOL_KEYS: [String: ReferenceWritableKeyPath<Settings, Bool>] = [
        "autoApps": \.autoApps, "autoDownloads": \.autoDownloads, "autoAudio": \.autoAudio, "autoLogin": \.autoLogin,
        "hotkey": \.hotkey, "pinned": \.pinned,
        "trigSchedule": \.trigSchedule, "trigPower": \.trigPower, "trigDisplay": \.trigDisplay, "trigDrive": \.trigDrive, "trigCPU": \.trigCPU,
        "endOnUnplug": \.endOnUnplug, "endOnSleep": \.endOnSleep, "endOnUserSwitch": \.endOnUserSwitch,
        "lockedDisplaySleep": \.lockedDisplaySleep, "startAtLaunch": \.startAtLaunch, "startAfterWake": \.startAfterWake,
        "notify": \.notify, "sounds": \.sounds, "menuTime": \.menuTime, "dimIdle": \.dimIdle, "driveAlive": \.driveAlive,
    ]
    static let INT_KEYS: [String: (ReferenceWritableKeyPath<Settings, Int>, ClosedRange<Int>)] = [
        "schedStart": (\.schedStart, 0...1439), "schedEnd": (\.schedEnd, 0...1439),
        "cpuPercent": (\.cpuPercent, 5...95), "endBattery": (\.endBattery, 0...90), "remindMinutes": (\.remindMinutes, 0...60),
    ]
    static let CHOICE_KEYS: [String: (ReferenceWritableKeyPath<Settings, String>, [String])] = [
        "mode": (\.mode, ["display", "system"]), "screensaver": (\.screensaver, ["allow", "block"]),
        "menuFormat": (\.menuFormat, ["short", "clock"]), "leftClick": (\.leftClick, ["panel", "toggle"]),
    ]

    static func days(_ v: Any?) -> [Int]? {
        guard let a = v as? [Any], a.count <= 7 else { return nil }
        let d = a.compactMap(intValue).filter { (1...7).contains($0) }
        return d.count == a.count ? Array(Set(d)).sorted() : nil
    }
    static func volumes(_ v: Any?) -> [String]? {
        guard let a = v as? [Any], a.count <= 20 else { return nil }
        let d = a.compactMap(validVolume)
        return d.count == a.count ? Array(Set(d)).sorted() : nil
    }

    /** Applies the stored keys we recognise; anything else is ignored. */
    func load(_ data: [String: Any]) {
        custom = CustomTime.from(data["custom"])
        if let x = intValue(data["pinX"]), abs(x) < 100000 { pinX = x }
        if let y = intValue(data["pinY"]), abs(y) < 100000 { pinY = y }
        if var d = intValue(data["durationIndex"]) {
            // settings from before the finer knob (no "knob": 2): map the old stop to the same length
            if intValue(data["knob"]) != 2 {
                d = d == OLD_DURATIONS.count ? CUSTOM_INDEX : (d >= 0 && d < OLD_DURATIONS.count ? DURATION_MINUTES.firstIndex(of: OLD_DURATIONS[d]) ?? 0 : -1)
            }
            if d >= 0, d <= (custom != nil ? CUSTOM_INDEX : CUSTOM_INDEX - 1) { durationIndex = d }
        }
        for (k, path) in Settings.BOOL_KEYS { if let b = boolValue(data[k]) { self[keyPath: path] = b } }
        for (k, (path, range)) in Settings.INT_KEYS { if let n = intValue(data[k]), range.contains(n) { self[keyPath: path] = n } }
        for (k, (path, allowed)) in Settings.CHOICE_KEYS { if let s = data[k] as? String, allowed.contains(s) { self[keyPath: path] = s } }
        if let d = Settings.days(data["schedDays"]) { schedDays = d }
        if let v = Settings.volumes(data["trigDrives"]) { trigDrives = v }
        if let v = Settings.volumes(data["aliveDrives"]) { aliveDrives = v }
        if let list = data["watched"] as? [[String: Any]] {
            watched = list.compactMap { w in
                guard let id = validAppId(w["id"]), let name = w["name"] as? String else { return nil }
                return WatchedApp(id: id, name: String(name.prefix(120)))
            }
            if watched.count > MAX_WATCHED { watched = Array(watched.prefix(MAX_WATCHED)) }
        }
        if let s = data["stats"] as? [String: Any] {
            if let n = intValue(s["sessions"]), n >= 0 { stats.sessions = n }
            if let n = (s["seconds"] as? NSNumber)?.doubleValue, n.isFinite, n >= 0 { stats.seconds = n }
            if let n = (s["longest"] as? NSNumber)?.doubleValue, n.isFinite, n >= 0 { stats.longest = n }
            if let n = (s["since"] as? NSNumber)?.doubleValue, n.isFinite, n > 0 { stats.since = n }
        }
    }

    var json: [String: Any] {
        var d: [String: Any] = [
            "knob": 2, "durationIndex": durationIndex, "custom": custom.map { $0.json as Any } ?? NSNull(),
            "pinX": pinX.map { $0 as Any } ?? NSNull(), "pinY": pinY.map { $0 as Any } ?? NSNull(),
            "watched": watched.map { ["id": $0.id, "name": $0.name] },
            "schedDays": schedDays, "trigDrives": trigDrives, "aliveDrives": aliveDrives,
            "stats": ["sessions": stats.sessions, "seconds": stats.seconds, "longest": stats.longest, "since": stats.since],
        ]
        for (k, path) in Settings.BOOL_KEYS { d[k] = self[keyPath: path] }
        for (k, (path, _)) in Settings.INT_KEYS { d[k] = self[keyPath: path] }
        for (k, (path, _)) in Settings.CHOICE_KEYS { d[k] = self[keyPath: path] }
        return d
    }

    // ------------------------------------------------------------------ File

    static var file: URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("Library/Application Support")
        return base.appendingPathComponent("ProtoArt Wake/settings.json")
    }

    static func loadFromDisk() -> Settings {
        let s = Settings()
        if let data = try? Data(contentsOf: file), data.count < 1 << 20,
           let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            s.load(obj)
        }
        return s
    }

    /** Written to a temporary file and renamed into place, readable only by you. */
    func save() {
        let url = Settings.file
        let dir = url.deletingLastPathComponent()
        do {
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            let data = try JSONSerialization.data(withJSONObject: json, options: [.prettyPrinted, .sortedKeys])
            let tmp = dir.appendingPathComponent(".settings-\(UUID().uuidString).tmp")
            guard FileManager.default.createFile(atPath: tmp.path, contents: data, attributes: [.posixPermissions: 0o600]) else { return }
            if rename(tmp.path, url.path) != 0 { try? FileManager.default.removeItem(at: tmp) }
        } catch { /* not fatal: settings just won't stick */ }
    }
}
