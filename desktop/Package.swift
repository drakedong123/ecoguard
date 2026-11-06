// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "EcoGuard",
    platforms: [.macOS(.v13)],
    products: [.executable(name: "EcoGuard", targets: ["EcoGuard"])],
    dependencies: [],
    targets: [
        .target(name: "EcoGuardCore"),
        .executableTarget(
            name: "EcoGuard",
            dependencies: ["EcoGuardCore"],
            linkerSettings: [.linkedFramework("AppKit")]
        )
    ]
)
