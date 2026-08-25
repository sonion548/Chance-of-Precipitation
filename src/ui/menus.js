import { RARITY, RARITY_ORDER, RUN_MODES, VERSION, COOP, MINIONS } from '../core/config.js';
import { ITEMS, ITEMS_BY_RARITY, itemDescription } from '../data/items.js';
import { itemIconDataURL } from '../data/itemArt.js';
import { WEAPONS } from '../data/weapons.js';
import { CHARACTERS } from '../data/characters.js';
import { ENEMIES, BOSSES } from '../data/enemies.js';
import { unlockCatalogue } from '../meta/progression.js';
import { formatTime, formatNumber } from '../core/mathx.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** How a settings value reads next to its control. */
function settingLabel(key, value) {
  if (key === 'damageNumbers') return value ? 'On' : 'Off';
  if (key === 'screenShake' && Number(value) === 0) return 'Off';
  return `${Number(value).toFixed(2)}×`;
}

/** All out-of-run screens: menu, loadout, Sanctum, codex, records, settings, pause, summary. */
export class Menus {
  constructor(game) {
    this.game = game;
    this.profile = game.profile;
    this.current = 'loading';
    this.selectedWeapon = this.profile.data.equippedWeapon;
    this.selectedCharacter = this.profile.data.equippedCharacter;
    this.unlockTab = 'items';
    this.codexTab = 'items';
    // What is currently half-typed into the co-op form. The panel re-renders
    // whenever the roster or the lobby address changes, and a re-render replaces
    // the fields — without this, a friend joining wipes what you were typing.
    this._clearCoopDraft();
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
  }

  hide() {
    for (const el of document.querySelectorAll('.screen')) el.classList.remove('active');
    this.current = 'none';
  }

