// Checks the pure logic (session rules and settings validation). The build runs
// `ProtoArt Wake --self-test` and stops if anything here fails.
import Foundation

enum SelfTest {
    static var failures = 0
    static func check(_ ok: Bool, _ what: String, line: Int = #line) {
        if !ok { failures += 1; print("FAIL (line \(line)): \(what)") }
    }

    static func run() -> Int32 {
        let t0: Millis = 1_700_000_000_000

        // Power on/off and presets
        let s = Session()
        var d = s.decide(now: t0, runningIds: [], fileActive: false, cause: nil)
        check(!d.awake, "starts asleep")
        s.setPower(true, now: t0)
        d = s.decide(now: t0, runningIds: [], fileActive: false, cause: nil)
        check(d.awake && d.endsAt == nil && d.manualKind == "time", "∞ session")
        s.setDuration(DURATION_MINUTES.firstIndex(of: 60)!, now: t0) // 1h
        d = s.decide(now: t0 + 1000, runningIds: [], fileActive: false, cause: nil)
        check(d.endsAt == t0 + 3_600_000, "knob restarts timer")
        d = s.decide(now: t0 + 3_600_000, runningIds: [], fileActive: false, cause: nil)
        check(!d.awake && d.expired == "Time is up.", "timer expires")

        // SET needs a custom time; extend adds time
        let s2 = Session()
        s2.setDuration(CUSTOM_INDEX, now: t0)
        check(s2.durationIndex == 0, "SET refused without a custom time")
        s2.setCustom(.forMinutes(90), now: t0)
        d = s2.decide(now: t0, runningIds: [], fileActive: false, cause: nil)
        check(d.awake && d.endsAt == t0 + 90 * 60000, "custom 90 minutes")
        s2.extend(minutes: 15, now: t0)
        check(s2.manual?.endsAt == t0 + 105 * 60000, "extend adds 15 minutes")
        let s3 = Session()
        s3.extend(minutes: 30, now: t0)
        check(s3.manual?.endsAt == t0 + 30 * 60000, "extend with no session starts one")

        // App and file sessions
        let s4 = Session()
        s4.startForApp(id: "/Applications/X.app", name: "X")
        d = s4.decide(now: t0, runningIds: ["/Applications/X.app"], fileActive: false, cause: nil)
        check(d.awake && d.reason == "While X is open", "app session")
        d = s4.decide(now: t0, runningIds: [], fileActive: false, cause: nil)
        check(!d.awake && d.expired == "X quit.", "app session ends when app quits")
        s4.startForFile(path: "/tmp/a.crdownload", name: "a")
        d = s4.decide(now: t0, runningIds: [], fileActive: false, cause: nil)
        check(!d.awake && d.expired == "a finished downloading.", "file session ends")

        // Triggers and switching off during one
        let s5 = Session()
        d = s5.decide(now: t0, runningIds: [], fileActive: false, cause: "Auto: audio is playing")
        check(d.awake && d.reason == "Auto: audio is playing", "trigger holds awake")
        s5.setPower(false, now: t0)
        d = s5.decide(now: t0, runningIds: [], fileActive: false, cause: "Auto: audio is playing")
        check(!d.awake && d.paused == "audio is playing", "switched off: paused until cause goes")
        d = s5.decide(now: t0, runningIds: [], fileActive: false, cause: nil)
        d = s5.decide(now: t0, runningIds: [], fileActive: false, cause: "Auto: audio is playing")
        check(d.awake, "trigger works again after its cause went away")

        // Clock times
        let noon = Calendar.current.date(bySettingHour: 12, minute: 0, second: 0, of: Date())!.timeIntervalSince1970 * 1000
        check(nextClockTime(hour: 13, minute: 0, now: noon) == noon + 3_600_000, "until later today")
        check(nextClockTime(hour: 11, minute: 0, now: noon) > noon + 22 * 3_600_000, "until tomorrow")

        // Settings validation
        let st = Settings()
        st.load(["mode": "system", "screensaver": "nope", "knob": 2, "durationIndex": CUSTOM_INDEX, "custom": ["kind": "for", "minutes": 5000],
                 "autoApps": 1, "hotkey": false, "cpuPercent": 200, "endBattery": 20, "schedDays": [1, 7, 7],
                 "trigDrives": ["/Volumes/A", "/etc/passwd"], "aliveDrives": ["/Volumes/B"],
                 "watched": [["id": "/Applications/Y.app", "name": "Y"], ["id": "relative.app", "name": "Z"]]])
        check(st.mode == "system" && st.screensaver == "allow", "choices validated")
        check(st.custom == nil && st.durationIndex == 0, "bad custom rejected, SET index needs custom")
        check(st.autoApps == false && st.hotkey == false, "booleans must be booleans")
        check(st.cpuPercent == 40 && st.endBattery == 20, "ranges validated")
        check(st.schedDays == [1, 7], "days de-duplicated")
        check(st.trigDrives.isEmpty && st.aliveDrives == ["/Volumes/B"], "drive paths validated")
        check(st.watched.map { $0.id } == ["/Applications/Y.app"], "watched apps validated")
        check(validAppId("/Applications/../x.app") == nil, "no .. in app ids")
        let round = Settings(); round.load(st.json)
        check(round.mode == st.mode && round.schedDays == st.schedDays && round.aliveDrives == st.aliveDrives, "settings round-trip")

        // Old 10-stop knob settings map to the same length on the finer knob
        let old = Settings(); old.load(["durationIndex": 3])  // was 1 h
        check(DURATION_MINUTES[old.durationIndex] == 60, "old knob 1 h stays 1 h")
        let oldSet = Settings(); oldSet.load(["durationIndex": 10, "custom": ["kind": "for", "minutes": 90]])
        check(oldSet.durationIndex == CUSTOM_INDEX, "old SET stays SET")
        let s6 = Session(); s6.setDuration(1, now: t0); s6.setPower(true, now: t0)
        d = s6.decide(now: t0, runningIds: [], fileActive: false, cause: nil)
        check(d.endsAt == t0 + 5 * 60000 && d.timerFrom == t0, "5-minute stop with countdown start")
        s6.extend(minutes: 5, now: t0 + 60000)
        check(s6.manual?.from == t0, "extending keeps the countdown start")

        // Download names
        check(isPartialDownload("film.mov.crdownload") && isPartialDownload("x.PART") && !isPartialDownload("x.mov"), "partial download names")
        check(parsePmsetSettings(" sleep                1\n displaysleep         10\n") == (1, 10), "pmset parse")

        print(failures == 0 ? "Self-test passed." : "Self-test: \(failures) failure(s).")
        return failures == 0 ? 0 : 1
    }
}
