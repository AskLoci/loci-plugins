---
name: setup
description: Download Loci for Mac, connect it to the plugin, and get a compatible model ready. Also use to repair the local connection.
---

# Set up Loci

Guide a new user from plugin installation to their first local answer. Assume they may not have Loci or a model. Loci requires an Apple silicon Mac with macOS 26.2 or later and the direct-download app. Check the host platform when available; on an unsupported host explain the requirement without starting a download.

## Get Loci and connect it

Call `loci_setup`. This tool works before Loci is installed and returns a connection check and the official download link. A missing connection can also mean the app is closed or Agent Access is off; do not describe it as proof the app is absent.

If `next_step` is `check_loci_connection`, follow the returned connection guidance: check that the intended direct-download app is open with Agent Access enabled, then call `loci_setup` again. Do not treat a stale or unverifiable connection as a missing installation, or stop another running Loci session.

Otherwise, when not connected, lead with this short path rather than configuration instructions:

1. [Download Loci for Mac](https://askloci.ai/api/mac-download). If Loci is already installed, open it instead.
2. Open the downloaded disk image, then open **Install Loci** and follow its prompts. Open the installed Loci app and complete its first-time setup.
3. In Loci, check that Settings → Advanced → Agent Access is enabled. Return here and say “Ready.”

Use this direct-download link rather than the Mac App Store, which does not provide Agent Access. When the user chooses to download, open the link with an available browser tool; otherwise leave the clickable link. Do not silently replace another app, change settings, stop a running session, or download a model. Give one next step at a time if the user needs help. No terminal commands, manual credential copying, or separate runtime installation are needed.

After the user returns, call `loci_setup` again. It rechecks the local connection and announces newly available model tools. If it is still disconnected, help with opening Loci or Agent Access; do not send an existing user through installation again or keep polling while waiting for them. If the host has not refreshed its tool list after a successful check, ask the user to reconnect the plugin and continue here.

If the check reports damaged connection settings, an invalid access token, or unsafe file permissions, ask the user to quit and reopen Loci, then call `loci_setup` again. Loci recreates its connection settings when it starts. Do not edit the file, weaken its permissions, copy credentials, or reinstall the app as the first recovery step. If Loci reports an installer error or macOS blocks it, show the specific next step from the installer; do not bypass macOS security warnings.

If `loci_setup` itself is unavailable, run the bundled `../../bin/loci-connector --check`, resolving the path from this skill folder. A failed check still leads to the same download-and-connect path above. Never treat the plugin's successful initialization alone as a successful connection to Loci.

## Get the model ready

Call `loci_status` after connecting. If `ready` is false, wait briefly and check again; stop after three unchanged checks and give the user the next step in Loci. Prefer the existing installed default model. A model already downloaded in Loci is shared with the plugin and does not need another copy.

If Loci's initial model is downloading, show its reported progress and let that download finish. Treat queued, stalled, installing, paused, and failed entries as an existing setup attempt. Ask the user to resume a paused download or retry a failed download in Loci; do not start a second model in its place. When the reported total is unknown, show downloaded bytes without a percentage. Installing means model setup is still running, even if all bytes have arrived. If progress goes backward or an unfinished download disappears, recheck status and ask the user to inspect Models in Loci; do not claim a restart or completion from that alone. Older app versions may omit paused downloads, so check in Loci before choosing another model if setup was already in progress.

If no suitable model is installed or being set up, choose a model from the reported installable list with `fits_in_memory: true`, preferring `recommended: true`. Show its name and download size before asking to download unless the user already authorized that specific download. If several qualify, prefer the smaller recommended download for first setup; do not invent a model ID or send everyone the same large model. If none qualifies, explain that no compatible model is currently offered.

Use `loci_pull` only for the selected and authorized model. Show progress from its results, respect paused or failed downloads, and avoid unbounded polling. Once installed, use that model explicitly for the first task; downloading it need not change the app's default. The user can manage models from either Loci or Codex.

Finish the user's original task, or check the connection with one short synthetic prompt such as “Reply with Ready.” Mark setup complete only after a model returns a successful, nonempty answer. Keep Loci running during use; it can remain in the background.

The connector reads Loci's owner-only connection file on each request and checks the saved process, owner and loopback listener before sending its credential. Never print or copy that credential into chat, configuration, commands, logs, or the plugin package.

Explain the data boundary when relevant: Loci runs model inference on the Mac, while paths, prompts and returned results shared with Codex remain part of the Codex workflow. Do not promise that a Codex conversation stays entirely on the device. When the connected app advertises file tools, Loci can read authorized paths directly without the assistant first reading their contents. Returned summaries, extracted values, quotes, previews and search passages can still disclose source information. If the user's requirement prohibits that disclosure, do not read those files or invoke tools that return their contents.
