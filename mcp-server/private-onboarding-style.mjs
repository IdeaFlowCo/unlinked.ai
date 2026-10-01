export const ONBOARDING_STYLE = `
/* The server owns h1; visually place it after the shared header without a second title. */
body:has(.unlinked-onboarding){box-sizing:border-box;font:16px/1.55 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#f5f6fc;color:#252747;max-width:1120px;margin:0 auto;padding:24px}
body:has(.unlinked-onboarding)>main{display:flex;flex-direction:column}
body:has(.unlinked-onboarding)>main>h1{order:3;width:100%;max-width:760px;margin:30px auto 0;font-size:clamp(28px,4vw,36px);line-height:1.15;letter-spacing:-.03em;overflow-wrap:anywhere}
body:has(.unlinked-onboarding)>main>a:first-child{display:none}
.unlinked-onboarding{display:contents;--brand:#4349c4;--line:#dddfee;--muted:#5e627b}
.unlinked-onboarding *{box-sizing:border-box}
.unlinked-onboarding header{order:0;display:flex;align-items:center;flex-wrap:wrap;gap:16px;padding-bottom:20px;border-bottom:1px solid var(--line)}
.unlinked-onboarding .logo{text-decoration:none;letter-spacing:-.04em}
.unlinked-onboarding header strong{font-size:21px;color:var(--brand)}
.unlinked-onboarding .header-search{display:flex;align-items:center;gap:8px;flex:1;min-width:240px;max-width:380px;margin-right:auto}
.unlinked-onboarding .header-search input{margin:0;min-width:0;border-radius:24px;font-size:14px}
.unlinked-onboarding .header-search button{padding:10px 14px}
.unlinked-onboarding nav{display:flex;gap:16px;flex-wrap:wrap;align-items:center}
.unlinked-onboarding a{color:var(--brand);text-underline-offset:3px}
.unlinked-onboarding nav a{text-decoration:none;font-size:14px;min-height:44px;display:inline-flex;align-items:center}
.unlinked-onboarding nav a:hover{text-decoration:underline}
.unlinked-onboarding .import-status{order:1;width:100%;max-width:760px;padding:14px 18px;margin:20px auto 0;background:#eceefc;border:1px solid var(--line);border-radius:8px;font-size:14px;overflow-wrap:anywhere}
.unlinked-onboarding .import-status p{margin:6px 0 0}
.unlinked-onboarding .import-status progress{margin:10px 0}
.unlinked-onboarding .account{order:2;width:100%;max-width:760px;margin:14px auto 0;font-size:13px;color:var(--muted);overflow-wrap:anywhere}
.unlinked-onboarding .journey{order:4;width:100%;max-width:760px;margin:14px auto 32px;overflow-wrap:anywhere}
.unlinked-onboarding .sign-out{order:5;width:100%;max-width:760px;margin:0 auto;padding-top:18px;border-top:1px solid var(--line)}
.unlinked-onboarding .lead{font-size:18px;color:var(--muted);margin:0 0 24px}
.unlinked-onboarding .steps{display:flex;gap:10px;flex-wrap:wrap;font-size:13px;color:var(--muted);margin:8px 0 24px}
.unlinked-onboarding .steps b{color:var(--brand)}
.unlinked-onboarding form,.unlinked-onboarding article{padding:0;margin:0;background:none;border:0;border-radius:0}
.unlinked-onboarding .panel{padding:24px;border:1px solid var(--line);border-radius:8px;background:#fff;margin:20px 0}
.unlinked-onboarding .panel>h2:first-child{margin-top:0}
.unlinked-onboarding .file{display:block;padding:28px 22px;border:2px dashed #b9bfdf;border-radius:8px;background:#fff;text-align:center}
.unlinked-onboarding input[type=file]{display:block;width:100%;max-width:100%;margin:18px auto;font:inherit}
.unlinked-onboarding input[type=text],.unlinked-onboarding input[type=search],.unlinked-onboarding textarea{display:block;width:100%;min-width:0;padding:12px 14px;margin-top:7px;border:1px solid #b9bfdf;border-radius:6px;background:#fff;color:#252747;font:inherit}
.unlinked-onboarding input::placeholder{color:var(--muted);opacity:1}
.unlinked-onboarding textarea{resize:vertical;font:13px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;margin:8px 0 14px}
.unlinked-onboarding label{display:block;margin:16px 0;font-size:14px}
.unlinked-onboarding .button,.unlinked-onboarding button{display:inline-flex;min-height:46px;align-items:center;justify-content:center;padding:11px 20px;background:var(--brand);border:1px solid var(--brand);border-radius:6px;color:#fff;text-decoration:none;font:600 15px system-ui;cursor:pointer}
.unlinked-onboarding button:disabled{opacity:.65;cursor:not-allowed}
.unlinked-onboarding .quiet{background:transparent;color:var(--brand)}
.unlinked-onboarding .sign-in-options{display:grid;gap:12px;max-width:400px}
.unlinked-onboarding .small{font-size:13px;color:var(--muted)}
.unlinked-onboarding .actions{display:flex;gap:12px;flex-wrap:wrap;align-items:center;margin:24px 0}
.unlinked-onboarding .notice{padding:14px 18px;background:#eceefc;border:1px solid var(--line);border-radius:6px;margin:16px 0}
.unlinked-onboarding .error{background:#fbeeed;color:#7e3030;border-color:currentColor}
.unlinked-onboarding details{margin:22px 0}
.unlinked-onboarding summary{cursor:pointer;color:var(--brand);min-height:44px;padding:10px 0}
.unlinked-onboarding h2{font-size:22px;line-height:1.25;letter-spacing:-.02em;margin:24px 0 12px}
.unlinked-onboarding h3{font-size:17px;margin:0 0 5px}
.unlinked-onboarding .person{display:flex;gap:14px;padding:16px 0;border-bottom:1px solid var(--line);align-items:start}
.unlinked-onboarding .person p{margin:0;color:var(--muted)}
.unlinked-onboarding .initials{display:grid;place-items:center;flex:none;width:44px;height:44px;background:#eceefc;border-radius:50%;color:var(--brand);font-weight:600}
.unlinked-onboarding .person>div{min-width:0;flex:1}
.unlinked-onboarding .tags{display:flex;gap:8px;flex-wrap:wrap;margin-top:18px}
.unlinked-onboarding .tag{font-size:13px;background:#eceefc;border:1px solid var(--line);border-radius:20px;padding:5px 12px}
.unlinked-onboarding progress{display:block;width:100%;height:9px;accent-color:var(--brand);margin:18px 0}
.unlinked-onboarding pre{white-space:pre-wrap;overflow-wrap:anywhere}
.unlinked-onboarding :is(a,button,input,textarea,summary):focus-visible{outline:3px solid var(--brand);outline-offset:4px}
.unlinked-onboarding [hidden]{display:none!important}
@media(max-width:900px){.unlinked-onboarding .header-search{order:2;flex:1 0 100%;max-width:none;min-width:0}.unlinked-onboarding nav{margin-left:auto}}
@media(max-width:600px){body:has(.unlinked-onboarding){padding:20px}.unlinked-onboarding header{gap:12px}.unlinked-onboarding nav{gap:14px;margin:0;width:100%}.unlinked-onboarding .panel{padding:20px}.unlinked-onboarding .steps{gap:8px}.unlinked-onboarding .lead{font-size:17px}.unlinked-onboarding .file{padding:24px 16px}.unlinked-onboarding .button{width:100%}}
@media(prefers-reduced-motion:reduce){.unlinked-onboarding *{scroll-behavior:auto}}
`
