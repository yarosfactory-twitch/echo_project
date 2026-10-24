// Конфеті на перемогу — як на сайті фільмів (fireConfetti з common.js), у кольорах гри.
let styleInjected = false;

export function fireConfetti() {
  if (!styleInjected) {
    const style = document.createElement("style");
    style.textContent = `
      @keyframes confettiFall {
        0% { transform: translateY(-20px) rotate(0deg); opacity: 1; }
        80% { opacity: 1; }
        100% { transform: translateY(100vh) rotate(720deg); opacity: 0; }
      }`;
    document.head.appendChild(style);
    styleInjected = true;
  }
  const colors = ["#d4a94a", "#f3e9d2", "#7fd1a0", "#b8452f", "#2f4a7a", "#e2bb62"];
  const container = document.createElement("div");
  container.className = "confetti";
  container.style.cssText = "position:fixed; inset:0; pointer-events:none; z-index:9999; overflow:hidden;";
  document.body.appendChild(container);
  for (let i = 0; i < 120; i++) {
    const el = document.createElement("div");
    const size = 6 + Math.random() * 7;
    const isCircle = Math.random() < 0.5;
    el.style.cssText = `
      position:absolute; top:-20px; left:${Math.random() * 100}vw; width:${size}px; height:${size * (isCircle ? 1 : 1.6)}px;
      background:${colors[Math.floor(Math.random() * colors.length)]}; opacity:.95; border-radius:${isCircle ? "50%" : "1px"};
      animation:confettiFall ${2.2 + Math.random() * 1.6}s ease-in ${Math.random() * 0.5}s forwards;`;
    container.appendChild(el);
  }
  setTimeout(() => container.remove(), 4500);
}