  _bind() {
    document.addEventListener('click', (e) => {
      const goto = e.target.closest('[data-goto]');
      if (goto) { this.show(goto.dataset.goto); return; }

      const tab = e.target.closest('.tab');
      if (tab) {
        const container = tab.closest('.panel');
        container.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
        tab.classList.add('active');
        if (container.closest('#screen-unlocks')) { this.unlockTab = tab.dataset.tab; this._renderUnlocks(); }
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

      const wpn = e.target.closest('.wpn-row');
      if (wpn && !wpn.classList.contains('locked')) {
        this.selectedWeapon = wpn.dataset.id;
        this.profile.equipWeapon(this.selectedWeapon);
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
    });
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      if (e.target.id === 'coop-code' || e.target.id === 'coop-url') { e.preventDefault(); this._coopJoin(); }
      else if (e.target.id === 'coop-name' && !this.game.coop.active) { e.preventDefault(); this._coopHost(); }
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
    // Settings live-update as they are dragged and are written straight to the
    // profile, so there is no Apply button to forget to press.
    document.addEventListener('input', (e) => {
      const el = e.target;
      if (!el.id || !el.id.startsWith('set-')) return;
      const key = el.id.slice(4);
      const value = el.type === 'checkbox' ? el.checked : Number(el.value);
      this.profile.setSetting(key, value);
      this.game.applySettings();
      const out = $(`val-${key}`);
      if (out) out.textContent = settingLabel(key, value);
    });

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
    this.selectedWeapon = this.profile.data.equippedWeapon;
    this.selectedCharacter = this.profile.data.equippedCharacter;
    this.game.applySettings();
    btn.classList.remove('armed');
    btn.textContent = 'Reset Account';
    this._renderSettings();
    this._renderMenu();
    this.game.hud.toast('Account reset — everything is back to zero', '#ff4d5e');
  }

  _purchase(kind, id, cost) {
    const ok = kind === 'item' ? this.profile.unlockItem(id, cost)
      : kind === 'character' ? this.profile.unlockCharacter(id, cost)
      : this.profile.unlockWeapon(id, cost);
    if (ok) {
      const name = kind === 'item' ? ITEMS.find((i) => i.id === id)?.name
        : kind === 'character' ? CHARACTERS.find((c) => c.id === id)?.name
        : WEAPONS.find((w) => w.id === id)?.name;
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
    $('menu-version').textContent = `v${VERSION} · ${CHARACTERS.length} characters · ${WEAPONS.length} weapons · ${ITEMS.length} items`;
  }

  // ------------------------------------------------------------------ loadout
  _renderLoadout() {
    const data = this.profile.data;
    if (!this.profile.isWeaponUnlocked(this.selectedWeapon)) this.selectedWeapon = data.equippedWeapon;
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
      <div class="wd-ability">
        <span class="wa-key">SHIFT</span>
        <div class="wa-body"><h6>${esc(char.utility.name)}
          <span style="color:var(--dim);font-size:11px">${char.utility.cooldown}s${(char.utility.charges ?? 1) > 1 ? ` · ${char.utility.charges} charges` : ''}</span></h6>
          <p>${esc(char.utility.desc)}</p></div>
      </div>
      <div class="wd-ability">
        <span class="wa-key">R</span>
        <div class="wa-body"><h6>${esc(char.special.name)}
          <span style="color:var(--dim);font-size:11px">${char.special.cooldown}s</span></h6>
          <p>${esc(char.special.desc)}</p></div>
      </div>
      ${char.ultimate ? `<div class="wd-ability ult">
        <span class="wa-key">F</span>
        <div class="wa-body"><h6>${esc(char.ultimate.name)}
          <span style="color:var(--gold);font-size:11px">ULTIMATE · charges from kills and damage taken</span></h6>
          <p>${esc(char.ultimate.desc)}</p></div>
      </div>` : ''}`;

    $('weapon-list').innerHTML = WEAPONS.map((w) => {
      const owned = this.profile.isWeaponUnlocked(w.id);
      const sel = w.id === this.selectedWeapon;
      return `<button class="wpn-row ${sel ? 'sel' : ''} ${owned ? '' : 'locked'}" data-id="${w.id}">
        <span class="wi">${w.icon}</span>
        <span class="wn">${esc(w.name)}</span>
        <span class="wl">${owned ? (sel ? 'EQUIPPED' : '') : `🔒 ${w.echoCost}`}</span>
      </button>`;
    }).join('');

    const w = WEAPONS.find((x) => x.id === this.selectedWeapon) || WEAPONS[0];
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
        <div class="wa-body"><h6>${esc(w.secondary.name)} <span style="color:var(--dim);font-size:11px">${w.secondary.cooldown}s</span></h6><p>${esc(w.secondary.desc)}</p></div>
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
          const weapon = WEAPONS.find((w) => w.id === p.weapon);
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

    if (this.unlockTab === 'weapons') {
      body.innerHTML = `
        <p style="color:var(--muted);font-size:13.5px;margin-bottom:16px;line-height:1.6">
          Weapons change how a run plays from the first second. Unlocked weapons can be equipped in the Loadout screen before any descent.
        </p>
        <div class="grid">${cat.weapons.map((w) => this._weaponCard(w)).join('')}</div>`;
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

  _weaponCard(entry) {
    const w = entry.ref;
    const affordable = !entry.owned && this.profile.echoes >= entry.cost;
    return `<button class="card ${entry.owned ? '' : 'locked'} ${affordable ? 'affordable' : ''}"
        style="border-left-color:#ffb347"
        ${entry.owned ? '' : `data-buy="${w.id}" data-kind="weapon" data-cost="${entry.cost}"`}>
      <span class="c-ico">${w.icon}</span>
      <span class="c-body">
        <span class="c-name" style="color:#ffb347">${esc(w.name)}</span>
        <span class="c-desc">${esc(w.desc)}</span>
        <span class="c-stack">${esc(w.tag)}</span>
        ${entry.owned
          ? '<span class="c-owned">✓ Unlocked</span>'
          : `<span class="c-cost">◈ ${entry.cost}</span>`}
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
    const weaponsUnlocked = this.profile.data.unlockedWeapons.length;
    $('stats-body').innerHTML = `
      <div class="stat-rows">
        ${rows.map(([k, v]) => `<div class="stat-row"><span>${k}</span><b>${v}</b></div>`).join('')}
      </div>
      <div class="sect-label">Collection</div>
      <div class="stat-rows">
        <div class="stat-row"><span>Items Unlocked</span><b>${itemsUnlocked} / ${ITEMS.length}</b></div>
        <div class="stat-row"><span>Weapons Unlocked</span><b>${weaponsUnlocked} / ${WEAPONS.length}</b></div>
        <div class="stat-row"><span>Characters Unlocked</span><b>${this.profile.data.unlockedCharacters.length} / ${CHARACTERS.length}</b></div>
      </div>`;
  }

  // ------------------------------------------------------------------ settings
  _renderSettings() {
    const st = this.profile.data.settings;
    const s = this.profile.data.stats;
    $('settings-body').innerHTML = `
      <div class="sect-label">Controls</div>
      <div class="set-rows">
        <label class="set-row">
          <span>Mouse Sensitivity</span>
          <input id="set-sensitivity" type="range" min="0.2" max="3" step="0.05" value="${st.sensitivity}" />
          <b id="val-sensitivity">${settingLabel('sensitivity', st.sensitivity)}</b>
        </label>
      </div>

      <div class="sect-label">Display</div>
      <div class="set-rows">
        <label class="set-row">
          <span>Screen Shake</span>
          <input id="set-screenShake" type="range" min="0" max="1.5" step="0.05" value="${st.screenShake}" />
          <b id="val-screenShake">${settingLabel('screenShake', st.screenShake)}</b>
        </label>
        <label class="set-row">
          <span>Damage Numbers</span>
          <input id="set-damageNumbers" type="checkbox" ${st.damageNumbers ? 'checked' : ''} />
          <b id="val-damageNumbers">${settingLabel('damageNumbers', st.damageNumbers)}</b>
        </label>
      </div>

      <div class="sect-label">Account</div>
      <div class="stat-rows">
        <div class="stat-row"><span>Echoes Available</span><b>${formatNumber(this.profile.echoes)}</b></div>
        <div class="stat-row"><span>Runs Recorded</span><b>${formatNumber(s.runs)}</b></div>
        <div class="stat-row"><span>Unlocks Owned</span><b>${
          this.profile.data.unlockedItems.length
          + this.profile.data.unlockedWeapons.length
          + this.profile.data.unlockedCharacters.length}</b></div>
      </div>
      <p class="set-warn">Resetting the account erases every Echo, unlock, record and option on this
      device and puts the game back to a first launch. There is no undo and no backup.</p>`;
  }

  // ------------------------------------------------------------------ help
  _renderHelp() {
    const keys = [
      ['W A S D', 'Move'],
      ['Mouse', 'Look'],
      ['Left Click', 'Primary attack'],
      ['Q', 'Secondary ability (hold to charge where applicable)'],
      ['Right Click', 'Aim — pulls the camera in and narrows the view'],
      ['Shift', 'Utility ability (character-specific)'],
      ['R', 'Special ability (character-specific)'],
      ['F', 'Ultimate — no cooldown; the meter fills from kills and from damage taken'],
      ['Space', 'Jump (twice with Gravity Boots)'],
      ['E', 'Interact with chests, shrines and the Beacon'],
      ['Esc', 'Pause'],
    ];
    $('help-body').innerHTML = `
      <h4>The Loop</h4>
      <p>Kill things, take their gold, spend it on chests. Chests give items. Items stack — every copy of an item makes its effect stronger, and there is no upper limit.</p>
      <p>Enemies get stronger every second you are alive. The difficulty meter at the top of the screen never goes down, so a run is a race between your item collection and the ramp.</p>

      <h4>Ultimates</h4>
      <p>Every character has one ultimate on <b>F</b>. It has no cooldown — the meter beside your other abilities fills as you kill things and as you take damage, and empties completely when you spend it. Being ground down in a bad fight is worth as much as winning an easy one, so the ultimate tends to arrive at the moment it is most needed.</p>

      <h4>Descending</h4>
      <p>Each stage holds a Beacon. Activating it starts a ${'≈'}42-second charge that only advances while you stand inside the ring, and it calls a guardian. Survive the charge, clear the guardian, and the Beacon opens the way down — a fresh arena, a harder baseline, and better gold.</p>
      <p>You can ignore the Beacon and farm the stage instead. The difficulty keeps climbing either way, so this is a real decision, not a free one.</p>

      <h4>The Brood</h4>
      <p>Eggs sit out in every stage next to the chests. Paying one hatches a lizard that follows
      you, picks targets off your crosshair and spits homing fire that explodes and burns.</p>
      <p>They have no stats of their own. Health, damage, speed and fire rate are all read from
      <em>your</em> current stats, and their hits go through the same pipe yours do — your crit,
      your damage modifiers, your lifesteal and your on-hit items all fire from their fireballs.
      Every second item you pick up grows another crystal on their backs.</p>
      <p>They cannot be lost. Dropping one to zero curls it back into an egg for ${MINIONS.reviveTime}s.
      They are not hunted by the enemy AI, but they will stop bullets meant for you and they will
      eat a slam, so where they stand matters. The whole brood descends with you.</p>

      <h4>Co-op</h4>
      <p>Open a lobby from the main menu and read your address and four-letter code out to your
      friends. Up to ${COOP.maxPlayers} of you share one arena, one director and one set of bosses.</p>
      <p>Everything else is yours alone: your items, your gold, your level and your lizards. Gold
      and experience are paid to everyone on every kill, so nobody has to race to a corpse — but
      an item on the ground goes to whoever reaches it first.</p>
      <p>Going down is not the end. You keep watching, and a teammate standing over you for
      ${COOP.reviveTime}s brings you back. The run only ends when the last of you falls, or when
      you all descend — anyone still down comes back up on the next stage.</p>

      <h4>Rarity</h4>
      <div class="rar-legend">
        ${RARITY_ORDER.map((r) => `<span class="rar-chip" style="color:${RARITY[r].color}">${RARITY[r].name}</span>`).join('')}
      </div>
      <p style="margin-top:10px">Ordinary chests overwhelmingly give Common items. Large and Legendary chests shift the odds; Fortune Clover rerolls every rarity roll and keeps the better result.</p>

      <h4>Echoes</h4>
      <p>Every run ends eventually. When it does you are paid in Echoes, based mostly on how long you survived, plus stages cleared and bosses killed. Spend them in the Sanctum to permanently add items to the drop pool and to unlock new weapons.</p>
      <p>Unlocking an item does not give it to you — it makes it findable. A bigger pool means more variety, not more power per chest.</p>

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
