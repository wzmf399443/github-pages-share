import { App, Modal } from "obsidian";

export interface PublishResultOptions {
	/** Shareable link for the published note. */
	link: string;
	/** Whether the link was already copied to the clipboard automatically. */
	copiedToClipboard: boolean;
	/** True when GitHub Pages appears to be disabled, so the link would 404. */
	pagesNotEnabled: boolean;
	/** Invoked when the user clicks the "Set up pages repo now" button. */
	onSetupRepo?: () => void;
}

/** Shown after a manual publish succeeds. The quiet auto-update path never opens this modal. */
export class PublishResultModal extends Modal {
	private readonly options: PublishResultOptions;
	private statusEl: HTMLElement | null = null;

	constructor(app: App, options: PublishResultOptions) {
		super(app);
		this.options = options;
	}

	onOpen(): void {
		const { contentEl, titleEl } = this;
		titleEl.setText("Note published");

		if (this.options.pagesNotEnabled) {
			const warning = contentEl.createDiv({ cls: "gps-publish-result-warning" });
			warning.createDiv({
				text: "GitHub pages is not enabled yet, so this link will not work.",
			});
			const setupButton = warning.createEl("button", {
				text: "Set up pages repo now",
				cls: "gps-publish-result-setup",
			});
			setupButton.addEventListener("click", () => {
				this.close();
				this.options.onSetupRepo?.();
			});
		}

		contentEl.createDiv({ cls: "gps-publish-result-link", text: this.options.link });

		this.statusEl = contentEl.createDiv({
			cls: "gps-publish-result-status",
			text: this.options.copiedToClipboard
				? "Link copied to clipboard."
				: "Copying to the clipboard failed. Copy the link manually.",
		});

		const buttons = contentEl.createDiv({ cls: "gps-publish-result-buttons" });

		const copyButton = buttons.createEl("button", { text: "Copy link" });
		copyButton.addEventListener("click", () => {
			void (async () => {
				try {
					await navigator.clipboard.writeText(this.options.link);
					this.statusEl?.setText("Link copied to clipboard.");
				} catch {
					this.statusEl?.setText("Copying to the clipboard failed. Copy the link manually.");
				}
			})();
		});

		const openButton = buttons.createEl("button", { text: "Open in browser" });
		openButton.addEventListener("click", () => {
			window.open(this.options.link, "_blank");
		});

		contentEl.createDiv({
			cls: "gps-publish-result-hint",
			text: "GitHub pages can take one to two minutes to build before the link works.",
		});
	}

	onClose(): void {
		this.statusEl = null;
		this.contentEl.empty();
	}
}
