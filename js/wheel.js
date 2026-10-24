// Вінілова платівка з аватарками для повторної нічиї в тай-брейку.
// Платівка крутиться, голка зверху; переможець — той, на кому зупинилась голка.
// Як і барабан, живе поза patch(), а всі клієнти анімують за однаковими даними:
// wheel = { id, players: [{uid, displayName, avatar}], target, jitter, ms, at }.
import { wheelRotation } from "./shop.js";
import { playSfx } from "./reel.js";

export const WHEEL_MS = 5200;

const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

export class VinylWheel {
  constructor(root, { sound = false } = {}) {
    this.root = root;
    this.sound = sound;
    this.key = null;
    this.timer = null;
    this.hide();
  }

  hide() { this.root.hidden = true; this.key = null; clearTimeout(this.timer); }

  build(players) {
    const n = players.length;
    const slice = 360 / n;
    const items = players.map((p, i) => {
      const angle = i * slice + slice / 2; // центр сектора, 0° — зверху
      const face = p.avatar
        ? `<img src="${esc(p.avatar)}" alt="">`
        : `<span>${esc((p.displayName || "?").slice(0, 1).toUpperCase())}</span>`;
      return `<div class="wheel-slot" style="--a:${angle}deg"><div class="wheel-face">${face}</div><div class="wheel-name">${esc(p.displayName)}</div></div>`;
    }).join("");
    const lines = players.map((_, i) => `<div class="wheel-line" style="--a:${i * slice}deg"></div>`).join("");
    this.root.innerHTML = `<div class="wheel-wrap">
        <div class="wheel-needle"></div>
        <div class="wheel-disc">${lines}${items}<div class="wheel-label"></div></div>
      </div>`;
    this.disc = this.root.querySelector(".wheel-disc");
  }

  /** Спокійна платівка до обертання. */
  idle(players) {
    const key = `idle:${players.map((p) => p.uid).join(",")}`;
    this.root.hidden = false;
    if (this.key === key) return;
    this.key = key;
    clearTimeout(this.timer);
    this.root.classList.remove("landed");
    this.build(players);
  }

  /** @param {{id:string, players:object[], target:number, jitter:number, ms:number}} w */
  spin(w, animate, onLanded) {
    const key = `spin:${w.id}`;
    this.root.hidden = false;
    if (this.key === key) return;
    this.key = key;
    clearTimeout(this.timer);
    this.root.classList.remove("landed");
    this.build(w.players);
    const rot = wheelRotation(w.players.length, w.target, 6, w.jitter ?? 0);
    const land = () => {
      this.root.classList.add("landed");
      this.root.querySelectorAll(".wheel-slot")[w.target]?.classList.add("win");
      onLanded?.(w.players[w.target]);
    };
    if (!animate) {
      this.disc.style.transform = `rotate(${rot}deg)`;
      land();
      return;
    }
    this.disc.style.transform = "rotate(0deg)";
    void this.disc.offsetHeight;
    this.disc.style.transition = `transform ${w.ms}ms cubic-bezier(.12,.68,.12,1)`;
    this.disc.style.transform = `rotate(${rot}deg)`;
    if (this.sound) playSfx("spin", 0.55);
    this.timer = setTimeout(() => { if (this.sound) playSfx("win", 0.6); land(); }, w.ms);
  }
}
