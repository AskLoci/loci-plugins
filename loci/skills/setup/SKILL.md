---
name: setup
description: Download Loci for Mac, connect it to the plugin, and get a compatible model ready. Also use to repair the local connection.
---

# Set up Loci

Guide a new user from plugin installation to their first local answer. Assume they may not have Loci or a model. Loci requires an Apple silicon Mac with macOS 26.2 or later and the direct-download app. Check the host platform when available; on an unsupported host explain the requirement without starting a download.

## Get Loci and connect it

If this skill loads but Loci tools are missing, inspect the client’s plugin startup errors first. Update the plugin through its manager and use a current client. In Codex, an old manual `loci` MCP registration may still point into a deleted plugin-cache version. When repairing setup, back up and remove only a registration confirmed to point to a missing Loci connector, using `codex mcp remove loci`, after confirming the current plugin is installed. Preserve working or custom registrations and all other settings; keep credential values out of logs. Start a new conversation and verify that the plugin’s tools are available.

Call `loci_setup`. This tool works before Loci is installed and returns a connection check and the official download link. A missing connection can also mean the app is closed or Agent Access is off; do not describe it as proof the app is absent.

Give a short explanation of the problem and one concrete next action. Use available tools to help with authorized routine steps. Keep state codes, process IDs, ports and version numbers out of the user-facing explanation unless they are needed to resolve a version mismatch or the user asks for detail.

Follow the returned `next_step`:

- `check_models`: continue with model readiness below.
- `check_loci_connection`: identify the intended app and its profile, and check Agent Access. A stale or unverified connection is not proof that the app is missing. A responding `/health` endpoint alone is not a working connection.
- `repair_loci_connection`: use the targeted connection repair below. Do not send the user through installation or client registration again.
- `update_loci`: check the intended direct-download app for an update through its normal update flow, then check the connection again.
- `install_or_open_loci`: first check whether Loci is installed, open, and has Agent Access enabled. Offer installation only if the app is absent.

For an older connector without these fields, follow its specific error message and verify the installed plugin version. Do not interpret every failed check as a missing app.

When the app is absent, use this installation path:

1. [Download Loci for Mac](https://askloci.ai/api/mac-download). If Loci is already installed, open it instead.
2. Open the downloaded disk image, then open **Install Loci** and follow its prompts. Open the installed Loci app and complete its first-time setup.
3. In Loci, check that Settings → Advanced → Agent Access is enabled. Return here and say “Ready.”

Use this direct-download link rather than the Mac App Store, which does not provide Agent Access. When the user chooses to download, open the link with an available browser tool; otherwise leave the clickable link. Do not silently replace another app, change settings, stop a running session, or download a model. Give one next step at a time if the user needs help. For normal setup, no terminal commands, manual credential copying, or separate runtime installation are needed.

After the user returns, call `loci_setup` again. It rechecks the local connection and announces newly available model tools. If it is still disconnected, help with opening Loci or Agent Access; do not send an existing user through installation again or keep polling while waiting for them. If the host has not refreshed its tool list after a successful check, ask the user to reconnect the plugin and continue here.

If the saved connection is stale or unverified, identify the intended Loci app before changing anything. A development or test app may use a different profile from the normal app. Do not borrow its credentials, guess a port, or stop an unrelated running instance.

For damaged connection settings or a refused token, refresh Settings → Advanced → Agent Access by turning it off and on in the intended app when no work is running. Assist with this through available tools when authorized. Reopen that same app only if needed and safe. Then call `loci_setup` again before any model operation. Re-reading an unchanged file or re-registering a client does not repair stale settings. Do not edit credentials, weaken file permissions, or reinstall the app as the first recovery step. Stop after one unchanged repair attempt and explain the remaining mismatch. If Loci reports an installer error or macOS blocks it, show the specific next step from the installer; do not bypass macOS security warnings.

If `loci_setup` itself is unavailable, run the bundled `../../bin/loci-connector --check`, resolving the path from this skill folder. Use the specific diagnosis from that check to choose connection repair, app update, or installation. A failed check alone does not justify reinstalling Loci. Never treat the plugin's successful initialization alone as a successful connection to Loci.

The app and connector have separate versions. Compare `connector_version` from `loci_setup` with the installed plugin manifest when available. If the tool is older than the installed package or lacks its expected setup features, refresh the Loci marketplace/plugin and start a new conversation before diagnosing the app further. Updating the plugin does not update Loci, and updating Loci does not replace a cached plugin.

## Get the model ready

Call `loci_status` after connecting. If `ready` is false, wait briefly and check again; stop after three unchanged checks and give the user the next step in Loci. A successful connection check does not mean a model has answered. Reuse a suitable installed model instead of downloading another copy.

Honor an explicit model choice. Otherwise select for the task, context and reported limits, using `loci_choose` when advertised. Reuse a suitable loaded model for one short readiness check. Avoid cold-loading a large chat default solely because it is the default; without comparable measurements, a smaller adequate installed model is a resource-based choice, not a promised speed improvement. Preserve active work and the app's default preference, and pass the selected reported model ID explicitly.

If Loci's initial model is downloading, show its reported progress and let that download finish. Treat queued, stalled, installing, paused, and failed entries as an existing setup attempt. Ask the user to resume a paused download or retry a failed download in Loci; do not start a second model in its place. When the reported total is unknown, show downloaded bytes without a percentage. Installing means model setup is still running, even if all bytes have arrived. If progress goes backward or an unfinished download disappears, recheck status and ask the user to inspect Models in Loci; do not claim a restart or completion from that alone. Older app versions may omit paused downloads, so check in Loci before choosing another model if setup was already in progress.

If no suitable model is installed or being set up, examine the returned installable catalog. A missing or false `recommended` flag does not disqualify a compatible model. Require `fits_in_memory: true` and the task's capabilities; check reported disk and runtime constraints as well. Use recommendation flags as guidance. Among suitable choices for first setup, prefer a smaller adequate download rather than choosing solely by the Mac's RAM. Show the selected name and download size before asking to download unless that specific download is already authorized.

Request `loci_status` with `installable: true` only when its advertised schema supports it. If that option is absent, use the catalog already returned or help inspect Models in Loci. Update the app only when required capabilities or catalog details are unavailable. Do not repeatedly try unsupported arguments or declare that no model fits from missing recommendations or an unavailable catalog option. If a complete catalog is available and none meets the task's requirements, explain that constraint.

Use `loci_pull` only for the selected and authorized model. Show progress from its results, respect paused or failed downloads, and avoid unbounded polling. Once installed, use that model explicitly for the first task; downloading it need not change the app's default. The user can manage models from either Loci or Codex.

Finish the user's original task, or verify the selected model with one short synthetic prompt such as “Reply with Ready.” Mark setup complete only after a model returns a successful, nonempty answer. Keep Loci running during use; it can remain in the background.

The connector reads Loci's owner-only connection file on each request and checks the saved process, owner and loopback listener before sending its credential. Never print or copy that credential into chat, configuration, commands, logs, or the plugin package.

Explain the data boundary when relevant: Loci runs model inference on the Mac, while paths, prompts and returned results shared with Codex remain part of the Codex workflow. Do not promise that a Codex conversation stays entirely on the device. When the connected app advertises file tools, Loci can read authorized paths directly without the assistant first reading their contents. Returned summaries, extracted values, quotes, previews and search passages can still disclose source information. If the user's requirement prohibits that disclosure, do not read those files or invoke tools that return their contents.
