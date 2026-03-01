# Findings — CDP Console & Network Capture

## CdpSession Interface (from cdp-screencast.ts)
```typescript
interface CdpSession {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  on(event: string, handler: (params: Record<string, unknown>) => void): void;
  off(event: string, handler: (params: Record<string, unknown>) => void): void;
}
```
This is the shared interface for all CDP capture classes. Obtained via:
```typescript
const cdpSession = (page as any).getSessionForFrame?.((page as any).mainFrameId?.());
```

## CDP Console Events
- `Runtime.enable` → activates console event delivery
- `Runtime.consoleAPICalled` event:
  - `type`: "log" | "debug" | "info" | "error" | "warning" | "dir" | "dirxml" | "table" | "trace" | "clear" | "startGroup" | "startGroupCollapsed" | "endGroup" | "assert" | "profile" | "profileEnd" | "count" | "timeEnd"
  - `args`: Array of `RemoteObject` — each has `type`, `value`, `description`
  - `timestamp`: number (Runtime.Timestamp — seconds since epoch)
  - `stackTrace`: optional `{ callFrames: [{ functionName, url, lineNumber, columnNumber }] }`
  - `executionContextId`: number

## CDP Network Events
- `Network.enable` → activates network event delivery
- `Network.requestWillBeSent` event:
  - `requestId`: string (correlator)
  - `request`: `{ url, method, headers, postData? }`
  - `timestamp`: number (MonotonicallyIncreasingTime)
  - `type`: resource type (Document, Stylesheet, Image, Script, XHR, Fetch, etc.)
  - `initiator`: `{ type, url?, lineNumber? }`
- `Network.responseReceived` event:
  - `requestId`: string (matches requestWillBeSent)
  - `response`: `{ url, status, statusText, headers, mimeType }`
  - `timestamp`: number
  - `type`: resource type
- `Network.loadingFinished` event:
  - `requestId`: string
  - `encodedDataLength`: number (bytes transferred)
  - `timestamp`: number
- `Network.loadingFailed` event:
  - `requestId`: string
  - `errorText`: string
  - `canceled`: boolean
  - `timestamp`: number

## Wiring Point (stagehand-verify.ts)
Lines 197-209: screencast start — console+network start here alongside
Lines 329-340: screencast stop+encode — console+network stop+save here
Lines 342-348: return object — add consolePath, networkPath
Lines 349-356: finally block — safety net stop for console+network

## Dashboard Extension Points
- API: `/api/runs/:id/media` (line ~2968-3011) — add consoleLogs, networkLog fields
- HTML: media card (line ~1428-1438) — add collapsible panels
- JS: loadMedia() (line ~1873-1921) — render console/network data

## Test Patterns (from existing tests)
- Use `node:test` and `node:assert/strict`
- Tests in `tests/*.test.ts`
- Mock CdpSession with `send`, `on`, `off` methods
- Test file: `tests/cdp-console-capture.test.ts` and `tests/cdp-network-capture.test.ts`
