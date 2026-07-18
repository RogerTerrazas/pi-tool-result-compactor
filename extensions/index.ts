/**
 * tool-result-compactor
 * -------------------
 * Routes every tool and MCP call through an "inspector model".
 *
 * For each tool/MCP result, a focused inspector (a single, isolated model call
 * with its own system prompt) receives:
 *   - what the parent agent is looking for (the broader goal, inferred from the
 *     conversation),
 *   - the command (tool name + arguments),
 *   - the raw tool output.
 *
 * It then returns ONLY the useful data plus a recommendation on whether the
 * call was an efficient way to advance the goal. That distilled report -- not
 * the raw output -- is what enters the parent agent's context.
 *
 * Design notes:
 *   - The tool executes normally in the parent process; the inspector inspects
 *     and distills the result (it does not re-run the tool in a child session,
 *     which would be unsafe for edit/write and prohibitively slow per call).
 *   - The inspector is a raw `complete()` call, not a child AgentSession, so it
 *     never reloads this extension and cannot recurse.
 *   - Anything that fails (no model, auth error, model error, abort) falls back
 *     to the original, unmodified result. The agent is never broken by this.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type {
  ExtensionAPI,
  ExtensionContext,
  ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import { complete } from "@earendil-works/pi-ai/compat";
import type { Context, Model } from "@earendil-works/pi-ai";

// -----------------------------------------------------------------------------
// Config
// -----------------------------------------------------------------------------

interface ProxyConfig {
  /** Master switch. */
  enabled: boolean;
  /**
   * Inspector model as "provider/id". When omitted, the parent's current model
   * is reused. Point this at a fast/cheap model to keep cost down.
   */
  inspectorModel: string | null;
  /** Max tokens for the inspector's reply. */
  maxTokens: number;
  /**
   * Only inspect outputs longer than this many characters. 0 = inspect every
   * call (honours "all tool and mcp calls" literally, at higher cost).
   */
  minChars: number;
  /** Upper bound on raw output (chars) handed to the inspector. */
  maxInputChars: number;
  /** Tool names that are never intercepted (passed through untouched). */
  excludeTools: string[];
  /** If non-empty, ONLY these tool names are intercepted. */
  includeTools: string[];
  /** Pass error results through untouched so the agent sees the raw error. */
  passThroughErrors: boolean;
  /**
   * Record a structured trace of the steps the inspector model took into
   * `details.toolResultCompactor.steps`. This lands in the `/export` SESSION_DATA
   * blob and costs the parent agent zero context tokens (details are not sent
   * to the model).
   */
  recordSteps: boolean;
  /**
   * Also append a human-visible "Inspector steps" block to the tool result
   * content so it renders directly in the `/export` HTML body. WARNING: this
   * is also seen by the parent agent and costs context tokens. Default off.
   */
  stepsInOutput: boolean;

  /** System prompt used for the inspector model. */
  inspectorPrompt: string;

  /** User prompt template sent to the inspector model. */
  inspectorInputTemplate: string;

  /** If true, prepend a compact marker before the distilled output. */
  showHeader: boolean;

  /** Header template used when showHeader is true. */
  headerTemplate: string;

  /** If true, keep the inspector's Efficiency line visible to the parent agent. */
  includeEfficiencyInOutput: boolean;
}

/** One recorded step in the inspector model's trace. */
interface ProxyStep {
  /** Monotonic ms since the handler started. */
  atMs: number;
  /** Short phase label. */
  step: string;
  /** Human-readable detail for this phase. */
  detail: string;
}

const DEFAULT_INSPECTOR_PROMPT = `You are a context-preserving tool-output compactor for a coding agent.

Transform raw tool output into the smallest result that still helps the parent agent decide what to do next.

Optimize for usefulness, not completeness:
- Return only facts, errors, paths, line numbers, commands, IDs, URLs, or values that matter.
- Preserve exact technical strings. Do not paraphrase file paths, symbols, errors, commands, or code identifiers.
- Prefer terse bullets or a tiny code block when structure helps.
- Do not restate the tool name, arguments, or search goal unless it changes the meaning of the result.
- Do not mention that you are an inspector or compactor.
- Do not include generic commentary such as "the output shows".
- If the raw output is already short and useful, return it mostly unchanged.
- If the raw output is noisy, discard noise aggressively.
- If nothing useful was found, return exactly: No useful information found.

Always end with one metadata line in this exact format:
Efficiency: efficient|inefficient -- brief reason

The parent-facing extension may hide that final metadata line, so put all useful task information above it.`;

const DEFAULT_INSPECTOR_INPUT_TEMPLATE = `Goal:
{goal}

Tool:
{toolName}

Arguments:
{toolArgs}

Raw output:
{rawOutput}`;

function renderTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (match, key) => values[key] ?? match);
}

