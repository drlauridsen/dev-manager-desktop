import {Injectable} from '@angular/core';
import {appDataDir, join} from '@tauri-apps/api/path';
import {exists, mkdir, readDir, readTextFile} from '@tauri-apps/plugin-fs';
import {open as openPath} from '@tauri-apps/plugin-shell';
import {PackageManifest, RepositoryItem} from './apps-repo.service';

/** The folder inside the app data directory that holds the description files. */
export const CUSTOM_APPS_DIR_NAME = 'custom-apps';

const DEFAULT_ICON = '/assets/images/custom-app.svg';

export interface CustomAppsResult {
    items: RepositoryItem[];
    /** One message per file that could not be used, naming the file. */
    errors: string[];
}

/**
 * Apps that are not in the Homebrew repository, described by JSON files in
 * `<app data dir>/custom-apps`. See {@link CUSTOM_APPS_HELP_JSON} for the format.
 */
@Injectable({
    providedIn: 'root'
})
export class CustomAppsService {

    async dirPath(): Promise<string> {
        return join(await appDataDir(), CUSTOM_APPS_DIR_NAME);
    }

    async openDir(): Promise<void> {
        const dir = await this.ensureDir();
        await openPath(dir);
    }

    async load(): Promise<CustomAppsResult> {
        const dir = await this.ensureDir();
        const result: CustomAppsResult = {items: [], errors: []};
        const entries = await readDir(dir);
        const names = entries.filter(e => e.isFile && e.name.toLowerCase().endsWith('.json'))
            .map(e => e.name).sort((a, b) => a.localeCompare(b));
        for (const name of names) {
            try {
                const text = await readTextFile(await join(dir, name));
                // Windows editors may add a byte order mark, which JSON.parse rejects.
                const data = JSON.parse(text.replace(/^﻿/, ''));
                result.items.push(parseCustomApp(data));
            } catch (e) {
                result.errors.push(`${name}: ${(e as Error).message}`);
            }
        }
        return result;
    }

    async loadMap(): Promise<Record<string, RepositoryItem>> {
        const {items} = await this.load().catch((): CustomAppsResult => ({items: [], errors: []}));
        return Object.fromEntries(items.map(item => [item.id, item]));
    }

    private async ensureDir(): Promise<string> {
        const dir = await this.dirPath();
        if (!await exists(dir)) {
            await mkdir(dir, {recursive: true});
        }
        return dir;
    }
}

function text(value: unknown, field: string, required = false): string | undefined {
    if (value === undefined || value === null || value === '') {
        if (required) {
            throw new Error(`"${field}" is missing`);
        }
        return undefined;
    }
    if (typeof value !== 'string') {
        throw new Error(`"${field}" must be text`);
    }
    return value;
}

/** Only web addresses can be used from a description file, local paths cannot be loaded by the app. */
function webUrl(value: unknown, field: string): string | undefined {
    const url = text(value, field);
    if (url !== undefined && !/^https?:\/\//i.test(url)) {
        throw new Error(`"${field}" must start with http:// or https://`);
    }
    return url;
}

export function parseCustomApp(data: any): RepositoryItem {
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
        throw new Error('the file must contain a JSON object');
    }
    const id = text(data.id, 'id', true)!;
    const title = text(data.title, 'title', true)!;
    const rawManifest = data.manifest;
    if (!rawManifest || typeof rawManifest !== 'object') {
        throw new Error('"manifest" is missing');
    }
    const version = text(rawManifest.version, 'manifest.version', true)!;
    const shortDescription = text(data.shortDescription, 'shortDescription');
    const manifest = new PackageManifest({
        id: text(rawManifest.id, 'manifest.id') ?? id,
        version,
        appDescription: text(rawManifest.appDescription, 'manifest.appDescription') ?? shortDescription ?? '',
        sourceUrl: webUrl(rawManifest.sourceUrl, 'manifest.sourceUrl'),
        ipkUrl: webUrl(rawManifest.ipkUrl, 'manifest.ipkUrl') ?? '',
    });
    if (manifest.id !== id) {
        throw new Error('"manifest.id" must be the same as "id"');
    }
    const item = new RepositoryItem({
        id,
        title,
        shortDescription,
        iconUri: webUrl(data.iconUri, 'iconUri') ?? DEFAULT_ICON,
        fullDescription: text(data.fullDescription, 'fullDescription'),
        manifest,
    }, 'https://custom-app.invalid/');
    return item;
}

/** The JSON a description file contains, shown in the help dialog. */
export const CUSTOM_APPS_HELP_JSON = `{
  "id": "com.example.myapp",
  "title": "My App",
  "shortDescription": "One line shown in the list.",
  "fullDescription": "Longer text shown on the details page.\\n\\nA blank line starts a new paragraph.",
  "iconUri": "https://example.com/icon.png",
  "manifest": {
    "version": "1.0.0",
    "appDescription": "Optional. Defaults to shortDescription.",
    "sourceUrl": "https://github.com/example/myapp",
    "ipkUrl": "https://example.com/com.example.myapp_1.0.0_all.ipk"
  }
}`;

/** An instruction an AI assistant can follow to write a description file. */
export const CUSTOM_APPS_AI_PROMPT = `Write a JSON description file for a webOS TV app, for use in webOS Dev Manager.

Return only the JSON, with no explanation. The file is named <app id>.json.

Fields:
- "id" (required): the app id from the "id" field in the app's appinfo.json, for example "com.example.myapp". Dev Manager uses it to find the installed app and to uninstall it, so it must match exactly.
- "title" (required): the app name shown to the user.
- "shortDescription" (optional): one short line for the list.
- "fullDescription" (optional): longer plain text for the details page. Use \\n\\n between paragraphs. No HTML or Markdown.
- "iconUri" (optional): an https:// link to a PNG. Leave it out if there is none. Local file paths do not work.
- "manifest" (required), with:
  - "version" (required): the version from appinfo.json, for example "1.0.0".
  - "appDescription" (optional): defaults to shortDescription.
  - "sourceUrl" (optional): an https:// link to the project page.
  - "ipkUrl" (optional): an https:// link to the .ipk file. Leave it out if the app is installed from a local file.

Use only the fields above. Use valid JSON: double quotes, no comments, no trailing commas.

Example:
${CUSTOM_APPS_HELP_JSON}`;
