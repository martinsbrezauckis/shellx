import AppKit
import ApplicationServices
import CryptoKit
import Foundation
import Darwin

let requestSchema = "shellx/release-surface-macos-native-input-helper-request@5"
let responseSchema = "shellx/release-surface-macos-native-input-helper-response@6"
let maxInputBytes = 256 * 1024

struct Rect: Codable {
    let left: Double
    let top: Double
    let width: Double
    let height: Double

    init(_ rect: CGRect) {
        left = rect.origin.x
        top = rect.origin.y
        width = rect.size.width
        height = rect.size.height
    }

    var cgRect: CGRect {
        CGRect(x: left, y: top, width: width, height: height)
    }

    var valid: Bool {
        [left, top, width, height].allSatisfy(
            { $0.isFinite }
        ) && width > 0 && height > 0
    }
}

struct CandidateRequest: Codable {
    let processId: Int32
    let executablePath: String
    let executableSha256: String
    let expectedWindowTitle: String
}

struct TargetRequest: Codable {
    let windowNumber: Int?
    let viewportWidth: Double
    let viewportHeight: Double
    let rect: Rect
}

struct HelperRequest: Codable {
    let schema: String
    let action: String
    let candidate: CandidateRequest
    let target: TargetRequest?
    let destinationTarget: TargetRequest?
    let text: String?
    let replaceAll: Bool?
    let keys: [String]?
    let accessibilityLabel: String?
    let ownedRootPath: String?
    let pickerPath: String?
    let pickerKind: String?
    let promptText: String?
    let promptResponseText: String?
}

struct CandidateResponse: Codable {
    let processId: Int32
    let executableSha256: String
    let pathMatched: Bool
}

struct PermissionResponse: Codable {
    let accessibilityTrusted: Bool
    let eventPostingTrusted: Bool
    let promptRequested: Bool
}

struct WindowResponse: Codable {
    let number: Int
    let ownerProcessId: Int32
    let titleSha256: String
    let bounds: Rect
    let webAreaBounds: Rect
    let webAreaSource: String
}

struct MappingResponse: Codable {
    let valid: Bool
    let screenX: Double
    let screenY: Double
}

struct EffectResponse: Codable {
    let applicationActivated: Bool
    let eventsPosted: Int
}

struct PickerResponse: Codable {
    let role: String
    let titleSha256: String
    let pathSha256: String
    let kind: String
    let rootVerified: Bool
    let dialogOwnedByCandidate: Bool
}

struct PromptResponse: Codable {
    let role: String
    let promptTextSha256: String
    let responseTextSha256: String
    let dialogOwnedByCandidate: Bool
}

struct ErrorResponse: Codable {
    let code: String
    let message: String
}

struct HelperResponse: Codable {
    let schema: String
    let ok: Bool
    let action: String
    let status: String
    let candidate: CandidateResponse?
    let permissions: PermissionResponse?
    let window: WindowResponse?
    let mapping: MappingResponse?
    let destinationMapping: MappingResponse?
    let effect: EffectResponse?
    let picker: PickerResponse?
    let prompt: PromptResponse?
    let error: ErrorResponse?
}

struct BoundProcess {
    let application: NSRunningApplication
    let candidate: CandidateResponse
}

struct BoundWindow {
    let number: Int
    let ownerProcessId: Int32
    let title: String
    let bounds: CGRect
    let webAreaBounds: CGRect
    let webAreaSource: String
    let accessibilityElement: AXUIElement
}

struct BoundRecoveryButton {
    let element: AXUIElement
    let rect: CGRect
}

struct BoundPicker {
    let role: String
    let title: String
}

struct BoundPrompt {
    let role: String
    let dialog: AXUIElement
    let textField: AXUIElement
    let confirmButton: AXUIElement
}

struct RunProfileMarker: Decodable {
    let schema: String
    let platform: String
    let runId: String
    let launchPath: String
}

struct HelperFailure: Error {
    let code: String
    let message: String
}

func fail(_ code: String, _ message: String) -> HelperFailure {
    HelperFailure(code: code, message: message)
}

func sha256(_ value: String) -> String {
    let digest = SHA256.hash(data: Data(value.utf8))
    return digest.map { String(format: "%02x", $0) }.joined()
}

func sha256File(_ path: String) throws -> String {
    let handle = try FileHandle(forReadingFrom: URL(fileURLWithPath: path))
    defer { try? handle.close() }
    var hasher = SHA256()
    while true {
        guard let chunk = try handle.read(upToCount: 1024 * 1024), !chunk.isEmpty else { break }
        hasher.update(data: chunk)
    }
    return hasher.finalize().map { String(format: "%02x", $0) }.joined()
}

func canonicalPath(_ path: String) -> String {
    URL(fileURLWithPath: path).resolvingSymlinksInPath().standardizedFileURL.path
}

func bindProcess(_ request: CandidateRequest) throws -> BoundProcess {
    guard request.processId > 0 else { throw fail("INVALID_CANDIDATE", "candidate process id must be positive") }
    guard request.executablePath.hasPrefix("/"), request.executablePath.utf8.count <= 4_096,
          !request.executablePath.contains("\0") else {
        throw fail("INVALID_CANDIDATE", "candidate executable path must be a bounded absolute path")
    }
    guard request.executableSha256.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil else {
        throw fail("INVALID_CANDIDATE", "candidate executable hash is invalid")
    }
    guard !request.expectedWindowTitle.isEmpty, request.expectedWindowTitle.utf8.count <= 256,
          !request.expectedWindowTitle.contains("\n"), !request.expectedWindowTitle.contains("\r"),
          !request.expectedWindowTitle.contains("\0") else {
        throw fail("INVALID_CANDIDATE", "candidate window title must be a bounded single-line string")
    }
    guard let application = NSRunningApplication(processIdentifier: pid_t(request.processId)), !application.isTerminated else {
        throw fail("PROCESS_NOT_RUNNING", "the exact candidate process is not running")
    }
    guard let executableURL = application.executableURL else {
        throw fail("PROCESS_PATH_UNAVAILABLE", "the exact candidate process has no executable URL")
    }
    let actualPath = canonicalPath(executableURL.path)
    let expectedPath = canonicalPath(request.executablePath)
    guard actualPath == expectedPath else {
        throw fail("PROCESS_PATH_MISMATCH", "the running process image path does not match the frozen candidate")
    }
    let actualHash = try sha256File(actualPath)
    guard actualHash == request.executableSha256 else {
        throw fail("PROCESS_HASH_MISMATCH", "the running process image hash does not match the frozen candidate")
    }
    return BoundProcess(
        application: application,
        candidate: CandidateResponse(
            processId: request.processId,
            executableSha256: actualHash,
            pathMatched: true
        )
    )
}

