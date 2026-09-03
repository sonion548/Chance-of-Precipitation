import { RARITY, RARITY_ORDER, RUN_MODES, VERSION, COOP, PETS, FINAL, ECHOES } from '../core/config.js';
import { PETS_SPECIES } from '../data/pets.js';
import { ITEMS, ITEMS_BY_RARITY, itemDescription } from '../data/items.js';
import { itemIconDataURL } from '../data/itemArt.js';
import { weaponById } from '../data/weapons.js';
import { CHARACTERS } from '../data/characters.js';
import { ENEMIES, BOSSES } from '../data/enemies.js';
import { unlockCatalogue } from '../meta/progression.js';
import { formatTime, formatNumber } from '../core/mathx.js';
import { settings, ACTIONS, codeLabel } from '../core/settings.js';
import { audio } from '../core/audio.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** How a settings value reads next to its control. */
/** All out-of-run screens: menu, loadout, Sanctum, codex, records, settings, pause, summary. */
export class Menus {
  constructor(game) {
    this.game = game;
    this.profile = game.profile;
    this.current = 'loading';
    this.selectedCharacter = this.profile.data.equippedCharacter;
    this.unlockTab = 'items';
    this.codexTab = 'items';
    this.settingsTab = 'audio';
    // Where the ✕ on the settings panel goes back to. Opening it from a paused
    // run and being dumped at the main menu would be a good way to lose a run.
    this.settingsReturn = 'menu';
    // What is currently half-typed into the co-op form. The panel re-renders
    // whenever the roster or the lobby address changes, and a re-render replaces
    // the fields — without this, a friend joining wipes what you were typing.
    this._clearCoopDraft();
    // Same problem as the co-op form, same answer: the panel re-renders when
    // you switch tabs, and a re-render replaces the fields. What is half-typed
    // lives out here so switching from Bug to Idea and back does not eat it.
    this.feedbackTab = 'bug';
    this.feedbackReturn = 'menu';
    this._clearFeedbackDraft();
    this._bind();
  }

  // ------------------------------------------------------------------ routing
  show(name) {
    for (const el of document.querySelectorAll('.screen')) el.classList.remove('active');
    const el = $(`screen-${name}`);
    if (el) el.classList.add('active');
    this.current = name;

    if (name === 'menu') this._renderMenu();
    if (name === 'loadout') this._renderLoadout();
    if (name === 'unlocks') this._renderUnlocks();
    if (name === 'codex') this._renderCodex();
    if (name === 'stats') this._renderStats();
    if (name === 'help') this._renderHelp();
    if (name === 'settings') this._renderSettings();
    if (name === 'pause') this._renderPause();
    if (name === 'coop') this._renderCoop();
    if (name === 'feedback') this._renderFeedback();
  }

  hide() {
    for (const el of document.querySelectorAll('.screen')) el.classList.remove('active');
    this.current = 'none';
  }

