import {
    MODULE_NAME,
    MACRO_NAME,
    STRINGS,
    cloneDefaultFields,
} from './constants.js';
import { createStorage } from './storage.js';

const DEFAULT_PANEL_SIZE = Object.freeze({ width: 900, height: 680 });
const MIN_PANEL_SIZE = Object.freeze({ width: 320, height: 300 });
const COMPACT_PANEL_WIDTH = 440;
const DRAG_EDGE = 10;
const DRAG_TOP = 76;
const MAX_IMAGE_BYTES = 30 * 1024 * 1024;

let initialized = false;
let context = null;
let settings = null;
let storage = null;
let library = null;
let activeChatKey = null;
let activeState = emptyState();
let activeLoadSerial = 0;
let renderSerial = 0;
let currentView = 'editor';
let previewVisible = true;
let wardrobeFolder = 'all';
let wardrobeSearch = '';
let saveStateTimer = null;
let panel = null;
let floatingButton = null;
let menuButton = null;
let settingsDrawer = null;
const objectUrls = new Set();

function getContextSafe() {
    try {
        return globalThis.SillyTavern?.getContext?.() || null;
    } catch (error) {
        console.error('[Character Visual] Failed to get context:', error);
        return null;
    }
}

function emptyState() {
    return {
        outfitId: null,
        outfitName: '',
        folderId: null,
        imageId: null,
        fields: {},
        updatedAt: null,
    };
}

function createId(prefix = 'item') {
    const value = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    return `${prefix}-${value}`;
}

function clone(value) {
    return globalThis.structuredClone ? structuredClone(value) : JSON.parse(JSON.stringify(value));
}

function escapeHtml(value) {
    return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#039;');
}

function normalizeValue(value) {
    return String(value ?? '')
        .replace(/\r/g, '')
        .replace(/[ \t]+/g, ' ')
        .replace(/\s*\n\s*/g, ' ')
        .trim();
}

function getUiLanguage() {
    if (settings?.uiLanguage === 'ru' || settings?.uiLanguage === 'en') {
        return settings.uiLanguage;
    }
    const htmlLang = document.documentElement.lang || navigator.language || 'en';
    return String(htmlLang).toLowerCase().startsWith('ru') ? 'ru' : 'en';
}

function t(key) {
    const lang = getUiLanguage();
    return STRINGS[lang]?.[key] ?? STRINGS.en[key] ?? key;
}

function toast(type, message) {
    const api = globalThis.toastr;
    if (api?.[type]) api[type](message);
    else console[type === 'error' ? 'error' : 'log'](`[Character Visual] ${message}`);
}

function fieldLabel(field, language = getUiLanguage()) {
    return field?.labels?.[language] || field?.labels?.en || field?.labels?.ru || field?.id || '';
}

function getDefaultSettings() {
    return {
        version: 1,
        storageNamespace: createId('user'),
        uiLanguage: 'auto',
        promptLanguage: 'en',
        showFloatingButton: true,
        previewVisible: true,
        panelPosition: null,
        panelSize: { ...DEFAULT_PANEL_SIZE },
        expandedWidth: DEFAULT_PANEL_SIZE.width,
        buttonPosition: null,
        fields: cloneDefaultFields(),
    };
}

function loadSettings() {
    const defaults = getDefaultSettings();
    const all = context.extensionSettings;
    if (!all[MODULE_NAME] || typeof all[MODULE_NAME] !== 'object') {
        all[MODULE_NAME] = defaults;
    } else {
        const saved = all[MODULE_NAME];
        for (const [key, value] of Object.entries(defaults)) {
            if (!Object.hasOwn(saved, key)) saved[key] = clone(value);
        }
        if (!Array.isArray(saved.fields) || !saved.fields.length) {
            saved.fields = cloneDefaultFields();
        }
        saved.fields = saved.fields.map((field) => ({
            id: String(field.id || createId('field')),
            icon: field.icon || 'fa-solid fa-tag',
            builtIn: !!field.builtIn,
            labels: {
                en: String(field.labels?.en || field.label || field.id || 'Field'),
                ru: String(field.labels?.ru || field.label || field.labels?.en || field.id || '\u041f\u043e\u043b\u0435'),
            },
        }));
    }
    settings = all[MODULE_NAME];
    context.saveSettingsDebounced();
}

function persistSettings() {
    context?.saveSettingsDebounced?.();
}

function getCurrentChatKey() {
    const ctx = getContextSafe();
    if (!ctx) return null;

    let chatId = null;
    try {
        chatId = ctx.getCurrentChatId?.() ?? ctx.chatId ?? null;
    } catch (error) {
        console.error('[Character Visual] Failed to read chat id:', error);
    }
    if (!chatId) return null;

    if (ctx.groupId != null) return `group:${ctx.groupId}::chat:${chatId}`;

    const character = ctx.characterId != null ? ctx.characters?.[ctx.characterId] : null;
    const characterKey = character?.avatar || character?.name || ctx.name2 || 'default';
    return `character:${characterKey}::chat:${chatId}`;
}

function formatCurrentOutfit() {
    const language = settings?.promptLanguage === 'ru' ? 'ru' : 'en';
    const lines = [];
    for (const field of settings?.fields || []) {
        const value = normalizeValue(activeState?.fields?.[field.id]);
        if (!value) continue;
        lines.push(`${fieldLabel(field, language)}: ${value};`);
    }
    return lines.length ? lines.join('\n') : STRINGS[language].noOutfitPrompt;
}

function registerMacro() {
    const macros = context.macros;
    if (macros?.register) {
        try {
            macros.registry?.unregisterMacro?.(MACRO_NAME);
        } catch (error) {
            // The macro simply was not registered yet.
        }

        macros.register(MACRO_NAME, {
            description: 'Returns the current chat outfit selected in Character Visual.',
            handler: () => formatCurrentOutfit(),
        });
        return;
    }

    if (context.registerMacro) {
        try { context.unregisterMacro?.(MACRO_NAME); } catch (error) { /* not registered */ }
        context.registerMacro(MACRO_NAME, () => formatCurrentOutfit());
        return;
    }

    console.error('[Character Visual] Macro API is not available in this SillyTavern version.');
}

async function loadActiveChatState() {
    const serial = ++activeLoadSerial;
    const nextKey = getCurrentChatKey();
    activeChatKey = nextKey;

    if (!nextKey) {
        activeState = emptyState();
        if (serial === activeLoadSerial) renderPanel();
        return;
    }

    try {
        const stored = await storage.loadChatState(nextKey);
        if (serial !== activeLoadSerial) return;
        activeState = stored ? {
            ...emptyState(),
            ...stored,
            fields: stored.fields && typeof stored.fields === 'object' ? stored.fields : {},
        } : emptyState();
    } catch (error) {
        console.error('[Character Visual] Failed to load chat state:', error);
        activeState = emptyState();
    }
    renderPanel();
}

async function saveActiveState() {
    if (!activeChatKey) return;
    try {
        await storage.saveChatState(activeChatKey, activeState);
    } catch (error) {
        console.error('[Character Visual] Failed to save chat state:', error);
        toast('error', t('storageError'));
    }
}

function scheduleStateSave() {
    clearTimeout(saveStateTimer);
    const chatKey = activeChatKey;
    const snapshot = clone(activeState);
    saveStateTimer = setTimeout(async () => {
        if (!chatKey) return;
        try {
            await storage.saveChatState(chatKey, snapshot);
        } catch (error) {
            console.error('[Character Visual] Failed to save delayed chat state:', error);
            toast('error', t('storageError'));
        }
    }, 250);
}

