/**
 * theme-toggle.js — Shared theme toggle for all Insight Analytics pages
 * - Rotating sun/moon icon with "Light"/"Dark" text label
 * - Persists to localStorage ("ia-theme")
 * - Works on all pages (index, blog, insights, auto-generated articles)
 */
(function () {
  'use strict';
  var KEY = 'ia-theme';
  var root = document.documentElement;
  var btn = document.getElementById('theme-toggle');
  var icon = document.getElementById('theme-icon');
  var label = document.getElementById('theme-label');

  function get() {
    try {
      var s = localStorage.getItem(KEY);
      if (s === 'light' || s === 'dark') return s;
    } catch (e) {}
    try {
      return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    } catch (e) { return 'light'; }
  }

  function apply(theme) {
    root.setAttribute('data-theme', theme);
    root.style.colorScheme = theme;
    if (icon) icon.className = theme === 'dark' ? 'fas fa-moon' : 'fas fa-sun';
    if (label) label.textContent = theme === 'dark' ? 'Dark' : 'Light';
  }

  function toggle() {
    var next = (root.getAttribute('data-theme') || get()) === 'dark' ? 'light' : 'dark';
    try { localStorage.setItem(KEY, next); } catch (e) {}
    apply(next);
  }

  // Apply on load
  apply(get());
  if (btn) btn.addEventListener('click', toggle);

  // Listen for cross-frame theme broadcasts (from dashboards iframe)
  window.addEventListener('message', function (e) {
    if (e.data && e.data.type === 'csr-dashboard-theme:apply') {
      apply(e.data.theme === 'dark' ? 'dark' : 'light');
    }
  });
})();
