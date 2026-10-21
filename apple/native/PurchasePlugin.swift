import Capacitor
import StoreKit

@objc(PurchasePlugin)
public class PurchasePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "PurchasePlugin"
    public let jsName = "Purchase"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "proof", returnType: CAPPluginReturnPromise)
    ]

    @objc func proof(_ call: CAPPluginCall) {
        Task {
            do {
                let result = try await AppTransaction.shared
                // The server checks the signed deviceVerification hash against this id, so the proof counts for this device only.
                guard let device = AppStore.deviceVerificationID else {
                    call.reject("This device has no App Store verification id.")
                    return
                }
                switch result {
                case .verified:
                    call.resolve(["jws": result.jwsRepresentation, "device": device.uuidString.lowercased()])
                case .unverified:
                    call.reject("Apple could not verify this app purchase.")
                }
            } catch {
                call.reject("The app purchase is unavailable. Open the app again when online.", nil, error)
            }
        }
    }
}

class PurchaseViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        guard let bridge else { preconditionFailure("The Capacitor bridge is missing") }
        bridge.registerPluginInstance(PurchasePlugin())
    }
}
