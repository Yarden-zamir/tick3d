// The advanced settings of the computer.
import { type Tuning, parseTuning, DEFAULT_TUNING, isDefaultTuning, TUNING_FIELDS, fieldValue } from '../tuning.ts';
import { agentCopy, agentSnippet, tuningEl, tuningReset } from './dom.ts';
import { copyText, showProblem, showToast, reject } from './feedback.ts';
import { render } from './render.ts';
import { settingsLocked } from './state.ts';

const TUNING_KEY = 'tick3d.tuning';

function loadTuning(): Tuning {
  try {
    return parseTuning(JSON.parse(localStorage.getItem(TUNING_KEY) ?? 'null'));
  } catch {
    return DEFAULT_TUNING;
  }
}

let tuning = loadTuning();
// The settings that the computer plays with now. Only this module changes them.
export const computerTuning = () => tuning;

function saveTuning(next: Tuning): void {
  tuning = next;
  try {
    if (isDefaultTuning(next)) localStorage.removeItem(TUNING_KEY);
    else localStorage.setItem(TUNING_KEY, JSON.stringify(next));
  } catch {
    // Storage is blocked (private mode). The settings then last for this visit only.
  }
}

// One box per level, one number per field. A change applies from the computer's next move.
function buildTuning(): void {
  const groups = new Map<string, HTMLFieldSetElement>();
  for (const field of TUNING_FIELDS) {
    let group = groups.get(field.group);
    if (group === undefined) {
      group = document.createElement('fieldset');
      const legend = document.createElement('legend');
      legend.textContent = field.group;
      group.append(legend);
      groups.set(field.group, group);
    }
    const label = document.createElement('label');
    const input = document.createElement('input');
    Object.assign(input, { type: 'number', min: String(field.min), max: String(field.max), step: String(field.step) });
    input.value = String(field.get(tuning));
    input.addEventListener('change', () => {
      const value = fieldValue(field, input.valueAsNumber);
      if (value === undefined) showToast(`${field.label}: use a number from ${field.min} to ${field.max}.`);
      else saveTuning(field.set(tuning, value));
      input.value = String(field.get(tuning));
    });
    label.append(field.label, input);
    group.append(label);
  }
  tuningEl.replaceChildren(...groups.values());
}

// A short text that a player gives to an AI agent. The OpenAPI document tells the agent the rest.
function agentText(): string {
  return [
    `tick3d is a 3D tic-tac-toe game with an HTTP API. Its OpenAPI document: ${location.origin}/api/openapi.json`,
    'No account or key is needed. curl is enough.',
    'Read the document, then wait for my instructions. Do not start a game on your own.',
    'When I ask you to play me, another agent or yourself, give me the game link so I can watch.',
  ].join('\n');
}

export function setupAdvanced(): void {
  agentSnippet.textContent = agentText();
  agentCopy.addEventListener('click', () => {
    void copyText(agentText()).then(
      () => showToast('Copied. Paste it to your AI agent.'),
      () => {
        // Select the text, so the player can copy it by hand.
        getSelection()?.selectAllChildren(agentSnippet);
        showProblem('Copy did not work. Select the text and copy it.');
      },
    );
  });

  tuningReset.addEventListener('click', () => {
    if (settingsLocked()) return reject(undefined, 'locked');
    saveTuning(DEFAULT_TUNING);
    buildTuning();
    render();
    showToast('The computer plays with the default settings again.');
  });

  buildTuning();
}
