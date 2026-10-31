// ProtoArt Wake (native). A menu-bar app: no Dock icon, no main window.
import AppKit

if CommandLine.arguments.contains("--self-test") { exit(SelfTest.run()) }

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
