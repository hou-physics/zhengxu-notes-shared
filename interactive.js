/* ============================================================
   zhengxu-notes — interactive runtime
   - Inflates <div class="viz" data-viz='...'> into slider+plot widgets
   - Wires theme switcher
   ============================================================ */

(function () {
  'use strict';

  /* ---------------- helpers ---------------- */

  const getCSS = (name) =>
    getComputedStyle(document.body).getPropertyValue(name).trim();

  // Safe-ish expression evaluator. Variables = slider IDs, plus 'x' for plot curves.
  // Exposes Math.* directly so users can write log(x), sin(x), etc.
  function makeEvaluator(varNames, expr) {
    const args = [...varNames, 'Math', 'log', 'sin', 'cos', 'tan', 'exp',
                  'sqrt', 'abs', 'PI', 'E', 'pow'];
    const body = `with(Math){return (${expr});}`;
    try {
      return new Function(...varNames, body);
    } catch (e) {
      console.error('Invalid expression:', expr, e);
      return () => NaN;
    }
  }

  /* ---------------- viz widget ---------------- */

  function buildViz(container) {
    let config;
    try {
      config = JSON.parse(container.dataset.viz);
    } catch (e) {
      container.innerHTML = '<em style="color: #c0392b">viz: invalid JSON config</em>';
      return;
    }

    const sliderDefs = config.sliders || {};
    const sliderIds = Object.keys(sliderDefs);
    const state = {};

    // Build slider rows
    const slidersWrap = document.createElement('div');
    const sliderElements = {};
    for (const [id, opts] of Object.entries(sliderDefs)) {
      const def = +opts.default;
      state[id] = isNaN(def) ? 0 : def;
      const row = document.createElement('div');
      row.className = 'slider-row';
      row.innerHTML = `
        <label>${opts.label || id} =</label>
        <input type="range"
               min="${opts.min ?? 0}"
               max="${opts.max ?? 1}"
               step="${opts.step ?? 0.01}"
               value="${state[id]}">
        <span class="value">${formatValue(state[id], opts)}</span>`;
      slidersWrap.appendChild(row);
      const input = row.querySelector('input');
      const valSpan = row.querySelector('.value');
      sliderElements[id] = { input, valSpan, opts };
    }
    container.appendChild(slidersWrap);

    // Build readouts
    let readoutsEl = null;
    const readouts = (config.readouts || []).map((r) => {
      const fn = makeEvaluator(sliderIds, r.expr);
      return { def: r, fn };
    });
    if (readouts.length) {
      readoutsEl = document.createElement('div');
      readoutsEl.className = 'readouts';
      for (const r of readouts) {
        const el = document.createElement('span');
        el.className = 'readout';
        el.innerHTML = `<span class="label">${r.def.label}</span> = <span class="val"></span>${
          r.def.unit ? ' ' + r.def.unit : ''
        }`;
        r.el = el.querySelector('.val');
        readoutsEl.appendChild(el);
      }
      container.appendChild(readoutsEl);
    }

    // Build plot
    //
    // Supports both legacy single-curve form (plot.curve = "<expr>") and
    // multi-curve form (plot.curves = [{expr, label, dash}, ...]).
    // Optional log axes via plot.x_type / plot.y_type = "log".
    let plotEl = null;
    /** @type {Array<{fn:Function, label:string, dash:string}>} */
    let curveFns = [];
    let markerXFn = null, markerYFn = null;
    if (config.plot) {
      plotEl = document.createElement('div');
      plotEl.className = 'plot-area';
      container.appendChild(plotEl);
      const p = config.plot;
      const rawCurves = Array.isArray(p.curves) ? p.curves
                       : (p.curve ? [{ expr: p.curve }] : []);
      for (const c of rawCurves) {
        curveFns.push({
          fn:    makeEvaluator(['x', ...sliderIds], c.expr),
          label: c.label || 'curve',
          dash:  c.dash  || 'solid',
        });
      }
      markerXFn = p.marker && p.marker.x ? makeEvaluator(sliderIds, p.marker.x) : null;
      markerYFn = p.marker && p.marker.y ? makeEvaluator(sliderIds, p.marker.y) : null;
    }

    function evalArgs() { return sliderIds.map(id => state[id]); }

    function _curveXY(p, fn, args) {
      const [xMin, xMax] = p.x_range || [0, 1];
      const N = p.samples || 161;
      const xs = Array.from({length: N},
                            (_, i) => xMin + (xMax - xMin) * i / (N - 1));
      const ys = xs.map(x => fn(x, ...args));
      return { xs, ys };
    }

    function redraw() {
      // Update sliders' value labels
      for (const id of sliderIds) {
        sliderElements[id].valSpan.textContent =
          formatValue(state[id], sliderElements[id].opts);
      }
      // Update readouts
      const args = evalArgs();
      for (const r of readouts) {
        const v = r.fn(...args);
        const prec = r.def.precision ?? 3;
        r.el.textContent = isFinite(v) ? (+v).toFixed(prec) : '—';
      }
      // Update plot
      if (plotEl && plotEl._plotInited) {
        const p = config.plot;
        for (let i = 0; i < curveFns.length; i++) {
          const { xs, ys } = _curveXY(p, curveFns[i].fn, args);
          Plotly.restyle(plotEl, { x: [xs], y: [ys] }, [i]);
        }
        if (markerXFn && markerYFn) {
          Plotly.restyle(plotEl,
            { x: [[markerXFn(...args)]], y: [[markerYFn(...args)]] },
            [curveFns.length]);
        }
      }
    }

    // Wire slider inputs
    for (const id of sliderIds) {
      sliderElements[id].input.addEventListener('input', (e) => {
        state[id] = +e.target.value;
        redraw();
      });
    }

    // Initial plot render (after Plotly loads + DOM ready)
    if (plotEl && window.Plotly && curveFns.length) {
      const p = config.plot;
      const args = evalArgs();
      const traces = [];
      const colorVars = ['--accent', '--accent-2', '--link', '--ink-2'];
      for (let i = 0; i < curveFns.length; i++) {
        const { xs, ys } = _curveXY(p, curveFns[i].fn, args);
        traces.push({
          x: xs, y: ys, mode: 'lines',
          line: {
            color: getCSS(colorVars[i % colorVars.length]),
            width: 2.5,
            dash: curveFns[i].dash,
          },
          name: curveFns[i].label,
        });
      }
      if (markerXFn && markerYFn) {
        traces.push({
          x: [markerXFn(...args)], y: [markerYFn(...args)],
          mode: 'markers',
          marker: { color: getCSS('--accent-2'), size: 13,
                    line: { color: getCSS('--paper'), width: 2 } },
          name: 'current',
          showlegend: false,
        });
      }
      const showLegend = curveFns.length > 1;
      Plotly.newPlot(plotEl, traces, {
        margin: { l: 60, r: 20, t: 10, b: 45 },
        xaxis: { title: p.x_label || '', type: p.x_type || 'linear',
                 gridcolor: getCSS('--rule'),
                 zerolinecolor: getCSS('--rule'), color: getCSS('--ink') },
        yaxis: { title: p.y_label || '', type: p.y_type || 'linear',
                 gridcolor: getCSS('--rule'),
                 zerolinecolor: getCSS('--rule'), color: getCSS('--ink') },
        height: p.height || 300,
        showlegend: showLegend,
        legend: { x: 0.55, y: 0.97, bgcolor: 'rgba(0,0,0,0)',
                  bordercolor: getCSS('--rule'), borderwidth: 0 },
        paper_bgcolor: getCSS('--paper-2'),
        plot_bgcolor:  getCSS('--paper-2'),
        font: { family: 'Charter, Georgia, serif', color: getCSS('--ink') }
      }, { displayModeBar: false, responsive: true }).then(() => {
        plotEl._plotInited = true;
      });
    }

    // Initial readouts paint
    redraw();
  }

  function formatValue(v, opts) {
    const prec = (opts && opts.precision != null)
      ? opts.precision
      : inferPrecision(opts);
    return (+v).toFixed(prec);
  }
  function inferPrecision(opts) {
    if (!opts) return 2;
    const step = +opts.step;
    if (!step || !isFinite(step)) return 2;
    const s = step.toString();
    if (s.indexOf('.') >= 0) return s.split('.')[1].length;
    return 0;
  }

  /* ---------------- theme switcher ---------------- */

  function applyTheme(name) {
    document.body.dataset.theme = name;
    document.querySelectorAll('.theme-switcher button').forEach(b =>
      b.classList.toggle('active', b.dataset.setTheme === name));
    // Save preference
    try { localStorage.setItem('zhengxu-notes-theme', name); } catch (e) {}
    // Update all initialized Plotly figures
    document.querySelectorAll('.viz .plot-area').forEach(el => {
      if (!el._plotInited || !window.Plotly) return;
      try {
        Plotly.relayout(el, {
          paper_bgcolor: getCSS('--paper-2'),
          plot_bgcolor:  getCSS('--paper-2'),
          'xaxis.gridcolor':     getCSS('--rule'),
          'yaxis.gridcolor':     getCSS('--rule'),
          'xaxis.zerolinecolor': getCSS('--rule'),
          'yaxis.zerolinecolor': getCSS('--rule'),
          'xaxis.color': getCSS('--ink'),
          'yaxis.color': getCSS('--ink'),
          'font.color':  getCSS('--ink')
        });
        // Re-colour each trace according to its kind. We don't know
        // upfront whether the plot has 1 curve or N; iterate.
        const colorVars = ['--accent', '--accent-2', '--link', '--ink-2'];
        const data = (el.data || []);
        let lineIdx = 0;
        for (let i = 0; i < data.length; i++) {
          if (data[i].mode === 'markers') {
            Plotly.restyle(el, {
              'marker.color': getCSS('--accent-2'),
              'marker.line.color': getCSS('--paper'),
            }, [i]);
          } else {
            Plotly.restyle(el,
              { 'line.color': getCSS(colorVars[lineIdx % colorVars.length]) },
              [i]);
            lineIdx++;
          }
        }
      } catch (e) { /* trace might not exist; ignore */ }
    });
  }

  /* ---------------- init ---------------- */

  /* ---------------- sidebar toggle ---------------- */

  function initSidebarToggle() {
    const isMobile = window.innerWidth <= 700;
    // Restore collapsed state. On mobile the default is collapsed
    // (sidebar slides in only when the user taps the hamburger).
    try {
      const stored = localStorage.getItem('zhengxu-notes-sidebar');
      if (stored === 'collapsed' || (stored === null && isMobile)) {
        document.body.classList.add('sidebar-collapsed');
      }
    } catch (e) {
      if (isMobile) document.body.classList.add('sidebar-collapsed');
    }

    const btn = document.querySelector('.sidebar-toggle');
    if (!btn) return;
    btn.addEventListener('click', () => {
      const collapsed = document.body.classList.toggle('sidebar-collapsed');
      try {
        localStorage.setItem('zhengxu-notes-sidebar',
                             collapsed ? 'collapsed' : 'open');
      } catch (e) {}
    });

    if (isMobile) {
      // Tap on the backdrop (anywhere outside sidebar + toggle) → close
      document.addEventListener('click', (e) => {
        if (document.body.classList.contains('sidebar-collapsed')) return;
        const sidebar = document.querySelector('.sidebar');
        if (sidebar && !sidebar.contains(e.target) && !btn.contains(e.target)) {
          document.body.classList.add('sidebar-collapsed');
          try { localStorage.setItem('zhengxu-notes-sidebar', 'collapsed'); }
          catch (e2) {}
        }
      });
      // Tapping a sidebar nav link → persist collapsed state for the next page
      document.querySelectorAll('.sidebar a').forEach(a => {
        a.addEventListener('click', () => {
          try { localStorage.setItem('zhengxu-notes-sidebar', 'collapsed'); }
          catch (e) {}
        });
      });
    }
  }

  /* ---------------- on-page TOC scroll-spy ---------------- */

  function initTocScrollSpy() {
    const toc = document.querySelector('.page-toc');
    if (!toc) return;
    const links = Array.from(toc.querySelectorAll('a[href^="#"]'));
    if (!links.length) return;
    const targets = links
      .map(a => ({ a, el: document.getElementById(a.getAttribute('href').slice(1)) }))
      .filter(t => t.el);

    function update() {
      const y = window.scrollY + 80;
      let activeIdx = 0;
      for (let i = 0; i < targets.length; i++) {
        if (targets[i].el.offsetTop <= y) activeIdx = i;
        else break;
      }
      links.forEach(l => l.classList.remove('active'));
      if (targets[activeIdx]) targets[activeIdx].a.classList.add('active');
    }
    window.addEventListener('scroll', update, { passive: true });
    update();
  }

  /* ---------------- init ---------------- */

  function init() {
    // Restore saved theme (if any)
    let saved = null;
    try { saved = localStorage.getItem('zhengxu-notes-theme'); } catch (e) {}
    if (saved) applyTheme(saved);
    else {
      const current = document.body.dataset.theme || 'manuscript';
      applyTheme(current);
    }

    // Wire theme switcher
    const switcher = document.querySelector('.theme-switcher');
    if (switcher) {
      switcher.addEventListener('click', (e) => {
        const btn = e.target.closest('button[data-set-theme]');
        if (btn) applyTheme(btn.dataset.setTheme);
      });
    }

    initSidebarToggle();
    initTocScrollSpy();

    // Inflate viz widgets
    document.querySelectorAll('.viz[data-viz]').forEach(buildViz);

    // Syntax highlight code blocks. highlight.js scans for
    // <pre><code class="language-...">, which is what markdown-it emits.
    if (window.hljs) {
      window.hljs.highlightAll();
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
