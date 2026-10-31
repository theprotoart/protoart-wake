// The tube-amp panel: the same HTML/CSS panel as before, shown in the Mac's built-in web view
// (WKWebView). It only exists while it is open; a little after it closes the web view is released,
// so a Wake sitting in the menu bar holds no web engine at all.
import AppKit
import WebKit

final class PanelWindow: NSPanel {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }
}

/** Transparent strip over the brand plate and the tube: drags the panel while it is pinned. */
final class DragOverlay: NSView {
    var rects: [NSRect] = []   // CSS pixels, from the top-left
    var enabled = false
    override var isFlipped: Bool { true }
    override func hitTest(_ point: NSPoint) -> NSView? {
        guard enabled, let sv = superview else { return nil }
        let p = convert(point, from: sv)
        return rects.contains(where: { $0.contains(p) }) ? self : nil
    }
    override func mouseDown(with event: NSEvent) { window?.performDrag(with: event) }
    override func resetCursorRects() { if enabled { for r in rects { addCursorRect(r, cursor: .openHand) } } }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}

/** Breaks the WKUserContentController → handler retain cycle. */
final class WeakHandler: NSObject, WKScriptMessageHandler {
    weak var target: PanelController?
    init(_ t: PanelController) { target = t }
    func userContentController(_ c: WKUserContentController, didReceive message: WKScriptMessage) {
        target?.received(message)
    }
}

private let SHIM = """
(() => {
  'use strict';
  const h = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.wake;
  if (!h) return;
  const post = (cmd, arg) => h.postMessage({ cmd, arg: arg === undefined ? null : arg });
  let stateCb = null, menuCb = null, last = null;
  const pending = [];
  window.__wakeState = s => { last = s; if (stateCb) stateCb(s); };
  window.__wakeMenu = c => { if (menuCb) menuCb(c); else pending.push(c); };
  window.wake = Object.freeze({
    onState: cb => { stateCb = cb; if (last) cb(last); },
    set: p => post('set', p),
    toggleApp: id => post('toggle-app', id),
    startApp: id => post('start-app', id),
    pickFile: () => post('pick-file'),
    pickDrive: which => post('pick-drive', which),
    onMenu: cb => { menuCb = cb; pending.splice(0).forEach(c => cb(c)); },
    lightsOut: () => post('lights-out'),
    extend: m => post('extend', m),
    resetStats: () => post('reset-stats'),
    sheet: open => post('sheet', !!open),
    quit: () => post('quit'),
    native: true,
  });
  const report = () => {
    const r = [...document.querySelectorAll('#brand, #tube-window')].map(e => { const b = e.getBoundingClientRect(); return [b.left, b.top, b.width, b.height]; });
    post('drag-rects', r);
  };
  addEventListener('load', () => { report(); post('ready'); });
})();
"""

final class PanelController: NSObject, WKNavigationDelegate, NSWindowDelegate {
    static let W: CGFloat = 440, H: CGFloat = 772
    private(set) var window: PanelWindow? = nil
    private var web: WKWebView? = nil
    private var overlay: DragOverlay? = nil
    private var teardown: DispatchWorkItem? = nil
    private var loaded = false
    private var sheetOpen = false
    private var pendingMenu: String? = nil
    private var shownAt = Date.distantPast
    unowned let core: Core

    init(core: Core) { self.core = core }

    var isOpen: Bool { window?.isVisible == true }

    private var rendererDir: URL { Bundle.main.resourceURL!.appendingPathComponent("renderer", isDirectory: true) }

    private func build() {
        let win = PanelWindow(contentRect: NSRect(x: 0, y: 0, width: Self.W, height: Self.H),
                              styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: true)
        win.isOpaque = false
        win.backgroundColor = .clear
        win.hasShadow = true
        win.hidesOnDeactivate = false
        win.isReleasedWhenClosed = false
        win.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .ignoresCycle]
        win.delegate = self

