import AppKit
import Foundation
import SafariServices
import ServiceManagement
import SwiftUI

private let safariExtensionIdentifier = "dev.landed.connector.SafariExtension"

struct AssistTab: Codable, Identifiable, Hashable {
    let id: Int
    let title: String
    let url: String
    let active: Bool
}

struct AssistResume: Codable, Identifiable, Hashable {
    let id: String
    let name: String
    let isCurrent: Bool
    let createdAt: String

    enum CodingKeys: String, CodingKey {
        case id, name
        case isCurrent = "is_current"
        case createdAt = "created_at"
    }
}

struct AssistResult: Codable, Hashable {
    let commandId: String
    let completedAt: String
    let filled: Int
    let review: Int
    let failed: Int
    let summary: String

    enum CodingKeys: String, CodingKey {
        case filled, review, failed, summary
        case commandId = "command_id"
        case completedAt = "completed_at"
    }
}

struct AssistSession: Codable, Identifiable, Hashable {
    let sessionId: String
    let browser: String
    let tabs: [AssistTab]
    let resumes: [AssistResume]
    let connectedAt: String
    let lastSeen: String
    let ollamaReady: Bool
    let ollamaModel: String?
    let lastResult: AssistResult?

    var id: String { sessionId }

    enum CodingKeys: String, CodingKey {
        case browser, tabs, resumes
        case sessionId = "session_id"
        case connectedAt = "connected_at"
        case lastSeen = "last_seen"
        case ollamaReady = "ollama_ready"
        case ollamaModel = "ollama_model"
        case lastResult = "last_result"
    }
}

struct FillCommand: Codable {
    let type = "assist_fill"
    let commandId: String
    let sessionId: String
    let tabIds: [Int]
    let resumeId: String

    enum CodingKeys: String, CodingKey {
        case type
        case commandId = "command_id"
        case sessionId = "session_id"
        case tabIds = "tab_ids"
        case resumeId = "resume_id"
    }
}

@MainActor
final class AssistModel: NSObject, ObservableObject {
    @Published var sessions: [AssistSession] = []
    @Published var selectedTabs: Set<String> = []
    @Published var selectedResumeId = ""
    @Published var notice = ""

    private var timer: Timer?
    private var didChooseDefaults = false
    private var lastSafariWake = Date.distantPast

    override init() {
        super.init()
        reload()
        timer = Timer.scheduledTimer(timeInterval: 1.0, target: self, selector: #selector(tick), userInfo: nil, repeats: true)
        wakeSafari()
    }

    deinit { timer?.invalidate() }

    private var landedHome: URL {
        FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".landed", isDirectory: true)
    }

    private var sessionsDirectory: URL {
        landedHome.appendingPathComponent("apply-assist/sessions", isDirectory: true)
    }

    private var commandsDirectory: URL {
        landedHome.appendingPathComponent("apply-assist/commands", isDirectory: true)
    }

    @objc private func tick() {
        reload()
        if Date().timeIntervalSince(lastSafariWake) >= 10 { wakeSafari() }
    }

    private func wakeSafari(userInfo: [String: String]? = nil) {
        lastSafariWake = Date()
        SFSafariApplication.dispatchMessage(
            withName: "landed_apply_assist",
            toExtensionWithIdentifier: safariExtensionIdentifier,
            userInfo: userInfo,
            completionHandler: nil
        )
    }

    func reload() {
        let decoder = JSONDecoder()
        let now = Date()
        let iso = ISO8601DateFormatter()
        let urls = (try? FileManager.default.contentsOfDirectory(
            at: sessionsDirectory,
            includingPropertiesForKeys: nil,
            options: [.skipsHiddenFiles]
        )) ?? []
        let next = urls.compactMap { url -> AssistSession? in
            guard url.pathExtension == "json",
                  let data = try? Data(contentsOf: url),
                  let session = try? decoder.decode(AssistSession.self, from: data),
                  let seen = iso.date(from: session.lastSeen),
                  now.timeIntervalSince(seen) < 15 else { return nil }
            return session
        }.sorted { $0.browser.localizedCaseInsensitiveCompare($1.browser) == .orderedAscending }
        sessions = next

        let validKeys = Set(next.flatMap { session in session.tabs.map { tabKey(session.sessionId, $0.id) } })
        selectedTabs = selectedTabs.intersection(validKeys)
        if !didChooseDefaults && !next.isEmpty {
            selectedTabs = Set(next.compactMap { session in
                guard let tab = session.tabs.first(where: { $0.active }) ?? session.tabs.first else { return nil }
                return tabKey(session.sessionId, tab.id)
            }.prefix(5))
            didChooseDefaults = true
        }

        let ids = Set(resumes.map(\.id))
        if selectedResumeId.isEmpty || !ids.contains(selectedResumeId) {
            selectedResumeId = resumes.first(where: { $0.isCurrent })?.id ?? resumes.first?.id ?? ""
        }
    }

