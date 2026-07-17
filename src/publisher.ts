import { Notice, TFile, TFolder, normalizePath } from "obsidian";
import type GithubPagesSharePlugin from "./main";
import { GithubApiError, GithubClient } from "./github";
import { PublishResultModal, UnpublishConfirmModal } from "./modal";
import { slugify, transformNote, escapeYamlString } from "./transform";
import { deriveBaseUrl, type GithubPagesShareSettings, type PublishedNoteRecord } from "./settings";
import { CALLOUTS_CSS } from "./callouts.css";

const HEAD_CUSTOM_MARKER = "<!-- gps-callouts-v1 -->";
const HEAD_CUSTOM_LINK = `<link rel="stylesheet" href="{{ '/assets/callouts.css' | relative_url }}">`;

const HEAD_CUSTOM_BASE = `<script type="module">
  import mermaid from "https://cdn.jsdelivr.net/npm/mermaid@11.16.0/dist/mermaid.esm.min.mjs";
  document.querySelectorAll("pre code.language-mermaid, pre > code.language-mermaid").forEach((code) => {
    const pre = code.closest("pre");
    const container = document.createElement("pre");
    container.className = "mermaid";
    container.textContent = code.textContent;
    pre.replaceWith(container);
  });
  mermaid.initialize({ startOnLoad: true });
</script>
${HEAD_CUSTOM_LINK}
${HEAD_CUSTOM_MARKER}
`;

/** Longer-lived Notice duration (ms) for terminal result messages the user needs time to read. */
const LONG_NOTICE_MS = 15000;

function describeError(error: unknown): string {
	if (error instanceof GithubApiError) {
		if (error.status === 401) return "GitHub rejected the token. Check the personal access token in settings.";
		if (error.status === 403) return "GitHub denied the request. Check the token's repo permissions.";
		if (error.status === 404) return "Repository not found. Check the owner/name and token access in settings.";
		if (error.status === 409) return "GitHub reported a conflict while saving. Please try again.";
		if (error.status === 422 && /fast.forward/i.test(error.message))
			return "Another publish updated the repo at the same time. Please try again.";
		return `GitHub error: ${error.message}`;
	}
	if (error instanceof Error) return error.message;
	return "Unknown error while talking to GitHub.";
}

function buildShareLink(settings: GithubPagesShareSettings, slug: string): string {
	const base = (settings.baseUrl || deriveBaseUrl(settings)).replace(/\/+$/, "");
	return `${base}/${settings.notesFolder}/${slug}.html`;
}

/** A file staged for a Git Data API commit. */
type RepoFile = { path: string; content: string };

/**
 * These build* helpers produce the scaffolding files (Jekyll config, index, head include, callout
 * styles) that publishNote/setupRepo fold into a single commit. Each keeps its original create-only
 * / marker existence check but returns {path, content} (or null when nothing needs writing) instead
 * of writing on its own, so all of a publish's files land in one atomic commit. The existence reads
 * don't need to be atomic with the write: a stale read only re-writes identical content (today's
 * behavior), never a conflict.
 */
async function buildJekyllConfigFile(
	client: GithubClient,
	settings: GithubPagesShareSettings,
): Promise<RepoFile | null> {
	const existingSha = await client.getFileSha("_config.yml");
	if (existingSha) return null;
	const repoName = settings.repo.split("/")[1] ?? settings.repo;
	const yaml = `theme: jekyll-theme-primer\ntitle: "${escapeYamlString(repoName)}"\n`;
	return { path: "_config.yml", content: yaml };
}

async function buildCalloutStylesFile(client: GithubClient): Promise<RepoFile | null> {
	const existingSha = await client.getFileSha("assets/callouts.css");
	if (existingSha) return null;
	return { path: "assets/callouts.css", content: CALLOUTS_CSS };
}

async function buildHeadCustomFile(client: GithubClient): Promise<RepoFile | null> {
	const existing = await client.getFileContent("_includes/head-custom.html");
	if (existing === null) {
		return { path: "_includes/head-custom.html", content: HEAD_CUSTOM_BASE };
	}
	if (existing.includes(HEAD_CUSTOM_MARKER)) return null;
	const updated = existing.endsWith("\n")
		? `${existing}${HEAD_CUSTOM_LINK}\n${HEAD_CUSTOM_MARKER}\n`
		: `${existing}\n${HEAD_CUSTOM_LINK}\n${HEAD_CUSTOM_MARKER}\n`;
	return { path: "_includes/head-custom.html", content: updated };
}

