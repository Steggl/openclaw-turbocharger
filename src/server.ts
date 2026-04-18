// TODO(issue #2): OpenAI-compatible HTTP server entry.
//
// Exposes a /v1 endpoint (chat/completions at minimum) that any OpenAI-compatible
// client can point at. Delegates to proxy.ts for forwarding and to the
// critic/escalation/transparency modules for the reactive layer.

export {};
