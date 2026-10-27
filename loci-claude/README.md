# Loci for Claude Code

Use models on your Mac for summaries, rewriting, classification, structured output and batch processing. With a compatible Loci app, you can also process selected files, extract document records, search folders and transcribe audio files. The plugin checks which tools your installed app provides.

## Requirements

An Apple silicon Mac with macOS 26.2 or later, Claude Code running locally, and the [Loci direct-download app](https://askloci.ai/api/mac-download). The Mac App Store version does not provide Agent Access. No Node.js or Python installation is needed.

## Install

In Claude Code, run:

```text
/plugin install loci --marketplace AskLoci/loci-plugins
```

## Get started

1. Install the Loci plugin and start a new conversation.
2. Ask: “Help me set up Loci.”
3. If needed, [download Loci](https://askloci.ai/api/mac-download), open the disk image, open **Install Loci**, and follow its prompts.
4. Open Loci, complete first-time setup, and enable **Settings → Advanced → Agent Access**.
5. Return to your assistant. It checks your existing models and helps you choose a compatible download if needed. Keep Loci running during use.

A model download uses disk space and bandwidth. Existing Loci models are shared with the plugin. If a download is paused or fails, resume or retry it in Loci’s Models screen.

## Try it

- “Which Loci models are ready on my Mac?”
- “Use Loci to classify these messages as positive, negative or neutral.”
- “Use Loci to summarize these selected files.”

File, extraction, search and transcription tools are available only when the connected app advertises them. The plugin does not expose Loci conversations, memories, email accounts or internal app tools.

## Data and permissions

Model inference runs on your Mac. The assistant receives the prompts, paths and results used in your conversation, under that assistant’s data policies. Summaries, extracted values, evidence quotes, search passages and transcripts can disclose information from selected files.

The connector communicates only with Loci over local loopback. It reads Loci’s owner-only connection file and never needs you to paste its access token. Model downloads use the model sources configured by Loci. The connector has no separate analytics or external reporting endpoint; Loci’s own data practices are described in its privacy policy.

If the connection is unavailable, open Loci and check Agent Access. For damaged connection settings, quit and reopen Loci, then ask your assistant to check the connection again.

[Support](https://askloci.ai/support) · [Privacy](https://askloci.ai/privacy) · [Terms](https://askloci.ai/terms)