function revokeObjectUrls() {
    for (const url of objectUrls) URL.revokeObjectURL(url);
    objectUrls.clear();
}

async function setStoredImage(img, imageId, thumbnail, serial) {
    if (!img || !imageId) return;
    try {
        const blob = await storage.getImage(imageId, thumbnail);
        if (!blob || serial !== renderSerial || !img.isConnected) return;
        const url = URL.createObjectURL(blob);
        objectUrls.add(url);
        img.src = url;
        img.closest('.cv-image-loading')?.classList.remove('cv-image-loading');
    } catch (error) {
        console.error('[Character Visual] Failed to load image:', error);
    }
}

function autoSizeTextarea(textarea) {
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(120, Math.max(24, textarea.scrollHeight))}px`;
}

function panelVisible() {
    return panel && panel.style.display !== 'none';
}

function previewToggleText() {
    if (getUiLanguage() === 'ru') {
        return previewVisible
            ? '\u0421\u043a\u0440\u044b\u0442\u044c \u043f\u0440\u0435\u0432\u044c\u044e'
            : '\u041f\u043e\u043a\u0430\u0437\u0430\u0442\u044c \u043f\u0440\u0435\u0432\u044c\u044e';
    }
    return previewVisible ? 'Hide preview' : 'Show preview';
}

// Toggles the preview column. Hiding it also physically shrinks the panel so it
// takes less space (and restores the previous width when shown again).
function setPreviewVisible(visible) {
    previewVisible = visible;
    settings.previewVisible = visible;

    if (panelVisible()) {
        const viewport = viewportSize();
        const maxWidth = Math.max(MIN_PANEL_SIZE.width, viewport.width - DRAG_EDGE * 2);
        let width;
        if (!visible) {
            settings.expandedWidth = panel.getBoundingClientRect().width;
            width = clamp(COMPACT_PANEL_WIDTH, MIN_PANEL_SIZE.width, maxWidth);
        } else {
            width = clamp(settings.expandedWidth || DEFAULT_PANEL_SIZE.width, MIN_PANEL_SIZE.width, maxWidth);
        }
        panel.style.width = `${width}px`;
        const rect = panel.getBoundingClientRect();
        const point = clampPanelPosition(rect.left, rect.top, rect.width, rect.height);
        panel.style.left = `${point.left}px`;
        panel.style.top = `${point.top}px`;
        settings.panelSize = { width: rect.width, height: rect.height };
    }

    persistSettings();
    renderPanel();
}

function updateStaticLabels() {
    if (floatingButton) floatingButton.textContent = t('floatingButton');
    if (menuButton) menuButton.querySelector('span').textContent = t('openPanel');
    if (settingsDrawer) renderExtensionSettingsDrawer();
    if (panel) {
        panel.querySelector('#cv-title').textContent = t('title');
        panel.querySelector('#cv-nav-editor').title = t('editor');
        panel.querySelector('#cv-nav-wardrobe').title = t('wardrobe');
        panel.querySelector('#cv-nav-settings').title = t('settings');
        panel.querySelector('#cv-close').title = t('close');
    }
}

function renderPanel() {
    if (!panel || !panelVisible()) return;
    const content = panel.querySelector('#cv-content');
    if (!content) return;

    revokeObjectUrls();
    renderSerial += 1;

    panel.querySelectorAll('.cv-nav-button').forEach((button) => {
        button.classList.toggle('cv-active', button.dataset.view === currentView);
    });

    if (currentView === 'wardrobe') renderWardrobe(content, renderSerial);
    else if (currentView === 'settings') renderSettings(content);
    else renderEditor(content, renderSerial);
}

function renderEditor(content, serial) {
    if (!activeChatKey) {
        content.innerHTML = `<div class="cv-empty-state"><i class="fa-solid fa-comments"></i><p>${escapeHtml(t('noChat'))}</p></div>`;
        return;
    }

    const name = activeState.outfitName || (Object.values(activeState.fields || {}).some(Boolean) || activeState.imageId
        ? t('unsavedOutfit')
        : t('noOutfit'));

    const fieldCards = (settings.fields || []).map((field) => `
        <label class="cv-field-card" data-field-id="${escapeHtml(field.id)}">
            <span class="cv-field-icon"><i class="${escapeHtml(field.icon)}"></i></span>
            <span class="cv-field-main">
                <span class="cv-field-label">${escapeHtml(fieldLabel(field))}</span>
                <textarea class="cv-field-input" rows="1" spellcheck="true" placeholder="&#8212;">${escapeHtml(activeState.fields?.[field.id] || '')}</textarea>
            </span>
            <i class="fa-solid fa-pencil cv-field-pencil" aria-hidden="true"></i>
        </label>
    `).join('');

    const previewCorners = `
        <span class="cv-preview-corner cv-preview-corner-tl" aria-hidden="true">&#9884;&#65038;</span>
        <span class="cv-preview-corner cv-preview-corner-tr" aria-hidden="true">&#9884;&#65038;</span>
        <span class="cv-preview-corner cv-preview-corner-bl" aria-hidden="true">&#9884;&#65038;</span>
        <span class="cv-preview-corner cv-preview-corner-br" aria-hidden="true">&#9884;&#65038;</span>
    `;

    const imageMarkup = activeState.imageId
        ? `<div class="cv-preview-frame cv-image-loading">${previewCorners}<img id="cv-current-image" alt=""><span class="cv-image-spinner"><i class="fa-solid fa-spinner fa-spin"></i></span></div>`
        : `<div class="cv-preview-frame cv-preview-empty">${previewCorners}<i class="fa-regular fa-image"></i><span>${escapeHtml(t('noImage'))}</span></div>`;

    content.innerHTML = `
        <div class="cv-editor-shell${previewVisible ? '' : ' cv-preview-hidden'}">
            <div class="cv-editor-heading">
                <div>
                    <div class="cv-eyebrow"><span>&#10022;</span>${escapeHtml(t('editor'))}<span>&#10022;</span></div>
                    <h2>${escapeHtml(name)}</h2>
                </div>
                <div class="cv-editor-heading-actions">
                    <button id="cv-toggle-preview" class="cv-secondary" type="button" aria-pressed="${previewVisible}" title="${escapeHtml(previewToggleText())}"><i class="fa-regular fa-image"></i><span>${escapeHtml(previewToggleText())}</span></button>
                    <button id="cv-open-wardrobe" class="cv-primary" type="button"><i class="fa-solid fa-door-open"></i><span>${escapeHtml(t('chooseOutfit'))}</span></button>
                </div>
            </div>
            <div class="cv-editor-grid">
                <section class="cv-editor-fields cv-section-card">
                    <div class="cv-section-title"><span class="cv-flourish">&#9884;&#65038;</span>${escapeHtml(t('outfitDetails'))}</div>
                    <div class="cv-field-list">${fieldCards}</div>
                    <div class="cv-hint">${escapeHtml(t('currentChatHint'))}</div>
                </section>
                <section class="cv-preview-section cv-section-card">
                    <div class="cv-section-title cv-centered"><span>&#10022;</span>${escapeHtml(t('preview'))}<span>&#10022;</span></div>
                    ${imageMarkup}
                    <div class="cv-preview-actions">
                        <button id="cv-upload-image" class="cv-secondary" type="button"><i class="fa-solid fa-arrow-up-from-bracket"></i>${escapeHtml(activeState.imageId ? t('replaceImage') : t('uploadImage'))}</button>
                        ${activeState.imageId ? `<button id="cv-remove-image" class="cv-icon-danger" type="button" title="${escapeHtml(t('removeImage'))}"><i class="fa-solid fa-trash"></i></button>` : ''}
                    </div>
                </section>
            </div>
            <div class="cv-ornament-divider"><span>&#10022;</span></div>
            <div class="cv-editor-actions">
                <button id="cv-save-outfit" class="cv-primary" type="button"><i class="fa-solid fa-floppy-disk"></i>${escapeHtml(activeState.outfitId ? t('updateOutfit') : t('saveOutfit'))}</button>
                <button id="cv-save-as-new" class="cv-secondary" type="button"><i class="fa-solid fa-copy"></i>${escapeHtml(t('saveAsNew'))}</button>
                <button id="cv-clear-current" class="cv-ghost-danger" type="button"><i class="fa-solid fa-eraser"></i>${escapeHtml(t('clearCurrent'))}</button>
            </div>
        </div>
    `;

    content.querySelectorAll('.cv-field-input').forEach((textarea) => {
        autoSizeTextarea(textarea);
        textarea.addEventListener('input', () => {
            const fieldId = textarea.closest('.cv-field-card').dataset.fieldId;
            activeState.fields[fieldId] = textarea.value;
            activeState.updatedAt = new Date().toISOString();
            autoSizeTextarea(textarea);
            scheduleStateSave();
        });
    });

    content.querySelector('#cv-open-wardrobe').addEventListener('click', () => switchView('wardrobe'));
    content.querySelector('#cv-toggle-preview').addEventListener('click', () => setPreviewVisible(!previewVisible));
    content.querySelector('#cv-upload-image').addEventListener('click', pickCurrentImage);
    content.querySelector('#cv-remove-image')?.addEventListener('click', async () => {
        activeState.imageId = null;
        await saveActiveState();
        renderPanel();
    });
    content.querySelector('#cv-save-outfit').addEventListener('click', () => {
        if (activeState.outfitId) updateLinkedOutfit();
        else saveAsNewOutfit();
    });
    content.querySelector('#cv-save-as-new').addEventListener('click', saveAsNewOutfit);
    content.querySelector('#cv-clear-current').addEventListener('click', clearCurrentOutfit);

    if (activeState.imageId) {
        setStoredImage(content.querySelector('#cv-current-image'), activeState.imageId, false, serial);
    }
}

function folderOptions(selected, includeAll = false) {
    const options = [];
    if (includeAll) {
        options.push(`<option value="all"${selected === 'all' ? ' selected' : ''}>${escapeHtml(t('allFolders'))}</option>`);
    }
    for (const folder of library.folders) {
        options.push(`<option value="${escapeHtml(folder.id)}"${selected === folder.id ? ' selected' : ''}>${escapeHtml(folder.name)}</option>`);
    }
    return options.join('');
}

function renderWardrobe(content, serial) {
    if (!library) return;
    if (wardrobeFolder !== 'all' && !library.folders.some((folder) => folder.id === wardrobeFolder)) {
        wardrobeFolder = 'all';
    }

    const query = wardrobeSearch.trim().toLowerCase();
    const outfits = library.outfits.filter((outfit) => {
        if (wardrobeFolder !== 'all' && outfit.folderId !== wardrobeFolder) return false;
        if (!query) return true;
        const folder = library.folders.find((item) => item.id === outfit.folderId);
        return `${outfit.name} ${folder?.name || ''}`.toLowerCase().includes(query);
    });

    const cards = outfits.map((outfit) => {
        const folder = library.folders.find((item) => item.id === outfit.folderId);
        const image = outfit.imageId
            ? `<div class="cv-wardrobe-thumb cv-image-loading"><img data-image-id="${escapeHtml(outfit.imageId)}" alt=""><span class="cv-image-spinner"><i class="fa-solid fa-spinner fa-spin"></i></span></div>`
            : `<div class="cv-wardrobe-thumb cv-thumb-empty"><i class="fa-regular fa-image"></i></div>`;
        return `
            <article class="cv-outfit-card" data-outfit-id="${escapeHtml(outfit.id)}">
                ${image}
                <div class="cv-outfit-card-body">
                    <h3>${escapeHtml(outfit.name)}</h3>
                    <div class="cv-folder-chip"><i class="fa-regular fa-folder"></i>${escapeHtml(folder?.name || '')}</div>
                    <div class="cv-outfit-card-actions">
                        <button class="cv-apply-outfit cv-primary-small" type="button"><i class="fa-solid fa-check"></i>${escapeHtml(t('apply'))}</button>
                        <button class="cv-rename-outfit cv-card-icon" type="button" title="${escapeHtml(t('rename'))}"><i class="fa-solid fa-pencil"></i></button>
                        <button class="cv-move-outfit cv-card-icon" type="button" title="${escapeHtml(t('move'))}"><i class="fa-solid fa-folder-tree"></i></button>
                        <button class="cv-delete-outfit cv-card-icon cv-danger" type="button" title="${escapeHtml(t('delete'))}"><i class="fa-solid fa-trash"></i></button>
                    </div>
                </div>
            </article>
        `;
    }).join('');

    const emptyText = query ? t('noMatches') : t('emptyWardrobe');
    content.innerHTML = `
        <div class="cv-wardrobe-shell">
            <div class="cv-editor-heading">
                <div>
                    <div class="cv-eyebrow"><span>&#10022;</span>${escapeHtml(t('wardrobe'))}<span>&#10022;</span></div>
                    <h2>${escapeHtml(t('chooseOutfit'))}</h2>
                </div>
                <div class="cv-editor-heading-actions">
                    <button id="cv-add-outfits" class="cv-primary" type="button"><i class="fa-solid fa-images"></i><span>${escapeHtml(t('addOutfits'))}</span></button>
                    <button id="cv-back-editor" class="cv-secondary" type="button"><i class="fa-solid fa-arrow-left"></i>${escapeHtml(t('back'))}</button>
                </div>
            </div>
            <div class="cv-wardrobe-toolbar cv-section-card">
                <select id="cv-folder-filter">${folderOptions(wardrobeFolder, true)}</select>
                <div class="cv-search-wrap"><i class="fa-solid fa-magnifying-glass"></i><input id="cv-outfit-search" type="search" value="${escapeHtml(wardrobeSearch)}" placeholder="${escapeHtml(t('search'))}"></div>
                <button id="cv-folder-new" class="cv-toolbar-button" type="button" title="${escapeHtml(t('newFolder'))}"><i class="fa-solid fa-folder-plus"></i></button>
                <button id="cv-folder-rename" class="cv-toolbar-button" type="button" title="${escapeHtml(t('renameFolder'))}"><i class="fa-solid fa-folder-open"></i></button>
                <button id="cv-folder-delete" class="cv-toolbar-button cv-danger" type="button" title="${escapeHtml(t('deleteFolder'))}"><i class="fa-solid fa-folder-minus"></i></button>
            </div>
            <div class="cv-hint cv-wardrobe-hint">${escapeHtml(t('savedOutfitHint'))}</div>
            ${cards ? `<div class="cv-wardrobe-grid">${cards}</div>` : `<div class="cv-empty-state"><i class="fa-solid fa-box-open"></i><p>${escapeHtml(emptyText)}</p></div>`}
        </div>
    `;

    content.querySelector('#cv-back-editor').addEventListener('click', () => switchView('editor'));
    content.querySelector('#cv-add-outfits').addEventListener('click', addWardrobeOutfits);
    content.querySelector('#cv-folder-filter').addEventListener('change', (event) => {
        wardrobeFolder = event.target.value;
        wardrobeSearch = '';
        renderPanel();
    });
    content.querySelector('#cv-outfit-search').addEventListener('input', (event) => {
        wardrobeSearch = event.target.value;
        renderPanel();
        const next = panel.querySelector('#cv-outfit-search');
        next?.focus();
        next?.setSelectionRange(next.value.length, next.value.length);
    });
    content.querySelector('#cv-folder-new').addEventListener('click', createFolder);
    content.querySelector('#cv-folder-rename').addEventListener('click', renameCurrentFolder);
    content.querySelector('#cv-folder-delete').addEventListener('click', deleteCurrentFolder);

    content.querySelectorAll('.cv-outfit-card').forEach((card) => {
        const outfitId = card.dataset.outfitId;
        card.querySelector('.cv-apply-outfit').addEventListener('click', () => applyOutfit(outfitId));
        card.querySelector('.cv-rename-outfit').addEventListener('click', () => renameOutfit(outfitId));
        card.querySelector('.cv-move-outfit').addEventListener('click', () => moveOutfit(outfitId));
        card.querySelector('.cv-delete-outfit').addEventListener('click', () => deleteOutfit(outfitId));
    });

    content.querySelectorAll('.cv-wardrobe-thumb img').forEach((img) => {
        setStoredImage(img, img.dataset.imageId, true, serial);
    });
}

function renderSettings(content) {
    const fieldRows = settings.fields.map((field, index) => `
        <div class="cv-setting-field" data-field-id="${escapeHtml(field.id)}">
            <span class="cv-field-icon cv-small"><i class="${escapeHtml(field.icon)}"></i></span>
            <span class="cv-setting-field-name">${escapeHtml(fieldLabel(field))}</span>
            <button class="cv-field-up cv-card-icon" type="button" title="${escapeHtml(t('moveUp'))}"${index === 0 ? ' disabled' : ''}><i class="fa-solid fa-chevron-up"></i></button>
            <button class="cv-field-down cv-card-icon" type="button" title="${escapeHtml(t('moveDown'))}"${index === settings.fields.length - 1 ? ' disabled' : ''}><i class="fa-solid fa-chevron-down"></i></button>
            <button class="cv-field-rename cv-card-icon" type="button" title="${escapeHtml(t('rename'))}"><i class="fa-solid fa-pencil"></i></button>
            <button class="cv-field-delete cv-card-icon cv-danger" type="button" title="${escapeHtml(t('delete'))}"><i class="fa-solid fa-trash"></i></button>
        </div>
    `).join('');

    content.innerHTML = `
        <div class="cv-settings-shell">
            <div class="cv-editor-heading">
                <div>
                    <div class="cv-eyebrow"><span>&#10022;</span>${escapeHtml(t('settings'))}<span>&#10022;</span></div>
                    <h2>${escapeHtml(t('title'))}</h2>
                </div>
                <button id="cv-settings-back" class="cv-secondary" type="button"><i class="fa-solid fa-arrow-left"></i>${escapeHtml(t('back'))}</button>
            </div>
            <div class="cv-settings-grid">
                <section class="cv-section-card cv-settings-card">
                    <div class="cv-section-title"><i class="fa-solid fa-language"></i>${escapeHtml(t('settings'))}</div>
                    <label class="cv-setting-row">
                        <span>${escapeHtml(t('uiLanguage'))}</span>
                        <select id="cv-ui-language">
                            <option value="auto"${settings.uiLanguage === 'auto' ? ' selected' : ''}>${escapeHtml(t('auto'))}</option>
                            <option value="ru"${settings.uiLanguage === 'ru' ? ' selected' : ''}>${escapeHtml(t('russian'))}</option>
                            <option value="en"${settings.uiLanguage === 'en' ? ' selected' : ''}>${escapeHtml(t('english'))}</option>
                        </select>
                    </label>
                    <label class="cv-setting-row">
                        <span>${escapeHtml(t('promptLanguage'))}</span>
                        <select id="cv-prompt-language">
                            <option value="en"${settings.promptLanguage === 'en' ? ' selected' : ''}>${escapeHtml(t('english'))}</option>
                            <option value="ru"${settings.promptLanguage === 'ru' ? ' selected' : ''}>${escapeHtml(t('russian'))}</option>
                        </select>
                    </label>
                    <label class="cv-check-row"><input id="cv-show-floating" type="checkbox"${settings.showFloatingButton ? ' checked' : ''}><span>${escapeHtml(t('showFloating'))}</span></label>
                    <button id="cv-reset-layout" class="cv-secondary cv-wide" type="button"><i class="fa-solid fa-arrows-to-dot"></i>${escapeHtml(t('resetLayout'))}</button>
                </section>
                <section class="cv-section-card cv-settings-card">
                    <div class="cv-section-title"><i class="fa-solid fa-tags"></i>${escapeHtml(t('fields'))}</div>
                    <div class="cv-hint">${escapeHtml(t('fieldsHint'))}</div>
                    <div class="cv-setting-fields">${fieldRows}</div>
                    <div class="cv-inline-actions">
                        <button id="cv-add-field" class="cv-primary-small" type="button"><i class="fa-solid fa-plus"></i>${escapeHtml(t('addField'))}</button>
                        <button id="cv-reset-fields" class="cv-secondary" type="button"><i class="fa-solid fa-rotate-left"></i>${escapeHtml(t('resetFields'))}</button>
                    </div>
                </section>
                <section class="cv-section-card cv-settings-card cv-backup-card">
                    <div class="cv-section-title"><i class="fa-solid fa-box-archive"></i>${escapeHtml(t('backup'))}</div>
                    <div class="cv-inline-actions">
                        <button id="cv-export" class="cv-secondary" type="button"><i class="fa-solid fa-file-export"></i>${escapeHtml(t('exportBackup'))}</button>
                        <button id="cv-import" class="cv-secondary" type="button"><i class="fa-solid fa-file-import"></i>${escapeHtml(t('importBackup'))}</button>
                    </div>
                </section>
            </div>
        </div>
    `;

    content.querySelector('#cv-settings-back').addEventListener('click', () => switchView('editor'));
    content.querySelector('#cv-ui-language').addEventListener('change', (event) => {
        settings.uiLanguage = event.target.value;
        persistSettings();
        updateStaticLabels();
        renderPanel();
    });
    content.querySelector('#cv-prompt-language').addEventListener('change', (event) => {
        settings.promptLanguage = event.target.value;
        persistSettings();
    });
    content.querySelector('#cv-show-floating').addEventListener('change', (event) => {
        settings.showFloatingButton = event.target.checked;
        persistSettings();
        updateFloatingVisibility();
    });
    content.querySelector('#cv-reset-layout').addEventListener('click', resetLayout);
    content.querySelector('#cv-add-field').addEventListener('click', addField);
    content.querySelector('#cv-reset-fields').addEventListener('click', () => {
        if (!confirm(t('resetFields'))) return;
        settings.fields = cloneDefaultFields();
        persistSettings();
        renderPanel();
    });
    content.querySelector('#cv-export').addEventListener('click', exportBackup);
    content.querySelector('#cv-import').addEventListener('click', importBackup);

    content.querySelectorAll('.cv-setting-field').forEach((row) => {
        const fieldId = row.dataset.fieldId;
        row.querySelector('.cv-field-up').addEventListener('click', () => moveField(fieldId, -1));
        row.querySelector('.cv-field-down').addEventListener('click', () => moveField(fieldId, 1));
        row.querySelector('.cv-field-rename').addEventListener('click', () => editField(fieldId));
        row.querySelector('.cv-field-delete').addEventListener('click', () => deleteField(fieldId));
    });
}

function switchView(view) {
    currentView = view;
    renderPanel();
}

async function createThumbnail(file) {
    const url = URL.createObjectURL(file);
    try {
        const img = await new Promise((resolve, reject) => {
            const element = new Image();
            element.onload = () => resolve(element);
            element.onerror = () => reject(new Error('IMAGE_LOAD_FAILED'));
            element.src = url;
        });
        const max = 420;
        const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
        canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
        const ctx = canvas.getContext('2d');
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        return await new Promise((resolve) => {
            canvas.toBlob((blob) => resolve(blob || file), 'image/webp', 0.88);
        });
    } finally {
        URL.revokeObjectURL(url);
    }
}

function pickImageFile() {
    return new Promise((resolve) => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'image/png,image/jpeg,image/webp,image/gif';
        input.style.display = 'none';
        input.addEventListener('change', () => {
            resolve(input.files?.[0] || null);
            input.remove();
        }, { once: true });
        document.body.appendChild(input);
        input.click();
    });
}

function pickImageFiles() {
    return new Promise((resolve) => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'image/png,image/jpeg,image/webp,image/gif';
        input.multiple = true;
        input.style.display = 'none';
        input.addEventListener('change', () => {
            resolve(input.files ? Array.from(input.files) : []);
            input.remove();
        }, { once: true });
        document.body.appendChild(input);
        input.click();
    });
}

// Bulk-adds outfits straight into the wardrobe from selected photos, without
// touching the current chat. Fields stay empty; the temporary name comes from
// the file name and can be renamed later per card.
async function addWardrobeOutfits() {
    if (!library) return;
    const files = await pickImageFiles();
    if (!files.length) return;

    const folderId = wardrobeFolder !== 'all' && library.folders.some((folder) => folder.id === wardrobeFolder)
        ? wardrobeFolder
        : library.folders[0].id;

    let added = 0;
    for (const file of files) {
        if (file.size > MAX_IMAGE_BYTES) {
            toast('warning', t('imageTooLarge'));
            continue;
        }
        try {
            const thumbnail = await createThumbnail(file);
            const imageId = createId('image');
            await storage.putImage(imageId, file, thumbnail);
            const now = new Date().toISOString();
            const baseName = String(file.name || '').replace(/\.[^.]+$/, '').trim() || t('unsavedOutfit');
            library.outfits.push({
                id: createId('outfit'),
                name: baseName,
                folderId,
                imageId,
                fields: {},
                createdAt: now,
                updatedAt: now,
            });
            added += 1;
        } catch (error) {
            console.error('[Character Visual] Add wardrobe outfit failed:', error);
            toast('error', t('imageFailed'));
        }
    }

    if (added) {
        library = await storage.saveLibrary(library);
        wardrobeSearch = '';
        toast('success', t('outfitsAdded'));
        renderPanel();
    }
}

async function pickCurrentImage() {
    const targetChatKey = activeChatKey;
    const file = await pickImageFile();
    if (!file) return;
    if (file.size > MAX_IMAGE_BYTES) {
        toast('error', t('imageTooLarge'));
        return;
    }
    try {
        const thumbnail = await createThumbnail(file);
        const imageId = createId('image');
        await storage.putImage(imageId, file, thumbnail);
        if (targetChatKey !== activeChatKey) return;
        activeState.imageId = imageId;
        activeState.updatedAt = new Date().toISOString();
        await saveActiveState();
        toast('success', t('imageSaved'));
        renderPanel();
    } catch (error) {
        console.error('[Character Visual] Image upload failed:', error);
        toast('error', t('imageFailed'));
    }
}

function hasCurrentContent() {
    return !!activeState.imageId || Object.values(activeState.fields || {}).some((value) => normalizeValue(value));
}

async function formDialog({ title, fields, confirmLabel = t('save') }) {
    return await new Promise((resolve) => {
        const overlay = document.createElement('div');
        overlay.className = 'cv-dialog-overlay';
        const rows = fields.map((field) => {
            let control = '';
            if (field.type === 'select') {
                control = `<select id="cv-dialog-${escapeHtml(field.id)}">${field.options.map((option) => `<option value="${escapeHtml(option.value)}"${option.value === field.value ? ' selected' : ''}>${escapeHtml(option.label)}</option>`).join('')}</select>`;
            } else {
                control = `<input id="cv-dialog-${escapeHtml(field.id)}" type="text" value="${escapeHtml(field.value || '')}" autocomplete="off">`;
            }
            return `<label class="cv-dialog-row"><span>${escapeHtml(field.label)}</span>${control}</label>`;
        }).join('');
        overlay.innerHTML = `
            <div class="cv-dialog-box" role="dialog" aria-modal="true">
                <div class="cv-dialog-ornament">&#10022;</div>
                <h3>${escapeHtml(title)}</h3>
                ${rows}
                <div class="cv-dialog-actions">
                    <button class="cv-dialog-cancel cv-secondary" type="button">${escapeHtml(t('cancel'))}</button>
                    <button class="cv-dialog-confirm cv-primary" type="button">${escapeHtml(confirmLabel)}</button>
                </div>
            </div>
        `;
        document.body.appendChild(overlay);

        const close = (result) => {
            overlay.remove();
            resolve(result);
        };
        const submit = () => {
            const result = {};
            for (const field of fields) {
                result[field.id] = overlay.querySelector(`#cv-dialog-${CSS.escape(field.id)}`).value.trim();
            }
            close(result);
        };
        overlay.addEventListener('click', (event) => {
            if (event.target === overlay) close(null);
        });
        overlay.querySelector('.cv-dialog-cancel').addEventListener('click', () => close(null));
        overlay.querySelector('.cv-dialog-confirm').addEventListener('click', submit);
        overlay.addEventListener('keydown', (event) => {
            if (event.key === 'Escape') close(null);
            if (event.key === 'Enter' && event.target.tagName !== 'TEXTAREA') submit();
        });
        setTimeout(() => overlay.querySelector('input, select')?.focus(), 0);
    });
}

