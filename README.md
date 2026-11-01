# Loci for agents

Use models running on your Mac for summaries, rewriting, classification, structured output and batch processing. Loci 0.1.28 and later also provide file processing, document extraction, folder search and audio transcription.

Requires an Apple silicon Mac with 8 GB of memory or more, macOS 26.2 or later, and the [Loci direct-download app](https://askloci.ai/api/mac-download). Loci 0.1.28 or later provides every tool. Loci 0.1.21 to 0.1.27 provide model status, text generation, batch processing, model downloads and model loading only.

## Codex

Add the Loci marketplace:

```sh
codex plugin marketplace add AskLoci/loci-plugins
```

In the desktop app, open the Plugins Directory, select **Loci**, and install the **Loci** plugin. If the marketplace does not appear, restart the desktop app. Start a new chat and ask: “Help me set up Loci.”

[Download the Codex plugin (0.1.8)](https://github.com/AskLoci/loci-plugins/releases/download/v0.1.8/loci-0.1.8-macos-arm64.zip).

## Claude Code

Requires [Node.js 22 or later](https://nodejs.org/).

Add the marketplace and install Loci:

```sh
claude plugin marketplace add AskLoci/loci-plugins
claude plugin install loci@askloci
```

Start a new conversation and ask: “Help me set up Loci.” [Setup and data handling](./loci-claude/README.md).

## Cursor

Open **Customize → Plugins** and add `https://github.com/AskLoci/loci-plugins` as a repository source. Install **Loci**, start a new conversation, and ask: “Help me set up Loci.” [Setup and data handling](./loci-cursor/README.md).

## Other MCP clients

Use the Loci MCP bundle with a local macOS client that supports MCPB, or configure the signed connector as a local stdio server. No Node.js or Python runtime is required.

[Download packages](https://github.com/AskLoci/loci-plugins/releases)

## Connect Loci

Open Loci and enable **Settings → Advanced → Agent Access**. Keep Loci running while using the plugin. The setup tool checks the connection and helps choose an installed model or a compatible download. Existing models are shared with the app.

If the saved connection is stale or refused, setup gives a connection-repair step before any model work. App and plugin updates are separate; each client can have a different plugin version.

## Data and file access

Model inference runs on your Mac. Prompts, paths and returned results shared in your assistant conversation follow that assistant’s data policies. File tools can read paths you authorize; summaries, extracted values, quotes and search passages can reveal information from those files.

The connector communicates only with Loci over local loopback and never needs you to paste its access token. For each request, it reads Loci’s owner-only connection file, or the file named by the `LOCI_AGENT_API_FILE` environment variable, and runs macOS `lsof` to confirm that the local port belongs to the Loci process named in that file and to your user account. Only then does it send the token. Each request’s User-Agent carries the name and version your assistant reports, followed by the connector version. The signed connector used by Codex and Cursor reduces that name and version to letters and digits. The connector has no analytics of its own.

Loci’s diagnostic sharing is on by default. While it is on, Loci records one event for each call from your assistant: the tool, how the call ended, whether the caller identified itself as Claude Code or Codex, and the model engine used. Loci also records which tool made the first call a model answered on your Mac. Model work your assistant starts also produces Loci’s usual content-free performance diagnostics, such as which model ran and how long it took. These events contain no prompts, file paths, file contents or results. To stop sharing, turn off diagnostic sharing in Loci under Settings → Advanced → Privacy. Loci’s data practices are described in its [privacy policy](https://askloci.ai/privacy).

[Support](https://askloci.ai/support) · [Privacy](https://askloci.ai/privacy) · [Terms](https://askloci.ai/terms)
