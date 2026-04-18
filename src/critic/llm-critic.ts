// TODO(issue #4): LLM-critic adapter.
// OpenAI-compatible, swappable model (default: ollama/qwen2.5:7b local,
// anthropic/claude-haiku-* or openai/gpt-*-mini cloud).
// Returns { verdict: "pass" | "fail", reason: string, confidence: 0..1 }.
// Critic is explicitly instructed NOT to rewrite the answer.

export {};