async function saveAsNewOutfit() {
    if (!activeChatKey) return;
    const defaultFolder = activeState.folderId && library.folders.some((folder) => folder.id === activeState.folderId)
        ? activeState.folderId
        : library.folders[0].id;
    const values = await formDialog({
        title: t('saveOutfit'),
        fields: [
            { id: 'name', label: t('outfitName'), value: activeState.outfitName || '' },
            {
                id: 'folder', label: t('folder'), type: 'select', value: defaultFolder,
                options: library.folders.map((folder) => ({ value: folder.id, label: folder.name })),
            },
        ],
    });
    if (!values) return;
    if (!values.name) {
        toast('warning', t('requiredName'));
        return;
    }

    const now = new Date().toISOString();
    const outfit = {
        id: createId('outfit'),
        name: values.name,
        folderId: values.folder,
        imageId: activeState.imageId || null,
        fields: clone(activeState.fields || {}),
        createdAt: now,
        updatedAt: now,
    };
    library.outfits.push(outfit);
    library = await storage.saveLibrary(library);
    activeState.outfitId = outfit.id;
    activeState.outfitName = outfit.name;
    activeState.folderId = outfit.folderId;
    await saveActiveState();
    toast('success', t('saved'));
    renderPanel();
}

async function updateLinkedOutfit() {
    const outfit = library.outfits.find((item) => item.id === activeState.outfitId);
    if (!outfit) {
        activeState.outfitId = null;
        await saveAsNewOutfit();
        return;
    }
    outfit.fields = clone(activeState.fields || {});
    outfit.imageId = activeState.imageId || null;
    outfit.updatedAt = new Date().toISOString();
    library = await storage.saveLibrary(library);
    toast('success', t('updated'));
}

