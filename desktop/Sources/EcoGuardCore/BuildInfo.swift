import Foundation

public struct BuildInfo: Encodable {
    public let name = "EcoGuard"
    public let version = "0.1.0"
    public let milestone = "Repository and build foundation"
    public let minimumMacOS = "13.0"
    public let automaticCleanupAvailable = false
    public let processActionsAvailable = false
    public let externalDependencies: [String] = []

    public init() {}

    public func json() throws -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        return try encoder.encode(self)
    }
}
