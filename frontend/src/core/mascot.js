// Маскот ТТК — виртуальный проводник.
//   Ожидание: прячется за правым краем окна, видны голова, руки и знак вопроса; при наведении — вторая картинка.
//   Нажатие: выходит целиком (GIF), говорит случайную фразу из списка, через минуту снова прячется.
//   Панорама: появляется и рассказывает о месте — текст точки задаёт админ, каждая строка — новая поза.
// Реплика печатается по одной букве в облаке фиксированного размера (длинный текст прокручивается),
// пока идёт печать — звучит «пиксельный разговор». Размер, громкость и фразы настраивает админ (map.mascot).

const A = (f) => new URL(`../../assets/mascot/${f}`, import.meta.url).href;
const POSES = Array.from({ length: 12 }, (_, i) => A(`poses/ttk_pose_${String(i + 1).padStart(2, '0')}.png`));
const GIF = A('full.gif'), PEEK = [A('peek-1.png'), A('peek-2.png')];
const IDLE_MS = 60000, CHAR_MS = 32, LINE_PAUSE = 650;

export const DEFAULT_PHRASES = [
  'О, привет! Рад тебя видеть! Ну что, исследуем наш IT-мир?',
  'Здравствуй, человек! Я твой виртуальный проводник. А значит, потеряться здесь будет немного сложнее!',
  'Привет-привет! Добро пожаловать туда, где идеи превращаются в проекты, а кофе — в топливо для разработчиков!',
  'Ну здравствуй! Я здесь, чтобы помочь тебе освоиться. А ещё немного поболтать, если ты не против!',
  'Добро пожаловать на Южный IT-форум Hackathon 2026! Пристегнись, впереди много интересного!',
  'О, новый исследователь! Готов посмотреть, что скрывается за пределами этого пространства?',
  'Привет! Я пока никуда не ухожу. Можешь осмотреться, а я составлю тебе компанию!',
];

/** Настройки маскота карты с подстановкой значений по умолчанию. */
export function mascotSettings(map) {
  const m = map?.mascot || {};
  return {
    enabled: m.enabled !== false,
    size: Math.min(2, Math.max(0.5, +m.size || 1)),
    volume: Math.min(1, Math.max(0, m.volume ?? 0.6)),
    phrases: (m.phrases || []).map((s) => String(s).trim()).filter(Boolean).length ? m.phrases.map((s) => String(s).trim()).filter(Boolean) : DEFAULT_PHRASES,
  };
}

/** Текст рассказа → строки: по переводам строки, а одну длинную строку — по предложениям. */
export function guideLines(text) {
  const lines = String(text || '').split(/\n+/).map((s) => s.trim()).filter(Boolean);
  return lines.length === 1 ? lines[0].split(/(?<=[.!?…])\s+/).filter(Boolean) : lines;
}

// Звук маскота посетитель включает сам (кнопка с динамиком); по умолчанию — выключен.
const SOUND_KEY = 'arena.sound';
export const soundOn = () => { try { return localStorage.getItem(SOUND_KEY) === '1'; } catch { return false; } };
export function setSound(on) {
  try { localStorage.setItem(SOUND_KEY, on ? '1' : '0'); } catch { /* запомнить не получится — работает до перезагрузки */ }
  window.dispatchEvent(new CustomEvent('soundchange', { detail: on }));
}