async function buildIndexPageFile(
	client: GithubClient,
	settings: GithubPagesShareSettings,
): Promise<RepoFile | null> {
	const existingSha = await client.getFileSha("index.md");
	if (existingSha) return null;
	const repoName = settings.repo.split("/")[1] ?? settings.repo;
	const markdown = `---\ntitle: "${escapeYamlString(repoName)}"\n---\n\nNotes published from Obsidian appear here. Maintain this index manually as you publish more notes.\n`;
	return { path: "index.md", content: markdown };
}

function hasConnectionSettings(settings: GithubPagesShareSettings): boolean {
	return settings.token.length > 0 && settings.repo.length > 0;
}

export interface PublishOptions {
	/** Auto-update path: no clipboard write, no success notice; failures still notify. */
	quiet?: boolean;
}

/** Guards against a manual publish and an auto-update racing on the same note (TOCTOU on sha). */
const inFlightPublishes = new Set<string>();

/** Reads a note, converts it, uploads it (and any embedded images), and copies its share link. */
export async function publishNote(
	plugin: GithubPagesSharePlugin,
	file: TFile,
	options: PublishOptions = {},
): Promise<boolean> {
	const quiet = options.quiet ?? false;
	if (file.extension !== "md") {
		if (!quiet) new Notice("Only Markdown notes can be published.");
		return false;
	}
	const settings = plugin.settings;
	if (!hasConnectionSettings(settings)) {
		if (!quiet) new Notice("Set a GitHub token and repository in the plugin settings first.");
		return false;
	}

	if (inFlightPublishes.has(file.path)) {
		if (!quiet) new Notice("This note is already being published.");
		return false;
	}

	let client: GithubClient;
	try {
		client = new GithubClient(settings);
	} catch (error) {
		if (!quiet) new Notice(describeError(error));
		return false;
	}

	inFlightPublishes.add(file.path);
	// Persistent progress notice (manual path only); duration 0 keeps it up until hide().
	const progress = quiet ? null : new Notice(`Publishing ${file.basename}...`, 0);
	try {
		const rawContent = await plugin.app.vault.cachedRead(file);
		const existing = settings.registry[file.path];
		const slug = existing?.slug ?? slugify(file.basename, file.path);
		const repoPath = normalizePath(`${settings.notesFolder}/${slug}.md`);

		const { content, attachments } = transformNote(plugin.app, file, rawContent, settings);

		// Fallback so publishing still works even if "Set up Pages repo" was never run; these only
		// produce a file when it's missing and are committed together with the note below.
		const scaffolding = (
			await Promise.all([
				buildJekyllConfigFile(client, settings),
				buildHeadCustomFile(client),
				buildCalloutStylesFile(client),
			])
		).filter((repoFile): repoFile is RepoFile => repoFile !== null);

		const files: Array<{ path: string; content: string | ArrayBuffer }> = [...scaffolding];
		for (let i = 0; i < attachments.length; i++) {
			progress?.setMessage(`Reading image ${i + 1} of ${attachments.length}...`);
			const attachment = attachments[i];
			const data = await plugin.app.vault.readBinary(attachment.file);
			files.push({ path: attachment.repoPath, content: data });
		}
		files.push({ path: repoPath, content });

		// One atomic commit for the note, its attachments, and any scaffolding: no per-file sha race
		// (the root cause of the 409/422 conflicts) and Pages rebuilds once instead of N times.
		const message =
			attachments.length > 0
				? `Publish note ${file.basename} (+${attachments.length} asset${attachments.length > 1 ? "s" : ""})`
				: `Publish note ${file.basename}`;
		progress?.setMessage("Committing to GitHub...");
		await client.commitFiles(files, message);

		const record: PublishedNoteRecord = {
			repoPath,
			slug,
			attachments: attachments.map((a) => a.repoPath),
		};
		settings.registry[file.path] = record;
		await plugin.saveSettings();

		if (!quiet) {
			// Check Pages once (until confirmed) so we can warn instead of handing out a dead link.
			// Do this before building the link so a corrected base URL applies to it.
			let pagesNotEnabled = false;
			if (!settings.pagesConfirmed) {
				progress?.setMessage("Checking pages status...");
				try {
					const pagesInfo = await client.getPagesInfo();
					if (pagesInfo) {
						settings.pagesConfirmed = true;
						// Always overwrite: the previously saved baseUrl belongs to the previous repo.
						settings.baseUrl = pagesInfo.url.replace(/\/+$/, "");
						await plugin.saveSettings();
					} else {
						pagesNotEnabled = true;
					}
				} catch {
					// Status unknown (e.g. token can't read Pages): don't warn, and re-check next time.
				}
			}

			const link = buildShareLink(settings, slug);
			let copiedToClipboard = false;
			try {
				await navigator.clipboard.writeText(link);
				copiedToClipboard = true;
			} catch {
				// Reflected in the modal's status text instead.
			}

			progress?.hide();
			new PublishResultModal(plugin.app, {
				link,
				copiedToClipboard,
				pagesNotEnabled,
				onSetupRepo: () => {
					void setupRepo(plugin);
				},
			}).open();
		}
		return true;
	} catch (error) {
		progress?.hide();
		new Notice(quiet ? `Auto-update failed for ${file.basename}: ${describeError(error)}` : describeError(error));
		return false;
	} finally {
		// Safety net: hide() is idempotent, so a stray persistent notice can never survive.
		progress?.hide();
		inFlightPublishes.delete(file.path);
	}
}

