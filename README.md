# Loci for Codex

Use models running on your Mac for summaries, rewriting, classification, structured output, and batch processing. Available tools depend on your Loci app version.

Requires an Apple silicon Mac, macOS 26.2 or later, and the [Loci direct-download app](https://askloci.ai/api/mac-download).

## Install

Add the Loci marketplace:

```sh
codex plugin marketplace add AskLoci/loci-plugins
```

In the desktop app, open the Plugins Directory, select **Loci**, and install the **Loci** plugin. If the marketplace does not appear, restart the desktop app. Start a new chat and ask: “Help me set up Loci.”

In Loci, turn on **Settings → Advanced → Agent Access**. Keep Loci running while using the plugin. The setup tool checks the connection and helps you choose an installed model or a compatible download.

See [OpenAI’s marketplace guide](https://developers.openai.com/plugins/build/plugins#add-a-marketplace-from-the-cli) for supported hosts and marketplace management.

## Package

[Download version 0.1.2 for macOS on Apple silicon](https://github.com/AskLoci/loci-plugins/releases/download/v0.1.2/loci-0.1.2-macos-arm64.zip).

The connector is signed with Apple Developer ID and notarized by Apple. No Node.js or Python runtime is required.

SHA-256:

```text
a1c3772257933a70fb53f911c12abcd8258ebc8a190038ee9723c0891e5ffb15
```

## Data and file access

Model inference runs on your Mac. Prompts, paths, and returned results shared in your assistant conversation follow that assistant’s data policies. File tools can read the paths you authorize; summaries, extracted values, quotes, and search passages can reveal information from those files.

The connector uses Loci’s local connection file and sends its credential only over loopback. The plugin does not include a model. Downloaded models stay in Loci and can be used by both the app and the plugin.

[Support](https://askloci.ai/support) · [Privacy](https://askloci.ai/privacy) · [Terms](https://askloci.ai/terms)