/** opts.sound — функция «можно ли играть звук» (в конструкторе админ слушает всегда). */
export function createMascot(host, settings, opts = {}) {
  const allowed = opts.sound || soundOn;
  let S = settings, mode = 'peek', idleT = null, typing = 0, lastPose = -1, lastPhrase = -1;
  const el = document.createElement('div');
  el.className = 'mascot';
  el.innerHTML = `
    <button class="mascot-peek" aria-label="Маскот ТТК — нажмите, чтобы поздороваться" title="Привет! Нажми на меня"></button>
    <img class="mascot-body" alt="Маскот ТТК" hidden>
    <div class="mascot-cloud" role="status" aria-live="polite">
      <button class="mascot-x" aria-label="Закрыть облако" title="Пропустить">×</button>
      <div class="mascot-text" tabindex="0"></div>
    </div>`;
  host.append(el);
  const body = el.querySelector('.mascot-body'), cloud = el.querySelector('.mascot-cloud'), textEl = el.querySelector('.mascot-text');
  const audio = new Audio(A('talk.mp3')); audio.loop = true; audio.preload = 'auto';
  for (const src of [...PEEK, GIF, ...POSES]) { const im = new Image(); im.src = src; }   // без мигания при смене картинок

  function apply() {
    el.style.setProperty('--m', S.size);
    audio.volume = S.volume;
    el.hidden = !S.enabled;
  }
  apply();

  // ---------- облако и печать ----------
  function openCloud() { textEl.textContent = ''; cloud.classList.add('on'); }
  function closeCloud() { typing++; audio.pause(); cloud.classList.remove('on'); }
  const sleep = (ms, t) => new Promise((r) => setTimeout(() => r(t === typing), ms));
  /** Напечатать строки по букве; poses — менять позу на каждой строке. Возвращает false, если реплику прервали. */
  async function say(lines, poses) {
    const t = ++typing;
    openCloud();
    for (let i = 0; i < lines.length; i++) {
      if (poses) setPose();
      const p = document.createElement('p'); textEl.append(p);
      if (allowed()) { audio.currentTime = 0; audio.play().catch(() => {}); }   // звук идёт, пока печатается текст
      for (const ch of lines[i]) {
        if (t !== typing) return false;
        // если человек прокрутил облако вверх — не дёргаем его вниз
        const stick = textEl.scrollHeight - textEl.scrollTop - textEl.clientHeight < 24;
        p.textContent += ch;
        if (stick) textEl.scrollTop = textEl.scrollHeight;
        if (!(await sleep(/[.,!?…—]/.test(ch) ? CHAR_MS * 4 : CHAR_MS, t))) return false;
      }
      audio.pause();
      if (i < lines.length - 1 && !(await sleep(LINE_PAUSE, t))) return false;
    }
    return true;
  }
  function setPose() {
    let i; do { i = Math.floor(Math.random() * POSES.length); } while (i === lastPose && POSES.length > 1);
    lastPose = i; body.src = POSES[i]; body.classList.add('pose');
  }

  // ---------- появление и уход ----------
  function appear(src, pose) {
    clearTimeout(idleT);
    body.src = src; body.classList.toggle('pose', !!pose); body.hidden = false;
    mode = 'full'; el.dataset.state = 'full';
    requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('out')));
  }
  function hide() {
    clearTimeout(idleT); closeCloud();
    if (mode === 'peek') return;
    mode = 'peek'; el.classList.remove('out');
    setTimeout(() => { if (mode === 'peek') { body.hidden = true; el.dataset.state = 'peek'; } }, 420);
  }

  /** Поздороваться: выйти целиком и сказать случайную фразу; через минуту — обратно за край. */
  async function greet() {
    if (!S.enabled || mode === 'guide') return;
    appear(GIF);
    let i; do { i = Math.floor(Math.random() * S.phrases.length); } while (i === lastPhrase && S.phrases.length > 1);
    lastPhrase = i; mode = 'greet';
    await sleep(450, typing);
    await say([S.phrases[i]], false);
    idleT = setTimeout(() => mode === 'greet' && hide(), IDLE_MS);
  }
  /** Рассказать о месте (панорама): появляется в позе, каждую строку — новая поза. Пустой текст — молчит и прячется. */
  async function guide(text) {
    const lines = guideLines(text);
    if (!S.enabled || !lines.length) { if (mode === 'guide') hide(); return; }
    clearTimeout(idleT);
    appear(POSES[0], true); mode = 'guide';
    await sleep(380, typing);
    await say(lines, true);
  }
  /** Выход из панорамы — маскот снова прячется. */
  function leave() { if (mode !== 'peek') hide(); }

  el.querySelector('.mascot-peek').addEventListener('click', greet);
  const onSound = (e) => { if (!e.detail) audio.pause(); };
  window.addEventListener('soundchange', onSound);
  el.querySelector('.mascot-x').addEventListener('click', () => {
    closeCloud();
    if (mode === 'greet') { clearTimeout(idleT); idleT = setTimeout(hide, IDLE_MS); }
  });
  return {
    el, greet, guide, leave,
    setSettings(s) { S = s; apply(); if (!S.enabled) hide(); },
    destroy() { clearTimeout(idleT); typing++; audio.pause(); window.removeEventListener('soundchange', onSound); el.remove(); },
  };
}
