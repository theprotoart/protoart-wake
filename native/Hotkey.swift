// A system-wide shortcut (⌃⌥⌘W) through Carbon's hot-key service: no Accessibility permission,
// no event tap, nothing running until the keys are pressed.
import Carbon.HIToolbox

final class Hotkey {
    private var ref: EventHotKeyRef? = nil
    private var handler: EventHandlerRef? = nil
    static var action: (() -> Void)? = nil

    func register() {
        if ref != nil { return }
        if handler == nil {
            var spec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
            InstallEventHandler(GetApplicationEventTarget(), { _, _, _ in
                DispatchQueue.main.async { Hotkey.action?() }
                return noErr
            }, 1, &spec, nil, &handler)
        }
        let id = EventHotKeyID(signature: OSType(0x5057_4B31), id: 1) // 'PWK1'
        let mods = UInt32(controlKey | optionKey | cmdKey)
        var r: EventHotKeyRef? = nil
        if RegisterEventHotKey(UInt32(kVK_ANSI_W), mods, id, GetApplicationEventTarget(), 0, &r) == noErr { ref = r }
    }

    func unregister() {
        if let r = ref { UnregisterEventHotKey(r); ref = nil }
    }
}