function stripEfficiencyLine(text: string): string {
  return text
    .split("
")
    .filter((line) => !/^\s*\*{0,2}efficiency:\s*/i.test(line))
    .join("
")
    .trim();
}

const DEFAULT_CONFIG: ProxyConfig = {
  enabled: true,
  inspectorModel: null,
  maxTokens: 40_000,
  minChars: 500,
  maxInputChars: 200_000,
  // Mutations, interactive prompts, and delegation tooling itself are not
  // useful to distill -- pass them through.
  excludeTools: ["edit", "write", "read"],
  includeTools: [],
  passThroughErrors: true,
  recordSteps: true,
  stepsInOutput: false,
  inspectorPrompt: DEFAULT_INSPECTOR_PROMPT,
  inspectorInputTemplate: DEFAULT_INSPECTOR_INPUT_TEMPLATE,
  showHeader: false,
  headerTemplate: "[compacted {toolName}: {rawChars}→{distilledChars} chars]",
  includeEfficiencyInOutput: true,
};

function loadConfig(): ProxyConfig {
  const configPath = join(homedir(), ".pi", "tool-result-compactor.json");

  try {
    if (!existsSync(configPath)) return { ...DEFAULT_CONFIG };
    const raw = readFileSync(configPath, "utf8");
    const parsed = JSON.parse(raw) as Partial<ProxyConfig>;
    return { ...DEFAULT_CONFIG, ...parsed };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function textFromContent(content: Array<{ type: string; text?: string }>): string {
  return content
    .filter((c) => c.type === "text" && typeof c.text === "string")
    .map((c) => c.text as string)
    .join("\n");
}

function hasImage(content: Array<{ type: string }>): boolean {
  return content.some((c) => c.type === "image");
}

/** Pull recent user intent + the assistant's latest reasoning from the session. */
function inferGoal(ctx: ExtensionContext): string {
  let lastUser = "";
  let lastAssistant = "";
  try {
    const branch = ctx.sessionManager.getBranch() as Array<any>;
    for (const entry of branch) {
      if (entry?.type !== "message" || !entry.message) continue;
      const msg = entry.message;
      const text = Array.isArray(msg.content)
        ? msg.content
            .filter((c: any) => c?.type === "text" && typeof c.text === "string")
            .map((c: any) => c.text)
            .join("\n")
        : "";
      if (!text.trim()) continue;
      if (msg.role === "user") lastUser = text;
      else if (msg.role === "assistant") lastAssistant = text;
    }
  } catch {
    /* best-effort only */
  }
  const parts: string[] = [];
  if (lastUser) parts.push(`User request:\n${truncate(lastUser, 2000)}`);
  if (lastAssistant)
    parts.push(`Agent's latest reasoning before this call:\n${truncate(lastAssistant, 2000)}`);
  return parts.join("\n\n") || "(no explicit goal found in recent conversation)";
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}\n…[truncated ${s.length - max} chars]`;
}

function resolveInspectorModel(
  cfg: ProxyConfig,
  ctx: ExtensionContext,
): Model<any> | undefined {
  if (cfg.inspectorModel) {
    const slash = cfg.inspectorModel.indexOf("/");
    if (slash > 0) {
      const provider = cfg.inspectorModel.slice(0, slash);
      const id = cfg.inspectorModel.slice(slash + 1);
      const found = ctx.modelRegistry.find(provider, id);
      if (found) return found;
    }
  }
  return ctx.model as Model<any> | undefined;
}

// -----------------------------------------------------------------------------
// Extension
// -----------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  let cfg = loadConfig();

  const shouldIntercept = (toolName: string): boolean => {
    if (!cfg.enabled) return false;
    if (cfg.excludeTools.includes(toolName)) return false;
    if (cfg.includeTools.length > 0 && !cfg.includeTools.includes(toolName)) return false;
    return true;
  };

  pi.on("session_start", async (_event, ctx) => {
    cfg = loadConfig();
    if (cfg.enabled) {
      ctx.ui.setStatus?.("toolcompact", "tool-compact: on");
    }
  });

  pi.on("tool_result", async (event: ToolResultEvent, ctx: ExtensionContext) => {
    const t0 = Date.now();
    const steps: ProxyStep[] = [];
    const record = (step: string, detail: string) => {
      if (cfg.recordSteps) steps.push({ atMs: Date.now() - t0, step, detail });
    };

    try {
      if (!shouldIntercept(event.toolName)) return;
      if (event.isError && cfg.passThroughErrors) return;
      if (ctx.signal?.aborted) return;
      if (hasImage(event.content)) return; // keep image results intact

      const raw = textFromContent(event.content);
      if (!raw.trim()) return;
      if (raw.length < cfg.minChars) return;
      record(
        "intercept",
        `tool=${event.toolName} rawChars=${raw.length} (>= minChars=${cfg.minChars})`,
      );

      const model = resolveInspectorModel(cfg, ctx);
      if (!model) return;

      const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
      if (!auth.ok) return;
      record("resolve-model", `inspector=${model.provider}/${model.id}`);

      const goal = inferGoal(ctx);
      record("infer-goal", `derived ${goal.length} chars of goal context from conversation`);
      const argsStr = (() => {
        try {
          return JSON.stringify(event.input);
        } catch {
          return String(event.input);
        }
      })();

      const truncatedInput = raw.length > cfg.maxInputChars;
      const rawForModel = truncatedInput
        ? `${raw.slice(0, cfg.maxInputChars)}\n…[truncated ${raw.length - cfg.maxInputChars} chars before inspection]`
        : raw;
      record(
        "build-prompt",
        `args=${truncate(argsStr, 200)} | inputChars=${rawForModel.length}${
          truncatedInput ? ` (truncated from ${raw.length})` : ""
        }`,
      );

      const userPrompt = renderTemplate(cfg.inspectorInputTemplate, {
        goal,
        toolName: event.toolName,
        toolArgs: argsStr,
        rawOutput: rawForModel,
        rawChars: String(raw.length),
      });

      const context: Context = {
        systemPrompt: cfg.inspectorPrompt,
        messages: [{ role: "user", content: [{ type: "text", text: userPrompt }] }],
      };

      const callStart = Date.now();
      const reply = await complete(model, context, {
        apiKey: auth.apiKey,
        headers: auth.headers,
        env: auth.env,
        maxTokens: cfg.maxTokens,
        signal: ctx.signal,
      });
      const callMs = Date.now() - callStart;

      const distilled = (reply.content ?? [])
        .filter((c: any) => c?.type === "text" && typeof c.text === "string")
        .map((c: any) => c.text)
        .join("\n")
        .trim();

      if (!distilled) return;

      const usage = (reply as any).usage ?? {};
      const inTok = usage.inputTokens ?? usage.input_tokens;
      const outTok = usage.outputTokens ?? usage.output_tokens;
      record(
        "inspect",
        `modelMs=${callMs} inputTokens=${inTok ?? "?"} outputTokens=${outTok ?? "?"}`,
      );

      const verdict = /efficiency:\s*\**\s*(inefficient|efficient)/i
        .exec(distilled)?.[1]
        ?.toLowerCase();
      record(
        "distill",
        `rawChars=${raw.length} → distilledChars=${distilled.length} (${Math.round(
          (1 - distilled.length / raw.length) * 100,
        )}% reduction)${verdict ? ` | verdict=${verdict}` : ""}`,
      );

      const parentText = cfg.includeEfficiencyInOutput
        ? distilled
        : stripEfficiencyLine(distilled) || distilled;
      const header = cfg.showHeader
        ? `${renderTemplate(cfg.headerTemplate, {
            toolName: event.toolName,
            rawChars: String(raw.length),
            distilledChars: String(parentText.length),
            verdict,
            inspectorModel: `${model.provider}/${model.id}`,
          })}

`
        : "";
      const stepsBlock =
        cfg.stepsInOutput && steps.length
          ? `

**Inspector steps:**
${steps
              .map((s) => `> - ${s.atMs}ms ${s.step}: ${s.detail}`)
              .join("
")}`
          : "";

      return {
        content: [{ type: "text", text: `${header}${parentText}${stepsBlock}` }],
        details: {
          ...(event.details && typeof event.details === "object" ? event.details : {}),
          toolResultCompactor: {
            tool: event.toolName,
            rawChars: raw.length,
            distilledChars: distilled.length,
            inspectorModel: `${model.provider}/${model.id}`,
            verdict: verdict ?? null,
            inspectMs: callMs,
            inputTokens: inTok ?? null,
            outputTokens: outTok ?? null,
            // The recorded trace of what the inspector model did. Surfaces in
            // `/export`'s SESSION_DATA blob; costs the parent zero context.
            steps: cfg.recordSteps ? steps : undefined,
          },
        },
      };
    } catch {
      // Never break the agent: fall back to the original result.
      return;
    }
  });

  // Runtime toggle / status command.
  pi.registerCommand("toolcompact", {
    description: "Toggle/inspect tool result compaction (on|off|status|steps|reload)",
    getArgumentCompletions: (prefix: string) =>
      ["on", "off", "status", "steps", "reload"]
        .filter((v) => v.startsWith(prefix))
        .map((v) => ({ value: v, label: v })),
    handler: async (args, ctx) => {
      const arg = (args || "").trim().toLowerCase();
      if (arg === "on") cfg.enabled = true;
      else if (arg === "off") cfg.enabled = false;
      else if (arg === "steps") cfg.stepsInOutput = !cfg.stepsInOutput;
      else if (arg === "reload") cfg = loadConfig();

      const model = cfg.inspectorModel ?? "parent model";
      const inc = cfg.includeTools.length ? cfg.includeTools.join(",") : "all (minus excluded)";
      ctx.ui.notify(
        `inspector tool-compact: ${cfg.enabled ? "ON" : "OFF"} | inspector=${model} | minChars=${cfg.minChars} | tools=${inc} | steps: record=${
          cfg.recordSteps ? "on" : "off"
        } inOutput=${cfg.stepsInOutput ? "on" : "off"}`,
        "info",
      );
      ctx.ui.setStatus?.("toolcompact", `tool-compact: ${cfg.enabled ? "on" : "off"}`);
    },
  });
}
