# Changelog

## 2026-06-08

- Changed panel opening behavior so it always appears on the right side and no longer restores the last dragged position.
- Kept panel size persistence while removing saved position persistence.
- Added a setting to automatically send manually marked translated text to Notes; enabled by default.
- Saved auto-sent marks to Notes using the selected Markdown-compatible mark style.
- Added a configurable highlight color for manual translated-text marks.
- Moved Markdown saving into the panel header next to the close button.
- Removed the separate save buttons from Ask and Notes panels.
- Kept the header save button wired to the same export options, including URL, original text, translation, Ask content, and notes.
- Removed automatic "important conclusion" highlighting because it produced unreliable highlights.
- Added manual marking for selected translated text with five Markdown-compatible styles:
  - `==highlight==`
  - `**bold**`
  - `*italic*`
  - `***bold italic***`
  - `` `code` ``
- Added a mark button to the selection toolbar for translated text.
- Added Markdown export support for marked translated text.
- Added Ask Markdown saving and allowed Notes export to include Ask content.
- Improved panel resizing with draggable edges and all four corner handles.
- Improved Twitter copy generation error handling for invalidated extension contexts.
