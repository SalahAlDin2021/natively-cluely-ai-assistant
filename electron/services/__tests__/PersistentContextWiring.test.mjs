import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

const ipc = read('electron/ipcHandlers.ts');
const preload = read('electron/preload.ts');
const rendererTypes = read('src/types/electron.d.ts');
const helper = read('electron/LLMHelper.ts');
const settings = read('src/components/SettingsOverlay.tsx');
const contextPanel = read('src/components/settings/ContextSettings.tsx');

test('free settings tab exposes the complete context bridge without premium gates', () => {
  assert.match(settings, /setActiveTab\('context'\)/);
  assert.match(settings, /<ContextSettings\s*\/>/);
  assert.doesNotMatch(contextPanel, /Premium|LicenseManager|ModesManager|licenseCheck/);
  for (const source of [preload, rendererTypes]) {
    for (const api of [
      'getPersistentContext', 'setPersistentContextEnabled', 'setPersistentContextPasted',
      'selectPersistentContextFiles', 'relinkPersistentContextFile',
      'setPersistentContextFileEnabled', 'reorderPersistentContextFiles',
      'removePersistentContextFile', 'onPersistentContextWarning',
    ]) assert.match(source, new RegExp(api));
  }
});

test('main process owns file selection and renderer never submits a path', () => {
  assert.match(ipc, /persistent-context:select-files[\s\S]{0,900}dialog\.showOpenDialog/);
  assert.match(ipc, /properties: \['openFile', 'multiSelections'\]/);
  assert.match(ipc, /PersistentContextService\.getInstance\(\)\.addSelectedFiles\(result\.filePaths\)/);
  assert.doesNotMatch(preload, /selectPersistentContextFiles:\s*\([^)]*filePath/);
});

test('shared dispatch hook covers stream, structured, vision, summary and Direct Assist', () => {
  assert.match(helper, /_streamChatTracked[\s\S]{0,700}withPersistentContext/);
  assert.match(helper, /generateContentStructured[\s\S]{0,700}withPersistentContext/);
  assert.match(helper, /generateWithVisionFallback[\s\S]{0,700}withPersistentContext/);
  assert.match(helper, /generateMeetingSummary[\s\S]{0,1000}withPersistentContext/);
  assert.match(ipc, /direct-assist[\s\S]+PersistentContextService\.getInstance\(\)\.capture\(\)/);
  assert.match(helper, /persistent_context/);
  assert.match(helper, /replace\(\/<persistent_user_context/);
});