async function clearCurrentOutfit() {
    activeState = emptyState();
    await saveActiveState();
    toast('success', t('cleared'));
    renderPanel();
}

async function applyOutfit(outfitId) {
    const outfit = library.outfits.find((item) => item.id === outfitId);
    if (!outfit || !activeChatKey) return;
    activeState = {
        outfitId: outfit.id,
        outfitName: outfit.name,
        folderId: outfit.folderId,
        imageId: outfit.imageId || null,
        fields: clone(outfit.fields || {}),
        updatedAt: new Date().toISOString(),
    };
    await saveActiveState();
    toast('success', t('applied'));
    switchView('editor');
}

async function createFolder() {
    const values = await formDialog({
        title: t('newFolder'),
        confirmLabel: t('create'),
        fields: [{ id: 'name', label: t('folderName'), value: '' }],
    });
    if (!values?.name) return;
    const folder = { id: createId('folder'), name: values.name };
    library.folders.push(folder);
    library = await storage.saveLibrary(library);
    wardrobeFolder = folder.id;
    renderPanel();
}

async function renameCurrentFolder() {
    if (wardrobeFolder === 'all') {
        toast('warning', t('selectFolder'));
        return;
    }
    const folder = library.folders.find((item) => item.id === wardrobeFolder);
    if (!folder) return;
    const values = await formDialog({
        title: t('renameFolder'),
        fields: [{ id: 'name', label: t('folderName'), value: folder.name }],
    });
    if (!values?.name) return;
    folder.name = values.name;
    library = await storage.saveLibrary(library);
    renderPanel();
}

