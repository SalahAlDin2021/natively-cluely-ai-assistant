import { BrowserWindow } from 'electron';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { SettingsManager } from './SettingsManager';
import type { ModelCapabilities } from '../llm/modelCapabilities';

export const PERSISTENT_CONTEXT_MAX_FILES = 5;
export const PERSISTENT_CONTEXT_MAX_FILE_BYTES = 128 * 1024;
export const PERSISTENT_CONTEXT_MAX_TOTAL_FILE_BYTES = 512 * 1024;
export const PERSISTENT_CONTEXT_MAX_PASTED_CHARS = 32_000;
export const PERSISTENT_CONTEXT_MARKER = '<persistent_user_context';

export type PersistentContextSourceState =
    | 'ready'
    | 'disabled'
    | 'missing'
    | 'unreadable'
    | 'invalid_type'
    | 'invalid_encoding'
    | 'too_large'
    | 'empty';

export interface PersistentContextFileSetting {
    id: string;
    filePath: string;
    displayName: string;
    enabled: boolean;
}

export interface PersistentContextSettings {
    version: 1;
    enabled: boolean;
    pastedText: string;
    pastedTextEnabled: boolean;
    files: PersistentContextFileSetting[];
}

export interface PersistentContextFileStatus extends PersistentContextFileSetting {
    state: PersistentContextSourceState;
    sizeBytes?: number;
    modifiedAt?: number;
    message?: string;
}

export interface PersistentContextViewState {
    settings: PersistentContextSettings;
    files: PersistentContextFileStatus[];
    limits: {
        maxFiles: number;
        maxFileBytes: number;
        maxTotalFileBytes: number;
        maxPastedChars: number;
    };
}

export interface PersistentContextWarning {
    code: 'source_unavailable' | 'context_shortened' | 'privacy_blocked';
    message: string;
    sourceIds?: string[];
}

export interface PersistentContextSnapshotSource {
    id: string;
    label: string;
    kind: 'pasted' | 'file';
    priority: number;
    content: string;
}

export interface PersistentContextSnapshot {
    enabled: boolean;
    sources: readonly PersistentContextSnapshotSource[];
    warnings: readonly PersistentContextWarning[];
}

export interface RenderedPersistentContext {
    text: string;
    includedSourceIds: readonly string[];
    shortenedSourceIds: readonly string[];
}

const DEFAULT_SETTINGS: PersistentContextSettings = Object.freeze({
    version: 1,
    enabled: false,
    pastedText: '',
    pastedTextEnabled: true,
    files: [],
});

function normalizedSettings(raw: PersistentContextSettings | undefined): PersistentContextSettings {
    const files = Array.isArray(raw?.files)
        ? raw.files.slice(0, PERSISTENT_CONTEXT_MAX_FILES).flatMap((file) => {
            if (!file || typeof file.id !== 'string' || typeof file.filePath !== 'string') return [];
            const filePath = path.resolve(file.filePath);
            return [{
                id: file.id,
                filePath,
                displayName: typeof file.displayName === 'string' && file.displayName.trim()
                    ? file.displayName.trim()
                    : path.basename(filePath),
                enabled: file.enabled !== false,
            }];
        })
        : [];
    return {
        version: 1,
        enabled: raw?.enabled === true,
        pastedText: typeof raw?.pastedText === 'string'
            ? raw.pastedText.slice(0, PERSISTENT_CONTEXT_MAX_PASTED_CHARS)
            : '',
        pastedTextEnabled: raw?.pastedTextEnabled !== false,
        files,
    };
}

