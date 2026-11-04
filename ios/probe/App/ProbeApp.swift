import NetworkExtension
import SwiftUI

@main
struct ProbeApp: App {
    var body: some Scene { WindowGroup { ContentView() } }
}

// Every step of starting the tunnel is written down, so a screenshot tells where a missing entitlement stops it.
@MainActor
final class Probe: ObservableObject {
    @Published var status = "Не подключено"
    @Published var log: [String] = []
    private var manager: NETunnelProviderManager?
    private var observer: NSObjectProtocol?

    private func note(_ text: String) { log.append(text) }
    private func describe(_ error: Error) -> String {
        let e = error as NSError
        return "\(e.localizedDescription) [\(e.domain) \(e.code)]"
    }

    // Sideloadly may rename bundle IDs, so the extension's own ID is read from the embedded bundle.
    private var tunnelID: String? {
        Bundle.main.builtInPlugInsURL.flatMap { Bundle(url: $0.appendingPathComponent("Tunnel.appex"))?.bundleIdentifier }
    }

    func connect() async {
        log = []
        guard let id = tunnelID else { note("Ошибка: в приложении нет расширения Tunnel.appex"); return }
        note("Расширение: \(id)")
        do {
            note("Загружаем профили VPN…")
            let managers = try await NETunnelProviderManager.loadAllFromPreferences()
            let m = managers.first ?? NETunnelProviderManager()
            let proto = NETunnelProviderProtocol()
            proto.providerBundleIdentifier = id
            proto.serverAddress = "JOXY test"
            m.protocolConfiguration = proto
            m.localizedDescription = "JOXY test"
            m.isEnabled = true
            note("Сохраняем профиль VPN (iOS спросит разрешение)…")
            try await m.saveToPreferences()
            try await m.loadFromPreferences()
            manager = m
            watch(m)
            note("Запускаем туннель…")
            try m.connection.startVPNTunnel()
        } catch {
            note("Ошибка: \(describe(error))")
        }
    }

    func disconnect() { manager?.connection.stopVPNTunnel() }

    private func watch(_ m: NETunnelProviderManager) {
        if let observer { NotificationCenter.default.removeObserver(observer) }
        observer = NotificationCenter.default.addObserver(forName: .NEVPNStatusDidChange, object: m.connection, queue: .main) { [weak self] _ in
            Task { @MainActor in self?.changed(m.connection) }
        }
        changed(m.connection)
    }

    private func changed(_ connection: NEVPNConnection) {
        let names: [NEVPNStatus: String] = [.invalid: "Профиль недействителен", .disconnected: "Не подключено", .connecting: "Подключение…", .connected: "Подключено", .reasserting: "Переподключение…", .disconnecting: "Отключение…"]
        status = names[connection.status] ?? "Неизвестно"
        note("Статус: \(status)")
        if connection.status == .disconnected {
            connection.fetchLastDisconnectError { [weak self] error in
                guard let error else { return }
                Task { @MainActor in self?.note("Причина отключения: \(self?.describe(error) ?? "")") }
            }
        }
    }
}

struct ContentView: View {
    @StateObject private var probe = Probe()
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("JOXY test").font(.largeTitle.bold())
            Text("Проверка: запускается ли VPN-туннель при подписи бесплатным Apple ID. Интернет через туннель не идёт.")
                .font(.footnote).foregroundStyle(.secondary)
            Text(probe.status).font(.title2.weight(.semibold))
            HStack {
                Button("Подключить") { Task { await probe.connect() } }.buttonStyle(.borderedProminent)
                Button("Отключить") { probe.disconnect() }.buttonStyle(.bordered)
            }
            ScrollView {
                VStack(alignment: .leading, spacing: 6) {
                    ForEach(Array(probe.log.enumerated()), id: \.offset) { Text($0.element).font(.system(.footnote, design: .monospaced)) }
                }.frame(maxWidth: .infinity, alignment: .leading)
            }
        }.padding()
    }
}