func cgWindows(for request: CandidateRequest) throws -> [(number: Int, bounds: CGRect)] {
    guard let rows = CGWindowListCopyWindowInfo(
        [.optionOnScreenOnly, .excludeDesktopElements],
        kCGNullWindowID
    ) as? [[String: Any]] else {
        throw fail("WINDOW_LIST_UNAVAILABLE", "CoreGraphics did not return an on-screen window list")
    }
    let candidates = rows.compactMap { row -> (Int, CGRect)? in
        guard let pid = row[kCGWindowOwnerPID as String] as? Int,
              pid == Int(request.processId),
              let layer = row[kCGWindowLayer as String] as? Int,
              layer == 0,
              let number = row[kCGWindowNumber as String] as? Int,
              let boundsObject = row[kCGWindowBounds as String] as? NSDictionary,
              let bounds = CGRect(dictionaryRepresentation: boundsObject as CFDictionary)
        else { return nil }
        return (number, bounds)
    }
    guard !candidates.isEmpty else {
        throw fail("WINDOW_NOT_FOUND", "no on-screen window belongs to the exact candidate process")
    }
    return candidates
}

func axAttribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success else { return nil }
    return value
}

func axString(_ element: AXUIElement, _ name: String) -> String? {
    axAttribute(element, name) as? String
}

func axValueAttribute(_ element: AXUIElement, _ name: String) -> AXValue? {
    guard let value = axAttribute(element, name),
          CFGetTypeID(value) == AXValueGetTypeID() else { return nil }
    return unsafeBitCast(value, to: AXValue.self)
}

func axElementAttribute(_ element: AXUIElement, _ name: String) -> AXUIElement? {
    guard let value = axAttribute(element, name),
          CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
    return unsafeBitCast(value, to: AXUIElement.self)
}

func axRect(_ element: AXUIElement) -> CGRect? {
    guard let positionValue = axValueAttribute(element, kAXPositionAttribute),
          let sizeValue = axValueAttribute(element, kAXSizeAttribute),
          AXValueGetType(positionValue) == .cgPoint,
          AXValueGetType(sizeValue) == .cgSize
    else { return nil }
    var position = CGPoint.zero
    var size = CGSize.zero
    guard AXValueGetValue(positionValue, .cgPoint, &position),
          AXValueGetValue(sizeValue, .cgSize, &size)
    else { return nil }
    return CGRect(origin: position, size: size)
}

func axChildren(_ element: AXUIElement) -> [AXUIElement] {
    axAttribute(element, kAXChildrenAttribute) as? [AXUIElement] ?? []
}

func findWebArea(_ root: AXUIElement, depth: Int = 0, remaining: inout Int) -> AXUIElement? {
    guard depth <= 12, remaining > 0 else { return nil }
    remaining -= 1
    if axString(root, kAXRoleAttribute) == "AXWebArea", let rect = axRect(root), rect.width > 0, rect.height > 0 {
        return root
    }
    for child in axChildren(root) {
        if let found = findWebArea(child, depth: depth + 1, remaining: &remaining) { return found }
    }
    return nil
}

func bindWindow(_ request: CandidateRequest, target: TargetRequest?) throws -> BoundWindow {
    let cgCandidates = try cgWindows(for: request)
    let applicationElement = AXUIElementCreateApplication(pid_t(request.processId))
    guard let windows = axAttribute(applicationElement, kAXWindowsAttribute) as? [AXUIElement] else {
        throw fail("AX_WINDOW_UNAVAILABLE", "Accessibility did not expose candidate windows")
    }
    let matchingAxWindows = windows.filter { window in
        axString(window, kAXTitleAttribute) == request.expectedWindowTitle
    }
    guard matchingAxWindows.count == 1, let axWindow = matchingAxWindows.first,
          let axWindowBounds = axRect(axWindow) else {
        throw fail("AX_WINDOW_UNAVAILABLE", "Accessibility did not expose the exact candidate window")
    }
    var matchingCgCandidates = cgCandidates
    if let expectedNumber = target?.windowNumber {
        matchingCgCandidates = cgCandidates.filter { $0.number == expectedNumber }
    }
    let exactCgCandidates = matchingCgCandidates.filter { rectDistance($0.bounds, axWindowBounds) <= 4 }
    guard exactCgCandidates.count == 1, let cg = exactCgCandidates.first else {
        throw fail("WINDOW_IDENTITY_MISMATCH", "Accessibility and CoreGraphics did not identify the same candidate window")
    }
    var remaining = 4_096
    let accessibleWebAreaBounds = findWebArea(axWindow, remaining: &remaining).flatMap(axRect)
    let webArea: (bounds: CGRect, source: String)
    if let accessibleWebAreaBounds {
        webArea = (accessibleWebAreaBounds, "ax-web-area")
    } else {
        guard let target else {
            throw fail("AX_WEB_AREA_UNAVAILABLE", "Accessibility did not expose the candidate WebView content area and no renderer viewport was bound")
        }
        let fullWindowGroups = axChildren(axWindow).compactMap { child -> CGRect? in
            guard axString(child, kAXRoleAttribute) == "AXGroup",
                  let bounds = axRect(child),
                  rectDistance(bounds, axWindowBounds) <= 4 else { return nil }
            return bounds
        }
        guard fullWindowGroups.count == 1,
              target.viewportWidth.isFinite,
              target.viewportHeight.isFinite,
              target.viewportWidth > 0,
              target.viewportHeight > 0 else {
            throw fail("AX_WEB_AREA_UNAVAILABLE", "Accessibility exposed neither a WebView area nor one exact full-window renderer host")
        }
        let widthDelta = axWindowBounds.width - target.viewportWidth
        let heightDelta = axWindowBounds.height - target.viewportHeight
        guard widthDelta >= -0.5, widthDelta <= 8,
              heightDelta >= -0.5, heightDelta <= 128 else {
            throw fail("RENDERER_VIEWPORT_MISMATCH", "the exact renderer viewport is not congruent with the candidate window")
        }
        let inferredBounds = CGRect(
            x: axWindowBounds.minX + max(0, widthDelta) / 2,
            y: axWindowBounds.maxY - target.viewportHeight,
            width: target.viewportWidth,
            height: target.viewportHeight
        )
        webArea = (inferredBounds, "renderer-window-content")
    }
    let webAreaBounds = webArea.bounds
    guard axWindowBounds.insetBy(dx: -4, dy: -4).contains(webAreaBounds) else {
        throw fail("AX_WEB_AREA_MISMATCH", "the candidate WebView content area escaped its exact Accessibility window")
    }
    return BoundWindow(
        number: cg.number,
        ownerProcessId: request.processId,
        title: request.expectedWindowTitle,
        bounds: cg.bounds,
        webAreaBounds: webAreaBounds,
        webAreaSource: webArea.source,
        accessibilityElement: axWindow
    )
}

