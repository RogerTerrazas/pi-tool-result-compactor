# Pi Tool Result Compactor

A generic [Pi](https://pi.dev) extension that keeps agent context cleaner by compacting verbose text tool outputs before they are added to the parent conversation.

The extension intercepts text-based tool and MCP results, asks an inspector model to extract the useful information, and returns a shorter Markdown summary to the agent. If inspection fails for any reason, the original tool result is passed through unchanged.

## Features

- Compacts large tool outputs before they consume context.
- Works with built-in tools and MCP tool results that return text.
- Uses the current Pi model by default, or a configured inspector model.
- Skips image results and, by default, skips write/edit-style tools.
- Runtime command for toggling, status, config reloads, and trace visibility.
- Fails safely: auth errors, model errors, aborts, or invalid outputs fall back to the original result.

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

When a tool result is compacted, the parent-visible output begins with a short marker such as:

```text
🔎 inspected by inspector (read, 12000→900 chars)
```

The full raw result is not included in the compacted message. Metadata about the inspection is stored in the tool result details under `toolResultCompactor`.

## Configuration

The extension works without configuration. Defaults are equivalent to:

```json
{
  "enabled": true,
  "inspectorModel": null,
  "maxTokens": 2000,
  "minChars": 0,
  "maxInputChars": 80000,
  "excludeTools": ["edit", "write"],
  "includeTools": [],
  "passThroughErrors": true,
  "recordSteps": true,
  "stepsInOutput": false
}
```

Configuration is loaded only from the root Pi agent config path:

```text
~/.pi/agent/tool-result-compactor.json
```

Create the file once for your Pi agent:

```bash
mkdir -p ~/.pi/agent
cp config.example.json ~/.pi/agent/tool-result-compactor.json
```

Then run `/toolcompact reload` inside Pi after changing the file.

### Options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `enabled` | boolean | `true` | Enables or disables compaction. |
| `inspectorModel` | string/null | `null` | Optional inspector model in `provider/model-id` form. `null` uses the active Pi model. |
| `maxTokens` | number | `2000` | Maximum tokens for the inspector response. |
| `minChars` | number | `0` | Skip compaction for outputs shorter than this many characters. |
| `maxInputChars` | number | `80000` | Truncate raw tool output before sending it to the inspector model. |
| `excludeTools` | string[] | `["edit", "write"]` | Tool names that should never be compacted. |
| `includeTools` | string[] | `[]` | If non-empty, only these tool names are compacted. |
| `passThroughErrors` | boolean | `true` | If true, errored tool results are not compacted. |
| `recordSteps` | boolean | `true` | Store the inspector's trace in result metadata. |
| `stepsInOutput` | boolean | `false` | Include the inspector trace in parent-visible output. |

### Inspector model selection

By default, `inspectorModel` is `null`, so the extension uses the active Pi model and its existing auth.

To use a specific model, set `inspectorModel` to `provider/model-id`, for example:

```json
{
  "inspectorModel": "openai-codex/gpt-5.6-sol"
}
```

The provider and model must already be available in Pi's model registry.

## Privacy and security

Tool output selected for compaction is sent to the configured inspector model. Do not enable this extension for tools whose raw output should not be sent to that model provider.

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
