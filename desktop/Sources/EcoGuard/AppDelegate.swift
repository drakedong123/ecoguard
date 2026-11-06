import AppKit
import EcoGuardCore

final class AppDelegate: NSObject, NSApplicationDelegate {
    private var statusItem: NSStatusItem?

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        item.button?.image = NSImage(systemSymbolName: "leaf", accessibilityDescription: "EcoGuard")
        item.button?.toolTip = "EcoGuard foundation build"

        let menu = NSMenu()
        menu.addItem(label("EcoGuard \(BuildInfo().version)"))
        menu.addItem(label("Foundation ready"))
        menu.addItem(label("Automatic cleanup is not available yet"))
        menu.addItem(.separator())
        let about = NSMenuItem(title: "About EcoGuard…", action: #selector(showAbout), keyEquivalent: "")
        about.target = self; menu.addItem(about)
        let quit = NSMenuItem(title: "Quit EcoGuard", action: #selector(quitApp), keyEquivalent: "q")
        quit.target = self; menu.addItem(quit)
        item.menu = menu; statusItem = item
    }

    private func label(_ text: String) -> NSMenuItem {
        let item = NSMenuItem(title: text, action: nil, keyEquivalent: "")
        item.isEnabled = false
        return item
    }

    @objc private func showAbout() {
        let alert = NSAlert()
        alert.messageText = "EcoGuard \(BuildInfo().version)"
        alert.informativeText = "The native app and build foundation are ready. Resource monitoring and process actions will arrive in later milestones. This build does not inspect or change other apps."
        alert.addButton(withTitle: "OK")
        NSApp.activate(ignoringOtherApps: true)
        alert.runModal()
    }

    @objc private func quitApp() { NSApp.terminate(nil) }
}