func focusBoundWindow(_ candidate: CandidateRequest, _ window: BoundWindow) throws {
    let applicationElement = AXUIElementCreateApplication(pid_t(candidate.processId))
    _ = AXUIElementSetAttributeValue(
        applicationElement,
        kAXFocusedWindowAttribute as CFString,
        window.accessibilityElement
    )
    let raised = AXUIElementPerformAction(window.accessibilityElement, kAXRaiseAction as CFString)
    guard raised == .success else {
        throw fail("WINDOW_FOCUS_FAILED", "Accessibility could not raise the exact candidate window")
    }
    Thread.sleep(forTimeInterval: 0.08)
    guard let focused = axElementAttribute(applicationElement, kAXFocusedWindowAttribute),
          axString(focused, kAXTitleAttribute) == window.title,
          let focusedBounds = axRect(focused),
          rectDistance(focusedBounds, window.bounds) <= 4 else {
        throw fail("WINDOW_FOCUS_FAILED", "the exact candidate window did not become focused")
    }
}

func hasRole(_ root: AXUIElement, role: String, depth: Int = 0, remaining: inout Int) -> Bool {
    guard depth <= 12, remaining > 0 else { return false }
    remaining -= 1
    if axString(root, kAXRoleAttribute) == role { return true }
    for child in axChildren(root) {
        if hasRole(child, role: role, depth: depth + 1, remaining: &remaining) { return true }
    }
    return false
}

func collectPickerElements(
    _ root: AXUIElement,
    depth: Int = 0,
    remaining: inout Int,
    into matches: inout [AXUIElement]
) {
    guard depth <= 12, remaining > 0 else { return }
    remaining -= 1
    let role = axString(root, kAXRoleAttribute) ?? ""
    if role == "AXSheet" || role == "AXDialog" {
        matches.append(root)
        return
    }
    for child in axChildren(root) {
        collectPickerElements(child, depth: depth + 1, remaining: &remaining, into: &matches)
    }
}

func bindPicker(_ request: CandidateRequest) throws -> BoundPicker {
    let applicationElement = AXUIElementCreateApplication(pid_t(request.processId))
    guard let focusedWindow = axElementAttribute(applicationElement, kAXFocusedWindowAttribute) else {
        throw fail("PICKER_NOT_FOCUSED", "the exact candidate process has no focused native picker window")
    }
    var remaining = 4_096
    var matches: [AXUIElement] = []
    collectPickerElements(focusedWindow, remaining: &remaining, into: &matches)
    if matches.isEmpty {
        let role = axString(focusedWindow, kAXRoleAttribute) ?? ""
        let title = axString(focusedWindow, kAXTitleAttribute) ?? ""
        var webAreaBudget = 4_096
        let containsWebArea = hasRole(focusedWindow, role: "AXWebArea", remaining: &webAreaBudget)
        if role == "AXWindow" && title != request.expectedWindowTitle && !containsWebArea {
            matches = [focusedWindow]
        }
    }
    guard matches.count == 1, let picker = matches.first else {
        throw fail("PICKER_IDENTITY_MISMATCH", "Accessibility did not expose exactly one candidate-owned native picker")
    }
    let role = axString(picker, kAXRoleAttribute) ?? ""
    guard role == "AXSheet" || role == "AXDialog" || role == "AXWindow" else {
        throw fail("PICKER_ROLE_MISMATCH", "the focused candidate-owned surface is not an allowlisted native picker role")
    }
    var webAreaBudget = 4_096
    guard !hasRole(picker, role: "AXWebArea", remaining: &webAreaBudget) else {
        throw fail("PICKER_WEB_CONTENT_REFUSED", "the candidate picker unexpectedly contains renderer web content")
    }
    return BoundPicker(role: role, title: axString(picker, kAXTitleAttribute) ?? "")
}

func collectElements(
    _ root: AXUIElement,
    roles: Set<String>,
    depth: Int = 0,
    remaining: inout Int,
    into matches: inout [AXUIElement]
) {
    guard depth <= 12, remaining > 0 else { return }
    remaining -= 1
    if roles.contains(axString(root, kAXRoleAttribute) ?? "") { matches.append(root) }
    for child in axChildren(root) {
        collectElements(child, roles: roles, depth: depth + 1, remaining: &remaining, into: &matches)
    }
}

func bindExactRecoveryButton(_ window: BoundWindow, label: String) throws -> BoundRecoveryButton {
    guard label == "Reset UI" || label == "Reload window" else {
        throw fail("ACCESSIBILITY_BUTTON_REFUSED", "the requested Accessibility button is outside the exact renderer-recovery allowlist")
    }
    var budget = 4_096
    var buttons: [AXUIElement] = []
    collectElements(window.accessibilityElement, roles: ["AXButton"], remaining: &budget, into: &buttons)
    let matches = buttons.filter { button in
        [kAXTitleAttribute, kAXDescriptionAttribute, kAXValueAttribute].contains { attribute in
            axString(button, attribute) == label
        }
    }
    guard matches.count == 1, let button = matches.first, let rect = axRect(button),
          rect.width > 0, rect.height > 0,
          window.bounds.insetBy(dx: -2, dy: -2).contains(rect),
          window.webAreaBounds.insetBy(dx: -2, dy: -2).contains(rect) else {
        throw fail("ACCESSIBILITY_BUTTON_MISMATCH", "Accessibility did not expose exactly one bounded candidate-owned renderer-recovery button")
    }
    return BoundRecoveryButton(element: button, rect: rect)
}

