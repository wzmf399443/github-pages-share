import { Notice, TFile, normalizePath } from "obsidian";
import type GithubPagesSharePlugin from "./main";
import { GithubApiError, GithubClient } from "./github";
import { PublishResultModal } from "./modal";
import { slugify, transformNote } from "./transform";
import { deriveBaseUrl, type GithubPagesShareSettings, type PublishedNoteRecord } from "./settings";

function describeError(error: unknown): string {
	if (error instanceof GithubApiError) {
		if (error.status === 401) return "GitHub rejected the token. Check the personal access token in settings.";
		if (error.status === 403) return "GitHub denied the request. Check the token's repo permissions.";
		if (error.status === 404) return "Repository not found. Check the owner/name and token access in settings.";
		if (error.status === 409) return "GitHub reported a conflict while saving. Please try again.";
		return `GitHub error: ${error.message}`;
	}
	if (error instanceof Error) return error.message;
	return "Unknown error while talking to GitHub.";
}

function buildShareLink(settings: GithubPagesShareSettings, slug: string): string {
	const base = (settings.baseUrl || deriveBaseUrl(settings)).replace(/\/+$/, "");
	return `${base}/${settings.notesFolder}/${slug}.html`;
}

async function ensureJekyllConfig(client: GithubClient, settings: GithubPagesShareSettings): Promise<void> {
	const existingSha = await client.getFileSha("_config.yml");
	if (existingSha) return;
	const repoName = settings.repo.split("/")[1] ?? settings.repo;
	const yaml = `theme: jekyll-theme-primer\ntitle: "${repoName.replace(/"/g, '\\"')}"\n`;
	await client.putFile("_config.yml", yaml, "Add Jekyll config for GitHub Pages");
}

async function ensureIndexPage(client: GithubClient, settings: GithubPagesShareSettings): Promise<void> {
	const existingSha = await client.getFileSha("index.md");
	if (existingSha) return;
	const repoName = settings.repo.split("/")[1] ?? settings.repo;
	const markdown = `---\ntitle: "${repoName.replace(/"/g, '\\"')}"\n---\n\nNotes published from Obsidian appear here. Maintain this index manually as you publish more notes.\n`;
	await client.putFile("index.md", markdown, "Add index page for GitHub Pages");
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
): Promise<void> {
	const quiet = options.quiet ?? false;
	if (file.extension !== "md") {
		if (!quiet) new Notice("Only Markdown notes can be published.");
		return;
	}
	const settings = plugin.settings;
	if (!hasConnectionSettings(settings)) {
		if (!quiet) new Notice("Set a GitHub token and repository in the plugin settings first.");
		return;
	}

	if (inFlightPublishes.has(file.path)) {
		if (!quiet) new Notice("This note is already being published.");
		return;
	}

	let client: GithubClient;
	try {
		client = new GithubClient(settings);
	} catch (error) {
		if (!quiet) new Notice(describeError(error));
		return;
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

		// Fallback so publishing still works even if "Set up Pages repo" was never run.
		await ensureJekyllConfig(client, settings);

		for (let i = 0; i < attachments.length; i++) {
			progress?.setMessage(`Uploading image ${i + 1} of ${attachments.length}...`);
			const attachment = attachments[i];
			const data = await plugin.app.vault.readBinary(attachment.file);
			await client.putFile(attachment.repoPath, data, `Publish asset ${attachment.file.name}`);
		}

		progress?.setMessage("Uploading note...");
		await client.putFile(repoPath, content, `Publish note ${file.basename}`);

		const record: PublishedNoteRecord = { repoPath, slug };
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
						if (!settings.baseUrl) {
							settings.baseUrl = pagesInfo.url.replace(/\/+$/, "");
						}
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
	} catch (error) {
		progress?.hide();
		new Notice(quiet ? `Auto-update failed for ${file.basename}: ${describeError(error)}` : describeError(error));
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
			new Notice("Repository is private. Free GitHub pages requires a public repository.");
		}

		progress.setMessage("Creating Jekyll config...");
		await ensureJekyllConfig(client, settings);
		progress.setMessage("Creating index page...");
		await ensureIndexPage(client, settings);

		progress.setMessage("Enabling pages...");
		try {
			await client.enablePages();
		} catch (error) {
			if (error instanceof GithubApiError && error.status === 403) {
				progress.hide();
				new Notice(
					"Token lacks permission to enable pages. Open the repo's settings > pages on GitHub and enable it manually. Fine-grained tokens need the pages read and write permission.",
					0,
				);
				return;
			}
			throw error;
		}

		// enablePages succeeded (or returned 409 = already enabled), so Pages is confirmed on.
		settings.pagesConfirmed = true;
		await plugin.saveSettings();

		progress.setMessage("Checking pages status...");
		const pagesInfo = await client.getPagesInfo();
		progress.hide();
		if (pagesInfo) {
			if (!settings.baseUrl) {
				settings.baseUrl = pagesInfo.url.replace(/\/+$/, "");
				await plugin.saveSettings();
			}
			new Notice(`Pages is set up: ${pagesInfo.url}`);
		} else {
			new Notice("Repo files are ready, but pages status could not be confirmed yet.");
		}
	} catch (error) {
		progress.hide();
		new Notice(describeError(error));
	} finally {
		// Safety net: hide() is idempotent, so a stray persistent notice can never survive.
		progress.hide();
	}
}
