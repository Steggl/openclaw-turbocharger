// TODO(issue #5): Orchestrator for the hybrid cascade critic.
// Runs hard-signals first; falls through to llm-critic only when hard-signals
// return "no clear failure" AND config allows LLM-critic AND budget is not
// exceeded. Emits a verdict: "pass" | "fail" with reason + confidence.

export {};