func containsExactAccessibilityText(_ root: AXUIElement, expected: String) -> Bool {
    var remaining = 4_096
    var stack: [(AXUIElement, Int)] = [(root, 0)]
    while let (element, depth) = stack.popLast(), remaining > 0 {
        remaining -= 1
        for attribute in [kAXTitleAttribute, kAXValueAttribute, kAXDescriptionAttribute, kAXHelpAttribute] {
            if axString(element, attribute) == expected { return true }
        }
        if depth < 12 {
            for child in axChildren(element) { stack.append((child, depth + 1)) }
        }
    }
    return false
}

func matchingPromptSurfaces(_ request: CandidateRequest, expectedText: String) throws -> [AXUIElement] {
    let applicationElement = AXUIElementCreateApplication(pid_t(request.processId))
    guard let focusedWindow = axElementAttribute(applicationElement, kAXFocusedWindowAttribute) else {
        throw fail("PROMPT_NOT_FOCUSED", "the exact candidate process has no focused prompt window")
    }
    var remaining = 4_096
    var dialogs: [AXUIElement] = []
    collectElements(focusedWindow, roles: ["AXSheet", "AXDialog"], remaining: &remaining, into: &dialogs)
    if dialogs.isEmpty {
        let role = axString(focusedWindow, kAXRoleAttribute) ?? ""
        let title = axString(focusedWindow, kAXTitleAttribute) ?? ""
        var webAreaBudget = 4_096
        let containsWebArea = hasRole(focusedWindow, role: "AXWebArea", remaining: &webAreaBudget)
        if role == "AXWindow" && title != request.expectedWindowTitle && !containsWebArea {
            dialogs = [focusedWindow]
        }
    }
    return dialogs.filter { containsExactAccessibilityText($0, expected: expectedText) }
}

func bindPrompt(_ request: CandidateRequest, expectedText: String) throws -> BoundPrompt {
    let matches = try matchingPromptSurfaces(request, expectedText: expectedText)
    guard matches.count == 1, let dialog = matches.first else {
        throw fail("PROMPT_IDENTITY_MISMATCH", "Accessibility did not expose exactly one candidate-owned prompt with the exact expected text")
    }
    let role = axString(dialog, kAXRoleAttribute) ?? ""
    guard role == "AXSheet" || role == "AXDialog" || role == "AXWindow" else {
        throw fail("PROMPT_ROLE_MISMATCH", "the exact candidate-owned prompt has a non-allowlisted role")
    }
    var webAreaBudget = 4_096
    guard !hasRole(dialog, role: "AXWebArea", remaining: &webAreaBudget) else {
        throw fail("PROMPT_WEB_CONTENT_REFUSED", "the candidate prompt unexpectedly contains renderer web content")
    }
    var fieldBudget = 4_096
    var fields: [AXUIElement] = []
    collectElements(dialog, roles: ["AXTextField", "AXTextArea"], remaining: &fieldBudget, into: &fields)
    guard fields.count == 1, let textField = fields.first else {
        throw fail("PROMPT_FIELD_MISMATCH", "the exact candidate prompt did not expose one response field")
    }
    var buttonBudget = 4_096
    var buttons: [AXUIElement] = []
    collectElements(dialog, roles: ["AXButton"], remaining: &buttonBudget, into: &buttons)
    let defaultButton = axElementAttribute(dialog, kAXDefaultButtonAttribute)
    let titledButtons = buttons.filter {
        let title = (axString($0, kAXTitleAttribute) ?? "").lowercased()
        return title == "ok" || title == "submit"
    }
    guard let confirmButton = defaultButton ?? (titledButtons.count == 1 ? titledButtons.first : nil),
          let dialogRect = axRect(dialog), let fieldRect = axRect(textField), let buttonRect = axRect(confirmButton),
          fieldRect.width > 0, fieldRect.height > 0, buttonRect.width > 0, buttonRect.height > 0,
          dialogRect.insetBy(dx: -2, dy: -2).contains(fieldRect),
          dialogRect.insetBy(dx: -2, dy: -2).contains(buttonRect) else {
        throw fail("PROMPT_CONTROL_MISMATCH", "the exact candidate prompt did not expose one bounded response field and default action")
    }
    return BoundPrompt(role: role, dialog: dialog, textField: textField, confirmButton: confirmButton)
}

func standardizedPath(_ path: String) -> String {
    URL(fileURLWithPath: path).standardizedFileURL.path
}

func fileMode(_ path: String) throws -> mode_t {
    var info = stat()
    guard lstat(path, &info) == 0 else {
        throw fail("PICKER_PATH_MISSING", "the exact owned picker path does not exist")
    }
    return info.st_mode & mode_t(S_IFMT)
}

func regularFileSize(_ path: String) throws -> off_t {
    var info = stat()
    guard lstat(path, &info) == 0, (info.st_mode & mode_t(S_IFMT)) == mode_t(S_IFREG) else {
        throw fail("PICKER_PATH_MISSING", "the exact owned picker marker is not a regular file")
    }
    return info.st_size
}

