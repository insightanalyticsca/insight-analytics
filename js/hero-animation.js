/**
 * Insight Analytics — Hero Node-Network Animation
 * Animated canvas background: 50 nodes, glowing connections, gradient lines.
 * Respects prefers-reduced-motion. Pauses when tab hidden or hero off-screen.
 */
(function () {
  "use strict";

  const canvas = document.getElementById("hero-canvas");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");

  const prefersReducedMotion = window.matchMedia(
    "(prefers-reduced-motion: reduce)"
  ).matches;

  // Config — tuned for an elegant enterprise feel
  const CONFIG = {
    nodeCount: 50,
    maxLinkDistance: 180,
    baseSpeed: 0.22,
    glow: 20,
    lineOpacity: 0.5,
    nodeRadiusMin: 1.4,
    nodeRadiusMax: 3.2,
    linkColorA: { r: 99, g: 102, b: 241 }, // indigo #6366F1
    linkColorB: { r: 6, g: 182, b: 212 }, // cyan #06B6D4
    nodeColor: { r: 99, g: 102, b: 241 },
    pointerRadius: 220,
  };

  let width = 0;
  let height = 0;
  let dpr = 1;
  let nodes = [];
  let pointer = { x: -9999, y: -9999, active: false };
  let rafId = null;
  let running = false;

  function rand(min, max) {
    return Math.random() * (max - min) + min;
  }

  function resize() {
    const rect = canvas.getBoundingClientRect();
    width = rect.width;
    height = rect.height;
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.floor(width * dpr);
    canvas.height = Math.floor(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    initNodes();
  }

  function initNodes() {
    nodes = [];
    for (let i = 0; i < CONFIG.nodeCount; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = rand(CONFIG.baseSpeed * 0.4, CONFIG.baseSpeed);
      nodes.push({
        x: Math.random() * width,
        y: Math.random() * height,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        r: rand(CONFIG.nodeRadiusMin, CONFIG.nodeRadiusMax),
        phase: Math.random() * Math.PI * 2,
      });
    }
  }

  function step(dt) {
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      n.x += n.vx * dt;
      n.y += n.vy * dt;
      n.phase += 0.02 * dt;

      // Soft boundary bounce
      if (n.x < -20) n.x = width + 20;
      else if (n.x > width + 20) n.x = -20;
      if (n.y < -20) n.y = height + 20;
      else if (n.y > height + 20) n.y = -20;

      // Pointer influence — gentle attraction
      if (pointer.active) {
        const dx = pointer.x - n.x;
        const dy = pointer.y - n.y;
        const dist = Math.hypot(dx, dy);
        if (dist < CONFIG.pointerRadius && dist > 0.001) {
          const force = (1 - dist / CONFIG.pointerRadius) * 0.06;
          n.vx += (dx / dist) * force;
          n.vy += (dy / dist) * force;
        }
      }

      // Clamp velocity to keep motion calm
      const v = Math.hypot(n.vx, n.vy);
      const maxV = CONFIG.baseSpeed * 1.8;
      if (v > maxV) {
        n.vx = (n.vx / v) * maxV;
        n.vy = (n.vy / v) * maxV;
      }
    }
  }

  function drawLinks() {
    const max = CONFIG.maxLinkDistance;
    for (let i = 0; i < nodes.length; i++) {
      const a = nodes[i];
      for (let j = i + 1; j < nodes.length; j++) {
        const b = nodes[j];
        const dx = a.x - b.x;
        const dy = a.y - b.y;
        const dist = Math.hypot(dx, dy);
        if (dist >= max) continue;

        const t = 1 - dist / max;
        const alpha = t * CONFIG.lineOpacity;

        // Gradient between indigo and cyan along the link
        const grad = ctx.createLinearGradient(a.x, a.y, b.x, b.y);
        const ca = CONFIG.linkColorA;
        const cb = CONFIG.linkColorB;
        grad.addColorStop(
          0,
          `rgba(${ca.r}, ${ca.g}, ${ca.b}, ${alpha.toFixed(3)})`
        );
        grad.addColorStop(
          1,
          `rgba(${cb.r}, ${cb.g}, ${cb.b}, ${alpha.toFixed(3)})`
        );
        ctx.strokeStyle = grad;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }
    }
  }

  function drawNodes() {
    const c = CONFIG.nodeColor;
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      const pulse = 0.7 + 0.3 * Math.sin(n.phase);
      ctx.shadowBlur = CONFIG.glow;
      ctx.shadowColor = `rgba(${c.r}, ${c.g}, ${c.b}, ${(0.5 * pulse).toFixed(
        3
      )})`;
      ctx.fillStyle = `rgba(${c.r}, ${c.g}, ${c.b}, ${(0.65 * pulse).toFixed(
        3
      )})`;
      ctx.beginPath();
      ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.shadowBlur = 0;
  }

  let last = performance.now();
  function loop(now) {
    if (!running) return;
    const dt = Math.min((now - last) / 16.6667, 3); // normalize to ~60fps frames
    last = now;
    ctx.clearRect(0, 0, width, height);
    step(dt);
    drawLinks();
    drawNodes();
    rafId = requestAnimationFrame(loop);
  }

  function start() {
    if (running || prefersReducedMotion) return;
    running = true;
    last = performance.now();
    rafId = requestAnimationFrame(loop);
  }

  function stop() {
    running = false;
    if (rafId) cancelAnimationFrame(rafId);
    rafId = null;
    ctx.clearRect(0, 0, width, height);
  }

  function onVisibility() {
    if (document.hidden) stop();
    else start();
  }

  // Pointer handlers
  window.addEventListener("pointermove", function (e) {
    const rect = canvas.getBoundingClientRect();
    pointer.x = e.clientX - rect.left;
    pointer.y = e.clientY - rect.top;
    pointer.active = true;
  });
  window.addEventListener("pointerleave", function () {
    pointer.active = false;
    pointer.x = -9999;
    pointer.y = -9999;
  });

  // Pause when hero is off-screen
  const heroEl = document.querySelector(".hero");
  if (heroEl && "IntersectionObserver" in window) {
    const io = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) start();
          else stop();
        });
      },
      { threshold: 0.05 }
    );
    io.observe(heroEl);
  } else {
    start();
  }

  document.addEventListener("visibilitychange", onVisibility);

  let resizeTimer;
  window.addEventListener("resize", function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(resize, 120);
  });

  // Initial size
  resize();
})();