async function deleteCurrentFolder() {
    if (wardrobeFolder === 'all') {
        toast('warning', t('selectFolder'));
        return;
    }
    if (library.folders.length <= 1) {
        toast('warning', t('cannotDeleteOnlyFolder'));
        return;
    }
    if (library.outfits.some((outfit) => outfit.folderId === wardrobeFolder)) {
        toast('warning', t('folderNotEmpty'));
        return;
    }
    if (!confirm(t('confirmDeleteFolder'))) return;
    library.folders = library.folders.filter((folder) => folder.id !== wardrobeFolder);
    library = await storage.saveLibrary(library);
    wardrobeFolder = 'all';
    renderPanel();
}

async function renameOutfit(outfitId) {
    const outfit = library.outfits.find((item) => item.id === outfitId);
    if (!outfit) return;
    const values = await formDialog({
        title: t('rename'),
        fields: [{ id: 'name', label: t('outfitName'), value: outfit.name }],
    });
    if (!values?.name) return;
    outfit.name = values.name;
    outfit.updatedAt = new Date().toISOString();
    if (activeState.outfitId === outfit.id) {
        activeState.outfitName = outfit.name;
        await saveActiveState();
    }
    library = await storage.saveLibrary(library);
    renderPanel();
}

async function moveOutfit(outfitId) {
    const outfit = library.outfits.find((item) => item.id === outfitId);
    if (!outfit) return;
    const values = await formDialog({
        title: t('move'),
        fields: [{
            id: 'folder', label: t('folder'), type: 'select', value: outfit.folderId,
            options: library.folders.map((folder) => ({ value: folder.id, label: folder.name })),
        }],
    });
    if (!values?.folder) return;
    outfit.folderId = values.folder;
    outfit.updatedAt = new Date().toISOString();
    if (activeState.outfitId === outfit.id) {
        activeState.folderId = outfit.folderId;
        await saveActiveState();
    }
    library = await storage.saveLibrary(library);
    renderPanel();
}

