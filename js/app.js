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
   * ------------------------------------------------------------------ */
  const sections = document.querySelectorAll("section[id]");
  const navLinks = document.querySelectorAll('.nav-link[data-nav]');
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
   * Live dashboard showcase — mobile placeholder toggle
   * On small screens we hide the iframe and show a placeholder card
   * with a "View Dashboard" button. The button opens the live URL.
   * ------------------------------------------------------------------ */
  const dashboardUrl =
    "https://insightanalyticsca.github.io/dashboards/custom-html/executive-chatters-portfolio.html";
  const mobileViewBtn = document.getElementById("mobile-view-dashboard");
  if (mobileViewBtn) {
    mobileViewBtn.addEventListener("click", function () {
      window.open(dashboardUrl, "_blank", "noopener,noreferrer");
    });
  }

  // Optionally lazy-load the iframe only when the showcase section is near viewport
  const showcaseFrame = document.getElementById("dashboard-iframe");
  const showcaseSection = document.getElementById("dashboard");
  if (
    showcaseFrame &&
    showcaseSection &&
    "IntersectionObserver" in window &&
    window.innerWidth >= 768
  ) {
    const src = showcaseFrame.getAttribute("data-src");
    if (src) showcaseFrame.removeAttribute("src");
    const fio = new IntersectionObserver(
      function (entries, observer) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting && src) {
            showcaseFrame.setAttribute("src", src);
            observer.unobserve(showcaseSection);
          }
        });
      },
      { rootMargin: "200px 0px 200px 0px" }
    );
    fio.observe(showcaseSection);
  }

  // Hide the browser loading overlay once the iframe reports it is loaded.
  const loadingOverlay = document.getElementById("browser-loading");
  if (showcaseFrame && loadingOverlay) {
    function hideLoading() {
      loadingOverlay.style.opacity = "0";
      loadingOverlay.style.transition = "opacity 0.4s ease";
      setTimeout(function () {
        loadingOverlay.style.display = "none";
      }, 420);
    }
    showcaseFrame.addEventListener("load", hideLoading);
    showcaseFrame.addEventListener("error", hideLoading);
    // Safety net — never leave a stuck spinner
    setTimeout(hideLoading, 8000);
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
   * Contact form handler (client-side validation + feedback)
   * NOTE: static site — no backend. We simulate submission and offer
   * a mailto fallback so the lead still reaches the inbox.
   * ------------------------------------------------------------------ */
  const form = document.getElementById("contact-form");
  const formStatus = document.getElementById("form-status");
  const submitBtn = document.getElementById("contact-submit");
  const contactEmail = "sergey.gurov@insight-analytics.ca";

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
      setStatus("Preparing your message…", "");

      // Build a mailto fallback — guarantees delivery on a static host
      const subject = encodeURIComponent(
        "Demo Request — " + name + (company ? " (" + company + ")" : "")
      );
      const body = encodeURIComponent(
        "Name: " +
          name +
          "\nEmail: " +
          email +
          "\nCompany: " +
          (company || "—") +
          "\n\nMessage:\n" +
          message
      );
      const mailto = "mailto:" + contactEmail + "?subject=" + subject + "&body=" + body;

      setTimeout(function () {
        // Reset button state
        if (submitBtn) {
          submitBtn.disabled = false;
          submitBtn.classList.remove("is-loading");
          submitBtn.removeAttribute("aria-busy");
        }
        form.reset();
        setStatus(
          "Thank you. Opening your email client to deliver the request — or call (289) 635-9915 directly.",
          "success"
        );
        // Trigger mailto in a new attempt
        window.location.href = mailto;
      }, 900);
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
   * Footer year
   * ------------------------------------------------------------------ */
  const yearEl = document.getElementById("year");
  if (yearEl) yearEl.textContent = new Date().getFullYear();
})();
