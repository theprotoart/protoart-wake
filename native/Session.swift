// Decides whether the Mac should be held awake right now. Pure logic, no system calls.
//
// A manual session is one of:
//   time  - until switched off, for a preset or custom length, or until a clock time
//   app   - while one chosen app keeps running
//   file  - while one chosen file is still downloading
// Triggers (watched apps, audio, downloads, schedule, power, display, drive, processor) can hold
// the Mac awake on their own; the caller works out which one applies and passes it in as `cause`.
import Foundation

typealias Millis = Double
func nowMs() -> Millis { Date().timeIntervalSince1970 * 1000 }

/** Next time the local clock reads hour:minute (today if still ahead, else tomorrow). */
func nextClockTime(hour: Int, minute: Int, now: Millis) -> Millis {
    let cal = Calendar.current
    let d = Date(timeIntervalSince1970: now / 1000)
    var t = cal.date(bySettingHour: hour, minute: minute, second: 0, of: d) ?? d
    if t.timeIntervalSince1970 * 1000 <= now + 30000 { t = cal.date(byAdding: .day, value: 1, to: t) ?? t }
    return t.timeIntervalSince1970 * 1000
}

struct Manual {
    enum Kind: String { case time, app, file }
    var kind: Kind
    var endsAt: Millis?
    var from: Millis = 0          // when the current timer was set (for the knob's countdown arc)
    var appId = ""
    var appName = ""
    var filePath = ""
    var fileName = ""
}

struct Decision {
    var awake = false
    var reason = ""
    var paused = ""
    var startedAt: Millis? = nil
    var endsAt: Millis? = nil
    var timerFrom: Millis? = nil
    var manualKind = ""
    var expired = ""
}

final class Session {
    var durationIndex: Int
    var custom: CustomTime?
    var manual: Manual? = nil
    var awakeSince: Millis? = nil
    var suppressed = false   // switched off during a trigger hold: wait until that cause goes away
    var lastCause: String? = nil

    init(durationIndex: Int = 0, custom: CustomTime? = nil) { self.durationIndex = durationIndex; self.custom = custom }

    /** End time for a timed session starting now (nil = until switched off). */
    func endsAtFrom(_ now: Millis) -> Millis? {
        if durationIndex == CUSTOM_INDEX, let c = custom {
            switch c {
            case .forMinutes(let m): return now + Double(m) * 60000
            case .until(let h, let m): return nextClockTime(hour: h, minute: m, now: now)
            }
        }
        let m = durationIndex < DURATION_MINUTES.count ? DURATION_MINUTES[durationIndex] : 0
        return m > 0 ? now + Double(m) * 60000 : nil
    }

    /** Power button. */
    func setPower(_ on: Bool, now: Millis = nowMs()) {
        if on { manual = Manual(kind: .time, endsAt: endsAtFrom(now), from: now); suppressed = false }
        else { manual = nil; if lastCause != nil { suppressed = true } }
    }

    /** Knob. During a timed session the timer restarts from now. */
    func setDuration(_ index: Int, now: Millis = nowMs()) {
        guard index >= 0, index <= CUSTOM_INDEX else { return }
        if index == CUSTOM_INDEX && custom == nil { return } // SET needs a custom time first
        durationIndex = index
        if var m = manual, m.kind == .time { m.endsAt = endsAtFrom(now); m.from = now; manual = m }
    }

    /** Custom length or clock time (the SET position); optionally starts a session right away. */
    func setCustom(_ c: CustomTime, now: Millis = nowMs(), start: Bool = true) {
        custom = c
        durationIndex = CUSTOM_INDEX
        if start || manual?.kind == .time { setPower(true, now: now) }
    }

    /** A one-off session for N minutes that leaves the knob where it is (menu, links). */
    func startFor(minutes: Int, now: Millis = nowMs()) {
        manual = Manual(kind: .time, endsAt: minutes > 0 ? now + Double(minutes) * 60000 : nil, from: now)
        suppressed = false
    }

    /** Adds time to a timed session (or starts one for that long). */
    func extend(minutes: Int, now: Millis = nowMs()) {
        if var m = manual, m.kind == .time {
            if let e = m.endsAt { m.endsAt = max(e, now) + Double(minutes) * 60000; manual = m }
        } else if manual == nil {
            startFor(minutes: minutes, now: now)
        }
    }

    func startForApp(id: String, name: String) { manual = Manual(kind: .app, endsAt: nil, appId: id, appName: name); suppressed = false }
    func startForFile(path: String, name: String) { manual = Manual(kind: .file, endsAt: nil, filePath: path, fileName: name); suppressed = false }

    /**
     * Returns the state now. expired is a short message once, when a manual session ends on its own;
     * paused names a trigger the user switched off.
     */
    func decide(now: Millis, runningIds: Set<String>, fileActive: Bool, cause: String?) -> Decision {
        var expired = ""
        if let m = manual {
            if m.kind == .time, let e = m.endsAt, now >= e { expired = "Time is up."; manual = nil }
            else if m.kind == .app && !runningIds.contains(m.appId) { expired = "\(m.appName) quit."; manual = nil }
            else if m.kind == .file && !fileActive { expired = "\(m.fileName) finished downloading."; manual = nil }
        }
        if cause == nil { suppressed = false }
        lastCause = cause

        let awake = manual != nil || (cause != nil && !suppressed)
        if awake && awakeSince == nil { awakeSince = now }
        if !awake { awakeSince = nil }

        var d = Decision()
        d.awake = awake
        d.expired = expired
        d.startedAt = awakeSince
        if let m = manual {
            d.manualKind = m.kind.rawValue
            if m.kind == .app { d.reason = "While \(m.appName) is open" }
            if m.kind == .file { d.reason = "While \(m.fileName) downloads" }
            if m.kind == .time { d.endsAt = m.endsAt; d.timerFrom = m.endsAt != nil ? m.from : nil }
        } else if awake, let c = cause { d.reason = c }
        if !awake && suppressed, let c = cause { d.paused = c.hasPrefix("Auto: ") ? String(c.dropFirst(6)) : c }
        return d
    }
}
