# Loci for Hermes

Use models on your Mac alongside Hermes for summaries, classification, structured output and batch work. Loci can also process selected files, extract document tables with evidence, search local folders and transcribe audio files. Available tools depend on the installed Loci app.

## Requirements

- Hermes Agent 0.23.0 or later, running on the same Mac as Loci.
- An Apple silicon Mac with macOS 26.2 or later.
- The [Loci direct-download app](https://askloci.ai/agents/) with **Settings → Advanced → Agent Access** enabled.

The Mac App Store app does not provide Agent Access. Remote servers, containers, Windows and Linux cannot connect to Loci on a different Mac through this package.

## Install

```sh
hermes plugins install https://github.com/AskLoci/loci-plugins/tree/main/loci-hermes --no-enable
hermes plugins enable loci
```

## Set up

1. Install and enable this plugin in Hermes. You can do this before installing Loci.
2. Ask Hermes: “Help me set up Loci.” If needed, [download Loci for Mac](https://askloci.ai/api/mac-download), open the disk image, and run **Install Loci**.
3. Open Loci, complete its setup, and enable **Settings → Advanced → Agent Access**. Keep Loci running in the background.
4. Run `/reload-mcp` or start a new Hermes conversation. Ask “Check my Loci models and give me one short local answer.” Reuse an installed model, or approve a compatible model download after reviewing its size.

No credential copying or separate connector runtime is needed. Hermes uses its built-in local application discovery and HTTP MCP connection. Its normal approval controls apply to write-capable tools, including downloads, file output and persistent indexing. Background tasks that require approval fail instead of waiting indefinitely.

## Try it

- “Use Loci to summarize these three files and tell me which ones failed.”
- “Use Loci to classify these 20 comments as positive, neutral or negative.”
- “Extract the invoice numbers and amounts from this folder into a CSV, with evidence and review flags.”
- “Search this project folder for the keyboard-focus bug.”
- “Transcribe this audio file with Loci.”

## Connection recovery

A missing connection can mean Loci is closed, Agent Access is disabled, or the saved endpoint is stale. It does not prove that Loci needs reinstalling. Open the intended Loci app, check Agent Access, then run `/reload-mcp` or start a new Hermes session. If authorization is refused, refresh Agent Access in that app when no work is running and reconnect. Do not reuse a development app's connection or stop another session to repair it.

If model files are being checked, or a download is paused or installing, preserve that work. Inspect Models in Loci before starting another download. A connection check is complete only when a model returns a successful answer.

## Data and permissions

Model inference runs on the Mac. Inputs, file paths and returned results enter the Hermes conversation and follow the data policies of the model provider configured in Hermes. Selected-file processing can avoid sending whole documents to that provider, but returned summaries, quotes, extracted values, search passages and transcripts can still disclose their contents.

This package contains manifests, skills and documentation. It includes no executable payload, startup script, self-updater, credential storage, telemetry or reporting endpoint. Hermes reads Loci's local discovery file at `~/Library/Application Support/LociRust/agent-api.json`, checks that its process is running, and attaches the token to the discovered loopback MCP endpoint. The package itself does not open that file or handle the token. Do not paste connection tokens into a conversation or configuration.

The separately installed Loci app has access to authorized local files and models. Tools can download models, write requested extraction output and maintain a local search index; approve only the paths and operations you intend. App installation and model downloads use the network. Loci's own diagnostics settings and data practices are described in its [privacy policy](https://askloci.ai/privacy). The plugin does not change those settings or expose Loci's private conversations, mail accounts or memories.

[Support](https://askloci.ai/support) · [Privacy](https://askloci.ai/privacy) · [Terms](https://askloci.ai/terms)
