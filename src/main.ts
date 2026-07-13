import { Plugin, TFile, Notice } from "obsidian";
import { DEFAULT_SETTINGS, GithubPagesShareSettingTab, type GithubPagesShareSettings } from "./settings";
import { copyPublishedLink, publishNote, setupRepo } from "./publisher";

const AUTO_UPDATE_DEBOUNCE_MS = 15000;

export default class GithubPagesSharePlugin extends Plugin {
	settings: GithubPagesShareSettings = DEFAULT_SETTINGS;
	private autoUpdateTimers = new Map<string, number>();

	async onload(): Promise<void> {
		await this.loadSettings();
		this.addSettingTab(new GithubPagesShareSettingTab(this.app, this));

		this.addCommand({
			id: "publish-note",
			name: "Publish current note",
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				if (!(file instanceof TFile) || file.extension !== "md") return false;
				if (checking) return true;
				void publishNote(this, file);
				return true;
			},
		});

		this.addCommand({
			id: "copy-link",
			name: "Copy published link",
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				if (!(file instanceof TFile) || file.extension !== "md") return false;
				if (checking) return true;
				void copyPublishedLink(this, file);
				return true;
			},
		});

		this.addCommand({
			id: "setup-repo",
			name: "Set up pages repo",
			callback: () => {
				void setupRepo(this);
			},
		});

		this.addRibbonIcon("upload-cloud", "Publish current note", () => {
			const file = this.app.workspace.getActiveFile();
			if (file instanceof TFile && file.extension === "md") {
				void publishNote(this, file);
			} else {
				new Notice("Open a Markdown note first.");
			}
		});

		this.registerEvent(
			this.app.workspace.on("file-menu", (menu, file) => {
				if (!(file instanceof TFile) || file.extension !== "md") return;
				menu.addItem((item) => {
					item
						.setTitle("Publish to GitHub pages")
						.setIcon("upload-cloud")
						.onClick(() => {
							void publishNote(this, file);
						});
				});
			}),
		);

		this.registerEvent(
			this.app.vault.on("modify", (file) => {
				if (!(file instanceof TFile)) return;
				this.scheduleAutoUpdate(file);
			}),
		);
	}

	onunload(): void {
		for (const timerId of this.autoUpdateTimers.values()) {
			window.clearTimeout(timerId);
		}
		this.autoUpdateTimers.clear();
	}

	private scheduleAutoUpdate(file: TFile): void {
		if (!this.settings.autoUpdate) return;
		if (!this.settings.registry[file.path]) return;

		const existingTimer = this.autoUpdateTimers.get(file.path);
		if (existingTimer !== undefined) {
			window.clearTimeout(existingTimer);
		}

		const timerId = window.setTimeout(() => {
			this.autoUpdateTimers.delete(file.path);
			void publishNote(this, file, { quiet: true });
		}, AUTO_UPDATE_DEBOUNCE_MS);
		this.autoUpdateTimers.set(file.path, timerId);
	}

	async loadSettings(): Promise<void> {
		const data = (await this.loadData()) as Partial<GithubPagesShareSettings> | null;
		this.settings = Object.assign({}, DEFAULT_SETTINGS, data, {
			registry: Object.assign({}, DEFAULT_SETTINGS.registry, data?.registry),
		});
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}
}