func validateOwnedPickerPath(rootPath: String, pickerPath: String, kind: String) throws {
    guard rootPath.hasPrefix("/"), pickerPath.hasPrefix("/"),
          rootPath.utf8.count <= 4_096, pickerPath.utf8.count <= 4_096,
          !rootPath.contains("\0"), !pickerPath.contains("\0"),
          standardizedPath(rootPath) == rootPath, standardizedPath(pickerPath) == pickerPath,
          canonicalPath(rootPath) == rootPath, canonicalPath(pickerPath) == pickerPath else {
        throw fail("INVALID_PICKER_PATH", "picker paths must be bounded absolute canonical non-symlink paths")
    }
    let rootName = URL(fileURLWithPath: rootPath).lastPathComponent
    guard let runId = rootName.range(
        of: "^shellx-final-webdriver-([a-f0-9]{16,64})$",
        options: .regularExpression
    ).map({ _ in String(rootName.dropFirst("shellx-final-webdriver-".count)) }) else {
        throw fail("INVALID_PICKER_ROOT", "picker root is not an isolated final-run profile")
    }
    guard try fileMode(rootPath) == mode_t(S_IFDIR) else {
        throw fail("INVALID_PICKER_ROOT", "picker root is not a regular directory")
    }
    let markerPath = rootPath + "/shellx-final-profile.json"
    guard try fileMode(markerPath) == mode_t(S_IFREG) else {
        throw fail("INVALID_PICKER_ROOT", "picker root has no regular run-profile marker")
    }
    let markerSize = try regularFileSize(markerPath)
    guard markerSize > 0, markerSize <= 16_384 else {
        throw fail("INVALID_PICKER_ROOT", "picker root run-profile marker exceeds its bounded size")
    }
    let marker = try JSONDecoder().decode(
        RunProfileMarker.self,
        from: Data(contentsOf: URL(fileURLWithPath: markerPath))
    )
    guard marker.schema == "shellx/release-surface-run-profile@1",
          marker.platform == "macos-installed",
          marker.runId == runId,
          marker.launchPath == rootPath else {
        throw fail("INVALID_PICKER_ROOT", "picker root marker does not match the exact macOS final-run profile")
    }
    guard pickerPath.hasPrefix(rootPath + "/") else {
        throw fail("PICKER_PATH_OUTSIDE_ROOT", "picker path escaped the isolated final-run profile")
    }
    let relativePath = String(pickerPath.dropFirst(rootPath.count + 1))
    let components = relativePath.split(separator: "/", omittingEmptySubsequences: false).map(String.init)
    guard components.count == 2,
          components[0].range(of: "^release-native-picker-[a-f0-9]{16}$", options: .regularExpression) != nil,
          components[1] == (kind == "file" ? "attached.txt" : "selected-folder") else {
        throw fail("PICKER_PATH_OUTSIDE_FIXTURE", "picker path is outside the exact release-owned fixture shape")
    }
    guard try fileMode(rootPath + "/" + components[0]) == mode_t(S_IFDIR) else {
        throw fail("INVALID_PICKER_ROOT", "picker fixture owner is not a regular directory")
    }
    let mode = try fileMode(pickerPath)
    guard (kind == "file" && mode == mode_t(S_IFREG))
            || (kind == "directory" && mode == mode_t(S_IFDIR)) else {
        throw fail("PICKER_KIND_MISMATCH", "picker path type does not match the exact requested kind")
    }
}

func rectDistance(_ left: CGRect, _ right: CGRect) -> Double {
    [
        abs(left.minX - right.minX),
        abs(left.minY - right.minY),
        abs(left.width - right.width),
        abs(left.height - right.height)
    ].max() ?? Double.infinity
}

func mapTarget(_ target: TargetRequest, _ window: BoundWindow) throws -> CGPoint {
    guard target.viewportWidth.isFinite, target.viewportWidth > 0,
          target.viewportHeight.isFinite, target.viewportHeight > 0,
          target.rect.valid,
          target.rect.left >= 0,
          target.rect.top >= 0,
          target.rect.left + target.rect.width <= target.viewportWidth + 0.5,
          target.rect.top + target.rect.height <= target.viewportHeight + 0.5
    else {
        throw fail("INVALID_TARGET", "the renderer target is outside its declared viewport")
    }
    let scaleX = window.webAreaBounds.width / target.viewportWidth
    let scaleY = window.webAreaBounds.height / target.viewportHeight
    guard scaleX.isFinite, scaleY.isFinite, scaleX > 0, scaleY > 0 else {
        throw fail("INVALID_MAPPING", "the candidate WebView mapping scale is invalid")
    }
    let x = window.webAreaBounds.minX + (target.rect.left + target.rect.width / 2) * scaleX
    let y = window.webAreaBounds.minY + (target.rect.top + target.rect.height / 2) * scaleY
    guard window.webAreaBounds.contains(CGPoint(x: x, y: y)) else {
        throw fail("INVALID_MAPPING", "the mapped target center escaped the candidate WebView")
    }
    return CGPoint(x: x, y: y)
}

func postMouseClick(at point: CGPoint) throws -> Int {
    guard let down = CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: point, mouseButton: .left),
          let up = CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: point, mouseButton: .left)
    else { throw fail("EVENT_CREATE_FAILED", "CoreGraphics could not create a mouse event pair") }
    // WKWebView can report a successful AXPress on its web area without
    // delivering a DOM click. The caller binds the point to the candidate
    // window and verifies that candidate is frontmost immediately beforehand.
    down.post(tap: .cghidEventTap)
    Thread.sleep(forTimeInterval: 0.025)
    up.post(tap: .cghidEventTap)
    return 2
}

func postContextClick(at point: CGPoint) throws -> Int {
    guard let down = CGEvent(mouseEventSource: nil, mouseType: .rightMouseDown, mouseCursorPosition: point, mouseButton: .right),
          let up = CGEvent(mouseEventSource: nil, mouseType: .rightMouseUp, mouseCursorPosition: point, mouseButton: .right)
    else { throw fail("EVENT_CREATE_FAILED", "CoreGraphics could not create a context-click event pair") }
    down.post(tap: .cghidEventTap)
    Thread.sleep(forTimeInterval: 0.025)
    up.post(tap: .cghidEventTap)
    return 2
}

func postMouseDrag(from source: CGPoint, to destination: CGPoint) throws -> Int {
    guard let down = CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: source, mouseButton: .left),
          let up = CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: destination, mouseButton: .left)
    else { throw fail("EVENT_CREATE_FAILED", "CoreGraphics could not create a drag event pair") }
    down.post(tap: .cghidEventTap)
    for step in 1...6 {
        let fraction = Double(step) / 6.0
        let point = CGPoint(
            x: source.x + (destination.x - source.x) * fraction,
            y: source.y + (destination.y - source.y) * fraction
        )
        guard let moved = CGEvent(mouseEventSource: nil, mouseType: .leftMouseDragged, mouseCursorPosition: point, mouseButton: .left)
        else { throw fail("EVENT_CREATE_FAILED", "CoreGraphics could not create a bounded drag movement") }
        moved.post(tap: .cghidEventTap)
        Thread.sleep(forTimeInterval: 0.025)
    }
    up.post(tap: .cghidEventTap)
    return 8
}

