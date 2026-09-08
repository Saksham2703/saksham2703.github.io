(function () {
  const root = document.querySelector('[data-pusht]');
  if (!root) return;

  const $ = (sel) => root.querySelector(sel);
  const stage = $('[data-stage]');
  const slider = $('[data-slider]');
  const ticks = $('[data-ticks]');
  const bars = $('[data-bars]');
  const videoBase = root.dataset.videoBase;

  const BX = 44, TOP = 12, BASE = 112, RIGHT = 446;
  let D = null, BW = 0, vids = {};

  function chart(active) {
    const max = D.chart_max_pct;
    let s = '';
    [0, max / 2, max].forEach((g) => {
      const y = BASE - (g / max) * (BASE - TOP);
      s += `<line x1="${BX}" x2="${RIGHT}" y1="${y}" y2="${y}" stroke="var(--line)" stroke-width="1"/>`;
      s += `<text x="${BX - 9}" y="${y + 3.5}" font-size="9.5" fill="var(--ink-3)" text-anchor="end">${g}%</text>`;
    });
    D.runs.forEach((d, i) => {
      const x = BX + i * BW + BW * 0.22, w = BW * 0.56, cx = x + w / 2;
      const h = (d.pc_success / max) * (BASE - TOP);
      const on = i === active;
      const fill = on ? (d.state === 'bad' ? 'var(--alarm)' : 'var(--accent)') : 'var(--line-2)';
      if (h > 0.5) s += `<rect x="${x}" y="${BASE - h}" width="${w}" height="${h}" rx="3" fill="${fill}"/>`;
      else s += `<rect x="${x}" y="${BASE - 2}" width="${w}" height="2" rx="1" fill="${fill}"/>`;

      const lo = Math.max(0, d.pc_success - D.binomial_noise_pts);
      const hi = d.pc_success + D.binomial_noise_pts;
      const yl = BASE - (lo / max) * (BASE - TOP), yh = BASE - (hi / max) * (BASE - TOP);
      const op = on ? 0.85 : 0.35;
      s += `<line x1="${cx}" x2="${cx}" y1="${yh}" y2="${yl}" stroke="var(--ink-3)" stroke-width="1" opacity="${op}"/>`;
      s += `<line x1="${cx - 3.5}" x2="${cx + 3.5}" y1="${yh}" y2="${yh}" stroke="var(--ink-3)" stroke-width="1" opacity="${op}"/>`;
      s += `<text x="${cx}" y="${BASE + 16}" font-size="10" fill="${on ? 'var(--ink)' : 'var(--ink-3)'}" text-anchor="middle" font-weight="${on ? 700 : 400}">${d.h}</text>`;
      if (on) s += `<text x="${cx}" y="${yh - 7}" font-size="11" fill="${fill}" text-anchor="middle" font-weight="700">${d.pc_success.toFixed(1)}%</text>`;
    });
    s += `<text x="${BX + (RIGHT - BX) / 2}" y="${BASE + 34}" font-size="9.5" fill="var(--ink-3)" text-anchor="middle" letter-spacing="1.2">N_ACTION_STEPS</text>`;
    bars.innerHTML = s;
  }

  function render(i) {
    const d = D.runs[i];
    Object.values(vids).forEach((v) => v.classList.remove('on'));
    vids[d.h].classList.add('on');
    vids[d.h].play().catch(() => {});
    $('[data-pc]').textContent = d.pc_success.toFixed(1) + '%';
    $('[data-bignum]').className = 'bignum' + (d.state === 'bad' ? ' bad' : '');
    $('[data-verdict]').className = 'verdict' + (d.state === 'bad' ? ' bad' : '');
    $('[data-chip]').textContent = d.label;
    $('[data-text]').textContent = d.text;
    $('[data-hval]').textContent = d.h;
    $('[data-tag-left]').textContent = 'n_action_steps = ' + d.h;
    $('[data-tag-right]').textContent =
      'episode ' + D.episode + ' · max_reward ' + d.ep_max_reward.toFixed(2);
    [...ticks.children].forEach((b, k) =>
      b.setAttribute('aria-current', k === i ? 'true' : 'false'));
    chart(i);
  }

  fetch(root.dataset.src)
    .then((r) => r.json())
    .then((data) => {
      D = data;
      BW = (RIGHT - BX - 14) / D.runs.length;
      slider.max = String(D.runs.length - 1);

      root.querySelectorAll('[data-n]').forEach((el) => (el.textContent = D.n_eval_episodes));

      // Keep the chart's screen-reader summary in sync with the data, so it can
      // never describe numbers the chart no longer shows.
      const svg = root.querySelector('[data-chart-svg]');
      if (svg) {
        svg.setAttribute('aria-label',
          'Success rate by execution horizon: ' +
          D.runs.map((d) => `${d.h} steps ${d.pc_success.toFixed(1)}%`).join(', ') +
          `. Measured over ${D.n_eval_episodes} episodes per setting.`);
      }
      const noise = root.querySelector('[data-noise]');
      if (noise) noise.textContent = D.binomial_noise_pts;

      D.runs.forEach((d) => {
        const v = document.createElement('video');
        v.src = `${videoBase}/h${d.h}.mp4`;
        v.muted = true; v.loop = true; v.playsInline = true;
        v.autoplay = true; v.preload = 'auto';
        v.setAttribute('aria-hidden', 'true');
        stage.insertBefore(v, stage.firstChild);
        vids[d.h] = v;
      });

      D.runs.forEach((d, i) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = d.h;
        b.setAttribute('aria-label', 'Set execution horizon to ' + d.h);
        b.addEventListener('click', () => { slider.value = i; render(i); });
        ticks.appendChild(b);
      });

      slider.addEventListener('input', (e) => render(+e.target.value));
      slider.value = D.default_index;
      render(D.default_index);
    })
    .catch((err) => {
      $('[data-tag-left]').textContent = 'Could not load the sweep data.';
      console.error('pusht:', err);
    });
})();