    var resumes: [AssistResume] {
        var seen = Set<String>()
        return sessions.flatMap(\.resumes)
            .filter { seen.insert($0.id).inserted }
            .sorted {
                if $0.isCurrent != $1.isCurrent { return $0.isCurrent }
                return $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending
            }
    }

    var aiLabel: String {
        let ready = sessions.first(where: { $0.ollamaReady })
        if let ready { return "Local AI · \(ready.ollamaModel ?? "Ollama")" }
        return sessions.isEmpty ? "Waiting for a browser" : "Rules only · Ollama unavailable"
    }

    var latestResult: AssistResult? {
        let iso = ISO8601DateFormatter()
        return sessions.compactMap(\.lastResult).max {
            (iso.date(from: $0.completedAt) ?? .distantPast) < (iso.date(from: $1.completedAt) ?? .distantPast)
        }
    }

    func key(sessionId: String, tabId: Int) -> String { tabKey(sessionId, tabId) }

    func isSelected(sessionId: String, tabId: Int) -> Bool {
        selectedTabs.contains(tabKey(sessionId, tabId))
    }

    func setSelected(_ selected: Bool, sessionId: String, tabId: Int) {
        let key = tabKey(sessionId, tabId)
        if selected {
            guard selectedTabs.count < 5 else {
                notice = "Choose up to five pages at a time."
                return
            }
            selectedTabs.insert(key)
        } else {
            selectedTabs.remove(key)
        }
    }

    func fillSelected() {
        guard !selectedTabs.isEmpty else {
            notice = "Choose at least one application page."
            return
        }
        guard !selectedResumeId.isEmpty else {
            notice = "Open the Landed web app once so the browser extension can receive your resumes."
            return
        }
        do {
            try FileManager.default.createDirectory(at: commandsDirectory, withIntermediateDirectories: true)
            try? FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: commandsDirectory.path)
            var sent = 0
            var unavailable = 0
            for session in sessions {
                let ids = session.tabs
                    .filter { selectedTabs.contains(tabKey(session.sessionId, $0.id)) }
                    .map(\.id)
                if ids.isEmpty { continue }
                guard session.resumes.contains(where: { $0.id == selectedResumeId }) else {
                    unavailable += ids.count
                    continue
                }
                let command = FillCommand(
                    commandId: UUID().uuidString.lowercased(),
                    sessionId: session.sessionId,
                    tabIds: Array(ids.prefix(5)),
                    resumeId: selectedResumeId
                )
                let data = try JSONEncoder().encode(command)
                let file = commandsDirectory.appendingPathComponent("\(command.commandId).json")
                try data.write(to: file, options: .atomic)
                try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
                if session.browser == "Safari" {
                    wakeSafari(userInfo: ["session_id": session.sessionId, "command_id": command.commandId])
                }
                sent += ids.count
            }
            if sent == 0 {
                notice = unavailable > 0 ? "That resume is not available in the selected browser profile." : "No connected browser received the request."
            } else {
                notice = "Filling \(sent) page\(sent == 1 ? "" : "s")… Review yellow fields, then submit yourself."
            }
        } catch {
            notice = "Could not send the fill request: \(error.localizedDescription)"
        }
    }

    func revealExtension() {
        let extensionURL = landedHome.appendingPathComponent("extension", isDirectory: true)
        NSWorkspace.shared.activateFileViewerSelecting([extensionURL])
    }

    func openSafariExtensionPreferences() {
        SFSafariApplication.showPreferencesForExtension(
            withIdentifier: safariExtensionIdentifier,
            completionHandler: nil
        )
    }

    func openLanded() {
        let configURL = landedHome.appendingPathComponent("config.json")
        guard let data = try? Data(contentsOf: configURL),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let raw = object["server"] as? String,
              let url = URL(string: raw) else { return }
        NSWorkspace.shared.open(url)
    }

    private func tabKey(_ sessionId: String, _ tabId: Int) -> String { "\(sessionId)|\(tabId)" }
}

