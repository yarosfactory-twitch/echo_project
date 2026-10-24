// Барабан тем (як «Колесо випадковості» на сайті фільмів).
// Вертикальна стрічка, 5 видимих рядків, центральний — вибраний.
//
// Барабан живе в окремому контейнері поза patch(), щоб перемальовування
// сторінки не обривало анімацію. Кожен клієнт сам анімує стрічку за
// однаковими даними з гри: spin = { id, list, target, ms }.

export const SPIN_MS = 4200; // підлаштовано під sfx/spin.mp3, як на сайті фільмів
const VISIBLE_ROWS = 5;
const CENTER_ROW = Math.floor(VISIBLE_ROWS / 2);
const COPIES = 12; // скільки разів повторити список для довгого прокручування

const sfxCache = {};
export function playSfx(name, volume = 0.55) {
  try {
    const audio = (sfxCache[name] ??= new Audio(`sfx/${name}.mp3`));
    audio.currentTime = 0;
    audio.volume = volume;
    audio.play().catch(() => {}); // браузер заблокував автоплей — тихо ігноруємо
  } catch { /* немає звуку — не критично */ }
}

const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

/** Позиція рядка-переможця в стрічці (чиста функція, є тести). */
export function landingRow(listLength, target, copies = COPIES) {
  return CENTER_ROW + (copies - 2) * listLength + target;
}

export class Reel {
  /** @param {HTMLElement} root  @param {{sound?: boolean}} opts */
  constructor(root, { sound = false } = {}) {
    this.root = root;
    this.sound = sound;
    this.key = null;
    this.timer = null;
    root.innerHTML = `<div class="reel-wrap">
        <div class="reel-arrow left">▶</div><div class="reel-arrow right">◀</div>
        <div class="reel-window">
          <div class="reel-band"></div><div class="reel-fade top"></div><div class="reel-fade bottom"></div>
          <div class="reel-track"></div>
        </div>
      </div>`;
    this.track = root.querySelector(".reel-track");
    this.hide();
  }

  hide() { this.root.hidden = true; this.key = null; clearTimeout(this.timer); }

  rowH() {
    return parseFloat(getComputedStyle(this.root).getPropertyValue("--row-h")) || 76;
  }

  build(list) {
    const rows = (item, i) => `<div class="reel-row" data-i="${i}"><span>${esc(item)}</span></div>`;
    let html = list.slice(-CENTER_ROW).map((t, k) => rows(t, list.length - CENTER_ROW + k)).join("");
    for (let c = 0; c < COPIES; c++) html += list.map(rows).join("");
    this.track.innerHTML = html;
    this.track.style.transition = "none";
    this.track.style.transform = "translateY(0px)";
  }

  /** Барабан у спокої до обертання. Стрічка зсунута на пів рядка, щоб у золотій
   *  смузі не стояла жодна тема (інакше перша тема пулу виглядає вже обраною). */
  idle(list) {
    const key = `idle:${list.join("\u0001")}`;
    this.root.hidden = false;
    if (this.key === key) return;
    this.key = key;
    clearTimeout(this.timer);
    this.root.classList.remove("landed");
    this.root.classList.add("idle");
    this.build(list.length ? list : ["—"]);
    this.track.style.transform = `translateY(${this.rowH() / 2}px)`;
  }

  /**
   * Показує обертання spin. Якщо animate=false (сторінку відкрили пізніше),
   * одразу ставить барабан на результат.
   * @param {{id:string, list:string[], target:number, ms:number}} spin
   * @param {(theme:string)=>void} [onLanded]
   */
  spin(spin, animate, onLanded) {
    const key = `spin:${spin.id}`;
    this.root.hidden = false;
    if (this.key === key) return;
    this.key = key;
    clearTimeout(this.timer);
    this.root.classList.remove("landed", "idle");
    this.build(spin.list);
    const y = (CENTER_ROW - landingRow(spin.list.length, spin.target)) * this.rowH();
    const land = () => {
      this.root.classList.add("landed");
      const row = this.track.children[landingRow(spin.list.length, spin.target)];
      row?.classList.add("win");
      onLanded?.(spin.list[spin.target]);
    };
    if (!animate) {
      this.track.style.transform = `translateY(${y}px)`;
      land();
      return;
    }
    void this.track.offsetHeight; // застосувати скидання перед анімацією
    this.track.style.transition = `transform ${spin.ms}ms cubic-bezier(.11,.7,.14,1)`;
    this.track.style.transform = `translateY(${y}px)`;
    if (this.sound) playSfx("spin", 0.55);
    this.timer = setTimeout(() => {
      if (this.sound) playSfx("win", 0.6);
      land();
    }, spin.ms);
  }
}
