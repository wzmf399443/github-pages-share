import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";
import obsidianmd from "eslint-plugin-obsidianmd";

export default defineConfig([
	{ ignores: ["node_modules/**", "main.js", "*.mjs"] },
	...obsidianmd.configs.recommended,
	{
		files: ["**/*.ts"],
		languageOptions: {
			parser: tseslint.parser,
			parserOptions: {
				project: "./tsconfig.json",
				sourceType: "module",
			},
		},
		rules: {
			// The declarative settings API (getSettingDefinitions()) needs Obsidian 1.13+.
			// This plugin's minAppVersion is 1.5.0, and requireDisplay already enforces the
			// imperative display() method for that floor, so the newer API is out of scope.
			"obsidianmd/settings-tab/prefer-setting-definitions": "off",
		},
	},
]);