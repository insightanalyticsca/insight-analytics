/**
 * Insight Analytics — app.js
 * Theme toggle, scroll-reveal animations, smooth nav, form handler,
 * mobile dashboard placeholder toggle, sticky nav state.
 */
(function () {
  "use strict";

  /* ------------------------------------------------------------------
   * Theme toggle (light/dark) — persists to localStorage
   * ------------------------------------------------------------------ */
  const THEME_KEY = "ia-theme";
  const root = document.documentElement;
  const themeToggle = document.getElementById("theme-toggle");
  const themeIcon = document.getElementById("theme-icon");
  const themeLabel = document.getElementById("theme-label");

  function getPreferredTheme() {
    const stored = localStorage.getItem(THEME_KEY);
    if (stored === "light" || stored === "dark") return stored;
    return window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
  }

  function applyTheme(theme) {
    root.setAttribute("data-theme", theme);
    if (themeIcon) {
      themeIcon.className = theme === "dark" ? "fas fa-moon" : "fas fa-sun";
    }
    if (themeLabel) {
      themeLabel.textContent = theme === "dark" ? "Dark" : "Light";
    }
  }

  function toggleTheme() {
    const current = root.getAttribute("data-theme") || getPreferredTheme();
    const next = current === "dark" ? "light" : "dark";
    localStorage.setItem(THEME_KEY, next);
    applyTheme(next);
  }

  // Apply theme as early as possible to avoid flash
  applyTheme(getPreferredTheme());

  if (themeToggle) {
    themeToggle.addEventListener("click", toggleTheme);
    themeToggle.addEventListener("keydown", function (e) {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        toggleTheme();
      }
    });
  }

  /* ------------------------------------------------------------------
   * Sticky nav — add shadow / condense on scroll
   * ------------------------------------------------------------------ */
  const nav = document.querySelector(".navbar");
  let lastScrollY = 0;
  function onNavScroll() {
    const y = window.scrollY || window.pageYOffset;
    if (nav) {
      if (y > 8) nav.classList.add("is-scrolled");
      else nav.classList.remove("is-scrolled");
    }
    lastScrollY = y;
  }
  window.addEventListener("scroll", onNavScroll, { passive: true });
  onNavScroll();

  /* ------------------------------------------------------------------
   * Smooth scroll for in-page anchors
   * ------------------------------------------------------------------ */
  document.querySelectorAll('a[href^="#"]').forEach(function (link) {
    link.addEventListener("click", function (e) {
      const href = link.getAttribute("href");
      if (!href || href === "#" || href.length < 2) return;
      const target = document.querySelector(href);
      if (!target) return;
      e.preventDefault();
      const navHeight = nav ? nav.offsetHeight : 0;
      const top =
        target.getBoundingClientRect().top + window.scrollY - navHeight - 12;
      window.scrollTo({ top: top, behavior: "smooth" });
      // Close mobile menu if open
      closeMobileMenu();
    });
  });

  /* ------------------------------------------------------------------
   * Mobile nav menu
   * ------------------------------------------------------------------ */
  const menuToggle = document.getElementById("menu-toggle");
  const mobileMenu = document.getElementById("mobile-menu");
  const menuIcon = document.getElementById("menu-icon");

  function openMobileMenu() {
    if (!mobileMenu) return;
    mobileMenu.classList.add("is-open");
    if (menuIcon) menuIcon.className = "fas fa-times";
    document.body.style.overflow = "hidden";
  }
  function closeMobileMenu() {
    if (!mobileMenu) return;
    mobileMenu.classList.remove("is-open");
    if (menuIcon) menuIcon.className = "fas fa-bars";
    document.body.style.overflow = "";
  }
  function toggleMobileMenu() {
    if (!mobileMenu) return;
    if (mobileMenu.classList.contains("is-open")) closeMobileMenu();
    else openMobileMenu();
  }
  if (menuToggle) menuToggle.addEventListener("click", toggleMobileMenu);

  /* ------------------------------------------------------------------
   * Scroll-reveal animations (IntersectionObserver)
   * ------------------------------------------------------------------ */
  const revealEls = document.querySelectorAll(".reveal");
  if ("IntersectionObserver" in window && revealEls.length) {
    const io = new IntersectionObserver(
      function (entries, observer) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) {
            entry.target.classList.add("is-visible");
            observer.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.12, rootMargin: "0px 0px -8% 0px" }
    );
    revealEls.forEach(function (el) {
      io.observe(el);
    });
  } else {
    revealEls.forEach(function (el) {
      el.classList.add("is-visible");
    });
  }

  // Staggered children reveal — when a container enters, stagger its children
  const staggerContainers = document.querySelectorAll("[data-stagger]");
  if ("IntersectionObserver" in window && staggerContainers.length) {
    const sio = new IntersectionObserver(
      function (entries, observer) {
        entries.forEach(function (entry) {
          if (!entry.isIntersecting) return;
          const items = entry.target.querySelectorAll("[data-stagger-item]");
          items.forEach(function (item, idx) {
            const delay = item.getAttribute("data-stagger-delay");
            const ms = delay ? parseInt(delay, 10) : idx * 80;
            item.style.transitionDelay = ms + "ms";
            item.classList.add("is-visible");
          });
          observer.unobserve(entry.target);
        });
      },
      { threshold: 0.15 }
    );
    staggerContainers.forEach(function (el) {
      sio.observe(el);
    });
  }

  /* ------------------------------------------------------------------
   * Active nav link highlighting via section observation
   * Covers .nav-link (primary nav) and .meta-link (hero meta pills)
   * ------------------------------------------------------------------ */
  const sections = document.querySelectorAll("section[id]");
  const navLinks = document.querySelectorAll('.nav-link[data-nav], .meta-link[data-nav]');
  if ("IntersectionObserver" in window && sections.length && navLinks.length) {
    const nio = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) {
            const id = entry.target.getAttribute("id");
            navLinks.forEach(function (link) {
              link.classList.toggle(
                "is-active",
                link.getAttribute("data-nav") === id
              );
            });
          }
        });
      },
      { rootMargin: "-45% 0px -50% 0px" }
    );
    sections.forEach(function (s) {
      nio.observe(s);
    });
  }

  /* ------------------------------------------------------------------
   * Dashboard showcase — image-based switcher (no iframe, no SW issues)
   *
   * The dashboard preview is now a static PNG screenshot of the live
   * dashboard, rendered headlessly and saved under
   * /dashboards-preview/screenshots/. This bypasses every iOS Safari/PWA
   * iframe loading issue — images always load.
   *
   * Each switcher tab carries:
   *   data-img       → path to the screenshot PNG (swapped into <img>)
   *   data-live      → URL of the live interactive dashboard (opens in new tab)
   *   data-url-text  → masked URL shown in the browser chrome bar
   * ------------------------------------------------------------------ */
  const showcaseImg = document.getElementById("dashboard-img");
  const showcaseSection = document.getElementById("dashboard");
  const fallbackLink = document.getElementById("browserFallback");
  const urlText = document.getElementById("browser-url-text");
  const switcher = document.getElementById("dashboardSwitcher");

  if (switcher && showcaseImg) {
    switcher.addEventListener("click", function (e) {
      const tab = e.target.closest(".dash-tab");
      if (!tab) return;

      // Already active — no-op
      if (tab.classList.contains("is-active")) return;

      const newImg = tab.getAttribute("data-img");
      const newLive = tab.getAttribute("data-live");
      const newUrlText = tab.getAttribute("data-url-text");
      if (!newImg) return;

      // Update active tab styling
      switcher.querySelectorAll(".dash-tab").forEach(function (t) {
        t.classList.remove("is-active");
        t.setAttribute("aria-selected", "false");
      });
      tab.classList.add("is-active");
      tab.setAttribute("aria-selected", "true");

      // Swap the screenshot (cache-bust so the browser doesn't show a stale
      // version after we redeploy)
      const cacheBust = newImg + (newImg.indexOf("?") >= 0 ? "&" : "?") + "v=20261005";
      showcaseImg.src = cacheBust;
      showcaseImg.setAttribute("data-dash", tab.getAttribute("data-dash"));

      // Update the masked URL in the browser chrome bar
      if (urlText && newUrlText) urlText.textContent = newUrlText;

      // Update the "Open live dashboard" CTA to point at the new dashboard
      if (fallbackLink && newLive) fallbackLink.setAttribute("href", newLive);
    });
  }

  /* ------------------------------------------------------------------
   * Browser mock maximize / restore — expand iframe to full screen
   * ------------------------------------------------------------------ */
  const browserMock = document.getElementById("browserMock");
  const maximizeBtn = document.getElementById("browserMaximize");

  // Create backdrop element
  const backdrop = document.createElement("div");
  backdrop.className = "browser-backdrop";
  document.body.appendChild(backdrop);

  if (browserMock && maximizeBtn) {
    maximizeBtn.addEventListener("click", function () {
      const isMax = browserMock.classList.toggle("is-maximized");
      backdrop.classList.toggle("is-visible", isMax);
      maximizeBtn.setAttribute("aria-label", isMax ? "Restore dashboard" : "Maximize to full screen");
      maximizeBtn.title = isMax ? "Restore" : "Maximize to full screen";
      document.body.style.overflow = isMax ? "hidden" : "";
    });
  }

  // Click backdrop to restore
  backdrop.addEventListener("click", function () {
    if (browserMock) browserMock.classList.remove("is-maximized");
    backdrop.classList.remove("is-visible");
    if (maximizeBtn) {
      maximizeBtn.setAttribute("aria-label", "Maximize to full screen");
      maximizeBtn.title = "Maximize to full screen";
    }
    document.body.style.overflow = "";
  });

  // ESC to restore
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && browserMock && browserMock.classList.contains("is-maximized")) {
      browserMock.classList.remove("is-maximized");
      backdrop.classList.remove("is-visible");
      if (maximizeBtn) {
        maximizeBtn.setAttribute("aria-label", "Maximize to full screen");
        maximizeBtn.title = "Maximize to full screen";
      }
      document.body.style.overflow = "";
    }
  });

  /* ------------------------------------------------------------------
   * Contact form handler
   * Tries the Netlify Edge Function /send-email endpoint first (delivers a
   * polished HTML email via Resend). Falls back to a polished plain-text
   * mailto: if the endpoint returns 503 (service not configured) or any
   * network error. Either way, the lead reaches dev@insight-analytics.ca.
   * ------------------------------------------------------------------ */
  const form = document.getElementById("contact-form");
  const formStatus = document.getElementById("form-status");
  const submitBtn = document.getElementById("contact-submit");
  const contactEmail = "dev@insight-analytics.ca";
  const SEND_EMAIL_ENDPOINT = "https://startling-belekoy-b0ec70.netlify.app/send-email";

  function setStatus(msg, kind) {
    if (!formStatus) return;
    formStatus.textContent = msg;
    formStatus.className = "form-status " + (kind || "");
    formStatus.setAttribute("role", kind === "error" ? "alert" : "status");
  }

  if (form) {
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      const data = new FormData(form);
      const name = (data.get("name") || "").toString().trim();
      const email = (data.get("email") || "").toString().trim();
      const company = (data.get("company") || "").toString().trim();
      const message = (data.get("message") || "").toString().trim();

      const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!name || !email || !message) {
        setStatus("Please complete the required fields.", "error");
        return;
      }
      if (!emailRe.test(email)) {
        setStatus("Please enter a valid email address.", "error");
        return;
      }

      // Visually simulate processing
      if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.classList.add("is-loading");
        submitBtn.setAttribute("aria-busy", "true");
      }
      setStatus("Sending your request…", "");

      // Build a polished plain-text mailto: fallback (used if endpoint fails)
      const frame = "══════════════════════════════════════════════";
      const rule  = "─────────────────────────────────────────────";
      const indentedMessage = message.replace(/\n/g, "\n   ");
      const subjectFallback = "Demo Request  ·  " + name + (company ? "  —  " + company : "");
      const bodyFallback = encodeURIComponent(
        frame + "\n" +
        "  INSIGHT ANALYTICS   ·   DEMO REQUEST\n" +
        frame + "\n\n" +
        "Hello,\n\n" +
        "I'd like to schedule a working session with Insight Analytics to explore what unified reporting and AI-assisted insight could look like for our team.\n\n" +
        "— WHO " + rule.slice(0, rule.length - 6) + "\n" +
        "   Name      " + name + "\n" +
        "   Email     " + email + "\n" +
        "   Company   " + (company || "—") + "\n\n" +
        "— MESSAGE " + rule.slice(0, rule.length - 10) + "\n" +
        "   " + indentedMessage + "\n\n" +
        "Looking forward to your reply.\n\n" +
        "— " + name + "\n" +
        frame + "\n" +
        "  Sent via  insightanalyticsca.github.io/insight-analytics/\n" +
        frame
      );
      const mailtoFallback = "mailto:" + contactEmail + "?subject=" + encodeURIComponent(subjectFallback) + "&body=" + bodyFallback;

      // Try the HTML-email endpoint first
      (async function () {
        try {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 12000); // 12s timeout
          const res = await fetch(SEND_EMAIL_ENDPOINT, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name, email, company, message }),
            signal: controller.signal
          });
          clearTimeout(timeout);

          if (res.ok) {
            // HTML email sent successfully — no email client opens
            if (submitBtn) {
              submitBtn.disabled = false;
              submitBtn.classList.remove("is-loading");
              submitBtn.removeAttribute("aria-busy");
            }
            form.reset();
            setStatus(
              "Thank you. Your request has been sent to dev@insight-analytics.ca as a branded HTML email. We'll reply within one business day — or call (289) 635-9915 directly.",
              "success"
            );
            return;
          }

          if (res.status === 429) {
            // Rate limited — don't fall back to mailto, just tell them
            if (submitBtn) {
              submitBtn.disabled = false;
              submitBtn.classList.remove("is-loading");
              submitBtn.removeAttribute("aria-busy");
            }
            setStatus("You've sent several requests recently. Please wait an hour and try again, or call (289) 635-9915.", "error");
            return;
          }

          // Endpoint returned non-OK (503 = not configured, 400 = validation,
          // 502 = email service error) — fall back to mailto:
          throw new Error("Endpoint returned " + res.status);
        } catch (err) {
          // Network / timeout / 503 / other — fall back to mailto: with the
          // polished plain-text version. Either way the lead gets through.
          if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.classList.remove("is-loading");
            submitBtn.removeAttribute("aria-busy");
          }
          form.reset();
          setStatus(
            "Your email client is opening with a pre-filled, branded request to dev@insight-analytics.ca — send it to deliver. Or call (289) 635-9915 directly.",
            "success"
          );
          window.location.href = mailtoFallback;
        }
      })();
    });
  }

  /* ------------------------------------------------------------------
   * Animated counter for stat numbers (when visible)
   * ------------------------------------------------------------------ */
  const counters = document.querySelectorAll("[data-count]");
  if ("IntersectionObserver" in window && counters.length) {
    const cio = new IntersectionObserver(
      function (entries, observer) {
        entries.forEach(function (entry) {
          if (!entry.isIntersecting) return;
          const el = entry.target;
          const target = parseFloat(el.getAttribute("data-count"));
          const suffix = el.getAttribute("data-suffix") || "";
          const dur = 1400;
          const start = performance.now();
          function tick(now) {
            const p = Math.min((now - start) / dur, 1);
            const eased = 1 - Math.pow(1 - p, 3);
            const val = target * eased;
            el.textContent = (target % 1 === 0 ? Math.round(val) : val.toFixed(1)) + suffix;
            if (p < 1) requestAnimationFrame(tick);
            else el.textContent = target + suffix;
          }
          requestAnimationFrame(tick);
          observer.unobserve(el);
        });
      },
      { threshold: 0.5 }
    );
    counters.forEach(function (c) {
      cio.observe(c);
    });
  }

  /* ------------------------------------------------------------------
   * Section-by-section keyboard navigation
   * PageDown / Space / ArrowDown → jump to next section start
   * PageUp / Shift+Space / ArrowUp → jump to previous section start
   * Home → jump to top, End → jump to bottom
   *
   * This pairs with CSS scroll-snap-type: y mandatory — the snap handles
   * mouse wheel + touch + the residual snap after PageDown, while this
   * handler guarantees that PageDown ALWAYS advances exactly one section,
   * even when the current section is taller than the viewport.
   * ------------------------------------------------------------------ */
  const NAV_OFFSET = 80; // px — offset for the fixed navbar so titles aren't hidden
  const SNAP_TARGETS = function () {
    return Array.prototype.slice.call(
      document.querySelectorAll("section[id], main > section, footer")
    );
  };

  function currentSectionIndex() {
    const targets = SNAP_TARGETS();
    if (!targets.length) return -1;
    const viewTop = window.scrollY || document.documentElement.scrollTop;
    const viewMid = viewTop + window.innerHeight / 2;
    // Find the section whose vertical range contains the viewport midpoint.
    // If the midpoint is below the last section (e.g. footer), return last.
    let idx = 0;
    for (let i = 0; i < targets.length; i++) {
      const t = targets[i];
      const top = t.offsetTop;
      const bottom = top + t.offsetHeight;
      if (viewMid >= top && viewMid < bottom) {
        idx = i;
        break;
      }
      if (viewMid >= bottom) idx = i;
    }
    return idx;
  }

  function snapTo(target) {
    if (!target) return;
    const top = target.getBoundingClientRect().top + (window.scrollY || document.documentElement.scrollTop) - NAV_OFFSET;
    window.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
  }

  function nextSection() {
    const targets = SNAP_TARGETS();
    const idx = currentSectionIndex();
    if (idx < 0) return;
    const next = targets[idx + 1];
    if (next) snapTo(next);
  }

  function prevSection() {
    const targets = SNAP_TARGETS();
    const idx = currentSectionIndex();
    if (idx <= 0) {
      // Already at top — snap to first section
      snapTo(targets[0]);
      return;
    }
    snapTo(targets[idx - 1]);
  }

  // Skip keyboard nav for reduced-motion users — they get default browser
  // behavior (Page Down scrolls one viewport, no snap, no JS interference).
  // The CSS prefers-reduced-motion block also disables scroll-snap entirely.
  const prefersReducedMotionKbd = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (!prefersReducedMotionKbd) {
    document.addEventListener("keydown", function (e) {
      // Don't hijack keyboard when the user is typing in a form field or
      // using a screen reader (let the AT handle the keys natively)
      const tag = (e.target && e.target.tagName) ? e.target.tagName.toLowerCase() : "";
      if (tag === "input" || tag === "textarea" || tag === "select" || e.target.isContentEditable) {
        return;
      }
      // Also skip when any modifier except Shift is held (Ctrl/Cmd/Alt — let browser handle)
      if (e.ctrlKey || e.metaKey || e.altKey) return;

      const key = e.key;
      if (key === "PageDown" || (key === " " && !e.shiftKey) || key === "ArrowDown") {
        e.preventDefault();
        nextSection();
      } else if (key === "PageUp" || (key === " " && e.shiftKey) || key === "ArrowUp") {
        e.preventDefault();
        prevSection();
      } else if (key === "Home") {
        e.preventDefault();
        window.scrollTo({ top: 0, behavior: "smooth" });
      } else if (key === "End") {
        e.preventDefault();
        const targets = SNAP_TARGETS();
        const last = targets[targets.length - 1];
        if (last) snapTo(last);
      }
    });
  }

  /* ------------------------------------------------------------------
   * Footer year
   * ------------------------------------------------------------------ */
  const yearEl = document.getElementById("year");
  if (yearEl) yearEl.textContent = new Date().getFullYear();
})();
