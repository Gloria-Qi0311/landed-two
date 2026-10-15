import Foundation
import SafariServices

/// Safari owns this process. It relays Web Extension native messages to the
/// loopback-only Landed daemon, which shares the same validated bridge logic
/// as Chromium without granting the extension filesystem access.
final class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling {
    private let endpoint = URL(string: "http://127.0.0.1:17841/safari-bridge")!

    func beginRequest(with context: NSExtensionContext) {
        let item = context.inputItems.first as? NSExtensionItem
        let message: Any?
        if #available(macOS 11.0, *) {
            message = item?.userInfo?[SFExtensionMessageKey]
        } else {
            message = item?.userInfo?["message"]
        }
        guard let message, JSONSerialization.isValidJSONObject(message),
              let body = try? JSONSerialization.data(withJSONObject: message) else {
            complete(context, with: ["ok": false, "error": "Invalid Landed message"])
            return
        }

        var request = URLRequest(url: endpoint)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = body
        request.timeoutInterval = 65
        URLSession.shared.dataTask(with: request) { data, response, error in
            let result: Any
            if let data,
               let http = response as? HTTPURLResponse,
               http.statusCode == 200,
               let decoded = try? JSONSerialization.jsonObject(with: data) {
                result = decoded
            } else {
                result = [
                    "ok": false,
                    "error": error?.localizedDescription ?? "Landed is not running",
                ]
            }
            self.complete(context, with: result)
        }.resume()
    }

    private func complete(_ context: NSExtensionContext, with message: Any) {
        let response = NSExtensionItem()
        if #available(macOS 11.0, *) {
            response.userInfo = [SFExtensionMessageKey: message]
        } else {
            response.userInfo = ["message": message]
        }
        context.completeRequest(returningItems: [response], completionHandler: nil)
    }
}
