// ui/recordControls.js - the game record's notes box and download button,
// shown on the Resolution panel of every round and on the final panel.

export function downloadJsonFile(payload, filename) {
  if (typeof document === 'undefined' || !payload) return;
  const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

// `controls` comes from GameController.buildRecordControls(): the note for
// this round (or the whole game), where to save it, and the download.
export function renderRecordControls(container, controls) {
  if (!container || !controls) return null;
  const section = document.createElement('section');
  section.className = 'record-controls';
  const noteId = `recordNote-${controls.final ? 'game' : 'round'}`;
  section.innerHTML = `
    <label class="record-note-label" for="${noteId}">${controls.final ? 'Your notes on this game' : 'Your notes on this round'}</label>
    <textarea id="${noteId}" class="record-note" rows="3" placeholder="${controls.final
      ? 'What worked, what surprised you, what the AIs did well or badly.'
      : 'Why you played as you did, what you expect the others to do.'}"></textarea>
    <div class="record-actions">
      <button type="button" class="btn-secondary" data-action="download-record">Download game record</button>
      <span class="record-hint">${controls.final
      ? "The record holds every move, your notes, and the AIs' reasons and hidden moods."
      : "Mid-game, the record reveals the AIs' hidden moods."}</span>
    </div>
  `;
  const textarea = section.querySelector('textarea');
  textarea.value = controls.note || '';
  textarea.addEventListener('input', () => controls.onNote?.(textarea.value));
  section.querySelector('[data-action="download-record"]').addEventListener('click', () => controls.download?.());
  container.appendChild(section);
  return section;
}
