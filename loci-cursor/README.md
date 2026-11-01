# Loci for Cursor

Use models on your Mac for summaries, rewriting, classification, structured output and batch processing. With Loci 0.1.28 or later, you can also process selected files, extract document records, search folders and transcribe audio files. The plugin checks which tools your installed app provides.

## Requirements

An Apple silicon Mac with 8 GB of memory or more and macOS 26.2 or later, Cursor running locally, and the [Loci direct-download app](https://askloci.ai/api/mac-download). Loci 0.1.28 or later provides every tool. Loci 0.1.21 to 0.1.27 provide model status, text generation, batch processing, model downloads and model loading only. The Mac App Store version does not provide Agent Access. No Node.js or Python installation is needed.

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

The connector communicates only with Loci over local loopback and never needs you to paste its access token. For each request, it reads Loci’s owner-only connection file, or the file named by the `LOCI_AGENT_API_FILE` environment variable, and runs macOS `lsof` to confirm that the local port belongs to the Loci process named in that file and to your user account. Only then does it send the token. Each request’s User-Agent carries the name and version Cursor reports, reduced to letters and digits, followed by the connector version. Model downloads use the model sources configured by Loci. The connector has no analytics of its own.

Loci’s diagnostic sharing is on by default. While it is on, Loci records one event for each call from your assistant: the tool, how the call ended and the model engine used. Loci records calls from Cursor without an assistant name. Loci also records which tool made the first call a model answered on your Mac. Model work your assistant starts also produces Loci’s usual content-free performance diagnostics, such as which model ran and how long it took. These events contain no prompts, file paths, file contents or results. To stop sharing, turn off diagnostic sharing in Loci under Settings → Advanced → Privacy. Loci’s data practices are described in its [privacy policy](https://askloci.ai/privacy).

If the connection is unavailable, open Loci and check Agent Access. For damaged connection settings, quit and reopen Loci, then ask your assistant to check the connection again.

[Support](https://askloci.ai/support) · [Privacy](https://askloci.ai/privacy) · [Terms](https://askloci.ai/terms)