  _bind() {
    document.addEventListener('click', (e) => {
      const goto = e.target.closest('[data-goto]');
      if (goto) {
        audio.unlock();
        audio.uiClick(goto.dataset.goto === 'menu' ? 'back' : 'click');
        if (goto.dataset.goto === 'settings') this.settingsReturn = this.current;
        if (goto.dataset.goto === 'feedback') this.feedbackReturn = this.current;
        this.show(goto.dataset.goto);
        return;
      }

      const tab = e.target.closest('.tab');
      if (tab) {
        const container = tab.closest('.panel');
        container.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
        tab.classList.add('active');
        audio.uiClick();
        if (tab.dataset.stab) { this.settingsTab = tab.dataset.stab; this._renderSettings(); }
        else if (tab.dataset.ftab) { this.feedbackTab = tab.dataset.ftab; this._renderFeedback(); }
        else if (container.closest('#screen-unlocks')) { this.unlockTab = tab.dataset.tab; this._renderUnlocks(); }
        else { this.codexTab = tab.dataset.tab; this._renderCodex(); }
        return;
      }

      const ch = e.target.closest('.char-card');
      if (ch && !ch.classList.contains('locked')) {
        this.selectedCharacter = ch.dataset.id;
        this.profile.equipCharacter(this.selectedCharacter);
        this.game.coop.announceLoadout();
        this._renderLoadout();
        return;
      }

      const buy = e.target.closest('.card[data-buy]');
      if (buy) { this._purchase(buy.dataset.kind, buy.dataset.buy, Number(buy.dataset.cost)); return; }

      const mode = e.target.closest('.diff-opt');
      if (mode) { this.profile.setRunMode(mode.dataset.mode); this._renderLoadout(); return; }
    });

    // Co-op controls are re-rendered constantly, so they are handled by
    // delegation rather than by binding nodes that keep being replaced.
    document.addEventListener('click', (e) => {
      if (e.target.closest('#coop-host')) { this._coopHost(); return; }
      if (e.target.closest('#coop-join')) { this._coopJoin(); return; }
      if (e.target.closest('#coop-start')) { this.game.coop.startRun(); return; }
      if (e.target.closest('#coop-leave')) { this.game.coop.leave(); this._renderCoop(); }
    });
    // Typing, also by delegation. The code field is normalised as you go —
    // upper-cased and stripped of anything a lobby code cannot contain — but
    // every letter is allowed through: W, A, S and D are letters like any other.
    document.addEventListener('input', (e) => {
      const el = e.target;
      if (!el.id) return;
      if (el.id === 'coop-code') {
        const clean = el.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
        if (clean !== el.value) {
          const at = el.selectionStart;
          el.value = clean;
          el.setSelectionRange?.(at, at);
        }
        this._coopDraft.code = clean;
      } else if (el.id === 'coop-name') this._coopDraft.name = el.value;
      else if (el.id === 'coop-url') this._coopDraft.url = el.value;
      else if (el.id === 'fb-title') this._feedbackDraft[this.feedbackTab].title = el.value;
      else if (el.id === 'fb-body') this._feedbackDraft[this.feedbackTab].body = el.value;
      else if (el.id === 'fb-contact') this._feedbackDraft.contact = el.value;
    });
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      // Ctrl/⌘+Enter sends from anywhere in the report, including the textarea,
      // where a plain Enter has to keep meaning "new paragraph".
      if ((e.ctrlKey || e.metaKey) && e.target.closest?.('#screen-feedback')) {
        e.preventDefault();
        this._sendFeedback();
        return;
      }
      if (e.target.id === 'coop-code' || e.target.id === 'coop-url') { e.preventDefault(); this._coopJoin(); }
      else if (e.target.id === 'coop-name' && !this.game.coop.active) { e.preventDefault(); this._coopHost(); }
      else if (e.target.id === 'fb-title') { e.preventDefault(); $('fb-body')?.focus(); }
    });
    this.game.coop.onLobbyChange = () => {
      if (this.current === 'coop') this._renderCoop();
      this._renderMenu();
    };
    this.game.coop.onFatal = (message) => {
      this._coopError = message;
      if (this.game.state !== 'menu') this.game.abandonRun();
      this.show('coop');
    };

    this._bindSettings();
    this._bindFeedback();

    $('launch-btn').addEventListener('click', () => {
      // In a lobby the host launches for everyone; solo, this is just Play.
      if (this.game.coop.active && this.game.coop.isHost) this.game.coop.startRun();
      else if (this.game.coop.active) this.show('coop');
      else this.game.startRun();
    });
    $('resume-btn').addEventListener('click', () => this.game.resume());
    $('abandon-btn').addEventListener('click', () => this.game.abandonRun());
    $('summary-again').addEventListener('click', () => this.game.startRun());
    $('summary-menu').addEventListener('click', () => this.show('menu'));
    $('reset-btn').addEventListener('click', () => this._resetAccount());
  }

  /**
   * Wipes the account, behind a two-click confirmation.
   *
   * The button arms rather than opening a modal: `confirm()` is blocked in some
   * embedded contexts, and an ignored dialog would make the destructive path
   * the silent one. Arming disarms itself after four seconds.
   */
  _resetAccount() {
    const btn = $('reset-btn');
    if (!btn) return;
    if (!this._resetArmed) {
      this._resetArmed = true;
      btn.classList.add('armed');
      btn.textContent = 'Click again to erase everything — this cannot be undone';
      clearTimeout(this._resetTimer);
      this._resetTimer = setTimeout(() => {
        this._resetArmed = false;
        const b = $('reset-btn');
        if (b) { b.classList.remove('armed'); b.textContent = 'Reset Account'; }
      }, 4000);
      return;
    }

    clearTimeout(this._resetTimer);
    this._resetArmed = false;
    this.profile.wipe();
    // Everything the menus were holding on to came from the profile, so it all
    // has to come back from the fresh one — otherwise the loadout still shows a
    // character the account no longer owns.
    this.selectedCharacter = this.profile.data.equippedCharacter;
    btn.classList.remove('armed');
    btn.textContent = 'Reset Account';
    this._renderSettings();
    this._renderMenu();
    this.game.hud.toast('Account reset — everything is back to zero', '#ff4d5e');
  }

  // ------------------------------------------------------------------ settings
  /**
   * Everything on this screen writes straight through to the settings store and
   * saves. There is no Apply button and no cancel: a volume slider you have to
   * confirm is a volume slider you cannot hear yourself adjusting.
   */
  _bindSettings() {
    $('settings-close').addEventListener('click', () => {
      audio.uiClick('back');
      this.show(this.settingsReturn === 'pause' ? 'pause' : 'menu');
    });
    $('pause-settings-btn')?.addEventListener('click', () => {
      this.settingsReturn = 'pause';
      this.show('settings');
    });
    $('settings-reset').addEventListener('click', () => {
      settings.resetAll();
      audio.applyVolumes();
      audio.uiClick('confirm');
      this._renderSettings();
    });

    // Sliders: live, on every drag frame.
    $('settings-body').addEventListener('input', (e) => {
      const el = e.target.closest('[data-set]');
      if (!el) return;
      const key = el.dataset.set;
      const value = Number(el.value) / 100;
      settings.set(key, value);
      audio.applyVolumes();
      const out = el.parentElement.querySelector('output');
      if (out) out.textContent = this._settingValue(key, value);
    });

    // Sliders make a noise when you let go of them, so you can hear what you
    // just set without having to go and find something to shoot.
    $('settings-body').addEventListener('change', (e) => {
      const el = e.target.closest('[data-set]');
      if (!el) return;
      if (el.dataset.set === 'musicVolume') return;   // the score is already audible
      audio.uiClick('confirm');
    });

    $('settings-body').addEventListener('click', (e) => {
      const sw = e.target.closest('[data-toggle]');
      if (sw) {
        const key = sw.dataset.toggle;
        settings.set(key, !settings.data[key]);
        audio.applyVolumes();
        audio.uiClick();
        sw.classList.toggle('on', !!settings.data[key]);
        return;
      }

      const bind = e.target.closest('[data-bind]');
      if (bind) { this._startRebind(bind); return; }

      const reset = e.target.closest('#binds-reset');
      if (reset) {
        settings.resetBindings();
        audio.uiClick('confirm');
        this._renderSettings();
        return;
      }

      const unlock = e.target.closest('#unlock-all-btn');
      if (unlock) { this._unlockEverything(unlock); return; }
    });
  }

  /**
   * Listens for the next key or button and binds it.
   *
   * The capture runs through the Input layer rather than a local listener so
   * that mouse buttons are offered on equal terms with keys — somebody who
   * wants their utility ability on the thumb button should not have to care
   * that it is not a keyboard.
   */
  _startRebind(el) {
    document.querySelectorAll('.bind-key.listening').forEach((b) => {
      b.classList.remove('listening');
      b.textContent = b.dataset.label;
    });
    el.classList.add('listening');
    el.textContent = 'Press…';
    const action = el.dataset.bind;
    const slot = Number(el.dataset.slot);
    this.game.input.captureBinding((code) => {
      el.classList.remove('listening');
      if (code === null) { this._renderSettings(); return; }
      if (code === 'Backspace' || code === 'Delete') settings.clearBinding(action, slot);
      else settings.rebind(action, slot, code);
      audio.uiClick('confirm');
      this._renderSettings();
    });
  }

  _unlockEverything(btn) {
    if (this.profile.everythingUnlocked) return;
    if (!this._unlockArmed) {
      this._unlockArmed = true;
      btn.classList.add('armed');
      btn.textContent = 'Click again — this cannot be undone';
      audio.uiClick('back');
      setTimeout(() => {
        this._unlockArmed = false;
        if (this.current === 'settings') this._renderSettings();
      }, 4000);
      return;
    }
    this._unlockArmed = false;
    const got = this.profile.unlockEverything();
    this.selectedCharacter = this.profile.data.equippedCharacter;
    audio.levelUp();
    this.game.hud.toast(`Everything unlocked — ${got.items} items, ${got.characters} characters`, '#ffcf5c');
    this._renderSettings();
    this._renderMenu();
  }

  _settingValue(key, v) {
    if (key === 'sensitivity' || key === 'aimSensitivity' || key === 'turnSnap') return `×${v.toFixed(2)}`;
    return `${Math.round(v * 100)}%`;
  }

  _slider(key, label, { min = 0, max = 100, note = null } = {}) {
    const v = settings.data[key] ?? 0;
    return `
      <div class="set-row">
        <label for="set-${key}">${esc(label)}</label>
        <input id="set-${key}" type="range" min="${min}" max="${max}" step="1"
               value="${Math.round(v * 100)}" data-set="${key}" />
        <output>${this._settingValue(key, v)}</output>
      </div>
      ${note ? `<p class="set-note">${note}</p>` : ''}`;
  }

  _toggle(key, label, note = null) {
    const on = !!settings.data[key];
    return `
      <div class="set-row toggle">
        <label>${esc(label)}</label>
        <button class="switch ${on ? 'on' : ''}" data-toggle="${key}" aria-pressed="${on}"></button>
      </div>
      ${note ? `<p class="set-note">${note}</p>` : ''}`;
  }

  _renderSettings() {
    const body = $('settings-body');
    if (!body) return;
    for (const t of document.querySelectorAll('#settings-tabs .tab')) {
      t.classList.toggle('active', t.dataset.stab === this.settingsTab);
    }
    if (this.settingsTab === 'audio') body.innerHTML = this._settingsAudio();
    else if (this.settingsTab === 'controls') body.innerHTML = this._settingsControls();
    else body.innerHTML = this._settingsGame();
  }

  _settingsAudio() {
    return `
      <div class="set-group">
        <div class="sect-label">Volume</div>
        <p class="set-note">Nothing here is a recording. Every sound in the game — every shot,
        every impact, and the score itself — is synthesised as it plays, which is why there is
        no download and why the music never loops back to the same bar twice.</p>
        ${this._toggle('muted', 'Mute Everything')}
        ${this._slider('masterVolume', 'Master')}
        ${this._slider('sfxVolume', 'Sound Effects')}
        ${this._slider('musicVolume', 'Music', {
          note: 'The score is generated live and opens up as the fight does — percussion arrives with the crowd, and a lead line only shows up when things have genuinely gone wrong.',
        })}
      </div>`;
  }

  _settingsControls() {
    const groups = new Map();
    for (const a of ACTIONS) {
      if (!groups.has(a.group)) groups.set(a.group, []);
      groups.get(a.group).push(a);
    }
    const rows = [...groups].map(([group, list]) => `
      <div class="sect-label">${esc(group)}</div>
      ${list.map((a) => {
        const binds = settings.bindingsFor(a.id);
        const slot = (i) => {
          const code = binds[i];
          const label = code ? codeLabel(code) : 'Unbound';
          return `<button class="bind-key ${code ? '' : 'empty'}" data-bind="${a.id}" data-slot="${i}"
                   data-label="${esc(label)}">${esc(label)}</button>`;
        };
        const dead = !binds.filter(Boolean).length;
        return `<div class="bind-row ${dead ? 'unbound' : ''}"><span>${esc(a.name)}</span>${slot(0)}${slot(1)}</div>`;
      }).join('')}`).join('');

    return `
      <div class="set-group">
        <p class="set-note">Click a key to rebind it, then press the key or mouse button you want.
        <kbd>Esc</kbd> cancels, <kbd>Backspace</kbd> clears the slot. Mouse buttons are offered on
        the same terms as keys, so anything can live on a thumb button. Binding a key that is
        already in use takes it away from whatever had it — two actions sharing a key is never
        what anyone meant.</p>
        ${rows}
      </div>
      <div class="set-group">
        <div class="sect-label">Mouse</div>
        ${this._slider('sensitivity', 'Sensitivity', { min: 10, max: 400 })}
        ${this._slider('aimSensitivity', 'Aim Sensitivity', {
          min: 10, max: 200,
          note: 'A multiplier applied only while you are holding aim. Below 100% the crosshair slows down when the camera pulls in, which is what keeps a scoped shot from being twitchier than a hip-fired one.',
        })}
        ${this._toggle('invertY', 'Invert Vertical Look')}
      </div>
      <div class="set-group">
        <button class="ghost-btn" id="binds-reset">Reset Controls to Default</button>
      </div>`;
  }

  _settingsGame() {
    const done = this.profile.everythingUnlocked;
    return `
      <div class="set-group">
        <div class="sect-label">Camera</div>
        ${this._slider('cameraShake', 'Screen Shake', {
          max: 150,
          note: 'Scales every impact, explosion and boss slam. Set it to zero and the game plays identically, it just stops moving the frame.',
        })}
        ${this._slider('turnSnap', 'Turn Response', {
          min: 20, max: 250,
          note: 'How hard the character swings round to face the camera when you start shooting. Your body and your camera are independent — you can run one way and look another — and this is how firmly the two are reunited when the weapon comes up.',
        })}
      </div>
      <div class="set-group">
        <div class="sect-label">Readout</div>
        ${this._toggle('damageNumbers', 'Damage Numbers',
          'The figure that floats off everything you hit. Off is a quieter screen, not a quieter fight.')}
      </div>
      <div class="set-group">
        <div class="sect-label">Chests</div>
        ${this._toggle('caseOpening', 'Case-Opening Reveal',
          'Every chest sends a strip of items scrolling past a marker before it stops on the one '
          + 'you got. The roll happens first and the reel is built around the answer, so this cannot '
          + 'change a single drop — it is five seconds of theatre over the same table.')}
        <p class="set-note">Solo only. The reel stops the world, and the world is not yours to stop
        with other people standing in it — in a lobby, chests open the way they always have.
        ${this.game.coop?.active ? '<b style="color:var(--accent)">You are in a lobby now, so it is inactive.</b>' : ''}</p>
      </div>
      <div class="set-group">
        <div class="sect-label">Collection</div>
        <p class="set-note">The Sanctum exists so that a long campaign slowly widens the drop pool.
        Some people do not want the campaign; they want the game underneath it. This hands over
        every item, weapon and character at once. Your Echoes are untouched, and nothing else about
        your progress changes.</p>
        <button class="unlock-all ${done ? 'done' : ''}" id="unlock-all-btn">
          ${done ? '✓ Everything is already unlocked' : 'Unlock All Items, Weapons and Characters'}
        </button>
      </div>
      <div class="set-group">
        <div class="sect-label">Status</div>
        <div class="stat-rows">
          <div class="stat-row"><span>Items</span><b>${this.profile.data.unlockedItems.length} / ${ITEMS.length}</b></div>
          <div class="stat-row"><span>Characters</span><b>${this.profile.data.unlockedCharacters.length} / ${CHARACTERS.length}</b></div>
          <div class="stat-row"><span>Echoes</span><b>${formatNumber(this.profile.echoes)}</b></div>
        </div>
      </div>`;
  }

  /* ------------------------------------------------------------------ feedback
     Bug reports and ideas, posted to whoever is hosting this copy of the game.

     The endpoint lives in the same server that served the page (`tools/serve.js`
     → `tools/feedback.js`), so there is no third-party form to sign up for and
     nothing to configure before the panel works — a report always lands in the
     host's log, and reaches their Discord or their inbox as well if they have
     pointed it at one. See FEEDBACK.md. */
  /** Fresh, empty drafts. One per tab, so the two do not overwrite each other. */
  _clearFeedbackDraft() {
    this._feedbackDraft = {
      bug: { title: '', body: '' },
      idea: { title: '', body: '' },
      contact: '',
      // On by default because a bug report without a version and a stage is
      // usually unactionable — but shown in full below the switch, because
      // quietly attaching anything to someone's message is not on.
      diagnostics: true,
    };
    this._feedbackStatus = null;
    this._feedbackSending = false;
  }

  _bindFeedback() {
    $('feedback-close')?.addEventListener('click', () => {
      audio.uiClick('back');
      this.show(this.feedbackReturn === 'pause' ? 'pause' : 'menu');
    });
    $('pause-feedback-btn')?.addEventListener('click', () => {
      this.feedbackReturn = 'pause';
      this.feedbackTab = 'bug';
      audio.uiClick();
      this.show('feedback');
    });
    $('feedback-send')?.addEventListener('click', () => this._sendFeedback());
    $('feedback-body')?.addEventListener('click', (e) => {
      if (e.target.closest('#fb-diag')) {
        this._feedbackDraft.diagnostics = !this._feedbackDraft.diagnostics;
        audio.uiClick();
        this._renderFeedback();
        return;
      }
      if (e.target.closest('#fb-copy')) this._copyFeedback();
    });
  }

  /**
   * What the report carries about the machine it was sent from.
   *
   * Whitelisted here and again on the server. A bug report is worth far more
   * with a version and a stage attached, and worth nothing at all if people
   * stop sending them because they cannot tell what they are sending.
   */
  _diagnostics() {
    const g = this.game;
    const run = g.run;
    const inRun = g.state !== 'menu' && !!run;
    const out = {
      version: VERSION,
      page: location.origin + location.pathname,
      screen: `${window.innerWidth}×${window.innerHeight}`,
      platform: navigator.userAgent,
      language: navigator.language,
      character: this.selectedCharacter,
      coop: g.coop?.active ? `${g.coop.isHost ? 'hosting' : 'joined'}, ${g.coop.lobbyList().length} in party` : 'solo',
    };
    if (inRun) {
      out.stage = run.stage;
      out.stageName = g.arena?.theme?.name ?? '';
      out.runTime = formatTime(run.time);
      out.mode = run.mode;
      out.difficulty = Number((g.director?.difficulty ?? 0).toFixed(2));
      out.items = g.inventory?.order.length ?? 0;
    }
    return out;
  }

  _renderFeedback() {
    const body = $('feedback-body');
    if (!body) return;
    for (const t of document.querySelectorAll('#feedback-tabs .tab')) {
      t.classList.toggle('active', t.dataset.ftab === this.feedbackTab);
    }
    const bug = this.feedbackTab === 'bug';
    const draft = this._feedbackDraft[this.feedbackTab];
    const diag = this._diagnostics();
    const on = this._feedbackDraft.diagnostics;

    body.innerHTML = `
      <div class="set-group">
        <p class="set-note">${bug
          ? 'Something behaving wrongly? Say what you did, what happened, and what you expected instead. '
            + 'The version, the stage and the difficulty go along with it automatically, which is usually the difference between a fixable report and a mystery.'
          : 'An item, an enemy, a character, a mechanic, a quality-of-life change — anything. '
            + 'Half-formed is fine; the point is that the idea reaches whoever is running this server rather than nobody.'}</p>
        <label class="fb-field">
          <span>${bug ? 'What went wrong' : 'The idea, in one line'}</span>
          <input id="fb-title" type="text" maxlength="120" autocomplete="off" spellcheck="true"
                 placeholder="${bug ? 'Boss health bar stays on screen after it dies' : 'An item that converts overkill damage into barrier'}"
                 value="${esc(draft.title)}" />
        </label>
        <label class="fb-field">
          <span>${bug ? 'Steps, and what you expected' : 'How it would work'}</span>
          <textarea id="fb-body" maxlength="4000" rows="7" spellcheck="true"
                    placeholder="${bug ? 'Killed the stage 3 guardian, teleported out, and the bar was still there on the next stage.' : 'Damage past a kill is stored, and converts to barrier on your next kill…'}">${esc(draft.body)}</textarea>
        </label>
        <label class="fb-field">
          <span>Name or contact <i>optional</i></span>
          <input id="fb-contact" type="text" maxlength="120" autocomplete="off"
                 placeholder="So you can be credited or asked a follow-up"
                 value="${esc(this._feedbackDraft.contact)}" />
        </label>
      </div>
      <div class="set-group">
        <div class="set-row toggle">
          <label>Attach what the game knows</label>
          <button class="switch ${on ? 'on' : ''}" id="fb-diag" aria-pressed="${on}"></button>
        </div>
        <div class="fb-diag ${on ? '' : 'off'}">
          ${Object.entries(diag).map(([k, v]) => `<div><span>${esc(k)}</span><b>${esc(v)}</b></div>`).join('')}
        </div>
        <p class="set-note">Exactly this, and nothing else. No save data, no account, no address —
        the server keeps a salted hash of where the report came from so it can tell one sender from
        another, and that is all.</p>
      </div>
      ${this._feedbackStatus ? `<div class="fb-result ${this._feedbackStatus.kind}">
        ${esc(this._feedbackStatus.text)}
        ${this._feedbackStatus.copy
    ? '<button class="ghost-btn" id="fb-copy">Copy the report instead</button>' : ''}
      </div>` : ''}`;

    const send = $('feedback-send');
    if (send) {
      send.disabled = this._feedbackSending;
      send.textContent = this._feedbackSending ? 'Sending…' : bug ? 'Send Report' : 'Send Idea';
    }
    const status = $('feedback-status');
    if (status) status.textContent = 'Ctrl+Enter sends';
  }

  /** Posts the report, and says plainly what happened either way. */
  async _sendFeedback() {
    if (this._feedbackSending) return;
    const draft = this._feedbackDraft[this.feedbackTab];
    // Read the fields back rather than trusting the draft: autofill and paste
    // do not always produce an input event.
    draft.title = $('fb-title')?.value ?? draft.title;
    draft.body = $('fb-body')?.value ?? draft.body;
    this._feedbackDraft.contact = $('fb-contact')?.value ?? this._feedbackDraft.contact;

    if (draft.title.trim().length < 3) {
      this._feedbackStatus = { kind: 'err', text: 'Give it a one-line summary first.' };
      audio.denied();
      this._renderFeedback();
      return;
    }
    if (draft.body.trim().length < 10) {
      this._feedbackStatus = { kind: 'err', text: 'Say a little more — ten characters is not a bug report.' };
      audio.denied();
      this._renderFeedback();
      return;
    }

    this._feedbackSending = true;
    this._feedbackStatus = null;
    this._renderFeedback();

    try {
      const res = await fetch('feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: this.feedbackTab,
          title: draft.title,
          body: draft.body,
          contact: this._feedbackDraft.contact,
          diagnostics: this._feedbackDraft.diagnostics ? this._diagnostics() : null,
        }),
      });
      const data = await res.json().catch(() => ({}));
      this._feedbackSending = false;
      if (res.ok && data.ok) {
        draft.title = '';
        draft.body = '';
        // `forwarded` is what happened to this report, not what the server was
        // configured to do with it. Telling someone their bug report reached a
        // maintainer when a refused webhook left it sitting in a log file is the
        // kind of small lie that costs a real report.
        this._feedbackStatus = {
          kind: 'ok',
          text: `Sent. ${data.forwarded
            ? 'It has gone through to whoever runs this server.'
            : 'It is on this server’s record for them to read.'} Reference ${data.id}.`,
        };
        audio.uiClick('confirm');
      } else {
        this._feedbackStatus = { kind: 'err', text: data.error || `The server refused it (${res.status}).` };
        audio.denied();
      }
    } catch {
      // No endpoint, or no network. Neither is the player's fault and neither
      // should cost them what they just wrote, so the text stays in the box and
      // the copy button becomes the way out.
      this._feedbackSending = false;
      this._feedbackStatus = {
        kind: 'err',
        // The only case the copy button belongs on: nothing this player does to
        // the text will help, because there is nothing listening.
        copy: true,
        text: 'Could not reach the server. Your text is still here — copy it and send it another way.',
      };
      audio.denied();
    }
    this._renderFeedback();
  }

  /** The escape hatch when the endpoint is not there: the report as plain text. */
  async _copyFeedback() {
    const draft = this._feedbackDraft[this.feedbackTab];
    const diag = this._feedbackDraft.diagnostics ? this._diagnostics() : null;
    const text = [
      `${this.feedbackTab === 'bug' ? 'Bug report' : 'Idea'}: ${draft.title}`,
      '',
      draft.body,
      this._feedbackDraft.contact ? `\nFrom ${this._feedbackDraft.contact}` : '',
      diag ? `\nContext:\n${Object.entries(diag).map(([k, v]) => `  ${k}: ${v}`).join('\n')}` : '',
    ].join('\n');
    try {
      await navigator.clipboard.writeText(text);
      this._feedbackStatus = { kind: 'ok', text: 'Copied. Paste it wherever you can reach them.' };
    } catch {
      this._feedbackStatus = { kind: 'err', text: 'The browser would not let the page copy. Select the text and copy it by hand.' };
    }
    this._renderFeedback();
  }

  _purchase(kind, id, cost) {
    const ok = kind === 'item' ? this.profile.unlockItem(id, cost)
      : this.profile.unlockCharacter(id, cost);
    if (ok) {
      const name = kind === 'item' ? ITEMS.find((i) => i.id === id)?.name
        : CHARACTERS.find((c) => c.id === id)?.name;
      this.game.hud.toast(`Unlocked ${name}`, '#ffcf5c');
    }
    this._renderUnlocks();
  }

  // ------------------------------------------------------------------ menu
  _renderMenu() {
    const coop = this.game.coop;
    const state = $('menu-coop-state');
    if (state) {
      state.textContent = coop.active
        ? `Lobby ${coop.code} · ${coop.lobbyList().length} in party`
        : 'Play with friends';
    }
    const launch = $('launch-btn');
    if (launch) launch.textContent = coop.active && coop.isHost ? 'Launch Descent (Party)' : 'Launch Run';
    $('menu-echoes').textContent = `${formatNumber(this.profile.echoes)} Echoes`;
    $('unlock-echoes').textContent = formatNumber(this.profile.echoes);
    $('menu-version').textContent = `v${VERSION} · ${CHARACTERS.length} characters · ${ITEMS.length} items`;
  }

  // ------------------------------------------------------------------ loadout
  _renderLoadout() {
    const data = this.profile.data;
    if (!this.profile.isCharacterUnlocked(this.selectedCharacter)) this.selectedCharacter = data.equippedCharacter;

    const char = CHARACTERS.find((c) => c.id === this.selectedCharacter) || CHARACTERS[0];
    $('char-strip').innerHTML = CHARACTERS.map((c) => {
      const owned = this.profile.isCharacterUnlocked(c.id);
      const sel = c.id === this.selectedCharacter;
      return `<button class="char-card ${sel ? 'sel' : ''} ${owned ? '' : 'locked'}" data-id="${c.id}"
          style="--ch:#${c.accent.toString(16).padStart(6, '0')}">
        <span class="ch-ico">${c.icon}</span>
        <span class="ch-name">${esc(c.name)}</span>
        <span class="ch-title">${owned ? esc(c.title) : `🔒 ${c.echoCost} ◈`}</span>
      </button>`;
    }).join('');

    const st = char.stats;
    $('char-detail').innerHTML = `
      <div class="cd-head">
        <span class="cd-ico">${char.icon}</span>
        <div>
          <h3 style="color:#${char.accent.toString(16).padStart(6, '0')}">${esc(char.name)}</h3>
          <div class="wd-tag">${esc(char.title)}</div>
        </div>
        <div class="cd-stats">
          <span><b>${st.health}</b>HP</span>
          <span><b>${st.damage}</b>DMG</span>
          <span><b>${st.moveSpeed}</b>SPD</span>
          <span><b>${st.armor}</b>ARM</span>
        </div>
      </div>
      <p class="wd-desc">${esc(char.desc)}</p>
      ${char.passive ? `<div class="wd-ability">
        <span class="wa-key">${char.passive.icon ?? '★'}</span>
        <div class="wa-body"><h6>${esc(char.passive.name)}
          <span style="color:var(--dim);font-size:11px">PASSIVE</span></h6>
          <p>${esc(char.passive.desc)}</p></div>
      </div>` : ''}
      <div class="wd-ability">
        <span class="wa-key">SHIFT</span>
        <div class="wa-body"><h6>${esc(char.utility.name)}
          <span style="color:var(--dim);font-size:11px">${char.utility.cooldown}s${(char.utility.charges ?? 1) > 1 ? ` · ${char.utility.charges} charges` : ''}</span></h6>
          <p>${esc(char.utility.desc)}</p></div>
      </div>
      <div class="wd-ability">
        <span class="wa-key">R</span>
        <div class="wa-body"><h6>${esc(char.special.name)}
          <span style="color:var(--dim);font-size:11px">${char.special.cooldown}s${(char.special.charges ?? 1) > 1 ? ` · ${char.special.charges} charges` : ''}</span></h6>
          <p>${esc(char.special.desc)}</p></div>
      </div>
      ${char.ultimate ? `<div class="wd-ability ult">
        <span class="wa-key">F</span>
        <div class="wa-body"><h6>${esc(char.ultimate.name)}
          <span style="color:var(--gold);font-size:11px">ULTIMATE · charges from damage dealt, kills and damage taken</span></h6>
          <p>${esc(char.ultimate.desc)}</p></div>
      </div>` : ''}`;

    // The weapon panel is a readout, not a picker: it shows what the selected
    // character carries, and changes when the character does.
    const w = weaponById(char.weapon);
    $('weapon-detail').innerHTML = `
      <div class="wd-head">
        <span class="wd-ico">${w.icon}</span>
        <div>
          <h3>${esc(w.name)}</h3>
          <div class="wd-tag">${esc(w.tag)}</div>
        </div>
      </div>
      <p class="wd-desc">${esc(w.desc)}</p>
      <div class="wd-stats">
        ${Object.entries(w.displayStats).map(([k, v]) => `<div class="wd-stat"><span>${esc(k)}</span><b>${esc(v)}</b></div>`).join('')}
      </div>
      <div class="wd-ability">
        <span class="wa-key">${w.primary.key}</span>
        <div class="wa-body"><h6>${esc(w.primary.name)}</h6><p>${esc(w.primary.desc)}</p></div>
      </div>
      <div class="wd-ability">
        <span class="wa-key">${w.secondary.key}</span>
        <div class="wa-body"><h6>${esc(w.secondary.name)} <span style="color:var(--dim);font-size:11px">${w.secondary.sustain ? 'HELD · no cooldown' : `${w.secondary.cooldown}s${(w.secondary.charges ?? 1) > 1 ? ` · ${w.secondary.charges} charges` : ''}`}</span></h6><p>${esc(w.secondary.desc)}</p></div>
      </div>
`;

    $('diff-select').innerHTML = RUN_MODES.map((m) => `
      <button class="diff-opt ${m.id === data.runMode ? 'sel' : ''}" data-mode="${m.id}" title="${esc(m.desc)}">${esc(m.name)}</button>
    `).join('');
  }

  // ------------------------------------------------------------------ co-op
  /**
   * One screen for the whole flow: pick a name, host or join, watch the roster
   * fill, launch. The lobby address is shown as a URL rather than a code alone,
   * because the thing a friend actually needs is the address of your machine —
   * the code on its own is useless to them.
   */
  _renderCoop() {
    const coop = this.game.coop;
    const body = $('coop-body');
    const foot = $('coop-foot');
    const data = this.profile.data;
    // Anything half-typed wins over the saved value, and the focused field is
    // put back where it was afterwards — a re-render must never eat a keystroke.
    const draft = this._coopDraft;
    const name = draft.name ?? (data.playerName || 'Descender');
    const url = draft.url ?? (data.lastLobbyHost || '');
    const code = draft.code ?? (data.lastLobbyCode || '');
    const active = document.activeElement;
    const focusId = active && active.id && active.id.startsWith('coop-') ? active.id : null;
    const caret = focusId ? active.selectionStart : null;
    const restore = () => {
      if (!focusId) return;
      const el = $(focusId);
      if (!el) return;
      el.focus();
      if (caret !== null) el.setSelectionRange?.(caret, caret);
    };

    if (!coop.active) {
      const err = this._coopError ? `<div class="coop-error">${esc(this._coopError)}</div>` : '';
      body.innerHTML = `
        ${err}
        <p class="coop-lead">Play the whole descent together — shared arena, shared bosses, your own
        items, your own gold, your own brood. Up to ${COOP.maxPlayers} descenders.</p>

        <div class="sect-label">Your name</div>
        <input id="coop-name" class="coop-input" maxlength="18" value="${esc(name)}" placeholder="Descender"
          autocomplete="off" autocorrect="off" spellcheck="false" />

        <div class="coop-split">
          <div class="coop-card">
            <h4>Host a lobby</h4>
            <p>Your machine runs the world. Friends join with the address below.</p>
            <button class="big-btn" id="coop-host">Open a Lobby</button>
          </div>
          <div class="coop-card">
            <h4>Join a lobby</h4>
            <p>Paste the address your host gave you, then the four-letter code.</p>
            <input id="coop-url" class="coop-input" placeholder="${esc(defaultHostGuess())}"
              value="${esc(url)}" autocomplete="off" autocorrect="off" spellcheck="false" />
            <input id="coop-code" class="coop-input code" maxlength="6" placeholder="CODE"
              value="${esc(code)}" autocomplete="off" autocorrect="off" autocapitalize="characters"
              spellcheck="false" inputmode="text" />
            <button class="big-btn ghost" id="coop-join">Join</button>
          </div>
        </div>`;
      foot.innerHTML = '<button class="ghost-btn" data-goto="menu">Back</button>';
      restore();
      return;
    }

    const list = coop.lobbyList();
    const share = this._shareAddresses();
    body.innerHTML = `
      <div class="coop-code-box">
        <div class="ccb-label">Lobby code</div>
        <div class="ccb-code">${esc(coop.code || '····')}</div>
        <div class="ccb-hint">${share.map((a) => `<b>${esc(a)}</b>`).join(' or ')}
          — friends open that in a browser and enter the code.</div>
      </div>
      <div class="sect-label">Party — ${list.length}/${COOP.maxPlayers}</div>
      <div class="party-list">
        ${list.map((p) => {
          const char = CHARACTERS.find((c) => c.id === p.character) || CHARACTERS[0];
          const weapon = weaponById(p.weapon);
          const hex = `#${char.accent.toString(16).padStart(6, '0')}`;
          return `<div class="party-row" style="border-left-color:${hex}">
            <span class="pr-ico">${char.icon}</span>
            <span class="pr-body">
              <span class="pr-name">${esc(p.name || 'Descender')}${p.self ? ' <em>(you)</em>' : ''}</span>
              <span class="pr-load">${esc(char.name)}${weapon ? ` · ${esc(weapon.name)}` : ''}</span>
            </span>
            ${p.host ? '<span class="pr-tag">HOST</span>' : ''}
          </div>`;
        }).join('')}
      </div>
      <p class="coop-lead" style="margin-top:14px">
        Change your character and weapon in the Loadout screen — the party sees it straight away.
        ${coop.isHost ? 'You start the run when everyone is in.' : 'Waiting for the host to launch.'}
      </p>`;

    foot.innerHTML = `
      ${coop.isHost ? '<button class="big-btn" id="coop-start">Launch Descent</button>' : ''}
      <button class="ghost-btn" data-goto="loadout">Change Loadout</button>
      <button class="ghost-btn" id="coop-leave">Leave Lobby</button>`;
    restore();
  }

  async _coopHost() {
    const name = ($('coop-name')?.value || this._coopDraft.name || 'Descender').trim() || 'Descender';
    this._clearCoopDraft();
    this.profile.setPlayerName(name);
    this._coopError = null;
    this._coopBusy('Opening a lobby…');
    try {
      await this.game.coop.host(name);
    } catch (err) {
      this._coopError = err.message;
    }
    this._renderCoop();
  }

  async _coopJoin() {
    const name = ($('coop-name')?.value || this._coopDraft.name || 'Descender').trim() || 'Descender';
    const code = ($('coop-code')?.value || this._coopDraft.code || '').trim().toUpperCase();
    const hostInput = ($('coop-url')?.value || this._coopDraft.url || '').trim();
    if (!code) { this._coopError = 'Enter the four-letter lobby code.'; this._renderCoop(); return; }
    this._clearCoopDraft();
    this.profile.setPlayerName(name);
    this.profile.setLastLobbyCode(code);
    this.profile.data.lastLobbyHost = hostInput;
    this.profile.save();
    this._coopError = null;
    this._coopBusy('Joining…');
    try {
      await this.game.coop.join(code, name, relayUrlFor(hostInput));
    } catch (err) {
      this._coopError = err.message;
    }
    this._renderCoop();
  }

  /** Forget the half-typed form: the saved profile values take over again. */
  _clearCoopDraft() { this._coopDraft = { name: null, url: null, code: null }; }

  _coopBusy(text) {
    $('coop-foot').innerHTML = `<div class="coop-busy">${esc(text)}</div>`;
  }

  /**
   * Addresses a friend can actually reach.
   *
   * localhost is right for the host and useless to everyone else, so the server
   * reports its LAN addresses and those are what we show. The fetch is fired
   * once and cached; until it lands we show what the page was loaded from.
   */
  _shareAddresses() {
    if (!this._shareCache) {
      this._shareCache = [`${location.protocol}//${location.host}`];
      fetch('/coop-info').then((r) => r.json()).then((info) => {
        if (!info.addresses?.length) return;
        this._shareCache = info.addresses.map((a) => `http://${a}:${info.port}`);
        if (this.current === 'coop') this._renderCoop();
      }).catch(() => { /* served from somewhere without the relay */ });
    }
    return this._shareCache;
  }

  // ------------------------------------------------------------------ Sanctum
  _renderUnlocks() {
    $('unlock-echoes').textContent = formatNumber(this.profile.echoes);
    const cat = unlockCatalogue(this.profile.data);
    const body = $('unlock-body');

    if (this.unlockTab === 'characters') {
      body.innerHTML = `
        <p style="color:var(--muted);font-size:13.5px;margin-bottom:16px;line-height:1.6">
          Characters change your stats and both signature abilities. Pick one in the Loadout screen before a descent.
        </p>
        <div class="grid">${cat.characters.map((c) => this._characterCard(c)).join('')}</div>`;
      return;
    }

    const groups = RARITY_ORDER.map((rar) => {
      const entries = cat.items.filter((i) => i.ref.rarity === rar);
      if (!entries.length) return '';
      const owned = entries.filter((e) => e.owned).length;
      const r = RARITY[rar];
      return `<div class="rar-group">
        <div class="rar-head" style="color:${r.color}">
          ${r.name}<span class="rline"></span>
          <span class="rcount">${owned}/${entries.length} · ${r.echoCost} ◈ each</span>
        </div>
        <div class="grid">${entries.map((e) => this._itemCard(e)).join('')}</div>
      </div>`;
    }).join('');

    const defaults = ITEMS.filter((i) => i.unlocked).length;
    body.innerHTML = `
      <p style="color:var(--muted);font-size:13.5px;margin-bottom:20px;line-height:1.6">
        Unlocked items join the pool that chests draw from on every future run.
        ${defaults} items are available from the start; everything below must be earned with Echoes.
      </p>
      ${groups}`;
  }

  _itemCard(entry) {
    const item = entry.ref;
    const r = RARITY[item.rarity];
    const affordable = !entry.owned && this.profile.echoes >= entry.cost;
    return `<button class="card ${entry.owned ? '' : 'locked'} ${affordable ? 'affordable' : ''}"
        style="border-left-color:${r.color}"
        ${entry.owned ? '' : `data-buy="${item.id}" data-kind="item" data-cost="${entry.cost}"`}>
      <img class="c-art" src="${itemIconDataURL(item, 72)}" alt="" />
      <span class="c-body">
        <span class="c-name" style="color:${r.color}">${esc(item.name)}</span>
        <span class="c-desc">${esc(itemDescription(item, 1))}</span>
        ${entry.owned
          ? '<span class="c-owned">✓ Unlocked</span>'
          : `<span class="c-cost">◈ ${entry.cost}</span>`}
      </span>
    </button>`;
  }

  _characterCard(entry) {
    const c = entry.ref;
    const affordable = !entry.owned && this.profile.echoes >= entry.cost;
    const hex = `#${c.accent.toString(16).padStart(6, '0')}`;
    return `<button class="card ${entry.owned ? '' : 'locked'} ${affordable ? 'affordable' : ''}"
        style="border-left-color:${hex}"
        ${entry.owned ? '' : `data-buy="${c.id}" data-kind="character" data-cost="${entry.cost}"`}>
      <span class="c-ico">${c.icon}</span>
      <span class="c-body">
        <span class="c-name" style="color:${hex}">${esc(c.name)}</span>
        <span class="c-desc">${esc(c.desc)}</span>
        <span class="c-stack">${esc(c.utility.name)} · ${esc(c.special.name)}${c.ultimate ? ` · ${esc(c.ultimate.name)}` : ''}</span>
        ${entry.owned ? '<span class="c-owned">✓ Unlocked</span>' : `<span class="c-cost">◈ ${entry.cost}</span>`}
      </span>
    </button>`;
  }


  // ------------------------------------------------------------------ codex
  _renderCodex() {
    const body = $('codex-body');
    const seen = this.profile.data.itemsSeen;

    if (this.codexTab === 'enemies') {
      const eseen = this.profile.data.enemiesSeen;
      const row = (e, isBoss) => {
        const known = eseen[e.id] > 0;
        return `<div class="card" style="border-left-color:#${e.accent.toString(16).padStart(6, '0')}">
          <span class="c-ico" style="color:#${e.accent.toString(16).padStart(6, '0')}">${isBoss ? '☠' : '◆'}</span>
          <span class="c-body">
            <span class="c-name">${known ? esc(e.name) : '???'}</span>
            <span class="c-desc">${known ? esc(e.lore) : 'Not yet encountered.'}</span>
            <span class="c-stack">${known ? `${e.health} HP base · ${e.damage} damage · ${isBoss ? 'Boss' : `${e.cost} credits`}` : ''}</span>
          </span>
        </div>`;
      };
      body.innerHTML = `
        <div class="rar-group">
          <div class="rar-head" style="color:#7d89a3">Common Threats<span class="rline"></span></div>
          <div class="grid">${ENEMIES.map((e) => row(e, false)).join('')}</div>
        </div>
        <div class="rar-group">
          <div class="rar-head" style="color:#ff4d5e">Guardians<span class="rline"></span></div>
          <div class="grid">${BOSSES.map((e) => row(e, true)).join('')}</div>
        </div>`;
      return;
    }

    body.innerHTML = RARITY_ORDER.map((rar) => {
      const list = ITEMS_BY_RARITY[rar] || [];
      const r = RARITY[rar];
      const found = list.filter((i) => seen[i.id] > 0).length;
      return `<div class="rar-group">
        <div class="rar-head" style="color:${r.color}">${r.name}<span class="rline"></span><span class="rcount">${found}/${list.length} found</span></div>
        <div class="grid">${list.map((item) => {
          const unlocked = this.profile.isItemUnlocked(item.id);
          const times = seen[item.id] || 0;
          return `<div class="card ${unlocked ? '' : 'locked'}" style="border-left-color:${r.color}">
            <img class="c-art" src="${itemIconDataURL(item, 72)}" alt="" />
            <span class="c-body">
              <span class="c-name" style="color:${r.color}">${esc(item.name)}</span>
              <span class="c-desc">${esc(itemDescription(item, 1))}</span>
              <span class="c-stack">${item.stackText || ''}${times ? ` · found ×${times}` : unlocked ? ' · never found' : ' · locked'}</span>
            </span>
          </div>`;
        }).join('')}</div>
      </div>`;
    }).join('');
  }

  // ------------------------------------------------------------------ records
  _renderStats() {
    const s = this.profile.data.stats;
    const rows = [
      ['Runs', s.runs],
      ['Deaths', s.deaths],
      ['Longest Survival', formatTime(s.bestTime)],
      ['Deepest Stage', s.bestStage || '—'],
      ['Peak Difficulty', `×${s.highestDifficulty.toFixed(2)}`],
      ['Total Time Descended', formatTime(s.totalTime)],
      ['Enemies Felled', formatNumber(s.kills)],
      ['Elites Felled', formatNumber(s.eliteKills)],
      ['Bosses Slain', formatNumber(s.bossKills)],
      ['Chests Opened', formatNumber(s.chestsOpened)],
      ['Items Collected', formatNumber(s.itemsCollected)],
      ['Gold Earned', formatNumber(s.goldEarned)],
      ['Echoes Earned (lifetime)', formatNumber(this.profile.data.lifetimeEchoes)],
      ['Echoes Available', formatNumber(this.profile.echoes)],
    ];
    const itemsUnlocked = this.profile.data.unlockedItems.length;
    $('stats-body').innerHTML = `
      <div class="stat-rows">
        ${rows.map(([k, v]) => `<div class="stat-row"><span>${k}</span><b>${v}</b></div>`).join('')}
      </div>
      <div class="sect-label">Collection</div>
      <div class="stat-rows">
        <div class="stat-row"><span>Items Unlocked</span><b>${itemsUnlocked} / ${ITEMS.length}</b></div>
        <div class="stat-row"><span>Characters Unlocked</span><b>${this.profile.data.unlockedCharacters.length} / ${CHARACTERS.length}</b></div>
      </div>`;
  }

  // ------------------------------------------------------------------ help
  _renderHelp() {
    // Printed from the live bindings, so a rebound key is documented correctly
    // the moment it is rebound rather than describing a keyboard nobody has.
    const bound = (action) => settings.bindingsFor(action).map(codeLabel).join(' / ') || 'Unbound';
    const primary = (action) => codeLabel(settings.bindingsFor(action)[0]);
    const keys = [
      [['moveForward', 'moveLeft', 'moveBack', 'moveRight'].map(primary).join(' '), 'Move — relative to the camera, not to the character'],
      ['Mouse', 'Look — the camera turns on its own; the body follows when it has to'],
      [bound('primary'), 'Primary attack'],
      [bound('secondary'), 'Second ability — press, hold, or hold to charge, depending on the character'],
      [bound('aim'), 'Aim — pulls the camera in and narrows the view'],
      [bound('utility'), 'Utility ability (character-specific)'],
      [bound('special'), 'Special ability (character-specific)'],
      [bound('ultimate'), 'Ultimate — no cooldown; the meter fills from kills and from damage taken'],
      [bound('jump'), 'Jump (twice with Gravity Boots)'],
      [bound('interact'), 'Interact with chests, shrines, eggs, the Beacon and the rift'],
      [bound('chat'), 'Chat — the same panel logs who picked up what'],
      ['Esc', 'Pause (in co-op this only frees your mouse)'],
    ];
    $('help-body').innerHTML = `
      <h4>The Loop</h4>
      <p>Kill things, take their gold, spend it on chests. Chests give items. Items stack — every copy of an item makes its effect stronger, and there is no upper limit.</p>
      <p>Enemies get stronger every second you are alive. The difficulty meter at the top of the screen never goes down, so a run is a race between your item collection and the ramp.</p>

      <h4>Ultimates</h4>
      <p>Every character has one ultimate on <b>F</b>. It has no cooldown — the meter beside your other abilities fills as you kill things and as you take damage, and empties completely when you spend it. Being ground down in a bad fight is worth as much as winning an easy one, so the ultimate tends to arrive at the moment it is most needed.</p>

      <h4>Where You Look, Where You Face</h4>
      <p>The camera is not bolted to the character. You can sprint one way and study something in
      the other direction, and the body will keep running where it is going — it only swings round
      to the camera when you do something that needs the weapon pointed at what you are aiming at:
      firing, aiming, or an ability. Which way you are travelling shows in the legs, so a
      backpedal, a side-step and a flat-out run all read differently from behind.</p>
      <p>Looking steeply up is a supported move, not a mistake. The camera lifts and pulls in
      rather than burying itself in the ground, so you can track something above you and keep
      shooting at it.</p>

      <h4>The Ground</h4>
      <p>Every stage has its own landform, not just its own palette. The Hollow rolls, the Tidal
      Shelf and the Void Terrace are cut into shelves you can break line of sight behind, the
      Frozen Shelf is long smooth drifts, the Ashfall Basin falls away from the middle, and the
      Ember Depths is a ridge field with nowhere flat to stand. Height is cover: so is a crest,
      and so is the far side of a terrace.</p>

      <h4>Prices</h4>
      <p>Everything on a stage is priced when the stage is built, from the difficulty at that
      moment, and the price does not move again until you descend. What you see on the prompt when
      you walk past a chest is what it will still cost when you come back with the gold. Eggs are
      priced as a clutch — the second one on a stage is dearer than the first, and it says so up
      front rather than repricing itself once you have bought one.</p>

      <h4>Descending</h4>
      <p>Each stage holds a Beacon. Activating it starts a ${'≈'}42-second charge that only advances while you stand inside the ring, and it calls a guardian. Survive the charge, clear the guardian, and the Beacon opens the way down — a fresh arena, a harder baseline, and better gold.</p>
      <p>You can ignore the Beacon and farm the stage instead. The difficulty keeps climbing either way, so this is a real decision, not a free one.</p>

      <h4>Pets</h4>
      <p>Eggs sit out in every stage next to the chests, and each one says what is inside before
      you pay for it. There is no limit on how many you keep — what stops you is how many eggs a
      stage puts out and the price of the next one, which climbs with every pet you own.</p>
      <ul>${PETS_SPECIES.map((s) => `<li class="key-row"><kbd>${s.icon} ${esc(s.name)}</kbd><span>${esc(s.desc)}</span></li>`).join('')}</ul>
      <p>None of them have stats of their own. Health, damage, speed and attack rate are all read
      from <em>your</em> current stats, and their hits go through the same pipe yours do — your
      crit, your damage modifiers, your lifesteal and your on-hit items all fire from their
      attacks. Every second item you pick up shows up on their backs.</p>
      <p>They cannot be lost. Dropping one to zero curls it back into an egg for ${PETS.reviveTime}s.
      They are not hunted by the enemy AI, but they will stop bullets meant for you and they will
      eat a slam, so where they stand matters. The whole pack descends with you.</p>

      <h4>The Sovereign</h4>
      <p>From stage ${FINAL.unlockStage} onward, clearing a stage tears a rift open beside the
      Beacon. Through it is the Null Sanctum and the thing the descent was built to keep down
      there — no chests, no eggs, no way back, and a boss that changes how it fights twice on the
      way down. Beating it ends the run as a win and pays ${ECHOES.victoryBonus} Echoes on top of
      everything else. Ignoring it is a perfectly good answer; the stages keep going.</p>

      <h4>Co-op</h4>
      <p>Open a lobby from the main menu and read your address and four-letter code out to your
      friends. Up to ${COOP.maxPlayers} of you share one arena, one director and one set of bosses.</p>
      <p>Everything else is yours alone: your items, your gold, your level and your lizards. Gold
      and experience are paid to everyone on every kill, so nobody has to race to a corpse — but
      an item on the ground goes to whoever reaches it first.</p>
      <p>Going down is not the end. You keep watching, and a teammate standing over you for
      ${COOP.reviveTime}s brings you back. The run only ends when the last of you falls, or when
      you all descend — anyone still down comes back up on the next stage.</p>
      <p>The party makes the run harder as well as shorter: enemies get tougher, more of them
      arrive at once, and the stages stock more chests and more eggs to match. Press
      <kbd>Enter</kbd> to talk; the same panel logs who picked up what.</p>

      <h4>Rarity</h4>
      <div class="rar-legend">
        ${RARITY_ORDER.map((r) => `<span class="rar-chip" style="color:${RARITY[r].color}">${RARITY[r].name}</span>`).join('')}
      </div>
      <p style="margin-top:10px">Ordinary chests overwhelmingly give Common items. Large and Legendary chests shift the odds; Fortune Clover rerolls every rarity roll and keeps the better result.</p>

      <h4>Echoes</h4>
      <p>Every run ends eventually. When it does you are paid in Echoes, based mostly on how long you survived, plus stages cleared and bosses killed. Spend them in the Sanctum to permanently add items to the drop pool and to unlock new weapons.</p>
      <p>Unlocking an item does not give it to you — it makes it findable. A bigger pool means more variety, not more power per chest.</p>
      <p>If the campaign is not what you are here for, Settings has a button that hands over every
      item, weapon and character at once. It costs nothing and it changes nothing else.</p>

      <h4>Settings</h4>
      <p>Volumes, mouse sensitivity (with a separate multiplier for while you are aiming), inverted
      look, screen shake, how hard the body snaps back to the camera, and every control — including
      onto mouse buttons. Nothing in the game is a recording; the effects and the score are
      synthesised as they play, and the score opens up as the fight does.</p>

      <h4>Controls</h4>
      <ul>${keys.map(([k, v]) => `<li class="key-row"><kbd>${k}</kbd><span>${v}</span></li>`).join('')}</ul>`;
  }

  // ------------------------------------------------------------------ pause
  _renderPause() {
    const g = this.game;
    const p = g.player;
    const st = p.stats;
    const rows = [
      ['Time', formatTime(g.run.time)],
      ['Stage', g.run.stage],
      ['Difficulty', `×${g.director.difficulty.toFixed(2)} (${g.director.tier.name})`],
      ['Level', p.level],
      ['Damage', st.damage.toFixed(1)],
      ['Attack Speed', `×${st.attackSpeed.toFixed(2)}`],
      ['Max Health', Math.round(st.maxHealth)],
      ['Regen', `${st.regen.toFixed(1)}/s`],
      ['Armor', Math.round(st.armor)],
      ['Move Speed', st.moveSpeed.toFixed(1)],
      ['Crit', `${(st.crit * 100).toFixed(0)}% · ×${st.critDamage.toFixed(1)}`],
      ['Cooldowns', `×${st.cooldownMult.toFixed(2)}`],
      ['Gold', formatNumber(p.gold)],
      ['Items', g.inventory.totalItems],
    ];
    $('pause-body').innerHTML = `
      <div class="stat-rows">${rows.map(([k, v]) => `<div class="stat-row"><span>${k}</span><b>${v}</b></div>`).join('')}</div>
      ${this._itemStrip(g.inventory)}`;
  }

  _itemStrip(inventory) {
    if (!inventory.order.length) return '<div class="sect-label">No items yet</div>';
    return `<div class="sect-label">Items</div><div class="sum-items">${inventory.entries().map(({ item, stacks }) => {
      const r = RARITY[item.rarity];
      return `<div class="sum-item" style="border-color:${r.color}66" title="${esc(item.name)} ×${stacks}">
        <img class="sum-art" src="${itemIconDataURL(item, 64)}" alt="" /><i style="color:${r.color}">${stacks}</i>
      </div>`;
    }).join('')}</div>`;
  }

  // ------------------------------------------------------------------ summary
  showSummary(result, echoes) {
    $('summary-title').textContent = result.victory ? 'Descent Complete' : 'Run Terminated';
    const killedBy = result.killedBy ? `Undone by ${esc(result.killedBy)}` : 'Survived to the end';
    $('summary-body').innerHTML = `
      <div class="sum-hero">
        <div class="sum-time">${formatTime(result.time)}</div>
        <div class="sum-sub">${killedBy} · Stage ${result.stage} · ${result.tierName}</div>
      </div>
      <div class="echo-award">
        <div class="ea-num">+${formatNumber(echoes.total)}</div>
        <div class="ea-label">Echoes Earned</div>
        <div class="echo-break">
          ${echoes.breakdown.map((b) => `<div><span>${esc(b.label)}</span>${b.value === null ? '' : `<b>+${b.value}</b>`}</div>`).join('')}
        </div>
      </div>
      <div class="stat-rows">
        <div class="stat-row"><span>Enemies Felled</span><b>${result.kills}</b></div>
        <div class="stat-row"><span>Elites Felled</span><b>${result.eliteKills}</b></div>
        <div class="stat-row"><span>Bosses Slain</span><b>${result.bossKills}</b></div>
        <div class="stat-row"><span>Chests Opened</span><b>${result.chestsOpened}</b></div>
        <div class="stat-row"><span>Gold Earned</span><b>${formatNumber(result.goldEarned)}</b></div>
        <div class="stat-row"><span>Peak Difficulty</span><b>×${result.difficulty.toFixed(2)}</b></div>
        <div class="stat-row"><span>Player Level</span><b>${result.level}</b></div>
        <div class="stat-row"><span>Total Echoes</span><b>${formatNumber(this.profile.echoes)}</b></div>
      </div>
      ${this._itemStrip(this.game.inventory)}`;
    this.show('summary');
  }
}

