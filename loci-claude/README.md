# Loci for Claude Code

Use models on your Mac for summaries, rewriting, classification, structured output and batch processing. With Loci 0.1.28 or later, you can also process selected files, extract document records, search folders and transcribe audio files. The plugin checks which tools your installed app provides.

## Requirements

An Apple silicon Mac with 8 GB of memory or more and macOS 26.2 or later, Claude Code running locally, and the [Loci direct-download app](https://askloci.ai/api/mac-download). Loci 0.1.28 or later provides every tool. Loci 0.1.21 to 0.1.27 provide model status, text generation, batch processing, model downloads and model loading only. The Mac App Store version does not provide Agent Access. [Node.js 22 or later](https://nodejs.org/) must be available as `node` on Claude Code’s PATH. No additional npm packages are required.

If startup reports `node` not found, `ENOENT`, or an outdated Node version, install an LTS version from [nodejs.org](https://nodejs.org/) and restart Claude Code. If Node is already installed, check that `node --version` reports 22 or later in your terminal, then start Claude Code from that terminal. A missing Node runtime does not mean Loci needs reinstalling.

## Install

In Claude Code, run:

```text
/plugin marketplace add AskLoci/loci-plugins
/plugin install loci@askloci
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

The connector communicates only with Loci over local loopback and never needs you to paste its access token. For each request, it reads Loci’s owner-only connection file, or the file named by the `LOCI_AGENT_API_FILE` environment variable, and runs macOS `lsof` to confirm that the local port belongs to the Loci process named in that file and to your user account. Only then does it send the token. Each request’s User-Agent gives the name and version your assistant reports, followed by the connector version. Model downloads use the model sources configured by Loci. The connector has no analytics of its own and connects to nothing outside your Mac.

Loci’s diagnostic sharing is on by default. While it is on, Loci records one event for each call from your assistant: the tool, how the call ended, whether the caller identified itself as Claude Code or Codex, and the model engine used. Loci also records which tool made the first call a model answered on your Mac. Model work your assistant starts also produces Loci’s usual content-free performance diagnostics, such as which model ran and how long it took. These events contain no prompts, file paths, file contents or results. To stop sharing, turn off diagnostic sharing in Loci under Settings → Advanced → Privacy. Loci’s data practices are described in its [privacy policy](https://askloci.ai/privacy).

If the connection is unavailable, open Loci and check Agent Access. For damaged connection settings, first identify the intended Loci app. Let active work and downloads finish before turning Settings → Advanced → Agent Access off and on. Then ask your assistant to check the connection again. Reopen that same app only if needed and safe.

[Support](https://askloci.ai/support) · [Privacy](https://askloci.ai/privacy) · [Terms](https://askloci.ai/terms)
