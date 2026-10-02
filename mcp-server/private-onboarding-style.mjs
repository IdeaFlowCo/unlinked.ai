// One stylesheet for every member-facing page. Indigo on a light tinted page,
// ordinary type sizes, the accepted prototype's profile and directory layout.
export const ONBOARDING_FONT_HREF = 'https://fonts.googleapis.com/css2?family=Public+Sans:wght@400;600;700&display=swap'
export const ONBOARDING_STYLE = `
html{-webkit-text-size-adjust:100%}
body:has(.unlinked-onboarding){margin:0;background:#f5f6fc;color:#16181d;font:17px/1.55 "Public Sans",system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
.unlinked-onboarding{--brand:#4349c4;--brand-d:#32379c;--tint:#eceefc;--page:#f5f6fc;--fg:#16181d;--muted:#667085;--line:#e6e8ec;--line2:#c4c9d2;--r:8px;max-width:1180px;margin:0 auto;padding:0 28px 30px;color:var(--fg)}
.unlinked-onboarding *{box-sizing:border-box}
.unlinked-onboarding button,.unlinked-onboarding input,.unlinked-onboarding textarea{font:inherit;color:inherit}
.unlinked-onboarding a{color:var(--brand-d);text-underline-offset:3px}
.unlinked-onboarding h1,.unlinked-onboarding h2,.unlinked-onboarding h3{margin:0}
.unlinked-onboarding header{display:flex;align-items:center;gap:20px;padding:24px 0;border-bottom:1px solid var(--line)}
.unlinked-onboarding .logo{text-decoration:none;letter-spacing:-.04em;color:var(--brand)}
.unlinked-onboarding .logo strong{font-size:21px;font-weight:700;color:var(--brand)}
.unlinked-onboarding .header-search{position:relative;display:flex;flex:1;max-width:440px;margin-right:auto}
.unlinked-onboarding .header-search input[type=search]{width:100%;min-width:0;margin:0;padding:10px 46px 10px 38px;border:1px solid var(--line2);border-radius:99px;font-size:15px;background:#fff url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' fill='none' stroke='%23667085' stroke-width='2'%3E%3Ccircle cx='7' cy='7' r='5'/%3E%3Cpath d='m11 11 4 4'/%3E%3C/svg%3E") no-repeat 14px 50%}
.unlinked-onboarding .header-search input[type=search]:focus{outline:0;border-color:var(--brand);box-shadow:0 0 0 3px var(--tint)}
.unlinked-onboarding .header-search button{position:absolute;right:5px;top:50%;transform:translateY(-50%);width:34px;height:34px;min-height:0;padding:0;border:0;border-radius:50%;background:none;color:var(--brand-d);display:grid;place-items:center;cursor:pointer}
.unlinked-onboarding .header-search button:hover{background:var(--tint)}
.unlinked-onboarding nav{display:flex;gap:18px;align-items:center;font-size:15px}
.unlinked-onboarding nav a{color:var(--fg);text-decoration:none;white-space:nowrap}
.unlinked-onboarding nav a:hover{text-decoration:underline}
.unlinked-onboarding nav .chip{display:inline-block;border:1px solid var(--line2);border-radius:99px;padding:6px 13px;background:#fff;max-width:200px;overflow:hidden;text-overflow:ellipsis;vertical-align:middle}
.unlinked-onboarding nav a.button{color:#fff}
.unlinked-onboarding nav a.button:hover{text-decoration:none}
.unlinked-onboarding .pill{background:var(--tint);color:var(--brand-d);border:1px solid var(--brand);border-radius:99px;padding:5px 12px;font-size:13px;font-weight:600}
.unlinked-onboarding .button,.unlinked-onboarding button{display:inline-flex;min-height:46px;align-items:center;justify-content:center;gap:8px;padding:11px 22px;background:var(--brand);border:1px solid var(--brand);border-radius:var(--r);color:#fff;text-decoration:none;font:600 16px "Public Sans",system-ui,sans-serif;cursor:pointer}
.unlinked-onboarding .button.lg{min-height:54px;padding:15px 26px}
.unlinked-onboarding .button.sm,.unlinked-onboarding button.sm{min-height:38px;padding:8px 14px;font-size:14px}
.unlinked-onboarding .quiet,.unlinked-onboarding .button.sec{background:#fff;color:var(--fg);border-color:var(--line2)}
.unlinked-onboarding button:disabled{opacity:.65;cursor:not-allowed}
.unlinked-onboarding .link-button{display:inline;min-height:0;padding:0;border:0;background:none;color:var(--brand-d);font:inherit;text-decoration:underline;text-underline-offset:3px}
.unlinked-onboarding .small{font-size:14px;color:var(--muted)}
.unlinked-onboarding .import-status{max-width:780px;margin:20px auto 0;padding:14px 18px;background:var(--tint);border:1px solid var(--brand);border-radius:var(--r);font-size:14px;overflow-wrap:anywhere}
.unlinked-onboarding .import-status p{margin:6px 0 0}
.unlinked-onboarding progress{display:block;width:100%;height:9px;accent-color:var(--brand);margin:10px 0}
.unlinked-onboarding .journey{overflow-wrap:anywhere}
.unlinked-onboarding .narrow{max-width:560px;margin:0 auto;padding-top:34px}
.unlinked-onboarding .narrow.wide{max-width:780px}
.unlinked-onboarding .dir{max-width:860px;margin:0 auto;padding-top:30px}
.unlinked-onboarding .hq{font:600 clamp(26px,3.2vw,36px)/1.1 "Public Sans",system-ui,sans-serif;letter-spacing:-.03em;margin:0 0 18px}
.unlinked-onboarding .ph{font-size:13px;letter-spacing:.12em;text-transform:uppercase;color:var(--muted);margin:34px 0 12px;font-weight:600}
.unlinked-onboarding .lead{font-size:18px;color:var(--muted);margin:0 0 24px}
.unlinked-onboarding .steps{display:flex;gap:10px;flex-wrap:wrap;font-size:13px;color:var(--muted);margin:0 0 22px}
.unlinked-onboarding .steps b{color:var(--brand-d)}
.unlinked-onboarding .panel,.unlinked-onboarding .card,.unlinked-onboarding .linkedin-lookup{background:#fff;border:1px solid var(--line);border-radius:var(--r);padding:20px 22px;margin:16px 0}
.unlinked-onboarding .panel>h2:first-child{margin-top:0}
.unlinked-onboarding h2{font-size:20px;line-height:1.25;letter-spacing:-.01em;margin:26px 0 10px}
.unlinked-onboarding h3{font-size:17px;margin:0 0 4px}
.unlinked-onboarding .file,.unlinked-onboarding .drop{display:block;padding:22px 24px;border:2px dashed var(--line2);border-radius:var(--r);background:#fff}
.unlinked-onboarding .drop strong{display:block;font-size:18px;margin-bottom:4px}
.unlinked-onboarding .drop p{margin:0 0 14px}
.unlinked-onboarding input[type=file]{display:block;width:100%;max-width:100%;margin:14px 0;font:inherit}
.unlinked-onboarding input[type=text],.unlinked-onboarding textarea{display:block;width:100%;min-width:0;padding:12px 14px;margin-top:7px;border:1px solid var(--line2);border-radius:var(--r);background:#fff;color:var(--fg);font:inherit;font-size:16px}
.unlinked-onboarding input::placeholder{color:var(--muted);opacity:1}
.unlinked-onboarding textarea{resize:vertical;font:13px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;margin:8px 0 14px}
.unlinked-onboarding label{display:block;margin:16px 0;font-size:14px;font-weight:600}
.unlinked-onboarding .sign-in-options{display:grid;gap:12px;max-width:400px}
.unlinked-onboarding .actions{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:16px 0 0}
.unlinked-onboarding .notice{padding:14px 18px;background:var(--tint);border-left:4px solid var(--brand);border-radius:0 var(--r) var(--r) 0;margin:16px 0;font-size:15px}
.unlinked-onboarding .error{background:#fbeeed;color:#7e3030;border-color:#b0413e}
.unlinked-onboarding details{margin:18px 0;font-size:15px}
.unlinked-onboarding summary{cursor:pointer;min-height:44px;padding:10px 0}
.unlinked-onboarding pre{white-space:pre-wrap;overflow-wrap:anywhere;background:var(--tint);border:1px solid var(--line);padding:12px 14px;font:13px/1.5 ui-monospace,Menlo,monospace;margin:10px 0;border-radius:var(--r)}
.unlinked-onboarding code{background:var(--tint);color:var(--brand-d);padding:2px 6px;border-radius:4px;font-size:.92em}
.unlinked-onboarding .row{display:flex;justify-content:space-between;gap:16px;padding:10px 0;border-top:1px solid var(--line);font-size:15px}
.unlinked-onboarding .row:first-child{border-top:0}
.unlinked-onboarding .avatar,.unlinked-onboarding .initials{display:grid;place-items:center;flex:none;width:44px;height:44px;border-radius:50%;background:var(--brand);color:#fff;font-size:14px;font-weight:600;text-decoration:none}
.unlinked-onboarding .list{padding:6px 22px}
.unlinked-onboarding .person,.unlinked-onboarding .prow{display:grid;grid-template-columns:44px 1fr;gap:14px;align-items:center;padding:12px 0;border-top:1px solid var(--line)}
.unlinked-onboarding .person:first-child,.unlinked-onboarding .prow:first-child{border-top:0}
.unlinked-onboarding .person>div{min-width:0}
.unlinked-onboarding .person h3{font-size:16px;font-weight:700;margin:0}
.unlinked-onboarding .person h3 a{color:var(--fg);text-decoration:none}
.unlinked-onboarding .person h3 a:hover{text-decoration:underline}
.unlinked-onboarding .person p{margin:0;font-size:15px}
.unlinked-onboarding .person p.small{color:var(--muted);font-size:14px}
.unlinked-onboarding .reason{margin:-4px 0 12px 58px;font-size:14px;color:var(--muted)}
.unlinked-onboarding .tags,.unlinked-onboarding .skills{display:flex;gap:6px;flex-wrap:wrap}
.unlinked-onboarding .tag,.unlinked-onboarding .skills span{display:inline-block;background:var(--tint);color:var(--brand-d);border-radius:99px;padding:5px 12px;font-size:14px}
.unlinked-onboarding .profile{display:grid;grid-template-columns:1fr 350px;gap:20px;padding-top:22px;align-items:start}
.unlinked-onboarding .profile .card{margin:0 0 16px}
.unlinked-onboarding .phead{padding:0 0 22px;overflow:hidden}
.unlinked-onboarding .banner{height:108px;background:linear-gradient(115deg,var(--h,var(--brand)),color-mix(in srgb,var(--h,var(--brand)) 30%,#fff))}
.unlinked-onboarding .pav{width:96px;height:96px;border-radius:50%;border:4px solid #fff;margin:-48px 0 0 24px;display:grid;place-items:center;background:var(--h,var(--brand));color:#fff;font-weight:600;font-size:30px}
.unlinked-onboarding .phead h1{font:600 28px/1.15 "Public Sans",system-ui,sans-serif;letter-spacing:-.01em;margin:12px 24px 2px}
.unlinked-onboarding .phead .hl{margin:0 24px 4px;font-size:17px}
.unlinked-onboarding .phead>.small{margin:0 24px;display:block}
.unlinked-onboarding .phead .actions{margin:16px 24px 0}
.unlinked-onboarding .phead .notice{margin:16px 24px 0}
.unlinked-onboarding .sec h3{margin:0 0 12px;font-size:17px}
.unlinked-onboarding .sec>p{margin:0}
.unlinked-onboarding .sec>p+p,.unlinked-onboarding .sec>pre+p{margin-top:10px}
.unlinked-onboarding .xp{padding:12px 0;border-top:1px solid var(--line)}
.unlinked-onboarding .xp:first-of-type{border-top:0;padding-top:0}
.unlinked-onboarding .xp:last-child{padding-bottom:0}
.unlinked-onboarding .xp b{display:block}
.unlinked-onboarding .xp p{margin:6px 0 0;color:var(--muted);font-size:15px}
.unlinked-onboarding .crow{display:grid;grid-template-columns:36px 1fr;gap:10px;padding:8px 0;align-items:center;text-decoration:none;font-size:15px;line-height:1.3;color:var(--fg)}
.unlinked-onboarding .crow .avatar{width:36px;height:36px;font-size:12px}
.unlinked-onboarding a.crow:hover strong{text-decoration:underline}
.unlinked-onboarding .land{display:grid;grid-template-columns:1.05fr .95fr;gap:76px;padding:60px 0 20px;align-items:start}
.unlinked-onboarding .land h1{font:600 clamp(32px,4vw,50px)/1.08 "Public Sans",system-ui,sans-serif;letter-spacing:-.02em;margin:0 0 20px}
.unlinked-onboarding .land .lead{font-size:19px;line-height:1.6;max-width:30em;margin:0 0 30px}
.unlinked-onboarding .cta{display:flex;gap:22px;align-items:center;flex-wrap:wrap;margin-bottom:26px}
.unlinked-onboarding .phead.mini{margin-top:6px;box-shadow:0 12px 32px rgba(40,20,10,.08);border-radius:12px}
.unlinked-onboarding .land .phead.mini h1{font:600 26px/1.15 "Public Sans",system-ui,sans-serif;letter-spacing:-.01em;margin:12px 24px 2px}
.unlinked-onboarding .mini-sec{margin:16px 24px 0;padding-top:14px;border-top:1px solid var(--line)}
.unlinked-onboarding .mini-sec p{margin:8px 0 0;font-size:15px}
.unlinked-onboarding .faces{display:flex;margin-top:10px}
.unlinked-onboarding .faces span{width:38px;height:38px;border-radius:50%;border:2px solid #fff;margin-right:-8px;display:grid;place-items:center;color:#fff;font-size:12px;font-weight:600}
.unlinked-onboarding .faces .moref{background:var(--tint);color:var(--brand-d)}
.unlinked-onboarding .agentband{display:grid;grid-template-columns:1fr 1fr;gap:28px;align-items:center;background:#fff;border:1px solid var(--line);border-left:4px solid var(--brand);border-radius:var(--r);padding:20px 24px;margin-top:44px}
.unlinked-onboarding .agentband pre{margin:0 0 8px}
.unlinked-onboarding footer{display:flex;gap:10px 28px;flex-wrap:wrap;justify-content:space-between;align-items:center;border-top:1px solid var(--line);margin-top:56px;padding-top:20px;font-size:14px;color:var(--muted)}
.unlinked-onboarding footer a{margin-right:18px}
.unlinked-onboarding footer form{display:inline}
.unlinked-onboarding .account{margin:0}
.unlinked-onboarding :is(a,button,input,textarea,summary):focus-visible{outline:3px solid var(--brand);outline-offset:3px}
.unlinked-onboarding [hidden]{display:none!important}
@media(max-width:900px){.unlinked-onboarding{padding:0 20px 30px}.unlinked-onboarding header{flex-wrap:wrap;gap:10px}.unlinked-onboarding .header-search{order:3;flex:1 0 100%;max-width:none}.unlinked-onboarding nav{gap:14px;font-size:14px;flex-wrap:wrap;margin-left:auto}.unlinked-onboarding .profile,.unlinked-onboarding .agentband{grid-template-columns:1fr}.unlinked-onboarding .land{grid-template-columns:1fr;gap:34px;padding-top:26px}.unlinked-onboarding .cta .button{width:100%}}
@media(max-width:600px){body:has(.unlinked-onboarding){font-size:16px}.unlinked-onboarding nav .hide-m{display:none}.unlinked-onboarding .panel,.unlinked-onboarding .card,.unlinked-onboarding .linkedin-lookup{padding:18px}.unlinked-onboarding .list{padding:4px 18px}.unlinked-onboarding .phead{padding:0 0 18px}}
@media(prefers-reduced-motion:reduce){.unlinked-onboarding *{scroll-behavior:auto;transition:none!important}}
`
