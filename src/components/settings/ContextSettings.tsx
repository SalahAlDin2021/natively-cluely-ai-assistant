import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AlertCircle, ArrowDown, ArrowUp, FileText, Link2, Loader2, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { useT } from '../../i18n';
import { SettingsToggle } from './SettingsToggle';
import type { PersistentContextViewState } from '../../types/electron';

const statusTone: Record<string, string> = {
    ready: 'text-emerald-400',
    disabled: 'text-text-tertiary',
    missing: 'text-amber-400',
    unreadable: 'text-amber-400',
    invalid_type: 'text-red-400',
    invalid_encoding: 'text-red-400',
    too_large: 'text-red-400',
    empty: 'text-amber-400',
};

const formatBytes = (bytes?: number): string => {
    if (typeof bytes !== 'number') return '';
    if (bytes < 1024) return `${bytes} B`;
    return `${(bytes / 1024).toFixed(bytes >= 10 * 1024 ? 0 : 1)} KiB`;
};

export const ContextSettings: React.FC = () => {
    const t = useT();
    const [state, setState] = useState<PersistentContextViewState | null>(null);
    const [draft, setDraft] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

    const load = useCallback(async () => {
        try {
            const next = await window.electronAPI.getPersistentContext();
            setState(next);
            setDraft(next.settings.pastedText);
        } catch {
            setError(t('Could not load context settings.'));
        }
    }, [t]);

    useEffect(() => {
        void load();
        const remove = window.electronAPI.onPersistentContextChanged?.((next) => {
            setState(next);
            setDraft((current) => current === state?.settings.pastedText ? next.settings.pastedText : current);
        });
        return () => {
            remove?.();
            if (saveTimer.current) clearTimeout(saveTimer.current);
        };
        // The event handler intentionally compares against the initially loaded
        // value; local keystrokes must never be replaced by a file-status event.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [load]);

    const run = async (action: () => Promise<{ success: boolean; error?: string; canceled?: boolean }>) => {
        setBusy(true);
        setError('');
        try {
            const result = await action();
            if (!result.success && !result.canceled) setError(result.error || t('The context setting could not be saved.'));
            if (result.success && !result.canceled) await load();
        } catch {
            setError(t('The context setting could not be saved.'));
        } finally {
            setBusy(false);
        }
    };

    const savePasted = (text: string, enabled = state?.settings.pastedTextEnabled ?? true) => {
        if (!state) return;
        if (saveTimer.current) clearTimeout(saveTimer.current);
        saveTimer.current = setTimeout(() => {
            void run(() => window.electronAPI.setPersistentContextPasted({ text, enabled }));
        }, 450);
    };

    const move = (index: number, direction: -1 | 1) => {
        if (!state) return;
        const next = [...state.files];
        const target = index + direction;
        if (target < 0 || target >= next.length) return;
        [next[index], next[target]] = [next[target], next[index]];
        void run(() => window.electronAPI.reorderPersistentContextFiles(next.map((file) => file.id)));
    };

    if (!state) {
        return <div className="h-full flex items-center justify-center text-text-tertiary"><Loader2 className="animate-spin" size={20} /></div>;
    }

    const canAdd = state.files.length < state.limits.maxFiles;
    return (
        <div className="h-full overflow-y-auto px-8 py-7">
            <div className="max-w-2xl mx-auto space-y-5">
                <div className="flex items-start justify-between gap-5">
                    <div>
                        <h2 className="text-xl font-semibold text-text-primary">{t('Context')}</h2>
                        <p className="mt-1 text-sm leading-relaxed text-text-secondary">
                            {t('Give every AI request persistent notes, reference material, or instructions. The current request always wins.')}
                        </p>
                    </div>
                    <SettingsToggle
                        checked={state.settings.enabled}
                        onChange={() => void run(() => window.electronAPI.setPersistentContextEnabled(!state.settings.enabled))}
                        label={t('Use persistent context')}
                        disabled={busy}
                    />
                </div>

                <div className="rounded-xl border border-border-subtle bg-bg-sidebar/50 p-4">
                    <div className="flex items-center justify-between gap-4 mb-3">
                        <div>
                            <h3 className="text-sm font-medium text-text-primary">{t('Pasted context')}</h3>
                            <p className="text-xs text-text-tertiary mt-0.5">{t('Highest priority after the current request.')}</p>
                        </div>
                        <SettingsToggle
                            checked={state.settings.pastedTextEnabled}
                            onChange={() => {
                                const enabled = !state.settings.pastedTextEnabled;
                                setState({ ...state, settings: { ...state.settings, pastedTextEnabled: enabled } });
                                void run(() => window.electronAPI.setPersistentContextPasted({ text: draft, enabled }));
                            }}
                            label={t('Include pasted context')}
                            disabled={busy}
                        />
                    </div>
                    <textarea
                        value={draft}
                        onChange={(event) => {
                            const text = event.target.value.slice(0, state.limits.maxPastedChars);
                            setDraft(text);
                            savePasted(text);
                        }}
                        onBlur={() => {
                            if (saveTimer.current) clearTimeout(saveTimer.current);
                            void run(() => window.electronAPI.setPersistentContextPasted({ text: draft, enabled: state.settings.pastedTextEnabled }));
                        }}
                        disabled={busy}
                        placeholder={t('Example: I am preparing for an oral data-science exam. Answer concisely, define terms clearly, and use these course conventions…')}
                        className="w-full min-h-[132px] resize-y rounded-lg border border-border-subtle bg-bg-elevated px-3 py-2.5 text-sm text-text-primary placeholder:text-text-tertiary focus:outline-none focus:ring-1 focus:ring-accent-primary/70 disabled:opacity-60"
                    />
                    <div className="mt-1.5 text-right text-[11px] text-text-tertiary">
                        {draft.length.toLocaleString()} / {state.limits.maxPastedChars.toLocaleString()}
                    </div>
                </div>

                <div className="rounded-xl border border-border-subtle bg-bg-sidebar/50 p-4">
                    <div className="flex items-start justify-between gap-4 mb-3">
                        <div>
                            <h3 className="text-sm font-medium text-text-primary">{t('Linked TXT files')}</h3>
                            <p className="text-xs text-text-tertiary mt-0.5">
                                {t('Files stay linked. Saved edits are picked up automatically on the next AI request.')}
                            </p>
                        </div>
                        <div className="flex items-center gap-2">
                            <button
                                type="button"
                                onClick={() => void load()}
                                disabled={busy}
                                className="p-2 rounded-lg text-text-secondary hover:text-text-primary hover:bg-white/5 disabled:opacity-50"
                                title={t('Refresh status')}
                                aria-label={t('Refresh status')}
                            >
                                <RefreshCw size={15} className={busy ? 'animate-spin' : ''} />
                            </button>
                            <button
                                type="button"
                                onClick={() => void run(() => window.electronAPI.selectPersistentContextFiles())}
                                disabled={busy || !canAdd}
                                className="inline-flex items-center gap-1.5 rounded-lg bg-accent-primary px-3 py-2 text-xs font-semibold text-white hover:opacity-90 disabled:opacity-40"
                            >
                                <Plus size={14} /> {t('Add TXT')}
                            </button>
                        </div>
                    </div>

                    {state.files.length === 0 ? (
                        <div className="rounded-lg border border-dashed border-border-subtle py-8 text-center">
                            <FileText size={22} className="mx-auto text-text-tertiary mb-2" />
                            <p className="text-sm text-text-secondary">{t('No linked context files')}</p>
                            <p className="text-xs text-text-tertiary mt-1">{t('Add up to five UTF-8 TXT files, 128 KiB each.')}</p>
                        </div>
                    ) : (
                        <div className="space-y-2">
                            {state.files.map((file, index) => (
                                <div key={file.id} className="flex items-center gap-3 rounded-lg border border-border-subtle bg-bg-elevated px-3 py-2.5">
                                    <FileText size={17} className="shrink-0 text-text-secondary" />
                                    <div className="min-w-0 flex-1">
                                        <div className="text-sm text-text-primary truncate" title={file.filePath}>{file.displayName}</div>
                                        <div className={`text-[11px] mt-0.5 ${statusTone[file.state] || 'text-text-tertiary'}`}>
                                            {file.state === 'ready' ? `${t('Linked')} · ${formatBytes(file.sizeBytes)}` : t(file.message || file.state)}
                                        </div>
                                    </div>
                                    <SettingsToggle
                                        checked={file.enabled}
                                        onChange={() => void run(() => window.electronAPI.setPersistentContextFileEnabled(file.id, !file.enabled))}
                                        label={`${t('Include')} ${file.displayName}`}
                                        disabled={busy}
                                    />
                                    <div className="flex items-center">
                                        <button type="button" onClick={() => move(index, -1)} disabled={busy || index === 0} className="p-1.5 text-text-tertiary hover:text-text-primary disabled:opacity-25" aria-label={t('Move up')}><ArrowUp size={14} /></button>
                                        <button type="button" onClick={() => move(index, 1)} disabled={busy || index === state.files.length - 1} className="p-1.5 text-text-tertiary hover:text-text-primary disabled:opacity-25" aria-label={t('Move down')}><ArrowDown size={14} /></button>
                                        <button type="button" onClick={() => void run(() => window.electronAPI.relinkPersistentContextFile(file.id))} disabled={busy} className="p-1.5 text-text-tertiary hover:text-text-primary disabled:opacity-25" title={t('Relink')} aria-label={t('Relink')}><Link2 size={14} /></button>
                                        <button type="button" onClick={() => void run(() => window.electronAPI.removePersistentContextFile(file.id))} disabled={busy} className="p-1.5 text-text-tertiary hover:text-red-400 disabled:opacity-25" title={t('Remove')} aria-label={t('Remove')}><Trash2 size={14} /></button>
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                    <p className="mt-3 text-[11px] leading-relaxed text-text-tertiary">
                        {t('Context is shortened fairly when a model has a smaller context window. Cloud sharing is controlled by AI Providers → Privacy → Persistent context.')}
                    </p>
                </div>

                {error && (
                    <div className="flex items-start gap-2 rounded-lg border border-red-500/25 bg-red-500/10 px-3 py-2.5 text-xs text-red-300">
                        <AlertCircle size={15} className="shrink-0 mt-0.5" /> {error}
                    </div>
                )}
            </div>
        </div>
    );
};

