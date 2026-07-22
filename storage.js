import { DATA_VERSION } from './constants.js';

function nowIso() {
    return new Date().toISOString();
}

function newId(prefix) {
    const uuid = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    return `${prefix}-${uuid}`;
}

export function createStorage(localforage, namespace, defaultFolderName) {
    if (!localforage) {
        throw new Error('SillyTavern localforage library is unavailable.');
    }

    const db = localforage.createInstance({
        name: 'character-visual',
        storeName: 'wardrobe_data',
        description: 'Local Character Visual wardrobes and images',
    });

    const prefix = `cv::${namespace}::`;
    const key = (suffix) => `${prefix}${suffix}`;

    function emptyLibrary() {
        return {
            version: DATA_VERSION,
            folders: [{ id: newId('folder'), name: defaultFolderName }],
            outfits: [],
            updatedAt: nowIso(),
        };
    }

    async function loadLibrary() {
        const stored = await db.getItem(key('library'));
        if (!stored || typeof stored !== 'object') {
            const fresh = emptyLibrary();
            await db.setItem(key('library'), fresh);
            return fresh;
        }

        const library = {
            version: DATA_VERSION,
            folders: Array.isArray(stored.folders) ? stored.folders : [],
            outfits: Array.isArray(stored.outfits) ? stored.outfits : [],
            updatedAt: stored.updatedAt || nowIso(),
        };

        if (!library.folders.length) {
            library.folders.push({ id: newId('folder'), name: defaultFolderName });
        }

        return library;
    }

    async function saveLibrary(library) {
        const clean = {
            version: DATA_VERSION,
            folders: Array.isArray(library.folders) ? library.folders : [],
            outfits: Array.isArray(library.outfits) ? library.outfits : [],
            updatedAt: nowIso(),
        };
        await db.setItem(key('library'), clean);
        return clean;
    }

    async function loadChatState(chatKey) {
        if (!chatKey) return null;
        const state = await db.getItem(key(`chat::${chatKey}`));
        return state && typeof state === 'object' ? state : null;
    }

    async function saveChatState(chatKey, state) {
        if (!chatKey) return;
        await db.setItem(key(`chat::${chatKey}`), {
            ...state,
            updatedAt: nowIso(),
        });
    }

    async function putImage(imageId, originalBlob, thumbnailBlob) {
        if (!imageId || !originalBlob) return;
        await db.setItem(key(`image::${imageId}`), originalBlob);
        await db.setItem(key(`thumb::${imageId}`), thumbnailBlob || originalBlob);
    }

    async function getImage(imageId, thumbnail = false) {
        if (!imageId) return null;
        const type = thumbnail ? 'thumb' : 'image';
        return await db.getItem(key(`${type}::${imageId}`));
    }

    async function removeImage(imageId) {
        if (!imageId) return;
        await db.removeItem(key(`image::${imageId}`));
        await db.removeItem(key(`thumb::${imageId}`));
    }

    async function blobToDataUrl(blob) {
        return await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onerror = () => reject(reader.error || new Error('Could not read image blob.'));
            reader.onload = () => resolve(String(reader.result || ''));
            reader.readAsDataURL(blob);
        });
    }

    function dataUrlToBlob(dataUrl) {
        const [header, payload] = String(dataUrl || '').split(',', 2);
        if (!header || payload == null) throw new Error('Invalid data URL.');
        const mime = header.match(/^data:([^;,]+)/i)?.[1] || 'application/octet-stream';
        const binary = header.includes(';base64') ? atob(payload) : decodeURIComponent(payload);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        return new Blob([bytes], { type: mime });
    }

    async function exportBackup() {
        const library = await loadLibrary();
        const imageIds = [...new Set(library.outfits.map((outfit) => outfit.imageId).filter(Boolean))];
        const images = {};

        for (const imageId of imageIds) {
            const original = await getImage(imageId, false);
            const thumbnail = await getImage(imageId, true);
            if (!original) continue;
            images[imageId] = {
                original: await blobToDataUrl(original),
                thumbnail: thumbnail ? await blobToDataUrl(thumbnail) : null,
            };
        }

        return {
            format: 'character-visual-backup',
            version: DATA_VERSION,
            exportedAt: nowIso(),
            library,
            images,
        };
    }

    async function importBackup(backup) {
        if (
            !backup ||
            backup.format !== 'character-visual-backup' ||
            !backup.library ||
            !Array.isArray(backup.library.folders) ||
            !Array.isArray(backup.library.outfits)
        ) {
            throw new Error('INVALID_BACKUP');
        }

        const keys = await db.keys();
        const removable = keys.filter((item) =>
            item.startsWith(key('image::')) || item.startsWith(key('thumb::'))
        );
        for (const item of removable) await db.removeItem(item);

        const images = backup.images && typeof backup.images === 'object' ? backup.images : {};
        for (const [imageId, imageData] of Object.entries(images)) {
            if (!imageData?.original) continue;
            const original = dataUrlToBlob(imageData.original);
            const thumbnail = imageData.thumbnail ? dataUrlToBlob(imageData.thumbnail) : original;
            await putImage(imageId, original, thumbnail);
        }

        return await saveLibrary({
            version: DATA_VERSION,
            folders: backup.library.folders,
            outfits: backup.library.outfits,
        });
    }

    async function collectReferencedImageIds() {
        const library = await loadLibrary();
        const referenced = new Set(
            library.outfits.map((outfit) => outfit.imageId).filter(Boolean)
        );

        const keys = await db.keys();
        const chatPrefix = key('chat::');
        for (const item of keys) {
            if (!item.startsWith(chatPrefix)) continue;
            try {
                const state = await db.getItem(item);
                if (state && typeof state === 'object' && state.imageId) {
                    referenced.add(state.imageId);
                }
            } catch (error) {
                console.error('[Character Visual] GC could not read chat state:', error);
            }
        }
        return { referenced, keys };
    }

    // Removes image/thumb blobs that no saved outfit and no chat snapshot
    // references any more. Reference-complete: it scans both the wardrobe
    // library and every stored chat state before deleting anything, so it is
    // safe even though one image can be shared by an outfit and several chats.
    // Callers must persist the current chat state (await saveChatState) before
    // invoking this, otherwise a freshly uploaded image could look orphaned.
    async function collectGarbage() {
        const { referenced, keys } = await collectReferencedImageIds();

        const imagePrefix = key('image::');
        const stored = new Set();
        for (const item of keys) {
            if (item.startsWith(imagePrefix)) stored.add(item.slice(imagePrefix.length));
        }

        let removed = 0;
        for (const imageId of stored) {
            if (referenced.has(imageId)) continue;
            await removeImage(imageId);
            removed += 1;
        }
        return removed;
    }

    return {
        db,
        newId,
        loadLibrary,
        saveLibrary,
        loadChatState,
        saveChatState,
        putImage,
        getImage,
        removeImage,
        collectGarbage,
        exportBackup,
        importBackup,
    };
}