async function deleteOutfit(outfitId) {
    const outfit = library.outfits.find((item) => item.id === outfitId);
    if (!outfit || !confirm(t('confirmDeleteOutfit'))) return;
    library.outfits = library.outfits.filter((item) => item.id !== outfitId);
    library = await storage.saveLibrary(library);
    renderPanel();
}

async function editField(fieldId) {
    const field = settings.fields.find((item) => item.id === fieldId);
    if (!field) return;
    const values = await formDialog({
        title: t('rename'),
        fields: [
            { id: 'ru', label: `${t('fieldName')} \u2014 RU`, value: field.labels.ru },
            { id: 'en', label: `${t('fieldName')} \u2014 EN`, value: field.labels.en },
        ],
    });
    if (!values || (!values.ru && !values.en)) return;
    field.labels.ru = values.ru || values.en;
    field.labels.en = values.en || values.ru;
    persistSettings();
    renderPanel();
}

async function addField() {
    const values = await formDialog({
        title: t('addField'),
        confirmLabel: t('create'),
        fields: [
            { id: 'ru', label: `${t('fieldName')} \u2014 RU`, value: '' },
            { id: 'en', label: `${t('fieldName')} \u2014 EN`, value: '' },
        ],
    });
    if (!values || (!values.ru && !values.en)) return;
    settings.fields.push({
        id: createId('field'),
        icon: 'fa-solid fa-tag',
        builtIn: false,
        labels: { ru: values.ru || values.en, en: values.en || values.ru },
    });
    persistSettings();
    renderPanel();
}

function moveField(fieldId, delta) {
    const index = settings.fields.findIndex((item) => item.id === fieldId);
    const target = index + delta;
    if (index < 0 || target < 0 || target >= settings.fields.length) return;
    const [field] = settings.fields.splice(index, 1);
    settings.fields.splice(target, 0, field);
    persistSettings();
    renderPanel();
}

function deleteField(fieldId) {
    settings.fields = settings.fields.filter((item) => item.id !== fieldId);
    delete activeState.fields[fieldId];
    persistSettings();
    scheduleStateSave();
    renderPanel();
}

