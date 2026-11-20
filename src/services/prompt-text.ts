/**
 * Agent CLIs inject context blocks and command scaffolding into the message
 * stream. These helpers strip that noise so titles and previews reflect what
 * the user actually typed.
 */

const WRAPPED_CONTEXT_PATTERNS = [
  /<system-reminder>[\s\S]*?<\/system-reminder>/g,
  /<environment_context>[\s\S]*?<\/environment_context>/g,
  /<user_instructions>[\s\S]*?<\/user_instructions>/g,
  /<skills_instructions>[\s\S]*?<\/skills_instructions>/g,
  /<multi_agent_mode>[\s\S]*?<\/multi_agent_mode>/g,
  /<local-command-caveat\b[^>]*>[\s\S]*?<\/local-command-caveat\s*>/gi,
  /<(external_codex_apps_[a-z0-9_]+)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,
];

const META_PROMPT_PREFIXES = [
  // Claude Code
  "<command-name>",
  "<command-message>",
  "<local-command-stdout>",
  "<local-command-stderr>",
  "<local-command-caveat",
  "<user-prompt-submit-hook>",
  "<bash-input>",
  "<bash-stdout>",
  "<scheduled-task",
  "<automation",
  "Caveat: The messages below were generated",
  "This session is being continued from a previous conversation",
  "[Request interrupted",
  // Codex
  "# AGENTS.md instructions",
  "<external_codex_apps_",
  "<environment_context>",
  "<user_instructions>",
  "<skills_instructions>",
  "<multi_agent_mode>",
  "The following is the Codex agent history",
  "You are `/root`",
  "## My request for Codex",
];

export function cleanPromptText(text: string): string {
  let cleaned = text;
  for (const pattern of WRAPPED_CONTEXT_PATTERNS) {
    cleaned = cleaned.replace(pattern, "");
  }
  // Paste wrappers are presentation scaffolding; the pasted text is useful.
  return cleaned.replace(/<\/?pasted_content\b[^>]*>/gi, "").trim();
}

export function isLocalCommandCaveat(text: string): boolean {
  return /^\s*<local-command-caveat\b/i.test(text);
}

export function isMetaPrompt(text: string): boolean {
  const trimmed = text.trimStart();
  if (trimmed.length === 0) return true;
  if (isLocalCommandCaveat(trimmed)) return true;
  return META_PROMPT_PREFIXES.some((prefix) => trimmed.startsWith(prefix));
}

export function toTitle(text: string, maxLength = 88): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length <= maxLength) return collapsed;
  return `${collapsed.slice(0, maxLength - 1).trimEnd()}…`;
}

export function toPreview(text: string, maxLength = 240): string {
  return toTitle(text, maxLength);
}
