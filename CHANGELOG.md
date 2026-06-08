# Changelog

## 2026-06-08

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