async function exportBackup() {
    try {
        const backup = await storage.exportBackup();
        const blob = new Blob([JSON.stringify(backup)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        const date = new Date().toISOString().slice(0, 10);
        anchor.href = url;
        anchor.download = `character-visual-backup-${date}.json`;
        anchor.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        toast('success', t('exportDone'));
    } catch (error) {
        console.error('[Character Visual] Export failed:', error);
        toast('error', t('storageError'));
    }
}

async function importBackup() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json,.json';
    input.style.display = 'none';
    document.body.appendChild(input);
    input.addEventListener('change', async () => {
        const file = input.files?.[0];
        input.remove();
        if (!file || !confirm(t('importConfirm'))) return;
        try {
            const data = JSON.parse(await file.text());
            library = await storage.importBackup(data);
            wardrobeFolder = 'all';
            toast('success', t('importDone'));
            renderPanel();
        } catch (error) {
            console.error('[Character Visual] Import failed:', error);
            toast('error', error?.message === 'INVALID_BACKUP' ? t('invalidBackup') : t('importFailed'));
        }
    }, { once: true });
    input.click();
}

function viewportSize() {
    const vv = window.visualViewport;
    return vv?.width && vv?.height
        ? { width: vv.width, height: vv.height }
        : { width: window.innerWidth, height: window.innerHeight };
}

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

function clampPanelPosition(left, top, width = panel.offsetWidth, height = panel.offsetHeight) {
    const viewport = viewportSize();
    return {
        left: clamp(left, DRAG_EDGE, Math.max(DRAG_EDGE, viewport.width - width - DRAG_EDGE)),
        top: clamp(top, DRAG_TOP, Math.max(DRAG_TOP, viewport.height - height - DRAG_EDGE)),
    };
}

function applyPanelLayout(centered = false) {
    const viewport = viewportSize();
    const savedSize = settings.panelSize || DEFAULT_PANEL_SIZE;
    const width = clamp(savedSize.width || DEFAULT_PANEL_SIZE.width, MIN_PANEL_SIZE.width, Math.max(MIN_PANEL_SIZE.width, viewport.width - DRAG_EDGE * 2));
    const height = clamp(savedSize.height || DEFAULT_PANEL_SIZE.height, MIN_PANEL_SIZE.height, Math.max(MIN_PANEL_SIZE.height, viewport.height - DRAG_TOP - DRAG_EDGE));
    panel.style.width = `${width}px`;
    panel.style.height = `${height}px`;

    let left;
    let top;
    if (centered || !settings.panelPosition) {
        left = Math.max(DRAG_EDGE, (viewport.width - width) / 2);
        top = Math.max(DRAG_TOP, (viewport.height - height) / 2);
    } else {
        left = settings.panelPosition.left;
        top = settings.panelPosition.top;
    }
    const point = clampPanelPosition(left, top, width, height);
    panel.style.left = `${point.left}px`;
    panel.style.top = `${point.top}px`;
    panel.style.right = 'auto';
    panel.style.bottom = 'auto';
}

function openPanel(mode = 'floating') {
    panel.style.display = 'flex';
    panel.dataset.openMode = mode;
    previewVisible = settings.previewVisible !== false;
    applyPanelLayout(mode === 'center');
    currentView = 'editor';
    renderPanel();
}

function closePanel() {
    panel.style.display = 'none';
    revokeObjectUrls();
}

function resetLayout() {
    settings.panelPosition = null;
    settings.panelSize = { ...DEFAULT_PANEL_SIZE };
    settings.buttonPosition = null;
    persistSettings();
    positionFloatingButton();
    if (panelVisible()) applyPanelLayout(true);
    toast('success', t('layoutReset'));
}

function makePanelDraggable() {
    const handle = panel.querySelector('#cv-header');
    handle.style.touchAction = 'none';
    let dragging = false;
    let startX = 0;
    let startY = 0;
    let baseLeft = 0;
    let baseTop = 0;

    handle.addEventListener('pointerdown', (event) => {
        if (event.target.closest('button')) return;
        if (event.button != null && event.button !== 0) return;
        dragging = true;
        const rect = panel.getBoundingClientRect();
        startX = event.clientX;
        startY = event.clientY;
        baseLeft = rect.left;
        baseTop = rect.top;
        try { handle.setPointerCapture(event.pointerId); } catch (error) { /* ignore */ }
    });
    handle.addEventListener('pointermove', (event) => {
        if (!dragging) return;
        const point = clampPanelPosition(baseLeft + event.clientX - startX, baseTop + event.clientY - startY);
        panel.style.left = `${point.left}px`;
        panel.style.top = `${point.top}px`;
    });
    const finish = (event) => {
        if (!dragging) return;
        dragging = false;
        try { handle.releasePointerCapture(event.pointerId); } catch (error) { /* ignore */ }
        const rect = panel.getBoundingClientRect();
        settings.panelPosition = { left: rect.left, top: rect.top };
        panel.dataset.openMode = 'floating';
        persistSettings();
    };
    handle.addEventListener('pointerup', finish);
    handle.addEventListener('pointercancel', finish);
}

function makePanelResizable() {
    const handle = panel.querySelector('#cv-resize-handle');
    handle.style.touchAction = 'none';
    let resizing = false;
    let startX = 0;
    let startY = 0;
    let baseWidth = 0;
    let baseHeight = 0;

    handle.addEventListener('pointerdown', (event) => {
        resizing = true;
        startX = event.clientX;
        startY = event.clientY;
        const rect = panel.getBoundingClientRect();
        baseWidth = rect.width;
        baseHeight = rect.height;
        try { handle.setPointerCapture(event.pointerId); } catch (error) { /* ignore */ }
        event.preventDefault();
    });
    handle.addEventListener('pointermove', (event) => {
        if (!resizing) return;
        const viewport = viewportSize();
        const rect = panel.getBoundingClientRect();
        const width = clamp(baseWidth + event.clientX - startX, MIN_PANEL_SIZE.width, viewport.width - rect.left - DRAG_EDGE);
        const height = clamp(baseHeight + event.clientY - startY, MIN_PANEL_SIZE.height, viewport.height - rect.top - DRAG_EDGE);
        panel.style.width = `${width}px`;
        panel.style.height = `${height}px`;
    });
    const finish = (event) => {
        if (!resizing) return;
        resizing = false;
        try { handle.releasePointerCapture(event.pointerId); } catch (error) { /* ignore */ }
        const rect = panel.getBoundingClientRect();
        settings.panelSize = { width: rect.width, height: rect.height };
        persistSettings();
    };
    handle.addEventListener('pointerup', finish);
    handle.addEventListener('pointercancel', finish);
}

function positionFloatingButton() {
    if (!floatingButton) return;
    const position = settings.buttonPosition;
    if (position) {
        floatingButton.style.left = `${position.left}px`;
        floatingButton.style.top = `${position.top}px`;
        floatingButton.style.right = 'auto';
        floatingButton.style.bottom = 'auto';
    } else {
        floatingButton.style.removeProperty('left');
        floatingButton.style.removeProperty('top');
        floatingButton.style.removeProperty('right');
        floatingButton.style.removeProperty('bottom');
    }
}

function makeFloatingButtonDraggable() {
    floatingButton.style.touchAction = 'none';
    let dragging = false;
    let moved = false;
    let startX = 0;
    let startY = 0;
    let baseLeft = 0;
    let baseTop = 0;

    floatingButton.addEventListener('pointerdown', (event) => {
        dragging = true;
        moved = false;
        const rect = floatingButton.getBoundingClientRect();
        startX = event.clientX;
        startY = event.clientY;
        baseLeft = rect.left;
        baseTop = rect.top;
        try { floatingButton.setPointerCapture(event.pointerId); } catch (error) { /* ignore */ }
    });
    floatingButton.addEventListener('pointermove', (event) => {
        if (!dragging) return;
        const dx = event.clientX - startX;
        const dy = event.clientY - startY;
        if (!moved && Math.hypot(dx, dy) < 5) return;
        moved = true;
        const viewport = viewportSize();
        const left = clamp(baseLeft + dx, DRAG_EDGE, viewport.width - floatingButton.offsetWidth - DRAG_EDGE);
        const top = clamp(baseTop + dy, DRAG_TOP, viewport.height - floatingButton.offsetHeight - DRAG_EDGE);
        floatingButton.style.left = `${left}px`;
        floatingButton.style.top = `${top}px`;
        floatingButton.style.right = 'auto';
        floatingButton.style.bottom = 'auto';
    });
    const finish = (event) => {
        if (!dragging) return;
        dragging = false;
        try { floatingButton.releasePointerCapture(event.pointerId); } catch (error) { /* ignore */ }
        if (moved) {
            const rect = floatingButton.getBoundingClientRect();
            settings.buttonPosition = { left: rect.left, top: rect.top };
            persistSettings();
        }
    };
    floatingButton.addEventListener('pointerup', finish);
    floatingButton.addEventListener('pointercancel', finish);
    floatingButton.addEventListener('click', () => {
        if (moved) {
            moved = false;
            return;
        }
        if (panelVisible()) closePanel();
        else openPanel('floating');
    });
}

function updateFloatingVisibility() {
    if (!floatingButton) return;
    floatingButton.style.display = settings.showFloatingButton ? '' : 'none';
}

function createMainUi() {
    if (document.querySelector('#cv-panel')) return;

    floatingButton = document.createElement('button');
    floatingButton.id = 'cv-button';
    floatingButton.type = 'button';
    floatingButton.textContent = t('floatingButton');
    document.body.appendChild(floatingButton);

    panel = document.createElement('div');
    panel.id = 'cv-panel';
    panel.style.display = 'none';
    panel.innerHTML = `
        <header id="cv-header">
            <div class="cv-header-brand"><span class="cv-header-ornament">&#9884;&#65038;</span><span id="cv-title">${escapeHtml(t('title'))}</span></div>
            <nav id="cv-header-actions">
                <button id="cv-nav-editor" class="cv-nav-button cv-active" data-view="editor" type="button" title="${escapeHtml(t('editor'))}"><i class="fa-solid fa-shirt"></i></button>
                <button id="cv-nav-wardrobe" class="cv-nav-button" data-view="wardrobe" type="button" title="${escapeHtml(t('wardrobe'))}"><i class="fa-solid fa-door-open"></i></button>
                <button id="cv-nav-settings" class="cv-nav-button" data-view="settings" type="button" title="${escapeHtml(t('settings'))}"><i class="fa-solid fa-gear"></i></button>
                <button id="cv-close" type="button" title="${escapeHtml(t('close'))}"><i class="fa-solid fa-xmark"></i></button>
            </nav>
        </header>
        <main id="cv-content"></main>
        <div id="cv-resize-handle" title="Resize"><i class="fa-solid fa-grip-lines"></i></div>
    `;
    document.body.appendChild(panel);

    panel.querySelectorAll('.cv-nav-button').forEach((button) => {
        button.addEventListener('click', () => switchView(button.dataset.view));
    });
    panel.querySelector('#cv-close').addEventListener('click', closePanel);
    makePanelDraggable();
    makePanelResizable();
    makeFloatingButtonDraggable();
    positionFloatingButton();
    updateFloatingVisibility();
}

function createMenuButton() {
    if (document.querySelector('#cv-menu-button')) {
        menuButton = document.querySelector('#cv-menu-button');
        return;
    }
    const host = document.querySelector('#extensionsMenu');
    if (!host) {
        setTimeout(createMenuButton, 1000);
        return;
    }
    menuButton = document.createElement('div');
    menuButton.id = 'cv-menu-button';
    menuButton.className = 'list-group-item flex-container flexGap5 interactable';
    menuButton.tabIndex = 0;
    menuButton.innerHTML = `<i class="fa-solid fa-shirt"></i><span>${escapeHtml(t('openPanel'))}</span>`;
    menuButton.addEventListener('click', () => openPanel('center'));
    menuButton.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') openPanel('center');
    });
    host.appendChild(menuButton);
}