/** Copies the share link for a note that has already been published. */
export async function copyPublishedLink(plugin: GithubPagesSharePlugin, file: TFile): Promise<void> {
	const record = plugin.settings.registry[file.path];
	if (!record) {
		new Notice("This note has not been published yet.");
		return;
	}
	const link = buildShareLink(plugin.settings, record.slug);
	await navigator.clipboard.writeText(link);
	new Notice(`Link copied to clipboard:\n${link}`);
}

/**
 * Collects every attachment repo path referenced by any published note other than `excludePath`.
 * Records written before the `attachments` field existed simply contribute nothing, which is
 * the right behavior for a v1.1 → v1.2 upgrade.
 */
export function collectReferencedAttachments(
	registry: Record<string, PublishedNoteRecord>,
	excludePath: string,
): Set<string> {
	const referenced = new Set<string>();
	for (const [path, record] of Object.entries(registry)) {
		if (path === excludePath) continue;
		for (const attachment of record.attachments ?? []) {
			referenced.add(attachment);
		}
	}
	return referenced;
}

/**
 * Removes a note (and any attachments only it uses) from the GitHub Pages repo. The registry
 * entry is only cleared once the .md deletion succeeds, so a failed delete is safe to retry.
 */
export async function unpublishNote(
	plugin: GithubPagesSharePlugin,
	file: TFile,
): Promise<void> {
	const settings = plugin.settings;
	const record = settings.registry[file.path];
	if (!record) {
		new Notice("This note has not been published.");
		return;
	}

	const referenced = collectReferencedAttachments(settings.registry, file.path);
	const ownAttachments = record.attachments ?? [];
	const orphans = ownAttachments.filter((path) => !referenced.has(path));

	const confirmed = await new Promise<boolean>((resolve) => {
		let resolved = false;
		const modal = new UnpublishConfirmModal(plugin.app, {
			noteName: file.basename,
			attachmentCount: orphans.length,
			onConfirm: () => {
				resolved = true;
				resolve(true);
				modal.close();
			},
		});
		const baseOnClose = modal.onClose.bind(modal);
		modal.onClose = () => {
			baseOnClose();
			if (!resolved) resolve(false);
		};
		modal.open();
	});
	if (!confirmed) return;

	let client: GithubClient;
	try {
		client = new GithubClient(settings);
	} catch (error) {
		new Notice(describeError(error));
		return;
	}

	const progress = new Notice(`Unpublishing ${file.basename}...`, 0);
	const attachmentFailures: string[] = [];
	let orphansRemoved = 0;
	try {
		for (const repoPath of orphans) {
			try {
				await client.deleteFile(repoPath, `Remove orphan asset ${repoPath}`);
				orphansRemoved++;
			} catch {
				attachmentFailures.push(repoPath);
			}
		}

		// If the .md delete fails, throw before touching the registry so the user can retry.
		await client.deleteFile(record.repoPath, `Unpublish note ${file.basename}`);

		delete settings.registry[file.path];
		await plugin.saveSettings();
		plugin.clearAutoUpdateTimer(file.path);

		progress.hide();
		let message = `Unpublished ${file.basename}.`;
		if (orphansRemoved > 0) {
			message += ` ${orphansRemoved} unused attachments removed.`;
		}
		new Notice(message);
		if (attachmentFailures.length > 0) {
			new Notice(
				`Could not remove ${attachmentFailures.length} attachment(s); the note was unpublished anyway. Affected paths: ${attachmentFailures.join(", ")}.`,
			);
		}
	} catch (error) {
		progress.hide();
		new Notice(describeError(error));
	} finally {
		// Safety net: hide() is idempotent, so a stray persistent notice can never survive.
		progress.hide();
	}
}

