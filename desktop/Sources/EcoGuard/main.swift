import AppKit
import EcoGuardCore
import Darwin

let arguments = Array(CommandLine.arguments.dropFirst())

if arguments == ["--status"] {
    do { print(String(decoding: try BuildInfo().json(), as: UTF8.self)); exit(0) }
    catch { fputs("EcoGuard could not encode its status.\n", stderr); exit(1) }
}

if arguments == ["--help"] {
    print("""
    Usage: EcoGuard [--status | --help]
      No arguments   Launch the menu bar app.
      --status       Print build capabilities as JSON without starting the GUI.
      --help         Show this message.

    Foundation build: no monitoring, cleanup or process actions.
    """)
    exit(0)
}

guard arguments.isEmpty else {
    fputs("Unknown arguments. Use EcoGuard --help.\n", stderr)
    exit(2)
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.run()
