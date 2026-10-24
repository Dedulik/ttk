// Видео перехода между точками обзора: ролик прохода на весь экран, пока грузится следующая панорама.
// Посетитель может пропустить его. Звук — как у маскота: по умолчанию выключен.
import { esc, icon } from './ui.js';

/**
 * Проиграть видео поверх страницы. Возвращает { done, close }:
 *   done — Promise<'ended' | 'skip' | 'error'>, разрешается, когда видео кончилось, его пропустили или оно не загрузилось;
 *   close() — убрать слой (вызывается, когда следующая панорама готова).
 */
export function playTransition(url, { title = '', sound = false, host = document.body } = {}) {
  const el = document.createElement('div');
  el.className = 'trans-video';
  el.innerHTML = `<video playsinline preload="auto" ${sound ? '' : 'muted'}></video>
    <div class="tv-top">${title ? `<span class="tv-title">${esc(title)}</span>` : ''}<button class="btn sm" data-skip>${icon('chevron')}Пропустить</button></div>
    <div class="tv-bar"><i></i></div>`;
  host.append(el);
  const v = el.querySelector('video'), bar = el.querySelector('.tv-bar i');
  let finish;
  const done = new Promise((res) => { finish = res; });
  const end = (why) => { v.pause(); finish(why); };
  v.addEventListener('ended', () => end('ended'));
  v.addEventListener('error', () => end('error'));
  v.addEventListener('timeupdate', () => { if (v.duration) bar.style.width = `${(v.currentTime / v.duration) * 100}%`; });
  el.querySelector('[data-skip]').addEventListener('click', () => end('skip'));
  const key = (e) => { if (e.key === 'Escape' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); end('skip'); } };
  document.addEventListener('keydown', key, true);
  // видео, которое долго не начинается (плохая сеть), не держит посетителя: через 8 с — дальше без него
  const slow = setTimeout(() => { if (v.readyState < 3) end('error'); }, 8000);
  v.addEventListener('playing', () => clearTimeout(slow), { once: true });
  v.src = url;
  v.play().catch(() => { if (!v.muted) { v.muted = true; v.play().catch(() => end('error')); } else end('error'); });
  requestAnimationFrame(() => el.classList.add('on'));
  const close = () => {
    clearTimeout(slow); document.removeEventListener('keydown', key, true);
    el.classList.remove('on'); setTimeout(() => { v.removeAttribute('src'); v.load(); el.remove(); }, 300);
  };
  return { done, close };
}