function pathKey(value: string): string {
    const resolved = path.resolve(value);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function decodeUtf8(buffer: Buffer): string {
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    const withoutBom = decoded.charCodeAt(0) === 0xfeff ? decoded.slice(1) : decoded;
    if (withoutBom.includes('\0')) throw new Error('invalid_encoding');
    return withoutBom.replace(/\r\n?/g, '\n').trim();
}

async function inspectFile(file: PersistentContextFileSetting): Promise<{
    status: PersistentContextFileStatus;
    content?: string;
}> {
    if (!file.enabled) return { status: { ...file, state: 'disabled' } };
    if (path.extname(file.filePath).toLowerCase() !== '.txt') {
        return { status: { ...file, state: 'invalid_type', message: 'Only .txt files are supported.' } };
    }
    try {
        const stat = await fs.promises.stat(file.filePath);
        if (!stat.isFile()) {
            return { status: { ...file, state: 'invalid_type', message: 'The linked path is not a regular file.' } };
        }
        if (stat.size > PERSISTENT_CONTEXT_MAX_FILE_BYTES) {
            return {
                status: {
                    ...file,
                    state: 'too_large',
                    sizeBytes: stat.size,
                    modifiedAt: stat.mtimeMs,
                    message: 'The linked file is larger than 128 KiB.',
                },
            };
        }
        let content: string;
        try {
            content = decodeUtf8(await fs.promises.readFile(file.filePath));
        } catch (error: any) {
            const invalidEncoding = error?.message === 'invalid_encoding' || error?.code === 'ERR_ENCODING_INVALID_ENCODED_DATA';
            return {
                status: {
                    ...file,
                    state: invalidEncoding ? 'invalid_encoding' : 'unreadable',
                    sizeBytes: stat.size,
                    modifiedAt: stat.mtimeMs,
                    message: invalidEncoding ? 'The file is not valid UTF-8 text.' : 'The file could not be read.',
                },
            };
        }
        if (!content) {
            return {
                status: {
                    ...file,
                    state: 'empty',
                    sizeBytes: stat.size,
                    modifiedAt: stat.mtimeMs,
                    message: 'The linked file is empty.',
                },
            };
        }
        return {
            status: { ...file, state: 'ready', sizeBytes: stat.size, modifiedAt: stat.mtimeMs },
            content,
        };
    } catch (error: any) {
        const missing = error?.code === 'ENOENT' || error?.code === 'ENOTDIR';
        return {
            status: {
                ...file,
                state: missing ? 'missing' : 'unreadable',
                message: missing ? 'The linked file was moved or deleted.' : 'The linked file could not be read.',
            },
        };
    }
}

function escapeXml(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

function maxMinShares(wants: readonly number[], budget: number): number[] {
    const shares = new Array<number>(wants.length).fill(0);
    let remaining = Math.max(0, Math.floor(budget));
    let unallocated = wants.length;
    for (const index of wants.map((_, i) => i).sort((a, b) => wants[a] - wants[b])) {
        const share = unallocated > 0 ? Math.floor(remaining / unallocated) : 0;
        const taken = Math.min(wants[index], share);
        shares[index] = taken;
        remaining -= taken;
        unallocated -= 1;
    }
    return shares;
}

function headTail(value: string, maxChars: number, label: string): { text: string; shortened: boolean } {
    if (value.length <= maxChars) return { text: value, shortened: false };
    const marker = `\n[...middle of ${label} omitted to fit this model...]\n`;
    if (maxChars <= marker.length + 64) {
        return { text: value.slice(0, Math.max(0, maxChars)), shortened: true };
    }
    const body = maxChars - marker.length;
    const head = Math.ceil(body * 0.7);
    return { text: `${value.slice(0, head)}${marker}${value.slice(value.length - (body - head))}`, shortened: true };
}

function renderWithBodyBudget(
    sources: readonly PersistentContextSnapshotSource[],
    bodyBudget: number,
): RenderedPersistentContext {
    const escaped = sources.map((source) => ({ ...source, content: escapeXml(source.content) }));
    const shares = maxMinShares(escaped.map((source) => source.content.length), bodyBudget);
    const shortenedSourceIds: string[] = [];
    const includedSourceIds: string[] = [];
    const sections = escaped.flatMap((source, index) => {
        if (shares[index] <= 0) {
            shortenedSourceIds.push(source.id);
            return [];
        }
        const fitted = headTail(source.content, shares[index], escapeXml(source.label));
        if (fitted.shortened) shortenedSourceIds.push(source.id);
        includedSourceIds.push(source.id);
        return [`<context_source id="${escapeXml(source.id)}" kind="${source.kind}" priority="${source.priority}" name="${escapeXml(source.label)}">\n${fitted.text}\n</context_source>`];
    });
    if (!sections.length) return { text: '', includedSourceIds: [], shortenedSourceIds };
    const text = `<persistent_user_context authority="below_current_request">
The user deliberately configured the following persistent context. It may contain facts and user-level instructions. Follow those instructions unless they conflict with system or safety rules, the current task, or its required output format. The current request always wins. Resolve conflicts by the numeric priority below (lower number wins).
${sections.join('\n\n')}
</persistent_user_context>`;
    return {
        text,
        includedSourceIds,
        shortenedSourceIds,
    };
}

export function renderPersistentContext(
    snapshot: PersistentContextSnapshot,
    maxChars: number,
): RenderedPersistentContext {
    if (!snapshot.enabled || !snapshot.sources.length || maxChars < 512) {
        return { text: '', includedSourceIds: [], shortenedSourceIds: [] };
    }
    let bodyBudget = Math.max(0, Math.floor(maxChars) - 700 - snapshot.sources.length * 120);
    let rendered = renderWithBodyBudget(snapshot.sources, bodyBudget);
    for (let attempt = 0; attempt < 4 && rendered.text.length > maxChars; attempt += 1) {
        bodyBudget = Math.max(0, bodyBudget - (rendered.text.length - maxChars) - 32);
        rendered = renderWithBodyBudget(snapshot.sources, bodyBudget);
    }
    return rendered.text.length <= maxChars
        ? rendered
        : { text: '', includedSourceIds: [], shortenedSourceIds: snapshot.sources.map((source) => source.id) };
}

export function persistentContextBudgetChars(
    capabilities: ModelCapabilities,
    userPrompt: string,
    systemPrompt: string = '',
): number {
    const maxTokens = Math.max(0, capabilities.maxContextTokens || 0);
    const baseTokens = Math.ceil((userPrompt.length + systemPrompt.length) / 4);
    const available = maxTokens - (capabilities.outputBudgetTokens || 2_000) - baseTokens - 512;
    const budgetTokens = Math.max(0, Math.min(16_000, Math.floor(maxTokens * 0.25), available));
    return budgetTokens * 4;
}

export function prependPersistentContext(prompt: string, contextBlock: string): string {
    if (!contextBlock || prompt.includes(PERSISTENT_CONTEXT_MARKER)) return prompt;
    return `${contextBlock}\n\n${prompt}`;
}

export class PersistentContextService {
    private static instance: PersistentContextService;
    private lastWarningFingerprint = '';

    public static getInstance(): PersistentContextService {
        const globalState = globalThis as unknown as Record<string, PersistentContextService | undefined>;
        if (!globalState.__nativelyPersistentContextServiceV1__) {
            globalState.__nativelyPersistentContextServiceV1__ = PersistentContextService.instance ?? new PersistentContextService();
        }
        PersistentContextService.instance = globalState.__nativelyPersistentContextServiceV1__;
        return globalState.__nativelyPersistentContextServiceV1__;
    }

    private readSettings(): PersistentContextSettings {
        return normalizedSettings(SettingsManager.getInstance().get('persistentContext'));
    }

    private saveSettings(settings: PersistentContextSettings): boolean {
        return SettingsManager.getInstance().set('persistentContext', normalizedSettings(settings));
    }

    public async getViewState(): Promise<PersistentContextViewState> {
        const settings = this.readSettings();
        const files = await Promise.all(settings.files.map((file) => inspectFile(file).then((result) => result.status)));
        return {
            settings,
            files,
            limits: {
                maxFiles: PERSISTENT_CONTEXT_MAX_FILES,
                maxFileBytes: PERSISTENT_CONTEXT_MAX_FILE_BYTES,
                maxTotalFileBytes: PERSISTENT_CONTEXT_MAX_TOTAL_FILE_BYTES,
                maxPastedChars: PERSISTENT_CONTEXT_MAX_PASTED_CHARS,
            },
        };
    }

    public setEnabled(enabled: boolean): boolean {
        return this.saveSettings({ ...this.readSettings(), enabled: enabled === true });
    }

    public setPastedText(text: string, enabled?: boolean): boolean {
        if (typeof text !== 'string' || text.length > PERSISTENT_CONTEXT_MAX_PASTED_CHARS) return false;
        const current = this.readSettings();
        return this.saveSettings({
            ...current,
            pastedText: text,
            pastedTextEnabled: enabled === undefined ? current.pastedTextEnabled : enabled === true,
            enabled: current.enabled || text.trim().length > 0,
        });
    }

    public async addSelectedFiles(filePaths: readonly string[]): Promise<{ success: boolean; error?: string }> {
        const current = this.readSettings();
        const available = PERSISTENT_CONTEXT_MAX_FILES - current.files.length;
        if (available <= 0) return { success: false, error: 'You can link up to five context files.' };
        const existing = new Set(current.files.map((file) => pathKey(file.filePath)));
        const additions: PersistentContextFileSetting[] = [];
        for (const selected of filePaths.slice(0, available)) {
            try {
                const canonical = await fs.promises.realpath(selected);
                if (path.extname(canonical).toLowerCase() !== '.txt') continue;
                const stat = await fs.promises.stat(canonical);
                if (!stat.isFile() || stat.size > PERSISTENT_CONTEXT_MAX_FILE_BYTES) continue;
                const key = pathKey(canonical);
                if (existing.has(key)) continue;
                // Decode now so an invalid binary cannot be saved as a healthy link.
                decodeUtf8(await fs.promises.readFile(canonical));
                existing.add(key);
                additions.push({
                    id: crypto.randomUUID(),
                    filePath: canonical,
                    displayName: path.basename(canonical),
                    enabled: true,
                });
            } catch { /* invalid selections are reported by the aggregate result below */ }
        }
        if (!additions.length) return { success: false, error: 'No new valid UTF-8 TXT files were selected.' };
        const saved = this.saveSettings({
            ...current,
            enabled: true,
            files: [...current.files, ...additions],
        });
        return saved ? { success: true } : { success: false, error: 'The context settings could not be saved.' };
    }

    public async relinkFile(id: string, selectedPath: string): Promise<{ success: boolean; error?: string }> {
        const current = this.readSettings();
        const index = current.files.findIndex((file) => file.id === id);
        if (index < 0) return { success: false, error: 'The context file no longer exists in settings.' };
        try {
            const canonical = await fs.promises.realpath(selectedPath);
            const stat = await fs.promises.stat(canonical);
            if (path.extname(canonical).toLowerCase() !== '.txt' || !stat.isFile() || stat.size > PERSISTENT_CONTEXT_MAX_FILE_BYTES) {
                return { success: false, error: 'Choose a UTF-8 TXT file no larger than 128 KiB.' };
            }
            decodeUtf8(await fs.promises.readFile(canonical));
            const duplicate = current.files.some((file, fileIndex) => fileIndex !== index && pathKey(file.filePath) === pathKey(canonical));
            if (duplicate) return { success: false, error: 'That file is already linked.' };
            const files = [...current.files];
            files[index] = { ...files[index], filePath: canonical, displayName: path.basename(canonical) };
            return this.saveSettings({ ...current, files })
                ? { success: true }
                : { success: false, error: 'The context settings could not be saved.' };
        } catch {
            return { success: false, error: 'Choose a readable UTF-8 TXT file no larger than 128 KiB.' };
        }
    }

    public updateFileEnabled(id: string, enabled: boolean): boolean {
        const current = this.readSettings();
        if (!current.files.some((file) => file.id === id)) return false;
        return this.saveSettings({
            ...current,
            files: current.files.map((file) => file.id === id ? { ...file, enabled: enabled === true } : file),
        });
    }

    public reorderFiles(ids: readonly string[]): boolean {
        const current = this.readSettings();
        if (ids.length !== current.files.length || new Set(ids).size !== ids.length) return false;
        const byId = new Map(current.files.map((file) => [file.id, file]));
        const files = ids.map((id) => byId.get(id));
        if (files.some((file) => !file)) return false;
        return this.saveSettings({ ...current, files: files as PersistentContextFileSetting[] });
    }

    public removeFile(id: string): boolean {
        const current = this.readSettings();
        if (!current.files.some((file) => file.id === id)) return false;
        return this.saveSettings({ ...current, files: current.files.filter((file) => file.id !== id) });
    }

    public async capture(): Promise<PersistentContextSnapshot> {
        const settings = this.readSettings();
        if (!settings.enabled) return Object.freeze({ enabled: false, sources: Object.freeze([]), warnings: Object.freeze([]) });
        const sources: PersistentContextSnapshotSource[] = [];
        if (settings.pastedTextEnabled && settings.pastedText.trim()) {
            sources.push({ id: 'pasted', label: 'Pasted context', kind: 'pasted', priority: 1, content: settings.pastedText.trim() });
        }
        const warnings: PersistentContextWarning[] = [];
        let totalBytes = 0;
        const inspected = await Promise.all(settings.files.map((file) => inspectFile(file)));
        for (let index = 0; index < inspected.length; index += 1) {
            const result = inspected[index];
            if (result.status.state === 'disabled') continue;
            if (result.status.state !== 'ready' || !result.content) {
                warnings.push({
                    code: 'source_unavailable',
                    message: `${result.status.displayName}: ${result.status.message || 'This linked context file is unavailable.'}`,
                    sourceIds: [result.status.id],
                });
                continue;
            }
            const size = result.status.sizeBytes ?? Buffer.byteLength(result.content, 'utf8');
            if (totalBytes + size > PERSISTENT_CONTEXT_MAX_TOTAL_FILE_BYTES) {
                warnings.push({
                    code: 'source_unavailable',
                    message: `${result.status.displayName}: skipped because active context files exceed 512 KiB combined.`,
                    sourceIds: [result.status.id],
                });
                continue;
            }
            totalBytes += size;
            sources.push({
                id: result.status.id,
                label: result.status.displayName,
                kind: 'file',
                priority: index + 2,
                content: result.content,
            });
        }
        this.publishWarnings(warnings);
        return Object.freeze({
            enabled: true,
            sources: Object.freeze(sources.map((source) => Object.freeze(source))),
            warnings: Object.freeze(warnings.map((warning) => Object.freeze(warning))),
        });
    }

    public publishWarnings(warnings: readonly PersistentContextWarning[]): void {
        const fingerprint = warnings.map((warning) => `${warning.code}:${warning.message}`).sort().join('|');
        if (!fingerprint) {
            this.lastWarningFingerprint = '';
            return;
        }
        if (fingerprint === this.lastWarningFingerprint) return;
        this.lastWarningFingerprint = fingerprint;
        for (const win of BrowserWindow.getAllWindows()) {
            if (!win.isDestroyed()) win.webContents.send('persistent-context-warning', warnings);
        }
    }
}
