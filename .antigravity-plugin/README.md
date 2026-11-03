# Loci for Antigravity

Use local models on your Mac to summarize text, classify batches, or produce structured answers. On compatible Loci versions you can also work with selected files, search folders, and transcribe audio. Ask “Which Loci models are ready on my Mac?” to see what your installation supports.

## Requirements

Use Antigravity locally on an Apple silicon Mac running macOS 26.2 or later. Install [Node.js 22 or later](https://nodejs.org/) and the [direct-download Loci Mac app](https://askloci.ai/api/mac-download). The Mac App Store edition does not provide Agent Access.

## Install the plugin

Download or clone the [public plugin repository](https://github.com/AskLoci/loci-plugins). From the repository folder, run:

```sh
agy plugin install .
agy plugin list
```

Start a new Antigravity conversation and ask “Help me set up Loci on this Mac.” If you still need the Mac app, open its downloaded disk image, launch **Install Loci**, and follow the prompts. Open Loci, finish first-time setup, then turn on **Settings → Advanced → Agent Access**. Keep Loci open while you work. Approve the connection in Loci if prompted.

Loci uses your installed models. If your first model download is underway, check its progress in **Models**. You can pause, resume or retry it there. If you need a new model, ask for a compatible choice and its download size before starting it.

If Antigravity cannot find Node, check that `node --version` reports 22 or later in your terminal, then restart Antigravity from that terminal. For connection or model problems, use the [Loci setup and recovery guide](https://askloci.ai/agents/).

## Data and permissions

Inference runs on your Mac. Prompts, file paths and results shared with Antigravity become part of its conversation and follow its data policies. Results such as summaries, quoted passages or transcripts can contain information from selected files. The connector communicates with Loci over local loopback. It reads the app’s owner-only connection file, so you never need to paste an access token. Downloaded models use Loci’s configured model sources.

[Support](https://askloci.ai/support) · [Privacy](https://askloci.ai/privacy)
