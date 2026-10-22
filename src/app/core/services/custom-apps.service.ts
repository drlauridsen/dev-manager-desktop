import {Injectable} from '@angular/core';
import {appDataDir, join} from '@tauri-apps/api/path';
import {exists, mkdir, readDir, readFile, readTextFile} from '@tauri-apps/plugin-fs';
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

/** A folder to look for description files in, with the names of the files in it. */
interface Source {
    folder: string;
    label: string;
    files: string[];
    dedicated: boolean;
}

/**
 * Apps that are not in the Homebrew repository, described by JSON files in
 * `<app data dir>/custom-apps`. Each app can have its own sub folder with the
 * description file, the .ipk and an icon next to each other. See {@link CUSTOM_APPS_HELP_JSON}.
 */
@Injectable({
    providedIn: 'root'
})
export class CustomAppsService {

    private icons = new Map<string, string>();

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
        const sources: Source[] = [{
            folder: dir, label: '', dedicated: false,
            files: entries.filter(e => e.isFile).map(e => e.name)
        }];
        for (const sub of entries.filter(e => e.isDirectory).sort((a, b) => a.name.localeCompare(b.name))) {
            try {
                const folder = await join(dir, sub.name);
                const files = (await readDir(folder)).filter(e => e.isFile).map(e => e.name);
                sources.push({folder, label: sub.name + '/', files, dedicated: true});
            } catch (e) {
                result.errors.push(`${sub.name}: ${(e as Error).message}`);
            }
        }
        for (const source of sources) {
            const names = source.files.filter(n => n.toLowerCase().endsWith('.json')).sort((a, b) => a.localeCompare(b));
            for (const name of names) {
                try {
                    const text = await readTextFile(await join(source.folder, name));
                    // Windows editors may add a byte order mark, which JSON.parse rejects.
                    const data = JSON.parse(text.replace(/^﻿/, ''));
                    const item = parseCustomApp(data);
                    await this.attachLocalFiles(item, data, source);
                    result.items.push(item);
                } catch (e) {
                    result.errors.push(`${source.label}${name}: ${(e as Error).message}`);
                }
            }
        }
        return result;
    }

    async loadMap(): Promise<Record<string, RepositoryItem>> {
        const {items} = await this.load().catch((): CustomAppsResult => ({items: [], errors: []}));
        return Object.fromEntries(items.map(item => [item.id, item]));
    }

    /** Finds the .ipk and the icon that belong to the description file, next to it. */
    private async attachLocalFiles(item: RepositoryItem, data: any, source: Source): Promise<void> {
        const files = source.files, lower = files.map(f => f.toLowerCase());
        const find = (name: string): string | undefined => {
            const i = lower.indexOf(name.toLowerCase());
            return i >= 0 ? files[i] : undefined;
        };
        // the installer
        const explicitIpk = text(data.ipk, 'ipk');
        let ipk: string | undefined;
        if (explicitIpk) {
            ipk = find(explicitIpk);
            if (!ipk) {
                throw new Error(`the file "${explicitIpk}" named in "ipk" is not in the same folder`);
            }
        } else {
            const ipks = files.filter(f => f.toLowerCase().endsWith('.ipk'));
            const mine = ipks.filter(f => f.toLowerCase().startsWith(item.id.toLowerCase()));
            const pool = mine.length ? mine : (source.dedicated && ipks.length === 1 ? ipks : []);
            // with several versions, take the newest by name
            pool.sort((a, b) => b.localeCompare(a, undefined, {numeric: true}));
            ipk = pool[0];
        }
        if (ipk) {
            item.localIpk = await join(source.folder, ipk);
        }
        // the icon
        const explicitIcon = text(data.icon, 'icon');
        let icon: string | undefined;
        if (explicitIcon) {
            icon = find(explicitIcon);
            if (!icon) {
                throw new Error(`the file "${explicitIcon}" named in "icon" is not in the same folder`);
            }
        } else {
            icon = find(item.id + '.png') ?? find('icon.png') ?? find('largeIcon.png');
        }
        if (icon) {
            item.iconUri = await this.iconUrl(await join(source.folder, icon), icon);
        }
    }

    private async iconUrl(path: string, name: string): Promise<string> {
        const cached = this.icons.get(path);
        if (cached) {
            return cached;
        }
        const ext = name.toLowerCase().split('.').pop();
        const type = ext === 'svg' ? 'image/svg+xml' : (ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : 'image/png');
        const url = URL.createObjectURL(new Blob([await readFile(path)], {type}));
        this.icons.set(path, url);
        return url;
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

/** Only web addresses can be used for links, local files are named without a path. */
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
    return new RepositoryItem({
        id,
        title,
        shortDescription,
        iconUri: webUrl(data.iconUri, 'iconUri') ?? DEFAULT_ICON,
        fullDescription: text(data.fullDescription, 'fullDescription'),
        manifest,
    }, 'https://custom-app.invalid/');
}

/** The JSON a description file contains, shown in the help dialog. */
export const CUSTOM_APPS_HELP_JSON = `{
  "id": "com.example.myapp",
  "title": "My App",
  "shortDescription": "One line shown in the list.",
  "fullDescription": "Longer text shown on the details page.\\n\\nA blank line starts a new paragraph.",
  "icon": "icon.png",
  "ipk": "com.example.myapp_1.0.0_all.ipk",
  "manifest": {
    "version": "1.0.0",
    "appDescription": "Optional. Defaults to shortDescription.",
    "sourceUrl": "https://github.com/example/myapp"
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
- "icon" (optional): the file name of a PNG in the same folder as this file, for example "icon.png". No folder path. Leave it out to use icon.png or largeIcon.png if they are there.
- "ipk" (optional): the file name of the .ipk in the same folder as this file, for example "com.example.myapp_1.0.0_all.ipk". No folder path. Leave it out to use the .ipk that starts with the app id.
- "iconUri" (optional): an https:// link to a PNG, used when there is no icon file.
- "manifest" (required), with:
  - "version" (required): the version from appinfo.json, for example "1.0.0".
  - "appDescription" (optional): defaults to shortDescription.
  - "sourceUrl" (optional): an https:// link to the project page.
  - "ipkUrl" (optional): an https:// link to the .ipk file. Leave it out when the .ipk is in the same folder.

Use only the fields above. Use valid JSON: double quotes, no comments, no trailing commas.

Example:
${CUSTOM_APPS_HELP_JSON}`;
