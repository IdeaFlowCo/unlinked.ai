// One device preference shared by anonymous and member pages. No account data.
export const APPEARANCE_KEY = 'unlinked.appearance.v1'

// Runs in the head under the response nonce, before any content can paint.
// CSS also follows the system when scripting or storage is unavailable.
export const APPEARANCE_INIT = `(()=>{let mode='system';try{const saved=localStorage.getItem('${APPEARANCE_KEY}');if(saved==='light'||saved==='dark')mode=saved}catch{}document.documentElement.dataset.appearance=mode})();`

export const APPEARANCE_CONTROL = `<details class="appearance"><summary aria-label="Change appearance" title="Appearance" aria-controls="appearance-panel"><svg viewBox="0 0 20 20" width="19" height="19" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><circle cx="10" cy="10" r="7.2"/><path d="M10 2.8a7.2 7.2 0 0 1 0 14.4Z" fill="currentColor" stroke="none"/></svg></summary><div class="appearance-panel" id="appearance-panel"><label for="appearance-mode">Appearance</label><select id="appearance-mode" aria-describedby="appearance-hint"><option value="system">System</option><option value="light">Light</option><option value="dark">Dark</option></select><p id="appearance-hint">Saved on this device. System follows your device’s appearance.</p></div></details>`

export const APPEARANCE_SCRIPT = `(()=>{const root=document.documentElement,menu=document.querySelector('details.appearance'),select=document.getElementById('appearance-mode');if(!menu||!select)return;const summary=menu.querySelector('summary'),valid=value=>value==='light'||value==='dark'?value:'system';const sync=()=>{select.value=valid(root.dataset.appearance)};sync();summary.setAttribute('aria-expanded',String(menu.open));menu.addEventListener('toggle',()=>summary.setAttribute('aria-expanded',String(menu.open)));select.addEventListener('change',()=>{const mode=valid(select.value);root.dataset.appearance=mode;try{if(mode==='system')localStorage.removeItem('${APPEARANCE_KEY}');else localStorage.setItem('${APPEARANCE_KEY}',mode)}catch{}});addEventListener('storage',event=>{if(event.key==='${APPEARANCE_KEY}'||event.key===null){root.dataset.appearance=valid(event.newValue);sync()}});document.addEventListener('click',event=>{if(menu.open&&!menu.contains(event.target))menu.open=false});menu.addEventListener('focusout',event=>{if(menu.open&&event.relatedTarget&&!menu.contains(event.relatedTarget))menu.open=false});menu.addEventListener('keydown',event=>{if(event.key==='Escape'){event.preventDefault();menu.open=false;summary.focus()}})})();`

const LIGHT = `color-scheme:light;--brand:#4349c4;--brand-d:#32379c;--tint:#eceefc;--page:#f5f6fc;--surface:#fff;--surface2:#f2f3f6;--fg:#16181d;--muted:#667085;--secondary:#4a5263;--line:#e6e8ec;--line2:#c4c9d2;--success:#166534;--success-bg:#e8f5eb;--success-line:#39734b;--warning:#a3461b;--warning-bg:#fff7e6;--warning-line:#f0d9a8;--error:#7e3030;--error-bg:#fbeeed;--error-line:#b0413e;--demo:#faf9f5;--demo-line:#e8e4da;--demo-bubble:#efece3;--demo-muted:#5b5648;--r:8px;`
const DARK = `color-scheme:dark;--brand:#5961d6;--brand-d:#b2b9ff;--tint:#282e50;--page:#11141d;--surface:#1b202c;--surface2:#252b39;--fg:#edf0f7;--muted:#a5afc2;--secondary:#c3cad8;--line:#ffffff1a;--line2:#505a70;--success:#8bd5a8;--success-bg:#17382b;--success-line:#3a7754;--warning:#efbe8b;--warning-bg:#372b1c;--warning-line:#795b32;--error:#ffb4b0;--error-bg:#402629;--error-line:#ae615f;--demo:#1e222c;--demo-line:#ffffff1a;--demo-bubble:#2c303c;--demo-muted:#b4b9c6;`
export const APPEARANCE_STYLE = `
:root{${LIGHT}}
:root[data-appearance=dark]{${DARK}}
@media(prefers-color-scheme:dark){:root:not([data-appearance=light]):not([data-appearance=dark]){${DARK}}}
.unlinked-onboarding .appearance{position:relative;flex:none}
.unlinked-onboarding .appearance>summary{display:grid;place-items:center;width:44px;height:44px;list-style:none;cursor:pointer;border-radius:50%;color:var(--muted)}
.unlinked-onboarding .appearance>summary::-webkit-details-marker{display:none}
.unlinked-onboarding .appearance>summary:hover,.unlinked-onboarding .appearance[open]>summary{background:var(--tint);color:var(--brand-d)}
.unlinked-onboarding .appearance>summary:focus-visible{outline:2px solid var(--brand-d);outline-offset:2px}
.unlinked-onboarding .appearance-panel{position:absolute;right:0;top:calc(100% + 8px);z-index:46;width:240px;padding:16px;border:1px solid var(--line2);border-radius:12px;background:var(--surface);color:var(--fg);box-shadow:0 8px 24px #0002;font-size:14px}
.unlinked-onboarding .appearance:not([open]) .appearance-panel{display:none}
.unlinked-onboarding .appearance-panel label{display:block;margin:0 0 8px;font-size:14px;font-weight:600}
.unlinked-onboarding .appearance-panel select{width:100%;min-height:44px;padding:8px 12px;border:1px solid var(--line2);border-radius:var(--r);background:var(--page);color:var(--fg);font:inherit;cursor:pointer}
.unlinked-onboarding .appearance-panel select:focus-visible{outline:2px solid var(--brand-d);outline-offset:2px}
.unlinked-onboarding .appearance-panel p{margin:10px 0 0;font-size:12px;line-height:1.5;color:var(--muted)}
@media(max-width:600px){.unlinked-onboarding header>.appearance{order:1;margin-left:auto}.unlinked-onboarding header>nav{order:2;width:100%;margin-left:0}.unlinked-onboarding .appearance-panel{width:min(240px,calc(100vw - 40px))}}
`