/**
 * Turns whatever the player pasted into a relay URL.
 *
 * People paste all sorts of things — a bare IP, a full http:// URL, a host with
 * a port, a tunnel's https address. An empty box means "the machine that served
 * this page", which is right for the host themselves and for anyone who opened
 * the host's address in their browser.
 *
 * The port is the fiddly part. `192.168.1.5` wants :8080, because that is our
 * dev server and nobody types it. A tunnel like `https://x.trycloudflare.com`
 * emphatically does not — it is on 443, and appending :8080 sends the socket
 * somewhere that will never answer. So: an explicit port always wins, a secure
 * scheme or a public-looking hostname keeps its default, and only bare
 * addresses on this LAN get :8080 assumed for them.
 */
export function relayUrlFor(input) {
  const raw = String(input || '').trim();
  if (!raw) {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${location.host}/net`;
  }

  const scheme = (raw.match(/^(wss?|https?):\/\//i) || [, ''])[1].toLowerCase();
  const host = raw.replace(/^\w+:\/\//i, '').replace(/\/.*$/, '');
  const hasPort = /:\d+$/.test(host);
  const bareHost = host.replace(/:\d+$/, '');
  const isLocal = bareHost === 'localhost'
    || /^\d{1,3}(\.\d{1,3}){3}$/.test(bareHost)
    || bareHost.endsWith('.local');

  // No scheme and a public-looking hostname is almost certainly a tunnel.
  const secure = scheme === 'https' || scheme === 'wss' || (!scheme && !isLocal);
  const port = hasPort ? '' : (secure || !isLocal ? '' : ':8080');
  return `${secure ? 'wss:' : 'ws:'}//${bareHost}${hasPort ? host.match(/:\d+$/)[0] : port}/net`;
}

/** Placeholder that shows the player what an address looks like. */
export function defaultHostGuess() {
  return location.host || 'localhost:8080';
}