func postKey(processId: Int32, code: CGKeyCode, flags: CGEventFlags = []) throws -> Int {
    guard let down = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: true),
          let up = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: false)
    else { throw fail("EVENT_CREATE_FAILED", "CoreGraphics could not create a keyboard event pair") }
    down.flags = flags
    up.flags = flags
    down.postToPid(pid_t(processId))
    Thread.sleep(forTimeInterval: 0.025)
    up.postToPid(pid_t(processId))
    return 2
}

func postUnicode(processId: Int32, _ text: String) throws -> Int {
    guard text.utf16.count <= 65_536 else { throw fail("TEXT_TOO_LARGE", "text exceeds 65536 UTF-16 code units") }
    guard let down = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true),
          let up = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: false)
    else { throw fail("EVENT_CREATE_FAILED", "CoreGraphics could not create Unicode keyboard events") }
    var characters = Array(text.utf16)
    characters.withUnsafeMutableBufferPointer { buffer in
        guard let base = buffer.baseAddress else { return }
        down.keyboardSetUnicodeString(stringLength: buffer.count, unicodeString: base)
        up.keyboardSetUnicodeString(stringLength: buffer.count, unicodeString: base)
    }
    down.postToPid(pid_t(processId))
    Thread.sleep(forTimeInterval: 0.025)
    up.postToPid(pid_t(processId))
    return 2
}

func keyCode(_ key: String) -> (CGKeyCode, CGEventFlags)? {
    let table: [String: CGKeyCode] = [
        "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7,
        "c": 8, "v": 9, "b": 11, "q": 12, "w": 13, "e": 14, "r": 15,
        "y": 16, "t": 17, "1": 18, "2": 19, "3": 20, "4": 21, "6": 22,
        "5": 23, "=": 24, "9": 25, "7": 26, "-": 27, "8": 28, "0": 29,
        "]": 30, "o": 31, "u": 32, "[": 33, "i": 34, "p": 35, "return": 36,
        "l": 37, "j": 38, "'": 39, "k": 40, ";": 41, "\\": 42, ",": 43,
        "/": 44, "n": 45, "m": 46, ".": 47, "tab": 48, "space": 49,
        "`": 50, "delete": 51, "escape": 53, "left": 123, "right": 124,
        "down": 125, "up": 126,
    ]
    if key == "?", let slash = table["/"] { return (slash, .maskShift) }
    guard let code = table[key.lowercased()] else { return nil }
    return (code, [])
}

func postKeyChord(processId: Int32, _ keys: [String]) throws -> Int {
    guard !keys.isEmpty, keys.count <= 8 else { throw fail("INVALID_KEY_CHORD", "key chord must contain one to eight keys") }
    var flags: CGEventFlags = []
    var target: String?
    for raw in keys {
        switch raw.lowercased() {
        case "meta", "command", "\u{e03d}": flags.insert(.maskCommand)
        case "shift", "\u{e008}": flags.insert(.maskShift)
        case "alt", "option", "\u{e00a}": flags.insert(.maskAlternate)
        case "control", "ctrl", "\u{e009}": flags.insert(.maskControl)
        case "\u{e004}": target = "tab"
        case "\u{e006}": target = "return"
        case "\u{e00c}": target = "escape"
        default:
            if target != nil { throw fail("INVALID_KEY_CHORD", "key chord contains more than one non-modifier key") }
            target = raw
        }
    }
    guard let target, let mapped = keyCode(target) else {
        throw fail("UNSUPPORTED_KEY", "key chord target is not in the bounded release key map")
    }
    flags.formUnion(mapped.1)
    return try postKey(processId: processId, code: mapped.0, flags: flags)
}

func emit(_ response: HelperResponse, exitCode: Int32) -> Never {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys]
    let data = (try? encoder.encode(response)) ?? Data("{\"schema\":\"shellx/release-surface-macos-native-input-helper-response@6\",\"ok\":false,\"action\":\"preflight\",\"status\":\"failed\"}".utf8)
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data([0x0a]))
    exit(exitCode)
}

func readBoundedStdin() throws -> Data {
    var input = Data()
    while true {
        let chunk = FileHandle.standardInput.availableData
        if chunk.isEmpty { break }
        input.append(chunk)
        if input.count > maxInputBytes { throw fail("REQUEST_TOO_LARGE", "helper JSON request exceeds 256 KiB") }
    }
    return input
}

