# Pi Tool Result Compactor

A generic [Pi](https://pi.dev) extension that keeps agent context cleaner by compacting verbose text tool outputs before they are added to the parent conversation.

The extension intercepts text-based tool and MCP results, asks an inspector model to extract the useful information, and returns a distilled Markdown summary to the agent. If inspection fails for any reason, the original tool result is passed through unchanged.

## Features

- Compacts large tool outputs before they consume context.
- Works with built-in tools and MCP tool results that return text.
- Uses the current Pi model by default, or a configured inspector model.
- Skips image results and, by default, skips write/edit-style tools.
- Runtime command for toggling, status, config reloads, and trace visibility.
- Fails safely: auth errors, model errors, aborts, or empty inspector outputs fall back to the original result.

## Requirements

- A current Pi installation.
- An active model with valid authentication. By default, the extension uses that model for inspection.
- Network access when the selected inspector model is hosted remotely.

The extension still loads without an available authenticated model, but eligible results pass through unchanged. Authentication and inspection failures are currently silent.

## Installation

Install from GitHub:

```bash
pi install git:github.com/RogerTerrazas/pi-tool-result-compactor
```

Or install from a local checkout:

```bash
pi install ./pi-tool-result-compactor
```

For a one-off run without installing:

```bash
pi -e git:github.com/RogerTerrazas/pi-tool-result-compactor
```

Restart Pi or run `/reload` after installation if your session is already open.

## Usage

Once installed, the extension runs automatically for eligible text tool results.

Runtime command:

```text
/toolcompact on
/toolcompact off
/toolcompact status
/toolcompact steps
/toolcompact reload
```

Command behavior:

- `on` enables compaction.
- `off` disables compaction.
- `status` shows current settings.
- `steps` toggles whether the inspector trace is included in parent-visible output.
- `reload` reloads configuration from disk.

When a tool result is compacted, the parent-visible output includes a compact header followed by the distilled result and its `Efficiency:` line. The full raw result is replaced and is not retained in the compacted message or extension metadata. If the inspector omits something important, rerun the original tool call to recover it. Metadata about the inspection is stored in the tool result details under `toolResultCompactor`.

Set `showHeader` or `includeEfficiencyInOutput` to `false` if you do not want those visible markers.

## Configuration

The extension works without configuration. Defaults are equivalent to:

```json
{
  "enabled": true,
  "inspectorModel": null,
  "maxTokens": 40000,
  "minChars": 600,
  "maxInputChars": 200000,
  "excludeTools": ["edit", "write", "read"],
  "includeTools": [],
  "passThroughErrors": true,
  "recordSteps": true,
  "stepsInOutput": false,
  "inspectorPrompt": "You are a context-preserving tool-output compactor...",
  "inspectorInputTemplate": "Goal:\n{goal}\n\nTool:\n{toolName}\n\nArguments:\n{toolArgs}\n\nRaw output:\n{rawOutput}",
  "showHeader": true,
  "headerTemplate": "[compacted {toolName}: {rawChars}→{distilledChars} chars]",
  "includeEfficiencyInOutput": true
}
```

Configuration is loaded only from this fixed path:

```text
~/.pi/tool-result-compactor.json
```

This path does not currently follow the `PI_CODING_AGENT_DIR` override.

Create the file once for your Pi installation:

```bash
mkdir -p ~/.pi
cp config.example.json ~/.pi/tool-result-compactor.json
```

Then run `/toolcompact reload` inside Pi after changing the file.

### Options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `enabled` | boolean | `true` | Enables or disables compaction. |
| `inspectorModel` | string/null | `null` | Optional inspector model in `provider/model-id` form. `null` uses the active Pi model. |
| `maxTokens` | number | `40000` | Maximum tokens for the inspector response. |
| `minChars` | number | `600` | Skip compaction for outputs shorter than this many characters. |
| `maxInputChars` | number | `200000` | Truncate raw tool output before sending it to the inspector model. |
| `excludeTools` | string[] | `["edit", "write", "read"]` | Tool names that should never be compacted. |
| `includeTools` | string[] | `[]` | If non-empty, only these tool names are compacted. |
| `passThroughErrors` | boolean | `true` | If true, errored tool results are not compacted. |
| `recordSteps` | boolean | `true` | Store the inspector's trace in result metadata. |
| `stepsInOutput` | boolean | `false` | Include the inspector trace in parent-visible output. |
| `inspectorPrompt` | string | built-in compact prompt | System prompt used by the inspector model. |
| `inspectorInputTemplate` | string | built-in template | User prompt template. Supports `{goal}`, `{toolName}`, `{toolArgs}`, `{rawOutput}`, `{rawChars}`. |
| `showHeader` | boolean | `true` | Prepend a compact marker before the distilled output. |
| `headerTemplate` | string | `[compacted {toolName}: {rawChars}→{distilledChars} chars]` | Header template when `showHeader` is true. Also supports `{verdict}` and `{inspectorModel}`. |
| `includeEfficiencyInOutput` | boolean | `true` | Keep the final `Efficiency:` metadata line visible to the parent agent. The verdict is stored in details either way. |

### Prompt and output customization

By default, the inspector produces parent-agent-ready facts and the extension displays both the compact header and final `Efficiency:` metadata line. The verdict is also preserved in `details.toolResultCompactor.verdict`.

For quieter parent-visible output, set:

```json
{
  "showHeader": false,
  "includeEfficiencyInOutput": false
}
```

To customize the inspector behavior, override `inspectorPrompt`. Keep an `Efficiency: efficient|inefficient -- reason` line if you want verdict extraction to keep working.

### Inspector model selection

By default, `inspectorModel` is `null`, so the extension uses the active Pi model and its existing auth.

To use a specific model, set `inspectorModel` to `provider/model-id`, for example:

```json
{
  "inspectorModel": "openai-codex/gpt-5.6-sol"
}
```

The provider and model must already be available in Pi's model registry. If the configured model cannot be found, the extension currently falls back to the active Pi model.

## Cost, latency, and output fidelity

Each eligible tool result creates an additional model request and waits for it to finish. This can increase latency and provider cost, especially with the default `minChars` of `600`, several parallel tool calls, or an expensive active model. Consider selecting a fast, inexpensive inspector model, increasing `minChars`, reducing `maxTokens`, or narrowing `includeTools`.

The inspector is model-driven: a non-empty response replaces the raw result even when it is not shorter or accidentally omits useful information. The extension does not currently compare output sizes or preserve the full raw result. Results longer than `maxInputChars` are truncated before inspection, so information beyond that boundary is not available to the inspector.

## Privacy and security

Tool output selected for compaction—including command arguments and recent conversation goal context—is sent to the configured inspector model. Do not enable this extension for tools whose raw output or surrounding context should not be sent to that model provider.

Use `excludeTools` or `includeTools` to control exactly which tools are compacted.

Pi extensions execute code locally with the same permissions as the Pi process. Review extensions before installing them.

## Development

Clone, edit, and install locally:

```bash
git clone https://github.com/RogerTerrazas/pi-tool-result-compactor.git
cd pi-tool-result-compactor
pi install .
```

Run the lightweight package check:

```bash
npm run check
```

No build step is required; Pi loads the TypeScript extension directly.

## Package manifest

This repository is a Pi package. The extension entrypoint is declared in `package.json`:

```json
{
  "pi": {
    "extensions": ["./extensions/index.ts"]
  }
}
```

## License

MIT
