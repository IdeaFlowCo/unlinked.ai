/* app-stamp.js: "v1.4.2 · Updated 5m ago" for any page. No dependencies, no network
 * beyond one same-origin fetch of version.json. Spec: APP-PRINCIPLES.md §1.
 *
 *   <span data-app-stamp></span>                          reads ./version.json
 *   <span data-app-stamp data-src="/app/version.json"></span>
 *   <span data-app-stamp data-show="time"></span>         content pages: "Updated 5m ago" with no version
 *   <span data-app-stamp data-version="1.4.2" data-commit="ebca55c"
 *         data-time="2026-11-15T09:37:12Z" data-repo="tmad4000/breathe"></span>   build-injected
 *
 * version.json: { "version", "commit", "commitTime", "buildTime", "event": "commit" | "build" }
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AppStamp = api;
  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', api.mountAll);
    else api.mountAll();
  }
})(typeof globalThis === 'object' ? globalThis : this, function () {
  var ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;

  // Returns { label, detail, datetime } or null when the time is missing or invalid.
  function format(iso, now, locale, timeZone) {
    if (typeof iso !== 'string' || !ISO.test(iso)) return null;
    var date = new Date(iso), t = date.getTime();
    if (now === undefined) now = Date.now();
    if (!isFinite(t) || !isFinite(now)) return null;
    var zone = timeZone ? { timeZone: timeZone } : {};
    var detail = new Intl.DateTimeFormat(locale, Object.assign({ dateStyle: 'full', timeStyle: 'long' }, zone)).format(date);
    var lang = new Intl.DateTimeFormat(locale).resolvedOptions().locale.toLowerCase();
    var english = lang.indexOf('en') === 0;
    var s = (now - t) / 1000, label;
    var absolute = function () {
      var y = new Intl.DateTimeFormat('en', Object.assign({ year: 'numeric' }, zone));
      var opts = Object.assign({ month: 'short', day: 'numeric' }, zone);
      if (y.format(date) !== y.format(new Date(now))) opts.year = 'numeric';
      return new Intl.DateTimeFormat(locale, opts).format(date);
    };
    if (s < -120) label = absolute();                        // clock skew beyond 2 min: never "in 3m" or a negative age
    else if (s < 60) label = english ? 'just now' : new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }).format(0, 'second');
    else if (s < 604800) {
      var unit = s < 3600 ? 'minute' : s < 86400 ? 'hour' : 'day';
      var n = Math.floor(s / { minute: 60, hour: 3600, day: 86400 }[unit]);
      label = english ? n + unit.charAt(0) + ' ago' : new Intl.RelativeTimeFormat(locale, { style: 'short' }).format(-n, unit);
    } else label = absolute();                               // 7 days or older: "Nov 8", or "Nov 8, 2025" in another year
    return { label: label, detail: detail, datetime: date.toISOString() };
  }

  function render(el, info) {
    var version = info.version && el.dataset.show !== 'time' ? 'v' + String(info.version).replace(/^v/, '') : '';
    var useBuild = info.event === 'build' || !info.commitTime;
    var f = format(useBuild ? info.buildTime : info.commitTime);
    var commit = info.commit ? String(info.commit).slice(0, 7) : '';
    el.textContent = '';
    el.classList.add('app-stamp');
    if (version) el.appendChild(document.createTextNode(version));
    if (!f) return;                                           // version alone; never an invented time
    if (version) el.appendChild(document.createTextNode(' · '));
    var time = document.createElement('time');
    var exact = f.detail + (commit ? ' · commit ' + commit : '') + (useBuild ? ' (build time)' : '');
    time.setAttribute('datetime', f.datetime);
    time.title = exact;
    time.textContent = el.dataset.exact === '1' ? exact : 'Updated ' + f.label;
    el.appendChild(time);
    el.setAttribute('aria-label', (version ? version + ', ' : '') + 'updated ' + exact);
  }

  function mount(el, info) {
    render(el, info);
    if (el.dataset.stampBound) return;
    el.dataset.stampBound = '1';
    el.tabIndex = 0;
    el.setAttribute('role', 'button');
    var toggle = function () { el.dataset.exact = el.dataset.exact === '1' ? '0' : '1'; render(el, info); };
    el.addEventListener('click', toggle);                     // title alone is unreachable by touch and keyboard
    el.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
    var timer = null;
    var start = function () { if (!timer) timer = setInterval(function () { render(el, info); }, 60000); };
    var stop = function () { clearInterval(timer); timer = null; };
    document.addEventListener('visibilitychange', function () { if (document.hidden) stop(); else { render(el, info); start(); } });
    if (!document.hidden) start();
  }

  function mountAll() {
    Array.prototype.forEach.call(document.querySelectorAll('[data-app-stamp]'), function (el) {
      var d = el.dataset;
      if (d.time || d.version) return mount(el, { version: d.version, commit: d.commit, commitTime: d.time, buildTime: d.buildTime, event: d.event });
      fetch(d.src || 'version.json', { cache: 'no-store' })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (info) { if (info && typeof info === 'object') mount(el, info); })
        .catch(function () {});                               // SPA fallbacks answer 200 with HTML; stay silent
    });
  }

  return { format: format, render: render, mount: mount, mountAll: mountAll };
});