var action = "preflight"
do {
    let data = try readBoundedStdin()
    let decoder = JSONDecoder()
    let request = try decoder.decode(HelperRequest.self, from: data)
    action = request.action
    guard request.schema == requestSchema else { throw fail("INVALID_SCHEMA", "helper request schema mismatch") }
    guard ["preflight", "click", "contextClick", "drag", "typeText", "clear", "keyChord", "clickAccessibilityButton", "selectPickerPath", "submitPrompt"].contains(request.action) else {
        throw fail("INVALID_ACTION", "unsupported bounded native-input action")
    }
    if request.action == "selectPickerPath" {
        guard let rootPath = request.ownedRootPath,
              let pickerPath = request.pickerPath,
              let pickerKind = request.pickerKind,
              pickerKind == "file" || pickerKind == "directory" else {
            throw fail("INVALID_PICKER_REQUEST", "picker selection requires one exact owned root, path, and kind")
        }
        try validateOwnedPickerPath(rootPath: rootPath, pickerPath: pickerPath, kind: pickerKind)
    } else if request.ownedRootPath != nil || request.pickerPath != nil || request.pickerKind != nil {
        throw fail("INVALID_PICKER_REQUEST", "picker fields are forbidden outside the dedicated picker action")
    }
    if request.action == "submitPrompt" {
        guard let promptText = request.promptText,
              let promptResponseText = request.promptResponseText,
              !promptText.isEmpty, promptText.utf8.count <= 4_096, !promptText.contains("\0"),
              !promptResponseText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              promptResponseText.utf8.count <= 4_096, !promptResponseText.contains("\0"),
              request.target == nil else {
            throw fail("INVALID_PROMPT_REQUEST", "prompt submission requires exact bounded prompt and response text without a renderer target")
        }
    } else if request.promptText != nil || request.promptResponseText != nil {
        throw fail("INVALID_PROMPT_REQUEST", "prompt fields are forbidden outside the dedicated prompt action")
    }
    if request.action == "clickAccessibilityButton" {
        guard request.target == nil,
              request.accessibilityLabel == "Reset UI" || request.accessibilityLabel == "Reload window" else {
            throw fail("INVALID_ACCESSIBILITY_BUTTON_REQUEST", "Accessibility button input requires one exact renderer-recovery label without a renderer target")
        }
    } else if request.accessibilityLabel != nil {
        throw fail("INVALID_ACCESSIBILITY_BUTTON_REQUEST", "Accessibility labels are forbidden outside the dedicated button action")
    }
    if request.action == "drag" {
        guard let sourceTarget = request.target, let destinationTarget = request.destinationTarget else {
            throw fail("INVALID_DRAG_REQUEST", "drag requires exact source and destination targets")
        }
        guard sourceTarget.windowNumber == destinationTarget.windowNumber,
              sourceTarget.viewportWidth == destinationTarget.viewportWidth,
              sourceTarget.viewportHeight == destinationTarget.viewportHeight else {
            throw fail("INVALID_DRAG_REQUEST", "drag source and destination must share one stable candidate viewport")
        }
    } else if request.destinationTarget != nil {
        throw fail("INVALID_DRAG_REQUEST", "destination target is forbidden outside the dedicated drag action")
    }
    let boundProcess = try bindProcess(request.candidate)
    let accessibilityTrusted = AXIsProcessTrusted()
    let eventPostingTrusted = CGPreflightPostEventAccess()
    let permissions = PermissionResponse(
        accessibilityTrusted: accessibilityTrusted,
        eventPostingTrusted: eventPostingTrusted,
        promptRequested: false
    )
    guard accessibilityTrusted && eventPostingTrusted else {
        emit(HelperResponse(
            schema: responseSchema,
            ok: false,
            action: request.action,
            status: "blocked",
            candidate: boundProcess.candidate,
            permissions: permissions,
            window: nil,
            mapping: nil,
            destinationMapping: nil,
            effect: EffectResponse(applicationActivated: false, eventsPosted: 0),
            picker: nil,
            prompt: nil,
            error: ErrorResponse(
                code: "ACCESSIBILITY_PERMISSION_REQUIRED",
                message: "Grant Accessibility to this exact helper executable in System Settings, then rerun; the helper never requests or changes permission"
            )
        ), exitCode: 3)
    }
    if request.action == "submitPrompt" {
        guard let expectedText = request.promptText, let responseText = request.promptResponseText else {
            throw fail("INVALID_PROMPT_REQUEST", "prompt payload disappeared after validation")
        }
        guard boundProcess.application.activate() else {
            throw fail("ACTIVATION_FAILED", "the exact candidate application could not be activated")
        }
        Thread.sleep(forTimeInterval: 0.08)
        guard boundProcess.application.isActive,
              NSWorkspace.shared.frontmostApplication?.processIdentifier == request.candidate.processId else {
            throw fail("ACTIVATION_LOST", "the exact candidate was not frontmost immediately before prompt input")
        }
        let prompt = try bindPrompt(request.candidate, expectedText: expectedText)
        guard let fieldRect = axRect(prompt.textField), let buttonRect = axRect(prompt.confirmButton) else {
            throw fail("PROMPT_CONTROL_MISMATCH", "the exact prompt controls lost their bounded geometry")
        }
        var promptEvents = 0
        promptEvents += try postMouseClick(at: CGPoint(x: fieldRect.midX, y: fieldRect.midY))
        promptEvents += try postKey(processId: request.candidate.processId, code: 0, flags: .maskCommand)
        promptEvents += try postUnicode(processId: request.candidate.processId, responseText)
        promptEvents += try postMouseClick(at: CGPoint(x: buttonRect.midX, y: buttonRect.midY))
        let dismissalDeadline = Date().addingTimeInterval(2.0)
        var promptRemains = true
        repeat {
            Thread.sleep(forTimeInterval: 0.04)
            promptRemains = !(try matchingPromptSurfaces(request.candidate, expectedText: expectedText)).isEmpty
        } while promptRemains && Date() < dismissalDeadline
        guard !promptRemains else {
            throw fail("PROMPT_NOT_DISMISSED", "the exact candidate-owned prompt remained after its default action")
        }
        emit(HelperResponse(
            schema: responseSchema,
            ok: true,
            action: request.action,
            status: "applied",
            candidate: boundProcess.candidate,
            permissions: permissions,
            window: nil,
            mapping: nil,
            destinationMapping: nil,
            effect: EffectResponse(applicationActivated: true, eventsPosted: promptEvents),
            picker: nil,
            prompt: PromptResponse(
                role: prompt.role,
                promptTextSha256: sha256(expectedText),
                responseTextSha256: sha256(responseText),
                dialogOwnedByCandidate: true
            ),
            error: nil
        ), exitCode: 0)
    }
    let window = try bindWindow(request.candidate, target: request.target)
    let recoveryButton: BoundRecoveryButton?
    let point: CGPoint?
    if request.action == "clickAccessibilityButton", let label = request.accessibilityLabel {
        recoveryButton = try bindExactRecoveryButton(window, label: label)
        point = recoveryButton.map { CGPoint(x: $0.rect.midX, y: $0.rect.midY) }
    } else if let target = request.target {
        recoveryButton = nil
        point = try mapTarget(target, window)
    } else {
        recoveryButton = nil
        point = nil
    }
    let destinationPoint: CGPoint?
    if let destinationTarget = request.destinationTarget {
        destinationPoint = try mapTarget(destinationTarget, window)
    } else {
        destinationPoint = nil
    }
    let windowResponse = WindowResponse(
        number: window.number,
        ownerProcessId: window.ownerProcessId,
        titleSha256: sha256(window.title),
        bounds: Rect(window.bounds),
        webAreaBounds: Rect(window.webAreaBounds),
        webAreaSource: window.webAreaSource
    )
    let mapping = point.map { MappingResponse(valid: true, screenX: $0.x, screenY: $0.y) }
    let destinationMapping = destinationPoint.map { MappingResponse(valid: true, screenX: $0.x, screenY: $0.y) }
    if request.action == "preflight" {
        guard mapping != nil else { throw fail("TARGET_REQUIRED", "preflight requires one renderer target mapping") }
        emit(HelperResponse(
            schema: responseSchema,
            ok: true,
            action: request.action,
            status: "ready",
            candidate: boundProcess.candidate,
            permissions: permissions,
            window: windowResponse,
            mapping: mapping,
            destinationMapping: nil,
            effect: EffectResponse(applicationActivated: false, eventsPosted: 0),
            picker: nil,
            prompt: nil,
            error: nil
        ), exitCode: 0)
    }

    guard boundProcess.application.activate() else {
        throw fail("ACTIVATION_FAILED", "the exact candidate application could not be activated")
    }
    try focusBoundWindow(request.candidate, window)
    Thread.sleep(forTimeInterval: 0.08)
    guard boundProcess.application.isActive,
          NSWorkspace.shared.frontmostApplication?.processIdentifier == request.candidate.processId else {
        throw fail("ACTIVATION_LOST", "the exact candidate was not frontmost immediately before native input")
    }
    var eventsPosted = 0
    var pickerResponse: PickerResponse? = nil
    switch request.action {
    case "click":
        guard let point else { throw fail("TARGET_REQUIRED", "click requires a mapped renderer target") }
        eventsPosted += try postMouseClick(at: point)
    case "contextClick":
        guard let point else { throw fail("TARGET_REQUIRED", "contextClick requires a mapped renderer target") }
        eventsPosted += try postContextClick(at: point)
    case "drag":
        guard let point, let destinationPoint else { throw fail("TARGET_REQUIRED", "drag requires mapped source and destination targets") }
        eventsPosted += try postMouseDrag(from: point, to: destinationPoint)
    case "typeText":
        guard let point, let text = request.text else { throw fail("TARGET_REQUIRED", "typeText requires a mapped target and text") }
        eventsPosted += try postMouseClick(at: point)
        if request.replaceAll == true {
            eventsPosted += try postKey(processId: request.candidate.processId, code: 0, flags: .maskCommand)
        }
        eventsPosted += try postUnicode(processId: request.candidate.processId, text)
    case "clear":
        guard let point else { throw fail("TARGET_REQUIRED", "clear requires a mapped renderer target") }
        eventsPosted += try postMouseClick(at: point)
        eventsPosted += try postKey(processId: request.candidate.processId, code: 0, flags: .maskCommand)
        eventsPosted += try postKey(processId: request.candidate.processId, code: 51)
    case "keyChord":
        eventsPosted += try postKeyChord(processId: request.candidate.processId, request.keys ?? [])
    case "clickAccessibilityButton":
        guard point != nil, let recoveryButton else {
            throw fail("ACCESSIBILITY_BUTTON_MISMATCH", "the exact renderer-recovery button lost its bounded identity")
        }
        guard AXUIElementPerformAction(recoveryButton.element, kAXPressAction as CFString) == .success else {
            throw fail("ACCESSIBILITY_BUTTON_PRESS_FAILED", "Accessibility could not press the exact candidate-owned renderer-recovery button")
        }
        eventsPosted += 1
    case "selectPickerPath":
        guard let rootPath = request.ownedRootPath,
              let pickerPath = request.pickerPath,
              let pickerKind = request.pickerKind else {
            throw fail("INVALID_PICKER_REQUEST", "picker selection payload disappeared after validation")
        }
        try validateOwnedPickerPath(rootPath: rootPath, pickerPath: pickerPath, kind: pickerKind)
        let picker = try bindPicker(request.candidate)
        eventsPosted += try postKeyChord(processId: request.candidate.processId, ["meta", "shift", "g"])
        Thread.sleep(forTimeInterval: 0.12)
        eventsPosted += try postUnicode(processId: request.candidate.processId, pickerPath)
        eventsPosted += try postKey(processId: request.candidate.processId, code: 36)
        Thread.sleep(forTimeInterval: 0.16)
        eventsPosted += try postKey(processId: request.candidate.processId, code: 36)
        Thread.sleep(forTimeInterval: 0.12)
        pickerResponse = PickerResponse(
            role: picker.role,
            titleSha256: sha256(picker.title),
            pathSha256: sha256(pickerPath),
            kind: pickerKind,
            rootVerified: true,
            dialogOwnedByCandidate: true
        )
    default:
        throw fail("INVALID_ACTION", "unsupported native-input action")
    }
    emit(HelperResponse(
        schema: responseSchema,
        ok: true,
        action: request.action,
        status: "applied",
        candidate: boundProcess.candidate,
        permissions: permissions,
        window: windowResponse,
        mapping: mapping,
        destinationMapping: destinationMapping,
        effect: EffectResponse(applicationActivated: true, eventsPosted: eventsPosted),
        picker: pickerResponse,
        prompt: nil,
        error: nil
    ), exitCode: 0)
} catch let error as HelperFailure {
    emit(HelperResponse(
        schema: responseSchema,
        ok: false,
        action: action,
        status: "failed",
        candidate: nil,
        permissions: PermissionResponse(
            accessibilityTrusted: AXIsProcessTrusted(),
            eventPostingTrusted: CGPreflightPostEventAccess(),
            promptRequested: false
        ),
        window: nil,
        mapping: nil,
        destinationMapping: nil,
        effect: EffectResponse(applicationActivated: false, eventsPosted: 0),
        picker: nil,
        prompt: nil,
        error: ErrorResponse(code: error.code, message: error.message)
    ), exitCode: 2)
} catch {
    emit(HelperResponse(
        schema: responseSchema,
        ok: false,
        action: action,
        status: "failed",
        candidate: nil,
        permissions: PermissionResponse(
            accessibilityTrusted: AXIsProcessTrusted(),
            eventPostingTrusted: CGPreflightPostEventAccess(),
            promptRequested: false
        ),
        window: nil,
        mapping: nil,
        destinationMapping: nil,
        effect: EffectResponse(applicationActivated: false, eventsPosted: 0),
        picker: nil,
        prompt: nil,
        error: ErrorResponse(code: "INVALID_REQUEST", message: "helper request could not be decoded or validated")
    ), exitCode: 2)
}
