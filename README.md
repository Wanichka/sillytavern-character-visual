# Character Visual

A theme-aware SillyTavern extension for keeping a visual wardrobe of complete
outfits and exposing the current outfit through the `{{current_outfit}}` macro.

## Features

- Complete outfit presets with a full-size reference image and thumbnail.
- Wardrobe folders for separate characters and AUs.
- Outfit selection across all folders.
- A separate current outfit for every chat.
- Local browser storage (IndexedDB); a new installation starts empty.
- Russian and English UI.
- English or Russian prompt labels, independently of the UI language.
- Theme-aware floating panel with decorative accents.
- Draggable floating button and draggable/resizable panel.
- A centered launcher in SillyTavern's extensions menu.
- Editable and reorderable outfit fields.
- JSON backup export/import, including images.

## Installation

Install the folder as a SillyTavern third-party UI extension, then reload
SillyTavern. The extension folder must contain `manifest.json`, `index.js`, and
`style.css` at its root.

## Prompt setup

Replace the contents of the existing `<outfit>` section with the macro:

```text
The <outfit> section is supplied by {{current_outfit}}. Copy its expanded content exactly. Do not add, remove, infer, or alter any outfit details based on the scene. Track temporary conditions such as dirt, wetness, damage, or similar changes only in <user_notes>, not in <outfit>.

<outfit>
{{current_outfit}}
</outfit>
```

When no outfit is selected, the macro returns `Outfit not specified.` (or its
Russian equivalent if Russian prompt labels are selected).

## Storage notes

Wardrobe data and images are stored locally in the current browser using
IndexedDB. Data is separated by the current SillyTavern account. It does not
ship with the extension and is not shared with other people who install it.

Browser storage is device-specific. Use **Export backup** before clearing site
data, changing browsers, or reinstalling the operating system. Use **Import
backup** to restore it.

### What a backup contains

A backup stores your **wardrobe**: every saved outfit, its folders, and the
images attached to those saved outfits. It does **not** store per-chat current
outfits or an image that was uploaded to a chat but never saved to the wardrobe.
If you want to keep such an image, save the look as a wardrobe outfit (**Save
outfit** / **Save as new**) before exporting.

Images that are no longer referenced by any saved outfit or chat are cleaned up
automatically from browser storage, so replacing or deleting outfit images does
not leave orphaned data behind.