/** Idempotently prepares an existing GitHub repo for Pages: config, index page, and enabling Pages. */
export async function setupRepo(plugin: GithubPagesSharePlugin): Promise<void> {
	const settings = plugin.settings;
	if (!hasConnectionSettings(settings)) {
		new Notice("Set a GitHub token and repository in the plugin settings first.");
		return;
	}

	let client: GithubClient;
	try {
		client = new GithubClient(settings);
	} catch (error) {
		new Notice(describeError(error));
		return;
	}

	// Persistent progress notice; duration 0 keeps it up until hide().
	const progress = new Notice("Setting up pages repo...", 0);
	try {
		progress.setMessage("Checking repository...");
		const repoInfo = await client.getRepo();
		if (repoInfo.private) {
			new Notice("Repository is private. Free GitHub Pages requires a public repository.");
		}

		progress.setMessage("Preparing repo files...");
		const scaffolding = (
			await Promise.all([
				buildJekyllConfigFile(client, settings),
				buildIndexPageFile(client, settings),
				buildHeadCustomFile(client),
				buildCalloutStylesFile(client),
			])
		).filter((repoFile): repoFile is RepoFile => repoFile !== null);
		if (scaffolding.length > 0) {
			progress.setMessage("Committing repo files...");
			await client.commitFiles(scaffolding, "Set up GitHub Pages repo files");
		}

		progress.setMessage("Enabling pages...");
		try {
			await client.enablePages();
		} catch (error) {
			if (error instanceof GithubApiError && error.status === 403) {
				// Enabling Pages needs Administration:write, but Pages may already be live (enabled
				// manually) with only Pages:read. Confirm via GET before treating the 403 as fatal.
				const alreadyLive = await client.getPagesInfo().catch(() => null);
				if (!alreadyLive) {
					progress.hide();
					new Notice(
						"To complete GitHub Pages setup, open the repo's Settings tab, click Pages in the left sidebar, and enable Pages. Once Pages is enabled, you can start publishing.",
						0,
					);
					return;
				}
				// Pages is already live; fall through to the confirmation block below.
			} else {
				throw error;
			}
		}

		// enablePages succeeded (or returned 409 = already enabled), so Pages is confirmed on.
		settings.pagesConfirmed = true;
		await plugin.saveSettings();

		progress.setMessage("Checking pages status...");
		const pagesInfo = await client.getPagesInfo();
		progress.hide();
		if (pagesInfo) {
			// Always overwrite: the previously saved baseUrl belongs to the previous repo.
			settings.baseUrl = pagesInfo.url.replace(/\/+$/, "");
			await plugin.saveSettings();
			new Notice(`Pages is set up: ${pagesInfo.url}`, LONG_NOTICE_MS);
		} else {
			new Notice("Repo files are ready, but pages status could not be confirmed yet.", LONG_NOTICE_MS);
		}
	} catch (error) {
		progress.hide();
		new Notice(describeError(error), LONG_NOTICE_MS);
	} finally {
		// Safety net: hide() is idempotent, so a stray persistent notice can never survive.
		progress.hide();
	}
}

/** Publishes every Markdown note inside a folder, surfacing progress and a summary. */
export async function publishFolder(plugin: GithubPagesSharePlugin, folder: TFolder): Promise<void> {
	if (!hasConnectionSettings(plugin.settings)) {
		new Notice("Set a GitHub token and repository in the plugin settings first.");
		return;
	}

	const prefix = folder.path === "/" ? "" : `${folder.path}/`;
	const files = plugin.app.vault
		.getMarkdownFiles()
		.filter((file) => file.path.startsWith(prefix))
		.sort((a, b) => a.path.localeCompare(b.path));

	if (files.length === 0) {
		new Notice("No Markdown notes in this folder.");
		return;
	}

	const progress = new Notice(`Publishing 0 / ${files.length} notes...`, 0);
	const failures: string[] = [];
	let successCount = 0;
	try {
		for (let i = 0; i < files.length; i++) {
			const file = files[i];
			progress.setMessage(`Publishing ${i + 1} / ${files.length}: ${file.basename}...`);
			try {
				const ok = await publishNote(plugin, file, { quiet: true });
				if (ok) {
					successCount++;
				} else {
					failures.push(file.basename);
				}
			} catch {
				failures.push(file.basename);
			}
		}
	} finally {
		// Safety net: hide() is idempotent, so a stray persistent notice can never survive.
		progress.hide();
	}

	if (failures.length === 0) {
		new Notice(`Published ${files.length} notes to GitHub Pages.`);
	} else if (successCount === 0) {
		new Notice(`Failed to publish ${files.length} notes.`);
	} else {
		const sample = failures.slice(0, 3).join(", ");
		new Notice(`Published ${successCount} of ${files.length} notes. ${failures.length} failed: ${sample}.`);
	}
}