struct LandedMenuView: View {
    @ObservedObject var model: AssistModel
    let quit: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 9) {
                LandedMark(size: 24)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Landed Apply Assist").font(.headline)
                    Text(model.aiLabel).font(.caption).foregroundStyle(model.sessions.contains(where: { $0.ollamaReady }) ? .green : .secondary)
                }
                Spacer()
                Text("\(model.selectedTabs.count)/5")
                    .font(.caption.monospacedDigit()).foregroundStyle(.secondary)
            }

            Divider()

            if model.sessions.isEmpty {
                VStack(alignment: .leading, spacing: 10) {
                    Label("No browser pages available", systemImage: "safari")
                        .font(.subheadline.weight(.semibold))
                    Text("Safari local build: enable Develop → Allow Unsigned Extensions, then turn on Landed in Safari Settings → Extensions. For Chrome, Brave, or Edge, load the bundled extension folder once.")
                        .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                    HStack {
                        Button("Open Safari Extension Settings") { model.openSafariExtensionPreferences() }
                        Button("Chromium Extension Folder") { model.revealExtension() }
                    }
                }
                .padding(12)
                .background(Color(nsColor: .controlBackgroundColor))
                .clipShape(RoundedRectangle(cornerRadius: 9))
            } else {
                Text("Application pages").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 12) {
                        ForEach(model.sessions) { session in
                            VStack(alignment: .leading, spacing: 6) {
                                HStack {
                                    Text(session.browser).font(.caption.weight(.semibold))
                                    Spacer()
                                    Text("\(session.tabs.count) pages").font(.caption2).foregroundStyle(.secondary)
                                }
                                ForEach(session.tabs) { tab in
                                    Toggle(isOn: Binding(
                                        get: { model.isSelected(sessionId: session.sessionId, tabId: tab.id) },
                                        set: { model.setSelected($0, sessionId: session.sessionId, tabId: tab.id) }
                                    )) {
                                        VStack(alignment: .leading, spacing: 1) {
                                            Text(tab.title).font(.system(size: 12)).lineLimit(1)
                                            Text(URL(string: tab.url)?.host ?? tab.url)
                                                .font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                                        }
                                    }
                                    .toggleStyle(.checkbox)
                                }
                            }
                        }
                    }
                }
                .frame(maxHeight: 250)

                HStack {
                    Text("Resume").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                    Spacer()
                    Picker("Resume", selection: $model.selectedResumeId) {
                        ForEach(model.resumes) { resume in
                            Text(resume.isCurrent ? "\(resume.name) · current" : resume.name).tag(resume.id)
                        }
                    }
                    .labelsHidden().frame(maxWidth: 240)
                }

                Button(action: model.fillSelected) {
                    HStack {
                        Spacer()
                        Text(model.selectedTabs.count > 1 ? "Fill \(model.selectedTabs.count) pages" : "Fill selected page")
                        Image(systemName: "arrow.right")
                        Spacer()
                    }
                }
                .buttonStyle(.borderedProminent)
                .disabled(model.selectedTabs.isEmpty || model.selectedResumeId.isEmpty)
            }

            if !model.notice.isEmpty {
                Text(model.notice).font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
            if let result = model.latestResult {
                Label(result.summary, systemImage: result.failed > 0 ? "exclamationmark.circle" : "checkmark.circle.fill")
                    .font(.caption)
                    .foregroundStyle(result.failed > 0 ? .orange : .green)
            }

            Divider()
            HStack {
                Button("Open Landed") { model.openLanded() }
                Button("Safari Extension") { model.openSafariExtensionPreferences() }
                Button("Chromium Extension") { model.revealExtension() }
                Spacer()
                Button("Quit") { quit() }
            }
            .font(.caption)
        }
        .padding(16)
        .frame(width: 410, height: 560, alignment: .top)
    }
}

/// The product mark shared with the web app: Landed's geometric L and
/// arrival dot. It intentionally follows the current macOS foreground color
/// while the dot keeps the brand accent in both light and dark appearances.
struct LandedMark: View {
    let size: CGFloat