        let cfg = WKWebViewConfiguration()
        let ucc = WKUserContentController()
        ucc.add(WeakHandler(self), name: "wake")
        ucc.addUserScript(WKUserScript(source: SHIM, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        cfg.userContentController = ucc
        cfg.websiteDataStore = .nonPersistent()
        cfg.suppressesIncrementalRendering = true
        let web = WKWebView(frame: NSRect(x: 0, y: 0, width: Self.W, height: Self.H), configuration: cfg)
        web.setValue(false, forKey: "drawsBackground")
        if #available(macOS 12.0, *) { web.underPageBackgroundColor = .clear }
        web.navigationDelegate = self
        web.allowsMagnification = false
        web.allowsBackForwardNavigationGestures = false

        let content = NSView(frame: NSRect(x: 0, y: 0, width: Self.W, height: Self.H))
        content.wantsLayer = true
        content.layer?.backgroundColor = NSColor.clear.cgColor
        web.autoresizingMask = [.width, .height]
        content.addSubview(web)
        let ov = DragOverlay(frame: content.bounds)
        ov.autoresizingMask = [.width, .height]
        content.addSubview(ov)
        win.contentView = content

        self.window = win; self.web = web; self.overlay = ov
        loaded = false
        web.loadFileURL(rendererDir.appendingPathComponent("index.html"), allowingReadAccessTo: rendererDir)
        applyPin()
    }

    /** Releases the window and its web view (and with it the web content process). */
    private func destroy() {
        web?.configuration.userContentController.removeScriptMessageHandler(forName: "wake")
        web?.navigationDelegate = nil
        web?.removeFromSuperview()
        window?.delegate = nil
        window?.close()
        web = nil; window = nil; overlay = nil; loaded = false; sheetOpen = false
    }

    // ------------------------------------------------------------------ Showing and hiding

    func show(menu: String? = nil) {
        teardown?.cancel(); teardown = nil
        if window == nil { build() }
        guard let win = window else { return }
        if let m = menu { if loaded { sendMenu(m) } else { pendingMenu = m } }
        if let p = pinnedOrigin() { win.setFrameOrigin(p) }
        else if let f = core.statusButtonFrame() {
            let screen = NSScreen.screens.first(where: { $0.frame.contains(NSPoint(x: f.midX, y: f.midY)) }) ?? NSScreen.main
            let area = screen?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
            let x = min(max(f.midX - Self.W / 2, area.minX + 6), area.maxX - Self.W - 6)
            let top = min(f.minY - 6, area.maxY - 6)
            win.setFrameOrigin(NSPoint(x: x.rounded(), y: max(area.minY + 6, top - Self.H).rounded()))
        } else {
            win.center()
        }
        shownAt = Date()
        NSApp.activate(ignoringOtherApps: true) // a menu-bar app isn't active: make the panel key so clicks land
        win.makeKeyAndOrderFront(nil)
        core.panelOpened()
    }

    func hide() {
        guard let win = window, win.isVisible else { return }
        win.orderOut(nil)
        let item = DispatchWorkItem { [weak self] in self?.destroy() }
        teardown = item
        DispatchQueue.main.asyncAfter(deadline: .now() + 20, execute: item) // reopening soon stays instant
    }

    func toggle() { if isOpen { hide() } else { show() } }

    func windowDidResignKey(_ notification: Notification) {
        // Close like a menu when you click elsewhere (but not in the instant it's being opened).
        if !core.settings.pinned && Date().timeIntervalSince(shownAt) > 0.4 { hide() }
    }

    func windowDidMove(_ notification: Notification) {
        guard core.settings.pinned, let win = window else { return }
        let primary = NSScreen.screens.first?.frame.height ?? win.frame.maxY
        core.settings.pinX = Int(win.frame.minX.rounded())
        core.settings.pinY = Int((primary - win.frame.maxY).rounded()) // stored from the top, as before
        core.saveSoon()
    }

    /** Pinned: floats on top, stays open and can be dragged. Unpinned: a menu-bar drop-down. */
    func applyPin() {
        guard let win = window else { return }
        let pinned = core.settings.pinned
        win.level = pinned ? .floating : .popUpMenu
        overlay?.enabled = pinned && !sheetOpen
        if let ov = overlay { ov.window?.invalidateCursorRects(for: ov) }
        if pinned && win.isVisible { windowDidMove(Notification(name: NSWindow.didMoveNotification)) }
    }

    /** The saved pinned position, if it's still on a connected display. */
    private func pinnedOrigin() -> NSPoint? {
        let s = core.settings
        guard s.pinned, let px = s.pinX, let py = s.pinY else { return nil }
        let primary = NSScreen.screens.first?.frame.height ?? 900
        let origin = NSPoint(x: CGFloat(px), y: primary - CGFloat(py) - Self.H)
        let topLeft = NSPoint(x: origin.x + 40, y: origin.y + Self.H - 10)
        return NSScreen.screens.contains(where: { $0.visibleFrame.insetBy(dx: -10, dy: -10).contains(topLeft) }) ? origin : nil
    }

    // ------------------------------------------------------------------ Talking to the page

    func push(_ state: [String: Any]) {
        guard isOpen, loaded, let web = web,
              let data = try? JSONSerialization.data(withJSONObject: state), let json = String(data: data, encoding: .utf8) else { return }
        web.evaluateJavaScript("window.__wakeState && window.__wakeState(\(json))", completionHandler: nil)
    }

    private func sendMenu(_ cmd: String) {
        guard ["custom", "about", "setup"].contains(cmd) else { return }
        web?.evaluateJavaScript("window.__wakeMenu && window.__wakeMenu('\(cmd)')", completionHandler: nil)
    }

    func received(_ message: WKScriptMessage) {
        guard message.frameInfo.isMainFrame,
              message.frameInfo.request.url?.isFileURL == true,
              let body = message.body as? [String: Any], let cmd = body["cmd"] as? String else { return }
        let arg = body["arg"]
        switch cmd {
        case "ready":
            loaded = true
            core.pushState()
            if let m = pendingMenu { pendingMenu = nil; sendMenu(m) }
        case "sheet":
            sheetOpen = (arg as? Bool) ?? false
            overlay?.enabled = core.settings.pinned && !sheetOpen
            if let ov = overlay { ov.window?.invalidateCursorRects(for: ov) }
        case "drag-rects":
            let list = (arg as? [[Any]]) ?? []
            overlay?.rects = list.prefix(8).compactMap { r in
                let n = r.compactMap { ($0 as? NSNumber)?.doubleValue }
                return n.count == 4 ? NSRect(x: n[0], y: n[1], width: n[2], height: n[3]) : nil
            }
            if let ov = overlay { ov.window?.invalidateCursorRects(for: ov) }
        default:
            core.fromPanel(cmd, arg)
        }
    }

    // Only our own panel files load here; links and anything else are refused.
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        let url = action.request.url
        let ok = url?.isFileURL == true && url!.standardizedFileURL.path.hasPrefix(rendererDir.standardizedFileURL.path + "/")
        decisionHandler(ok ? .allow : .cancel)
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        loaded = false
        webView.loadFileURL(rendererDir.appendingPathComponent("index.html"), allowingReadAccessTo: rendererDir)
    }
}