function createExtensionSettingsDrawer() {
    if (document.querySelector('#cv-extension-settings')) {
        settingsDrawer = document.querySelector('#cv-extension-settings');
        renderExtensionSettingsDrawer();
        return;
    }
    const host = document.querySelector('#extensions_settings2');
    if (!host) {
        setTimeout(createExtensionSettingsDrawer, 1000);
        return;
    }
    settingsDrawer = document.createElement('div');
    settingsDrawer.id = 'cv-extension-settings';
    settingsDrawer.className = 'cv-extension-settings';
    host.appendChild(settingsDrawer);
    renderExtensionSettingsDrawer();
}

function renderExtensionSettingsDrawer() {
    if (!settingsDrawer) return;
    settingsDrawer.innerHTML = `
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b><i class="fa-solid fa-shirt"></i> ${escapeHtml(t('title'))}</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <label class="cv-drawer-row"><span>${escapeHtml(t('uiLanguage'))}</span><select id="cv-drawer-ui-language">
                    <option value="auto"${settings.uiLanguage === 'auto' ? ' selected' : ''}>${escapeHtml(t('auto'))}</option>
                    <option value="ru"${settings.uiLanguage === 'ru' ? ' selected' : ''}>${escapeHtml(t('russian'))}</option>
                    <option value="en"${settings.uiLanguage === 'en' ? ' selected' : ''}>${escapeHtml(t('english'))}</option>
                </select></label>
                <label class="cv-drawer-row"><span>${escapeHtml(t('promptLanguage'))}</span><select id="cv-drawer-prompt-language">
                    <option value="en"${settings.promptLanguage === 'en' ? ' selected' : ''}>${escapeHtml(t('english'))}</option>
                    <option value="ru"${settings.promptLanguage === 'ru' ? ' selected' : ''}>${escapeHtml(t('russian'))}</option>
                </select></label>
                <label class="checkbox_label"><input id="cv-drawer-floating" type="checkbox"${settings.showFloatingButton ? ' checked' : ''}><span>${escapeHtml(t('showFloating'))}</span></label>
                <div class="cv-drawer-actions">
                    <button id="cv-drawer-open" class="menu_button" type="button"><i class="fa-solid fa-up-right-from-square"></i>${escapeHtml(t('openPanel'))}</button>
                    <button id="cv-drawer-fields" class="menu_button" type="button"><i class="fa-solid fa-tags"></i>${escapeHtml(t('manageFields'))}</button>
                    <button id="cv-drawer-reset" class="menu_button" type="button"><i class="fa-solid fa-arrows-to-dot"></i>${escapeHtml(t('resetLayout'))}</button>
                </div>
            </div>
        </div>
    `;
    settingsDrawer.querySelector('#cv-drawer-ui-language').addEventListener('change', (event) => {
        settings.uiLanguage = event.target.value;
        persistSettings();
        updateStaticLabels();
        renderPanel();
    });
    settingsDrawer.querySelector('#cv-drawer-prompt-language').addEventListener('change', (event) => {
        settings.promptLanguage = event.target.value;
        persistSettings();
    });
    settingsDrawer.querySelector('#cv-drawer-floating').addEventListener('change', (event) => {
        settings.showFloatingButton = event.target.checked;
        persistSettings();
        updateFloatingVisibility();
    });
    settingsDrawer.querySelector('#cv-drawer-open').addEventListener('click', () => openPanel('center'));
    settingsDrawer.querySelector('#cv-drawer-fields').addEventListener('click', () => {
        openPanel('center');
        switchView('settings');
    });
    settingsDrawer.querySelector('#cv-drawer-reset').addEventListener('click', resetLayout);
}

function handleViewportChange() {
    if (panelVisible()) applyPanelLayout(panel.dataset.openMode === 'center');
    if (settings.buttonPosition && floatingButton) {
        const rect = floatingButton.getBoundingClientRect();
        const viewport = viewportSize();
        const left = clamp(rect.left, DRAG_EDGE, viewport.width - rect.width - DRAG_EDGE);
        const top = clamp(rect.top, DRAG_TOP, viewport.height - rect.height - DRAG_EDGE);
        floatingButton.style.left = `${left}px`;
        floatingButton.style.top = `${top}px`;
    }
}

async function init() {
    if (initialized) return;
    context = getContextSafe();
    const localforage = globalThis.SillyTavern?.libs?.localforage || context?.libs?.localforage;
    if (!context?.extensionSettings || !localforage) {
        setTimeout(init, 750);
        return;
    }
    initialized = true;

    loadSettings();
    storage = createStorage(localforage, settings.storageNamespace, t('defaultFolder'));
    try {
        library = await storage.loadLibrary();
    } catch (error) {
        initialized = false;
        console.error('[Character Visual] Could not initialize storage:', error);
        toast('error', t('storageError'));
        return;
    }

    registerMacro();
    createMainUi();
    createMenuButton();
    createExtensionSettingsDrawer();
    await loadActiveChatState();

    context.eventSource?.on?.(context.event_types.CHAT_CHANGED, loadActiveChatState);
    window.addEventListener('resize', handleViewportChange);
    window.visualViewport?.addEventListener?.('resize', handleViewportChange);
    console.log('[Character Visual] Loaded.');
}

function boot() {
    const ctx = getContextSafe();
    if (ctx?.eventSource && ctx?.event_types?.APP_READY) {
        ctx.eventSource.on(ctx.event_types.APP_READY, init);
    }
    setTimeout(init, 1000);
}

boot();
