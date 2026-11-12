// Runs only on the private list page, under the existing controller CSP nonce.
// History stores opaque page URLs and scroll position, never member contents.
export function enhancePrivateList(win = window) {
  const doc = win.document, root = doc.querySelector('[data-private-list]');
  if (!root) return;
  const rows = root.querySelector('[data-list-members]'), link = root.querySelector('[data-load-members]'), status = root.querySelector('[data-member-status]');
  if (!rows || !link || !status) return;
  const listPath = win.location.pathname;
  let busy = false, pages = [], next = link.getAttribute('href');
  const seen = new Set([...rows.children].map(el => el.dataset.memberId));
  const visited = new Set([win.location.href]);
  const safeUrl = value => { const url = new URL(value, win.location.href); if (url.origin !== win.location.origin || url.pathname !== listPath || (url.searchParams.get('view') || 'list') !== (root.dataset.listView || 'list') || [...url.searchParams.keys()].some(key => !['after', 'view'].includes(key))) throw Error(); return url.href; };
  const save = () => { try { win.history.replaceState({ ...win.history.state, privateList: { path: listPath, pages, scroll: win.scrollY } }, ''); } catch {} };
  async function load(restore = false) {
    if (busy || !next) return false;
    busy = true; rows.setAttribute('aria-busy', 'true'); link.setAttribute('aria-disabled', 'true'); status.textContent = 'Loading more members…';
    try {
      const target = safeUrl(next);
      if (visited.has(target)) throw Error();
      const response = await win.fetch(target, { credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'text/html' } });
      if (!response.ok || response.redirected || safeUrl(response.url) !== target) throw Error();
      const page = new win.DOMParser().parseFromString(await response.text(), 'text/html');
      const incoming = page.querySelector('[data-private-list]');
      if (!incoming || incoming.dataset.privateList !== root.dataset.privateList || incoming.dataset.listView !== root.dataset.listView) throw Error();
      const batch = incoming.querySelector('[data-list-members]');
      if (!batch) throw Error();
      const candidates = [...batch.children];
      if (candidates.length > 50 || candidates.some(el => !el.dataset.memberId)) throw Error();
      const following = incoming.querySelector('[data-load-members]')?.getAttribute('href');
      if (following && (safeUrl(following) === target || visited.has(safeUrl(following)))) throw Error();
      let added = 0, first;
      for (const el of candidates) if (!seen.has(el.dataset.memberId)) {
        seen.add(el.dataset.memberId); const row = doc.importNode(el, true); rows.append(row); first ||= row; added++;
      }
      visited.add(target); pages.push(target); next = following || null;
      status.textContent = `${added} more members loaded. ${seen.size} shown.${next ? '' : ' End of list.'}`;
      if (next) link.setAttribute('href', next); else { link.hidden = true; }
      if (rows.children.length) root.querySelector('[data-members-empty]')?.setAttribute('hidden', '');
      if (!restore && !first) { status.tabIndex = -1; status.focus(); }
      if (!restore && first) { const focus = first.querySelector('a') || first; if (!focus.hasAttribute('tabindex')) focus.tabIndex = -1; focus.focus({ preventScroll: true }); }
      if (!restore) save();
      return true;
    } catch { status.textContent = 'More members could not be loaded. Try Load more again, or open the next page.'; return false; }
    finally { busy = false; rows.removeAttribute('aria-busy'); link.removeAttribute('aria-disabled'); }
  }
  link.addEventListener('click', event => { if (event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return; event.preventDefault(); void load(); });
  win.addEventListener('pagehide', save);
  const saved = win.history.state?.privateList;
  if (saved?.path === listPath && Array.isArray(saved.pages) && saved.pages.length <= 100) {
    void (async () => { for (const target of saved.pages) { if (!next || safeUrl(next) !== target || !await load(true)) break; } win.requestAnimationFrame(() => win.scrollTo(0, Number.isFinite(saved.scroll) ? saved.scroll : 0)); })();
  }
}
export const PRIVATE_LIST_LOADING_SCRIPT = `;(${enhancePrivateList.toString()})();`;