    var body: some View {
        Canvas { context, canvasSize in
            let scale = min(canvasSize.width, canvasSize.height) / 24
            func point(_ x: CGFloat, _ y: CGFloat) -> CGPoint {
                CGPoint(x: x * scale, y: y * scale)
            }

            var letter = Path()
            letter.move(to: point(7, 5.5))
            letter.addLine(to: point(10, 5.5))
            letter.addLine(to: point(10, 15.5))
            letter.addLine(to: point(17, 15.5))
            letter.addLine(to: point(17, 18.5))
            letter.addLine(to: point(7, 18.5))
            letter.closeSubpath()
            context.fill(letter, with: .foreground)

            let dot = CGRect(x: 16 * scale, y: 5 * scale, width: 4 * scale, height: 4 * scale)
            context.fill(Path(ellipseIn: dot), with: .color(Color(red: 0.89, green: 0.31, blue: 0.27)))
        }
        .frame(width: size, height: size)
        .accessibilityLabel("Landed")
    }
}

private func landedStatusImage() -> NSImage {
    let image = NSImage(size: NSSize(width: 18, height: 18), flipped: false) { bounds in
        let scale = min(bounds.width, bounds.height) / 24
        func point(_ x: CGFloat, _ y: CGFloat) -> NSPoint {
            NSPoint(x: x * scale, y: (24 - y) * scale)
        }

        let letter = NSBezierPath()
        letter.move(to: point(7, 5.5))
        letter.line(to: point(10, 5.5))
        letter.line(to: point(10, 15.5))
        letter.line(to: point(17, 15.5))
        letter.line(to: point(17, 18.5))
        letter.line(to: point(7, 18.5))
        letter.close()
        NSColor.labelColor.setFill()
        letter.fill()

        NSColor(red: 0.89, green: 0.31, blue: 0.27, alpha: 1).setFill()
        NSBezierPath(ovalIn: NSRect(x: 16 * scale, y: 15 * scale, width: 4 * scale, height: 4 * scale)).fill()
        return true
    }
    // A template would make the red arrival dot monochrome.
    image.isTemplate = false
    image.accessibilityDescription = "Landed"
    return image
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    private let statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
    private let popover = NSPopover()
    private let model = AssistModel()

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        if let button = statusItem.button {
            button.image = landedStatusImage()
            button.toolTip = "Landed Apply Assist"
            button.target = self
            button.action = #selector(togglePopover)
        }
        popover.behavior = .transient
        popover.contentSize = NSSize(width: 410, height: 560)
        popover.contentViewController = NSHostingController(rootView: LandedMenuView(model: model) {
            NSApp.terminate(nil)
        })
        installBackgroundComponents()
        if #available(macOS 13.0, *) {
            try? SMAppService.mainApp.register()
        }
        // A first launch should be visible, not another silent installer.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { [weak self] in self?.showPopover() }
    }

    func application(_ application: NSApplication, open urls: [URL]) {
        for url in urls where url.scheme == "landed" {
            runDaemon(["open-url", url.absoluteString])
        }
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        showPopover()
        return true
    }

    @objc private func togglePopover() {
        if popover.isShown { popover.performClose(nil) } else { showPopover() }
    }

    private func showPopover() {
        guard let button = statusItem.button else { return }
        model.reload()
        popover.show(relativeTo: button.bounds, of: button, preferredEdge: .minY)
        NSApp.activate(ignoringOtherApps: true)
    }

    private func installBackgroundComponents() {
        runDaemon(["setup"])
    }

    private func runDaemon(_ arguments: [String]) {
        guard let daemon = Bundle.main.resourceURL?.appendingPathComponent("landed-daemon.mjs"),
              FileManager.default.fileExists(atPath: daemon.path) else { return }
        let escaped = "'" + daemon.path.replacingOccurrences(of: "'", with: "'\"'\"'") + "'"
        let escapedArguments = arguments.map { "'" + $0.replacingOccurrences(of: "'", with: "'\"'\"'") + "'" }.joined(separator: " ")
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/zsh")
        process.arguments = ["-lc", "export PATH=\"$PATH:/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin\"; exec node \(escaped) \(escapedArguments)"]
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        try? process.run()
    }
}

@main
struct LandedMenuBarApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate

    var body: some Scene {
        Settings { EmptyView() }
    }
}
