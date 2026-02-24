# @jademind/pi-bridge

Minimal secure inbox bridge for Pi sessions.

`@jademind/pi-bridge` is designed for status bar and mobile clients that must send messages reliably to running Pi agents, including plain terminal sessions where tty injection is unreliable.

## What it does

- Watches a per-PID inbox directory
- Validates signed/structured message envelopes
- Delivers to Pi using user-message semantics
  - queued mode -> `followUp` when busy
  - interrupt mode -> `steer` when busy
- Writes delivery acknowledgements per message
- Publishes lightweight per-session registry heartbeat
- Enforces size limits, TTL, path safety, idempotency, and rate limits

## Install

```bash
pi install npm:@jademind/pi-bridge
```

## Filesystem layout

Default base directory:

```text
~/.pi/agent/statusbridge/
  registry/<pid>.json
  inbox/<pid>/<message-id>.json
  processing/<pid>/*.processing
  acks/<pid>/<message-id>.json
```

Override base with:

- `PI_BRIDGE_DIR`

## Envelope (`send-v1`)

```json
{
  "v": 1,
  "id": "4a4c5295-d3e4-4f91-b562-8f0f4cc6f413",
  "pid": 12345,
  "text": "Please summarize current progress and blockers.",
  "source": "statusbar",
  "createdAt": "2026-02-24T15:50:00Z",
  "expiresAt": "2026-02-24T15:51:00Z",
  "delivery": {
    "mode": "queued"
  },
  "meta": {
    "requestId": "ios-123"
  }
}
```

`delivery.mode` values:

- `queued` (default): queue politely if busy
- `interrupt`: steering interrupt if busy

## Ack (`ack-v1`)

```json
{
  "v": 1,
  "id": "4a4c5295-d3e4-4f91-b562-8f0f4cc6f413",
  "pid": 12345,
  "status": "delivered",
  "at": 1771948234000,
  "resolvedMode": "queued"
}
```

Possible statuses:

- `delivered`
- `failed`
- `duplicate`

## Security defaults

- file size cap: 32 KB
- message length cap: 4000 chars
- strict PID matching
- TTL expiry enforcement
- symlink and path traversal rejection
- bounded queue depth
- separate normal/interrupt rate limiters

## Runtime config

- `PI_BRIDGE_MAX_TEXT` (default `4000`)
- `PI_BRIDGE_MAX_SKEW_MS` (default `120000`)
- `PI_BRIDGE_HEARTBEAT_MS` (default `2000`)
- `PI_BRIDGE_SCAN_MS` (default `750`)
- `PI_BRIDGE_QUEUE_DEPTH` (default `64`)
- `PI_BRIDGE_RATE_PER_MIN` (default `12`)
- `PI_BRIDGE_RATE_BURST` (default `4`)
- `PI_BRIDGE_INTERRUPT_RATE_PER_MIN` (default `4`)
- `PI_BRIDGE_INTERRUPT_RATE_BURST` (default `2`)

## Command

- `/pi-bridge-status`

## Development

```bash
npm test
npm pack --dry-run
```

## License

MIT
