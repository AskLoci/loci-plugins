# Loci for agents

Use models running on your Mac for summaries, rewriting, classification, structured output and batch processing. Compatible Loci app versions also provide file processing, document extraction, folder search and audio transcription.

Requires an Apple silicon Mac, macOS 26.2 or later, and the [Loci direct-download app](https://askloci.ai/api/mac-download). Available tools depend on your app version.

## Codex

Add the Loci marketplace:

```sh
codex plugin marketplace add AskLoci/loci-plugins
```

In the desktop app, open the Plugins Directory, select **Loci**, and install the **Loci** plugin. If the marketplace does not appear, restart the desktop app. Start a new chat and ask: “Help me set up Loci.”

[Download the Codex plugin (0.1.4)](https://github.com/AskLoci/loci-plugins/releases/download/v0.1.4/loci-0.1.4-macos-arm64.zip).

## Claude Code

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

## Data and file access

Model inference runs on your Mac. Prompts, paths and returned results shared in your assistant conversation follow that assistant’s data policies. File tools can read paths you authorize; summaries, extracted values, quotes and search passages can reveal information from those files.

The connector reads Loci’s owner-only connection file and sends its credential only over loopback. It has no separate analytics or external reporting endpoint. Loci’s data practices are described in its privacy policy.

[Support](https://askloci.ai/support) · [Privacy](https://askloci.ai/privacy) · [Terms](https://askloci.ai/terms)
