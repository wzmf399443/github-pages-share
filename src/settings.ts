import { App, ButtonComponent, Notice, PluginSettingTab, Setting } from "obsidian";
import type GithubPagesSharePlugin from "./main";
import { GithubClient, parseRepo } from "./github";

export interface PublishedNoteRecord {
	repoPath: string;
	slug: string;
	/** Repo paths (under the assets folder) of every image this note embeds, as uploaded by
	 *  publish. Older registry entries written before this field existed will not have it;
	 *  treat a missing value as an empty list when iterating. */
	attachments?: string[];
}

export interface GithubPagesShareSettings {
	token: string;
	repo: string;
	branch: string;
	notesFolder: string;
	assetsFolder: string;
	baseUrl: string;
	autoUpdate: boolean;
	/** Set once GitHub Pages has been confirmed enabled, so publish stops re-checking the Pages API. */
	pagesConfirmed: boolean;
	registry: Record<string, PublishedNoteRecord>;
}

export const DEFAULT_SETTINGS: GithubPagesShareSettings = {
	token: "",
	repo: "",
	branch: "main",
	notesFolder: "notes",
	assetsFolder: "assets",
	baseUrl: "",
	autoUpdate: true,
	pagesConfirmed: false,
	registry: {},
};

/** Default Pages URL derived from owner/repo, used when baseUrl is not overridden. */
export function deriveBaseUrl(settings: GithubPagesShareSettings): string {
	const parsed = parseRepo(settings.repo);
	if (!parsed) return "";
	return `https://${parsed.owner}.github.io/${parsed.repo}`;
}

function normalizeFolderName(value: string, fallback: string): string {
	const trimmed = value.trim().replace(/^\/+|\/+$/g, "");
	if (!trimmed) return fallback;
	const segments = trimmed.split("/");
	if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) return fallback;
	return segments.join("/");
}

export class GithubPagesShareSettingTab extends PluginSettingTab {
	plugin: GithubPagesSharePlugin;
	private pagesBaseUrlInput: import("obsidian").TextComponent | null = null;

	constructor(app: App, plugin: GithubPagesSharePlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl).setName("GitHub connection").setHeading();

		new Setting(containerEl)
			.setName("Personal access token")
			.setDesc(
				"Fine-grained token with contents read/write on the target repo. Stored as plain text in this vault's plugin data.",
			)
			.addText((text) => {
				text.inputEl.type = "password";
				text
					.setPlaceholder("Paste token here")
					.setValue(this.plugin.settings.token)
					.onChange(async (value) => {
						this.plugin.settings.token = value.trim();
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("Repository")
			.setDesc("GitHub repository as owner/name.")
			.addText((text) =>
				text
					.setPlaceholder("Owner/name")
					.setValue(this.plugin.settings.repo)
					.onChange(async (value) => {
						const newRepo = value.trim();
						const prevRepo = this.plugin.settings.repo;
						const changed = !!newRepo && newRepo !== prevRepo;

						// Snapshot the derived default BEFORE we change settings.repo, so we
						// can detect "user hasn't customized baseUrl — it's still the old
						// default" and follow the new default instead of leaving a stale
						// value or wiping it.
						const oldDerived = deriveBaseUrl(this.plugin.settings);

						this.plugin.settings.repo = newRepo;

						if (changed) {
							const newDerived = deriveBaseUrl(this.plugin.settings);
							const current = this.plugin.settings.baseUrl;
							const onDefault = !current || current === oldDerived;
							if (onDefault) {
								this.plugin.settings.baseUrl = newDerived;
								this.pagesBaseUrlInput?.setValue(newDerived);
							}
							this.plugin.settings.pagesConfirmed = false;
						}
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Branch")
			.setDesc("Branch that GitHub Pages serves from.")
			.addText((text) =>
				text
					.setPlaceholder("Branch name")
					.setValue(this.plugin.settings.branch)
					.onChange(async (value) => {
						this.plugin.settings.branch = value.trim() || "main";
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Notes folder")
			.setDesc("Folder in the repo where published notes are saved.")
			.addText((text) =>
				text
					.setPlaceholder("Folder name")
					.setValue(this.plugin.settings.notesFolder)
					.onChange(async (value) => {
						this.plugin.settings.notesFolder = normalizeFolderName(value, "notes");
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Assets folder")
			.setDesc("Folder in the repo where uploaded images are saved.")
			.addText((text) =>
				text
					.setPlaceholder("Folder name")
					.setValue(this.plugin.settings.assetsFolder)
					.onChange(async (value) => {
						this.plugin.settings.assetsFolder = normalizeFolderName(value, "assets");
						await this.plugin.saveSettings();
					}),
			);

		const derivedUrl = deriveBaseUrl(this.plugin.settings) || "https://owner.github.io/repo";
		new Setting(containerEl)
			.setName("Pages base URL")
			.setDesc(`Shareable link prefix. Leave blank to use ${derivedUrl}.`)
			.addText((text) => {
				this.pagesBaseUrlInput = text;
				text
					.setPlaceholder(derivedUrl)
					.setValue(this.plugin.settings.baseUrl)
					.onChange(async (value) => {
						this.plugin.settings.baseUrl = value.trim().replace(/\/+$/, "");
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("Auto-update published notes")
			.setDesc("Republish a note automatically a short while after you save changes to it.")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.autoUpdate).onChange(async (value) => {
					this.plugin.settings.autoUpdate = value;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName("Test connection")
			.setDesc("Verify the token and repository are valid.")
			.addButton((button) =>
				button.setButtonText("Test connection").onClick(() => {
					void this.testConnection(button);
				}),
			);
	}

	private async testConnection(button: ButtonComponent): Promise<void> {
		button.setDisabled(true);
		try {
			const client = new GithubClient(this.plugin.settings);
			const repo = await client.getRepo();
			new Notice(
				repo.private
					? "Connection works. Note: repo is private, so free GitHub Pages will not serve it."
					: "Connection works.",
			);
		} catch (error) {
			new Notice(error instanceof Error ? error.message : "Could not connect to GitHub.");
		} finally {
			button.setDisabled(false);
		}
	}
}
