---
name: setup
description: Set up Loci for Hermes on a Mac, download a compatible model when authorized, and repair a failed local connection.
---

# Set up Loci

Guide the user to their first local model answer. They may not have Loci or a model. Requires Hermes 0.23.0 or later running locally on an Apple silicon Mac with macOS 26.2 or later. This package cannot reach a Mac from a remote Hermes server, container, Linux or Windows. Check the execution host before downloading anything.

## Connect

Use the host's available Loci MCP tools. Call `loci_status` if it is available. This Hermes package has no `loci_setup` tool or separate executable connector; a successful plugin install alone does not establish a connection.

If Loci tools are missing, check whether the plugin is enabled and whether the direct-download Loci app is installed and running on this Mac. The setup skill remains available before app installation. Give one concrete next step based on the observed state; a missing connection does not mean the app is absent.

When the app is absent:

1. Offer [Download Loci for Mac](https://askloci.ai/download/mac/0.1.33/0.1.33/Loci-48038e3963f894b295bf4e449879fc30790826732bf74d9e6fc7324aaadc90ec.dmg/Loci.dmg). Use available tools to help with authorized installation.
2. Before opening the downloaded image, verify its SHA-256 is `48038e3963f894b295bf4e449879fc30790826732bf74d9e6fc7324aaadc90ec` and its size is 61,905,465 bytes. This pins the official Loci 0.1.33 installer. Stop on a mismatch; do not substitute another download or bypass verification.
3. Open the verified disk image and run **Install Loci**. Complete first-time setup in the installed app.
4. Enable **Settings → Advanced → Agent Access**, then keep Loci running in the background.
5. Run `/reload-mcp` or start a new Hermes session to connect and discover its tools; call `loci_status`.

Use the direct-download app, because the Mac App Store version does not expose Agent Access. Do not replace an existing installation, download a model or alter another session without authorization. Do not bypass macOS security warnings. No manual credential copying or extra Node.js runtime is needed.

Hermes discovers the endpoint through its built-in application connection and handles authentication. Never read, copy, print, or write the discovery token. Do not guess a port or fall back to unauthenticated requests. Do not reconfigure the user's model provider to use Loci; these tools complement that provider.

For stale settings, HTTP 401, or a connection that points to the wrong app: identify the intended Loci installation and profile. Refresh Agent Access by turning it off and on in that app when no work is active, then run `/reload-mcp` in Hermes or start a new session. A responding health endpoint alone is insufficient. Re-reading an unchanged credential file cannot repair a stale connection. Preserve development profiles, unrelated apps and active work. Stop after one unchanged repair attempt and explain the remaining mismatch.

App and plugin updates are separate. Check the app's advertised schemas instead of assuming every listed feature exists. If Hermes cannot offer the plugin on an older release, update Hermes through its normal update flow. Preserve the user's existing manual MCP configuration if it conflicts with the server name `loci`; explain the conflict before changing it.

Hermes asks for approval for write-capable tool calls. Respect denied or unavailable approvals; an unattended job must stop with an actionable result instead of attempting another route.

## Get the model ready

Call `loci_status` after connecting. If `ready` is false, wait briefly and check again; stop after three unchanged checks and give the user the next step in Loci. A successful connection check does not mean a model has answered. Reuse a suitable installed model instead of downloading another copy.

Honor an explicit model choice. Otherwise select for the task, context and reported limits, using `loci_choose` when advertised. Reuse a suitable loaded model for one short readiness check. Avoid cold-loading a large chat default solely because it is the default; without comparable measurements, a smaller adequate installed model is a resource-based choice, not a promised speed improvement. Preserve active work and the app's default preference, and pass the selected reported model ID explicitly.

When reported, `models.checking` lists model IDs whose local files await or are undergoing inspection; checking alone does not prove readiness. A suitable model already in `models.installed` remains usable while its files are checked. If the chosen model is absent from `installed` and listed in `checking`, or no suitable installed model exists while checks remain, preserve those checks and do not start a replacement download. Wait a few seconds between at most three status rechecks, even if `ready` is true. If checks remain, report that Loci is still checking and inspect Models in Loci. Use the model only after it appears in `models.installed`; an ID disappearing from `checking` alone does not prove success. Inspect its result in Models before retrying or downloading. Older apps may omit `checking`; when files or setup already exist, inspect Models before treating an absent installed entry as a missing download.

If Loci's initial model is downloading, show its reported progress and let that download finish. Treat queued, stalled, installing, paused, and failed entries as an existing setup attempt. Ask the user to resume a paused download or retry a failed download in Loci; do not start a second model in its place. When the reported total is unknown, show downloaded bytes without a percentage. Installing means model setup is still running, even if all bytes have arrived. If progress goes backward or an unfinished download disappears, recheck status and ask the user to inspect Models in Loci; do not claim a restart or completion from that alone. Older app versions may omit paused downloads, so check in Loci before choosing another model if setup was already in progress.

If no suitable model is installed or being set up, examine the returned installable catalog. A missing or false `recommended` flag does not disqualify a compatible model. Require `fits_in_memory: true` and the task's capabilities; check reported disk and runtime constraints as well. Use recommendation flags as guidance. Among suitable choices for first setup, prefer a smaller adequate download rather than choosing solely by the Mac's RAM. Show the selected name and download size before asking to download unless that specific download is already authorized.

Request `loci_status` with `installable: true` only when its advertised schema supports it. If that option is absent, use the catalog already returned or help inspect Models in Loci. Update the app only when required capabilities or catalog details are unavailable. Do not repeatedly try unsupported arguments or declare that no model fits from missing recommendations or an unavailable catalog option. If a complete catalog is available and none meets the task's requirements, explain that constraint.

Use `loci_pull` only for the selected and authorized model. Show progress from its results, respect paused or failed downloads, and avoid unbounded polling. Once installed, use that model explicitly for the first task; downloading it need not change the app's default. The user can manage models from either Loci or Hermes.

Finish the user's original task, or verify the selected model with one short synthetic prompt such as “Reply with Ready.” Mark setup complete only after a model returns a successful, nonempty answer. Keep Loci running during use; it can remain in the background.

Inference runs on the Mac. Prompts, paths and results returned to Hermes follow the configured model provider's data policies. File tools can process authorized paths without Hermes first reading whole files, but returned summaries, values, quotes and transcripts can disclose their contents. If that disclosure conflicts with the user's requirement, do not invoke a tool that returns them.
