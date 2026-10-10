// One stylesheet for every member-facing page. Indigo on a light tinted page,
// ordinary type sizes, the accepted prototype's profile and directory layout.
export const ONBOARDING_FONT_HREF = 'https://fonts.googleapis.com/css2?family=Public+Sans:wght@400;600;700&display=swap'
export const ONBOARDING_STYLE = `
html{-webkit-text-size-adjust:100%}
.unlinked-onboarding #api-keys{scroll-margin-top:24px}
.unlinked-onboarding .key-permissions{padding:12px 16px;margin:16px 0;border:1px solid var(--line);border-radius:var(--r);background:var(--page)}
.unlinked-onboarding .key-permissions label{display:flex;align-items:center;gap:10px;min-height:44px;font-weight:600}
.unlinked-onboarding .key-permissions input{width:20px;height:20px;accent-color:var(--brand);flex-shrink:0}
.unlinked-onboarding section[aria-label="Connect with sign-in"]{margin-top:24px;padding-top:20px;border-top:1px solid var(--line)}
.unlinked-onboarding .key-list{display:flex;flex-direction:column;align-items:stretch;gap:6px;margin:16px 0}
.unlinked-onboarding .key-row{display:flex;justify-content:space-between;gap:12px;padding:10px 12px;border:1px solid var(--line);border-radius:8px;text-decoration:none;overflow-wrap:anywhere}
.unlinked-onboarding .key-row[aria-current]{border-color:var(--brand);background:var(--tint)}
.unlinked-onboarding .key-value{display:flex;align-items:center;gap:8px;margin-bottom:12px}
.unlinked-onboarding .key-value input{min-width:0;flex:1;padding:12px 14px;border:1px solid var(--line2);border-radius:var(--r);font:14px monospace}
.unlinked-onboarding .selected-key h4{margin:16px 0 8px;font-size:16px}
@media(max-width:520px){.unlinked-onboarding .key-row{flex-direction:column;gap:4px}}
.membership-member{display:inline-flex;font-size:12px;font-weight:600;color:#27634a;background:#e8f4ed;border-radius:99px;padding:2px 8px;margin-left:8px;vertical-align:middle}
body:has(.msg) .unlinked-onboarding{max-width:1480px;height:100dvh;display:flex;flex-direction:column;padding-bottom:16px}
body:has(.msg) .journey{flex:1;min-height:0}
body:has(.msg) header{flex-shrink:0}
body:has(.msg) footer{display:none}
body:has(.msg) nav>a[href="/messages"]{font-weight:700;color:var(--brand)}
.unlinked-onboarding nav .nav-count{display:inline-block;min-width:19px;height:19px;margin-left:6px;padding:0 5px;border-radius:99px;background:#c8372d;color:#fff;font:700 11px/19px "Public Sans",system-ui,sans-serif;text-align:center;vertical-align:1px}
.unlinked-onboarding .msg{height:100%;padding-top:16px}
.unlinked-onboarding .msg-app{display:grid;grid-template-columns:minmax(280px,340px) 1fr;height:100%;min-height:0;background:#fff;border:1px solid var(--line);border-radius:12px;overflow:hidden}
.unlinked-onboarding .msg-side{display:flex;flex-direction:column;min-height:0;border-right:1px solid var(--line)}
.unlinked-onboarding .msg-side-head{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:16px 16px 8px}
.unlinked-onboarding .msg-side-head h1{font-size:20px;letter-spacing:-.02em;line-height:1.2;margin:0}
.unlinked-onboarding .msg-live{font-size:12px;color:var(--muted);background:var(--page);border:1px solid var(--line);border-radius:99px;padding:2px 9px}
.unlinked-onboarding .msg-search{padding:4px 12px 10px}
.unlinked-onboarding .msg-search input{width:100%;min-height:38px;padding:7px 12px;border:1px solid var(--line2);border-radius:var(--r);font:inherit;font-size:14px;background:var(--page)}
.unlinked-onboarding .msg-status{margin:0 12px 10px;padding:8px 12px;font-size:13px;background:#fff7e6;border:1px solid #f0d9a8;border-radius:var(--r)}
.unlinked-onboarding .msg-list{list-style:none;margin:0;padding:0 6px 8px;overflow-y:auto;flex:1;min-height:0}
.unlinked-onboarding .msg-list-empty{padding:16px 10px;font-size:14px;color:var(--muted)}
.unlinked-onboarding .msg-item{display:flex;align-items:center;gap:12px;min-height:64px;padding:10px;border-radius:var(--r);color:var(--fg);text-decoration:none}
.unlinked-onboarding .msg-item:hover{background:var(--page);text-decoration:none}
.unlinked-onboarding .msg-item.active{background:var(--tint)}
.unlinked-onboarding .msg-item.active .msg-item-time,.unlinked-onboarding .msg-item.active .msg-item-preview,.unlinked-onboarding .msg-item:hover .msg-item-time,.unlinked-onboarding .msg-item:hover .msg-item-preview{color:#4a5263}
.unlinked-onboarding .msg-item:focus-visible,.unlinked-onboarding .msg-log:focus-visible{outline:2px solid var(--brand);outline-offset:-2px}
.unlinked-onboarding .msg-avatar{position:relative;flex:0 0 40px;width:40px;height:40px;border-radius:50%;display:grid;place-items:center;color:#fff;font-size:14px;font-weight:700}
.unlinked-onboarding .msg-dot{position:absolute;right:-1px;bottom:-1px;width:12px;height:12px;border-radius:50%;border:2px solid #fff;background:#2e8b57}
.unlinked-onboarding .msg-dot.away{background:#d99a1e}
.unlinked-onboarding .msg-item-body{display:flex;flex-direction:column;min-width:0;flex:1}
.unlinked-onboarding .msg-item-top{display:flex;align-items:baseline;gap:6px;min-width:0}
.unlinked-onboarding .msg-item-name{font-size:15px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.unlinked-onboarding .msg-item-time{margin-left:auto;flex-shrink:0;font-size:12px;color:var(--muted)}
.unlinked-onboarding .msg-item-preview{font-size:14px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.unlinked-onboarding .msg-item.unread .msg-item-preview{color:var(--fg);font-weight:600}
.unlinked-onboarding .msg-tag{font-size:11px;font-weight:600;color:var(--muted);border:1px solid var(--line2);border-radius:4px;padding:0 4px}
.unlinked-onboarding .msg-muted{font-size:12px}
.unlinked-onboarding .msg-pill{flex-shrink:0;min-width:20px;height:20px;padding:0 6px;border-radius:99px;background:var(--brand);color:#fff;font-size:12px;font-weight:700;line-height:20px;text-align:center}
.unlinked-onboarding .msg-thread{display:flex;flex-direction:column;min-width:0;min-height:0}
.unlinked-onboarding .msg-empty{margin:auto;padding:24px;text-align:center;max-width:420px}
.unlinked-onboarding .msg-empty h2{font-size:18px;margin:12px 0 6px}
.unlinked-onboarding .msg-empty .avatar{margin:0 auto}
.unlinked-onboarding .msg-thread-head{display:flex;align-items:center;gap:12px;min-height:64px;padding:10px 16px;border-bottom:1px solid var(--line)}
.unlinked-onboarding .msg-thread-who{display:flex;flex-direction:column;min-width:0;flex:1}
.unlinked-onboarding .msg-thread-who h2{font-size:16px;margin:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.unlinked-onboarding .msg-thread-who .small{font-size:13px}
.unlinked-onboarding .msg-head-link{white-space:nowrap}
.unlinked-onboarding .msg-back{display:none;min-height:44px;min-width:44px;padding:0;background:#fff;color:var(--fg);border-color:var(--line2);font-size:18px}
.unlinked-onboarding .msg-log{flex:1;min-height:0;overflow-y:auto;padding:16px 20px;display:flex;flex-direction:column;gap:2px;overscroll-behavior:contain}
.unlinked-onboarding .msg-loading{margin:auto;color:var(--muted);font-size:14px}
.unlinked-onboarding .msg-more{text-align:center;padding:4px 0 10px;font-size:14px}
.unlinked-onboarding .msg-day{display:flex;justify-content:center;margin:14px 0 8px}
.unlinked-onboarding .msg-day span{font-size:12px;font-weight:600;color:var(--muted);background:var(--page);border-radius:99px;padding:2px 10px}
.unlinked-onboarding .msg-row{display:flex;flex-direction:column;align-items:flex-start;max-width:min(72%,640px);margin-top:8px}
.unlinked-onboarding .msg-row.grouped{margin-top:2px}
.unlinked-onboarding .msg-row.own{align-self:flex-end;align-items:flex-end}
.unlinked-onboarding .msg-sender{font-size:12px;font-weight:600;color:var(--muted);margin:0 0 2px 12px}
.unlinked-onboarding .msg-bubble{padding:8px 12px;border-radius:14px;background:#f2f3f6;font-size:15px;line-height:1.45;white-space:pre-wrap;overflow-wrap:anywhere}
.unlinked-onboarding .msg-row.own .msg-bubble{background:var(--tint);color:#1c1f4a}
.unlinked-onboarding .msg-bubble a{color:var(--brand-d)}
.unlinked-onboarding .msg-bubble.deleted{font-style:italic;color:var(--muted);background:#fff;border:1px dashed var(--line2)}
.unlinked-onboarding .msg-edited{font-size:12px;color:var(--muted)}
.unlinked-onboarding .msg-quote{display:block;margin:0 0 6px;padding:4px 8px;border-left:3px solid var(--brand);background:#ffffffa8;border-radius:4px;font-size:13px;color:var(--fg);text-decoration:none;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%}
.unlinked-onboarding .msg-attachment{display:block;margin-top:4px;font-size:13px;color:var(--muted)}
.unlinked-onboarding .msg-preview{display:flex;flex-direction:column;gap:2px;margin-top:4px;max-width:360px;padding:8px 12px;border:1px solid var(--line);border-radius:10px;color:var(--fg);text-decoration:none;font-size:13px}
.unlinked-onboarding .msg-preview:hover{border-color:var(--line2);text-decoration:none}
.unlinked-onboarding .msg-reactions{display:flex;gap:4px;margin-top:3px;flex-wrap:wrap}
.unlinked-onboarding .msg-reaction{display:inline-flex;align-items:center;gap:3px;padding:1px 8px;border:1px solid var(--line);border-radius:99px;background:#fff;font-size:13px}
.unlinked-onboarding .msg-reaction.mine{border-color:var(--brand);background:var(--tint);color:var(--brand-d)}
.unlinked-onboarding .msg-meta{font-size:12px;color:var(--muted);margin-top:2px}
.unlinked-onboarding .msg-meta.failed{color:#b0413e}
.unlinked-onboarding .msg-composer{display:flex;align-items:flex-end;gap:8px;padding:12px 76px 12px 16px;border-top:1px solid var(--line);padding-bottom:max(12px,env(safe-area-inset-bottom))}
.unlinked-onboarding .msg-composer textarea{flex:1;min-height:44px;max-height:212px;resize:none;padding:10px 12px;border:1px solid var(--line2);border-radius:var(--r);font:inherit;font-size:15px;line-height:24px;background:#fff}
.unlinked-onboarding .msg-composer textarea:focus{outline:2px solid var(--brand);outline-offset:-1px;border-color:var(--brand)}
.unlinked-onboarding .msg-send{min-height:44px;padding:8px 18px}
.unlinked-onboarding .msg-side-head .button{margin-left:auto}
.unlinked-onboarding .msg-search{display:flex;gap:8px;align-items:center}
.unlinked-onboarding .msg-search input{flex:1;min-width:0}
.unlinked-onboarding .msg-toggle{min-height:38px;padding:6px 10px;font-size:13px;font-weight:600;background:#fff;color:var(--fg);border:1px solid var(--line2);border-radius:var(--r);white-space:nowrap}
.unlinked-onboarding .msg-toggle[aria-pressed=true]{background:var(--tint);border-color:var(--brand);color:var(--brand-d)}
.unlinked-onboarding .msg-item-preview.typing{color:var(--brand-d);font-style:italic}
.unlinked-onboarding .msg-line{position:relative;display:flex;align-items:center;gap:6px;max-width:100%}
.unlinked-onboarding .msg-row.own .msg-line{flex-direction:row-reverse}
.unlinked-onboarding .msg-actions{display:flex;gap:2px;opacity:0;pointer-events:none;transition:opacity .12s}
.unlinked-onboarding .msg-row:hover .msg-actions,.unlinked-onboarding .msg-row:focus-within .msg-actions,.unlinked-onboarding .msg-row.show-actions .msg-actions{opacity:1;pointer-events:auto}
.unlinked-onboarding .msg-act{display:inline-grid;place-items:center;min-height:32px;min-width:32px;padding:0;background:#fff;color:var(--muted);border:1px solid var(--line);border-radius:8px;font-size:15px;line-height:1}
.unlinked-onboarding .msg-act:hover{color:var(--fg);border-color:var(--line2)}
.unlinked-onboarding .msg-act:focus-visible,.unlinked-onboarding .msg-reaction:focus-visible,.unlinked-onboarding .msg-quote:focus-visible,.unlinked-onboarding .msg-toggle:focus-visible,.unlinked-onboarding .msg-menu summary:focus-visible{outline:2px solid var(--brand);outline-offset:2px}
.unlinked-onboarding .msg-react-picker{position:absolute;bottom:calc(100% + 4px);z-index:20;display:flex;gap:2px;padding:4px;background:#fff;border:1px solid var(--line);border-radius:12px;box-shadow:0 8px 24px #25295324}
.unlinked-onboarding .msg-row.own .msg-react-picker{right:0}
.unlinked-onboarding .msg-react-picker button{min-height:40px;min-width:40px;padding:0;background:#fff;border:0;border-radius:8px;font-size:20px;color:inherit}
.unlinked-onboarding .msg-react-picker button:hover{background:var(--tint)}
.unlinked-onboarding .msg-react-picker button:focus-visible{background:var(--tint);outline:2px solid var(--brand);outline-offset:1px}
.unlinked-onboarding button.msg-reaction{min-height:28px;padding:1px 8px;color:var(--fg);font-weight:400;cursor:pointer}
.unlinked-onboarding button.msg-reaction.mine{color:var(--brand-d)}
.unlinked-onboarding button.msg-quote{min-height:0;width:100%;justify-content:flex-start;text-align:left;font-weight:400;cursor:pointer}
.unlinked-onboarding .msg-row.flash .msg-bubble{animation:msg-flash 1.4s ease-out}
@keyframes msg-flash{0%{box-shadow:0 0 0 3px var(--brand)}100%{box-shadow:0 0 0 3px transparent}}
.unlinked-onboarding .msg-edit-wrap{display:flex;flex-direction:column;gap:4px;min-width:min(420px,70vw);font-size:13px}
.unlinked-onboarding .msg-edit{width:100%;padding:8px 10px;border:1px solid var(--brand);border-radius:10px;font:inherit;font-size:15px;line-height:1.45;resize:vertical}
.unlinked-onboarding .msg-typing{min-height:20px;padding:0 20px;font-size:13px;color:var(--muted);font-style:italic}
.unlinked-onboarding .msg-jump{position:absolute;left:50%;transform:translateX(-50%);bottom:132px;z-index:5;min-height:36px;padding:6px 14px;font-size:13px;border-radius:99px;box-shadow:0 6px 18px #25295333}
.unlinked-onboarding .msg-thread{position:relative}
.unlinked-onboarding .msg-compose-wrap{border-top:1px solid var(--line)}
.unlinked-onboarding .msg-compose-wrap .msg-composer{border-top:0;padding-bottom:4px}
.unlinked-onboarding .msg-hint{margin:0;padding:0 76px max(10px,env(safe-area-inset-bottom)) 18px;font-size:12px;color:var(--muted)}
.unlinked-onboarding .msg-reply-card{display:flex;align-items:center;gap:8px;margin:10px 76px 0 16px;padding:6px 6px 6px 10px;border-left:3px solid var(--brand);background:var(--page);border-radius:6px;font-size:13px}
.unlinked-onboarding .msg-reply-card>span{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.unlinked-onboarding .msg-menu{position:relative}
.unlinked-onboarding .msg-menu summary{list-style:none;display:grid;place-items:center;width:44px;height:44px;border-radius:8px;cursor:pointer;font-size:20px;color:var(--muted)}
.unlinked-onboarding .msg-menu summary::-webkit-details-marker{display:none}
.unlinked-onboarding .msg-menu summary:hover{background:var(--page);color:var(--fg)}
.unlinked-onboarding .msg-menu-panel{position:absolute;right:0;top:calc(100% + 4px);z-index:30;display:flex;flex-direction:column;min-width:250px;padding:6px;background:#fff;border:1px solid var(--line);border-radius:12px;box-shadow:0 16px 40px #25295324}
.unlinked-onboarding .msg-menu-panel button,.unlinked-onboarding .msg-menu-panel a,.unlinked-onboarding .msg-menu-check{display:flex;align-items:center;gap:8px;min-height:40px;padding:8px 10px;background:none;border:0;border-radius:8px;color:var(--fg);font:inherit;font-size:14px;font-weight:400;text-align:left;text-decoration:none;justify-content:flex-start;cursor:pointer}
.unlinked-onboarding .msg-menu-panel button:hover,.unlinked-onboarding .msg-menu-panel a:hover,.unlinked-onboarding .msg-menu-check:hover{background:var(--page)}
.unlinked-onboarding .msg-menu-check input{width:18px;height:18px;accent-color:var(--brand)}
dialog.msg-picker{width:min(480px,calc(100vw - 32px));max-height:min(620px,calc(100dvh - 48px));padding:0;border:1px solid #e6e8ec;border-radius:14px;box-shadow:0 24px 60px #25295340;font:16px/1.5 "Public Sans",system-ui,sans-serif;color:#16181d}
dialog.msg-picker::backdrop{background:#16181d55}
.msg-picker .msg-picker-head{display:flex;align-items:center;justify-content:space-between;padding:14px 16px 6px}
.msg-picker h2{font-size:18px;margin:0}
.msg-picker input[type=search]{display:block;width:calc(100% - 32px);margin:6px 16px;min-height:42px;padding:8px 12px;border:1px solid #c4c9d2;border-radius:8px;font:inherit}
.msg-picker .small{margin:4px 16px;font-size:13px;color:#667085}
.msg-picker .msg-act{min-height:36px;min-width:36px;background:#fff;border:1px solid #e6e8ec;border-radius:8px;font-size:18px;cursor:pointer}
.msg-picker-list{list-style:none;margin:0;padding:4px 8px 12px;overflow-y:auto;max-height:420px}
.msg-pick{display:flex;align-items:center;gap:12px;min-height:56px;padding:8px;border-radius:8px;cursor:pointer}
.msg-pick:hover,.msg-pick[aria-selected=true]{background:#eceefc}
.msg-pick .msg-avatar{position:relative;flex:0 0 40px;width:40px;height:40px;border-radius:50%;display:grid;place-items:center;color:#fff;font-size:14px;font-weight:700}
.msg-pick .msg-item-body{display:flex;flex-direction:column;min-width:0}
.msg-pick .msg-item-name{font-size:15px}
.msg-pick .msg-item-preview{font-size:13px;color:#667085;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
@media(hover:none){.unlinked-onboarding .msg-act{min-height:40px;min-width:40px}}
@media(prefers-reduced-motion:reduce){.unlinked-onboarding .msg-row.flash .msg-bubble{animation:none;box-shadow:0 0 0 3px var(--brand)}.unlinked-onboarding .msg-actions{transition:none}}
@media(max-width:759px){body:has(.msg) .unlinked-onboarding{padding:0 0 0;height:100dvh}body:has(.msg) header{padding:12px 16px}.unlinked-onboarding .msg{padding-top:0}.unlinked-onboarding .msg-app{grid-template-columns:1fr;border:0;border-radius:0;border-top:1px solid var(--line)}.unlinked-onboarding .msg-side{border-right:0}.unlinked-onboarding .msg-app[data-open] .msg-side{display:none}.unlinked-onboarding .msg-app:not([data-open]) .msg-thread{display:none}.unlinked-onboarding .msg-back{display:inline-flex}.unlinked-onboarding .msg-head-link{display:none}.unlinked-onboarding .msg-row{max-width:85%}.unlinked-onboarding .msg-log{padding:12px}.unlinked-onboarding .msg-hint{display:none}.unlinked-onboarding .msg-toggle{padding:6px 8px}}

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
/* The omnibox uses the product's existing type, indigo tokens and profile faces. */
.unlinked-onboarding .omni-panel{position:absolute;top:calc(100% + 10px);left:0;width:max(100%,390px);max-width:calc(100vw - 40px);z-index:45;background:#fff;border:1px solid var(--line);border-radius:16px;box-shadow:0 16px 48px #25295324;overflow:hidden}
.unlinked-onboarding .omni-panel[hidden]{display:none}
.unlinked-onboarding #omni-suggestions{max-height:min(58vh,540px);overflow-y:auto;overscroll-behavior:contain;padding:6px}
.unlinked-onboarding .omni-heading{font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);padding:10px 12px 5px}
.unlinked-onboarding .omni-option{display:flex;gap:12px;align-items:center;min-height:58px;padding:9px 12px;border-radius:10px;color:var(--fg);text-decoration:none}
.unlinked-onboarding .omni-option:hover,.unlinked-onboarding .omni-option[aria-selected=true]{background:var(--tint)}
.unlinked-onboarding .omni-face{position:relative;display:grid;place-items:center;flex:0 0 36px;width:36px;height:36px;border-radius:50%;background:var(--tint);color:var(--brand-d);font-size:12px;font-weight:700;overflow:hidden}
.unlinked-onboarding .omni-face img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}
.unlinked-onboarding .omni-square{border-radius:9px;background:var(--page)}
.unlinked-onboarding .omni-copy{min-width:0;display:flex;flex-direction:column;gap:2px}
.unlinked-onboarding .omni-name{font-size:14px;font-weight:600;line-height:1.4;overflow-wrap:anywhere}
.unlinked-onboarding .omni-name mark{color:var(--brand-d);background:transparent;font-weight:700}
.unlinked-onboarding .omni-known{margin-left:6px;padding:0 6px;border-radius:99px;background:var(--tint);color:var(--brand-d);font-size:11px;font-weight:600;vertical-align:1px;white-space:nowrap}
.unlinked-onboarding .omni-membership{margin-left:6px;padding:0 6px;font-size:11px;vertical-align:1px;white-space:nowrap}
.unlinked-onboarding .omni-shadow{display:inline-flex;border-radius:99px;background:var(--page);color:var(--muted);font-weight:400}
.unlinked-onboarding .omni-subtitle{font-size:12px;line-height:1.4;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.unlinked-onboarding .omni-status{padding:10px 16px;border-top:1px solid var(--line);background:var(--page);font-size:11px;color:var(--muted)}
.unlinked-onboarding .omni-status.omni-searching{display:flex;align-items:center;gap:8px;color:var(--brand-d);font-weight:600}
.unlinked-onboarding .omni-searching::before{content:"";width:12px;height:12px;flex:0 0 12px;border:2px solid var(--line2);border-top-color:var(--brand-d);border-radius:50%;animation:omni-search-spin .8s linear infinite}
@keyframes omni-search-spin{to{transform:rotate(360deg)}}
@media(prefers-reduced-motion:reduce){.unlinked-onboarding .omni-searching::before{animation:none}}
.unlinked-onboarding .header-search input[type=search]{width:100%;min-width:0;margin:0;padding:10px 84px 10px 38px;border:1px solid var(--line2);border-radius:99px;font-size:15px;background:#fff}
/* iOS Safari and WKWebView zoom into fields under 16px on focus. */
@media(max-width:900px),(pointer:coarse){.unlinked-onboarding .header-search input[type=search]{font-size:16px}}
/* The icon is an element, not a data: background, so the page's default-src 'none' policy allows it. */
.unlinked-onboarding .header-search .search-icon{position:absolute;left:14px;top:50%;transform:translateY(-50%);color:var(--muted);pointer-events:none}
.unlinked-onboarding .header-search input[type=search]:focus{outline:0;border-color:var(--brand);box-shadow:0 0 0 3px var(--tint)}
.unlinked-onboarding .header-search button{position:absolute;right:41px;top:50%;transform:translateY(-50%);width:34px;height:34px;min-height:0;padding:0;border:0;border-radius:50%;background:none;color:var(--brand-d);display:grid;place-items:center;cursor:pointer}
.unlinked-onboarding .header-search button:hover{background:var(--tint)}
/* The QR scan button sits at the right end of the field; the submit arrow appears beside it once there is text. */
.unlinked-onboarding .header-search input[type=search]:placeholder-shown{padding-right:46px}
.unlinked-onboarding .header-search input:placeholder-shown~button{display:none}
.unlinked-onboarding .header-search .scan{position:absolute;right:5px;top:50%;transform:translateY(-50%);width:34px;height:34px;border-radius:50%;display:grid;place-items:center;color:var(--brand-d);text-decoration:none}
.unlinked-onboarding .header-search .scan:hover{background:var(--tint)}
.unlinked-onboarding nav{display:flex;gap:18px;align-items:center;font-size:15px}
.unlinked-onboarding nav a{color:var(--fg);text-decoration:none;white-space:nowrap}
.unlinked-onboarding nav .my-card-link{display:inline-flex;align-items:center;gap:6px;min-height:44px;color:var(--brand-d);font-weight:600}
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
.unlinked-onboarding button.danger{background:#b0413e;border-color:#b0413e}
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
.unlinked-onboarding .phead>.profile-links{margin-top:8px}
.unlinked-onboarding .profile-links a{display:inline-block;padding:5px 0}
.unlinked-onboarding .phead .actions{margin:16px 24px 0}
.unlinked-onboarding .phead .notice{margin:16px 24px 0}
.unlinked-onboarding .qr{margin:18px 24px 0;max-width:260px;background:#fff}
.unlinked-onboarding .qr svg{display:block;width:100%;height:auto;border:1px solid var(--line);border-radius:var(--r)}
.unlinked-onboarding .qr-url{margin:10px 24px 0;overflow-wrap:anywhere}
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
/* Shadow profiles: imported, not on Unlinked yet. Members carry no mark. */
.unlinked-onboarding .shadow{display:inline-flex;align-items:center;gap:4px;margin-left:6px;padding:1px 7px;border:1px dashed var(--line2);border-radius:99px;font-size:12px;font-weight:500;line-height:1.5;color:var(--muted);white-space:nowrap;vertical-align:middle}
.unlinked-onboarding .shadow.net{border-style:solid;border-color:var(--brand);color:var(--brand-d);background:var(--tint)}
.unlinked-onboarding .shadow svg{flex:none}
.unlinked-onboarding .shadow-note{margin:10px 0 0;color:var(--muted)}
.unlinked-onboarding .shadow-note .shadow{margin-left:0}
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
.unlinked-onboarding .land-steps{list-style:none;margin:0;padding:0;background:#fff;border:1px solid var(--line);border-radius:14px;overflow:hidden}
.unlinked-onboarding .land-steps li{display:grid;grid-template-columns:30px 1fr;gap:14px;padding:16px 18px;border-top:1px solid var(--line)}
.unlinked-onboarding .land-steps li:first-child{border-top:0}
.unlinked-onboarding .land-steps .n{display:grid;place-items:center;width:28px;height:28px;border-radius:50%;background:var(--brand);color:#fff;font-weight:700;font-size:13px}
.unlinked-onboarding .land-steps li.later .n{background:var(--tint);color:var(--brand-d)}
.unlinked-onboarding .land-steps b{display:block;font-size:16px}
.unlinked-onboarding .land-steps p{margin:2px 0 10px}
.unlinked-onboarding .land-steps li.later p{margin-bottom:0}
.unlinked-onboarding .button.sec.brand{color:var(--brand-d);border-color:var(--brand)}
.unlinked-onboarding .button.export-opened{background:#e8f5eb;color:#166534;border-color:#39734b}
.unlinked-onboarding .export-opened-step .n{background:#e8f5eb;color:#166534;border:1px solid #39734b}
.unlinked-onboarding .land-explore{margin:16px 0 0}
.unlinked-onboarding .land-steps .land-hint{margin:8px 0 0}
.unlinked-onboarding .land-steps p b{display:inline;font-size:inherit}
.unlinked-onboarding .notice.in-app{margin:18px 0 0}
.unlinked-onboarding .notice.in-app p{margin:0 0 10px}
.unlinked-onboarding .notice.in-app p.small{margin:10px 0 0}
.unlinked-onboarding .eyebrow{text-transform:uppercase;letter-spacing:.08em;font-size:13px;font-weight:700;color:var(--brand);margin:0 0 6px}
.unlinked-onboarding .agent-demo{display:grid;grid-template-columns:.85fr 1.15fr;gap:40px;align-items:center;padding:44px 0 10px}
.unlinked-onboarding .agent-demo h2{font-size:28px;line-height:1.15;letter-spacing:-.025em;margin:0 0 10px}
.unlinked-onboarding .agent-demo .lead{font-size:16px;margin:0 0 12px}
.unlinked-onboarding .agent-demo pre{margin:0 0 8px;white-space:pre-wrap;overflow-wrap:anywhere}
.unlinked-onboarding .claude-demo{margin:0;border:1px solid #e8e4da;border-radius:16px;background:#faf9f5;padding:16px 18px;font-size:14.5px}
.unlinked-onboarding .claude-demo figcaption{font-size:12.5px;color:#7a7466;margin-bottom:10px}
.unlinked-onboarding .demo-user{margin-left:auto;width:fit-content;max-width:80%;background:#efece3;border-radius:14px;padding:9px 13px}
.unlinked-onboarding .demo-tool{display:inline-block;font-size:12.5px;border:1px solid #e1dccf;background:#fff;border-radius:8px;padding:4px 9px;margin:12px 0 6px;color:#5b5648}
.unlinked-onboarding .demo-answer{margin:6px 0 0;padding-left:20px}
.unlinked-onboarding .demo-answer li{margin:5px 0}
.unlinked-onboarding .demo-answer span{color:#5b5648}
.unlinked-onboarding .demo-note{margin:8px 0 0}
@media(max-width:800px){.unlinked-onboarding .agent-demo{grid-template-columns:1fr}}
.unlinked-onboarding .agentband{display:grid;grid-template-columns:1fr 1fr;gap:28px;align-items:center;background:#fff;border:1px solid var(--line);border-left:4px solid var(--brand);border-radius:var(--r);padding:20px 24px;margin-top:44px}
.unlinked-onboarding .agentband pre{margin:0 0 8px}
.unlinked-onboarding footer{display:flex;gap:10px 28px;flex-wrap:wrap;justify-content:space-between;align-items:center;border-top:1px solid var(--line);margin-top:56px;padding-top:20px;font-size:14px;color:var(--muted)}
.unlinked-onboarding footer a{margin-right:18px}
.unlinked-onboarding footer form{display:inline}
.unlinked-onboarding .account{margin:0}
.unlinked-onboarding :is(a,button,input,textarea,summary):focus-visible{outline:3px solid var(--brand);outline-offset:3px}
.unlinked-onboarding [hidden]{display:none!important}
/* "Me": one account menu. A dropdown on wide screens, a bottom sheet on phones. */
.unlinked-onboarding .me{position:relative;margin:0}
.unlinked-onboarding .me>summary{list-style:none;display:flex;min-height:0;align-items:center;gap:7px;padding:3px 11px 3px 3px;border:1px solid var(--line2);border-radius:99px;background:#fff;cursor:pointer;font-size:15px;white-space:nowrap}
.unlinked-onboarding .me>summary::-webkit-details-marker{display:none}
.unlinked-onboarding .me>summary:hover,.unlinked-onboarding .me[open]>summary{border-color:var(--brand)}
.unlinked-onboarding .me .avatar{width:30px;height:30px;font-size:12px}
.unlinked-onboarding .me-face{display:inline-flex;border-radius:50%;text-decoration:none}.unlinked-onboarding .me-face .avatar{width:32px;height:32px;font-size:12px}.unlinked-onboarding .me-face:hover .avatar,.unlinked-onboarding .me-face:focus-visible .avatar{box-shadow:0 0 0 2px var(--brand)}.unlinked-onboarding .me>summary{padding-left:11px}
.unlinked-onboarding .me-l{display:inline-flex;align-items:center;gap:3px}
.unlinked-onboarding .me[open]>summary::before{content:"";position:fixed;inset:0;z-index:40;cursor:default}
.unlinked-onboarding .me-panel{position:absolute;right:0;top:calc(100% + 8px);z-index:41;width:300px;padding:6px 0;background:#fff;border:1px solid var(--line);border-radius:12px;box-shadow:0 12px 32px rgba(16,24,40,.14);font-size:15px}
.unlinked-onboarding .me-head{display:grid;grid-template-columns:48px 1fr;gap:4px 12px;align-items:center;padding:12px 16px 14px;margin-bottom:6px;border-bottom:1px solid var(--line)}
.unlinked-onboarding .me-head .avatar{width:48px;height:48px;font-size:16px}
.unlinked-onboarding .me-who{min-width:0;line-height:1.3}
.unlinked-onboarding .me-who b{display:block;font-size:16px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.unlinked-onboarding .me-hl{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;font-size:14px;color:var(--muted);white-space:normal}
.unlinked-onboarding nav .me .me-view{grid-column:1/-1;margin-top:10px;min-height:34px;border-color:var(--brand);border-radius:99px;color:var(--brand-d)}
.unlinked-onboarding nav .me .me-view:hover{background:var(--tint);text-decoration:none}
.unlinked-onboarding .me-panel>a,.unlinked-onboarding .me .me-out{display:flex;align-items:center;gap:12px;width:100%;min-height:0;padding:10px 16px;border:0;border-radius:0;background:none;color:var(--fg);font:inherit;text-align:left;justify-content:flex-start;text-decoration:none;cursor:pointer}
.unlinked-onboarding .me-panel>a svg{color:var(--muted);flex:none}
.unlinked-onboarding .me-panel>a:hover,.unlinked-onboarding .me .me-out:hover{background:var(--page);text-decoration:none}
.unlinked-onboarding .me-panel :is(a,button):focus-visible{outline-offset:-3px}
.unlinked-onboarding .me-sep{height:1px;margin:6px 0;background:var(--line)}
.unlinked-onboarding .me .me-out{color:var(--muted)}
/* The scan sheet: Scan and My card tabs. */
.unlinked-onboarding .sheet-top{display:flex;align-items:center;justify-content:space-between;gap:12px}
.unlinked-onboarding .sheet-top .hq{margin:0}
.unlinked-onboarding .sheet-close{display:grid;place-items:center;width:40px;height:40px;border-radius:50%;color:var(--muted);font-size:28px;line-height:1;text-decoration:none}
.unlinked-onboarding .sheet-close:hover{background:var(--tint)}
.unlinked-onboarding .tabs{display:flex;gap:4px;margin:18px 0 16px;padding:4px;background:#fff;border:1px solid var(--line);border-radius:99px}
.unlinked-onboarding .tabs a{flex:1;padding:9px 12px;border-radius:99px;color:var(--fg);font-size:15px;font-weight:600;text-align:center;text-decoration:none}
.unlinked-onboarding .tabs a[aria-selected=true],.unlinked-onboarding .tabs a[aria-current=page]{background:var(--brand);color:#fff}
/* The business card: identity and detail rows, with the QR code in a tinted side panel. */
.unlinked-onboarding .bcard{display:grid;grid-template-columns:1fr 232px;margin:16px 0;background:#fff;border:1px solid var(--line);border-top:5px solid var(--brand);border-radius:14px;overflow:hidden;box-shadow:0 12px 32px rgba(16,24,40,.09)}
.unlinked-onboarding .bcard.solo{grid-template-columns:1fr}
.unlinked-onboarding .bc-main{min-width:0;padding:26px 26px 22px}
.unlinked-onboarding .bc-id{display:grid;grid-template-columns:64px 1fr;gap:16px;align-items:center}
.unlinked-onboarding .bc-av{display:grid;place-items:center;width:64px;height:64px;border-radius:50%;background:var(--brand);color:#fff;font-size:22px;font-weight:600}
.unlinked-onboarding img.photo{object-fit:cover;padding:0;background:var(--tint)}
.unlinked-onboarding .bcard .bc-name{font:600 24px/1.15 "Public Sans",system-ui,sans-serif;letter-spacing:-.01em;margin:0}
.unlinked-onboarding .bc-hl{margin:4px 0 0;font-size:16px;line-height:1.35}
.unlinked-onboarding .bc-id .small{margin:2px 0 0}
.unlinked-onboarding .bc-rows{list-style:none;margin:20px 0 0;padding:0;border-top:1px solid var(--line)}
.unlinked-onboarding .bc-row{display:grid;grid-template-columns:36px 1fr;gap:12px;align-items:center;padding:11px 0;border-bottom:1px solid var(--line);color:var(--fg);text-decoration:none;line-height:1.3}
.unlinked-onboarding .bc-rows li:last-child .bc-row{border-bottom:0;padding-bottom:0}
.unlinked-onboarding .bc-row b{display:block;font-weight:600;overflow-wrap:anywhere}
.unlinked-onboarding .bc-row:hover b{text-decoration:underline}
.unlinked-onboarding .bc-ico{display:grid;place-items:center;width:36px;height:36px;border-radius:50%;background:var(--tint);color:var(--brand-d)}
.unlinked-onboarding .bc-side{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;padding:20px;background:var(--tint);text-align:center}
.unlinked-onboarding .bc-side .qr{margin:0;width:100%;max-width:192px;background:none}
.unlinked-onboarding .bc-side .qr svg{border:0;border-radius:10px;background:#fff}
.unlinked-onboarding .bc-side .small{margin:0;line-height:1.35}
.unlinked-onboarding .bcard+.qr-url{margin:10px 0 0}
.unlinked-onboarding nav.tabs{margin:0 0 18px}
.unlinked-onboarding nav.tabs a:hover{text-decoration:none}
.unlinked-onboarding .cc-form .cc-field{padding:0 0 16px;margin:0 0 16px;border-bottom:1px solid var(--line)}
.unlinked-onboarding .cc-form label{margin:0}
.unlinked-onboarding .cc-form label .small{font-weight:400;margin-left:6px}
.unlinked-onboarding .check{display:flex;align-items:center;gap:9px;margin:10px 0 0;font-weight:400;font-size:15px;cursor:pointer}
.unlinked-onboarding .cc-form .check{margin-top:10px}
.unlinked-onboarding .check input{width:18px;height:18px;margin:0;accent-color:var(--brand)}
.unlinked-onboarding .cc-reset form{margin:10px 0 0}
.unlinked-onboarding .cc-kicker{margin:0 0 4px}
.unlinked-onboarding .cc-foot{margin-top:22px}
/* The install hint on the card page, phones only. */
.unlinked-onboarding .pwa-hint{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:0 0 18px}
/* Settings: who is signed in and Sign out, on one line. */
.unlinked-onboarding .acct{display:flex;align-items:center;justify-content:space-between;gap:8px 14px;flex-wrap:wrap;margin:-6px 0 0;font-size:15px;color:var(--muted)}
.unlinked-onboarding .acct b{color:var(--fg)}
.unlinked-onboarding .acct form{margin:0}
.unlinked-onboarding .scan-cam{position:relative;display:grid;place-items:center;width:min(100%,62vh);aspect-ratio:1;margin:0 auto;background:#16181d;border-radius:14px;overflow:hidden}
.unlinked-onboarding .scan-cam #camera{position:absolute;inset:0}
.unlinked-onboarding .scan-cam video{display:block;width:100%;height:100%;object-fit:cover}
.unlinked-onboarding .scan-frame{position:relative;width:62%;aspect-ratio:1;border:3px solid rgba(255,255,255,.9);border-radius:18px}
.unlinked-onboarding .scan-hint{position:absolute;left:0;right:0;bottom:14px;margin:0;padding:0 16px;color:#fff;font-size:14px;text-align:center;text-shadow:0 1px 2px rgba(0,0,0,.5)}
.unlinked-onboarding .scan-sheet #status:empty{display:none}
.unlinked-onboarding .scan-paste{margin:16px 0}
.unlinked-onboarding .scan-paste>summary{color:var(--brand-d);font-size:15px;cursor:pointer}
.unlinked-onboarding .scan-sheet .phead{margin:0}
.unlinked-onboarding .phead h2{font:600 24px/1.15 "Public Sans",system-ui,sans-serif;letter-spacing:-.01em;margin:12px 24px 2px}
/* Connections and notifications: My Network + bell in the header, Connect on profiles, the two feeds. */
.unlinked-onboarding .vh{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}
.unlinked-onboarding nav .nav-ico{position:relative;display:inline-grid;place-items:center;width:40px;height:40px;border-radius:50%;color:var(--fg)}
.unlinked-onboarding nav .nav-ico:hover{background:var(--tint);text-decoration:none}
.unlinked-onboarding .badge{position:absolute;top:1px;right:-2px;min-width:19px;height:19px;padding:0 5px;border-radius:99px;background:#c8372d;color:#fff;border:2px solid var(--page);font:700 11px/15px "Public Sans",system-ui,sans-serif;text-align:center}
.unlinked-onboarding .state-pill{display:inline-flex;align-items:center;min-height:38px;padding:8px 14px;border:1px solid var(--line2);border-radius:99px;background:#fff;font-size:14px;font-weight:600;color:var(--muted)}
.unlinked-onboarding .state-pill.ok{color:#1f6b45;border-color:#a8d5bd;background:#f0f9f4}
.unlinked-onboarding .actions form{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:0}
.unlinked-onboarding .connect-note{margin:10px 24px 0}
.unlinked-onboarding .connect-note summary{min-height:0;padding:4px 0;font-size:14px;color:var(--brand-d)}
.unlinked-onboarding .connect-note textarea,.unlinked-onboarding .req-note{font:15px/1.5 "Public Sans",system-ui,sans-serif}
.unlinked-onboarding .invite-note q,.unlinked-onboarding .req-note q{color:var(--fg)}
.unlinked-onboarding .subtabs{display:flex;gap:6px;flex-wrap:wrap;margin:0 0 4px;font-size:15px}
.unlinked-onboarding .subtabs a{padding:8px 14px;border-radius:99px;border:1px solid var(--line2);background:#fff;color:var(--fg);text-decoration:none}
.unlinked-onboarding .subtabs a[aria-current=page]{background:var(--brand);border-color:var(--brand);color:#fff;font-weight:600}
.unlinked-onboarding .reqs,.unlinked-onboarding .note-list{list-style:none;margin:0;padding:0}
.unlinked-onboarding .req{display:grid;grid-template-columns:44px 1fr auto;gap:14px;align-items:center;padding:14px 0;border-top:1px solid var(--line)}
.unlinked-onboarding .req:first-child,.unlinked-onboarding .note:first-child{border-top:0}
.unlinked-onboarding .req-body{min-width:0}
.unlinked-onboarding .req-body p{margin:0}
.unlinked-onboarding .req-body a{color:var(--fg);text-decoration:none}
.unlinked-onboarding .req-body a:hover{text-decoration:underline}
.unlinked-onboarding .row-actions{display:flex;gap:8px;margin:0}
.unlinked-onboarding .empty{margin:6px 0}
.unlinked-onboarding .notes-top{display:flex;justify-content:space-between;align-items:center;gap:12px}
.unlinked-onboarding .notes-top .hq{margin-bottom:12px}
.unlinked-onboarding .notes .card{padding:0;overflow:hidden}
.unlinked-onboarding .notes .card .empty{padding:18px 22px}
.unlinked-onboarding .note{display:flex;flex-wrap:wrap;align-items:center;gap:8px 14px;padding:12px 22px;border-top:1px solid var(--line)}
.unlinked-onboarding .note.unread{background:#f3f4fd;box-shadow:inset 3px 0 0 var(--brand)}
.unlinked-onboarding .note-open{display:flex;gap:14px;align-items:center;flex:1 1 280px;min-width:0;color:var(--fg);text-decoration:none}
.unlinked-onboarding .note-open:hover .note-text{text-decoration:underline}
.unlinked-onboarding .note-text{font-size:15px}
.unlinked-onboarding .note-time{display:block}
.unlinked-onboarding .note-state{color:var(--brand-d);font-weight:600}
.unlinked-onboarding .note .row-actions{margin-left:58px}
.unlinked-onboarding .note-summary{display:flex;gap:14px;align-items:center;padding:14px 18px;margin:8px 0 0;background:#fff;border:1px solid var(--line);border-radius:var(--r);color:var(--fg);text-decoration:none}
.unlinked-onboarding .note-summary span span{display:block}
@media(max-width:600px){.unlinked-onboarding .bcard{grid-template-columns:1fr}.unlinked-onboarding .bc-main{padding:20px 18px 18px}.unlinked-onboarding .bc-id{grid-template-columns:56px 1fr;gap:14px}.unlinked-onboarding .bc-av{width:56px;height:56px;font-size:19px}.unlinked-onboarding .bc-side{padding:18px}.unlinked-onboarding .bc-side .qr{max-width:220px}.unlinked-onboarding .req{grid-template-columns:44px 1fr}.unlinked-onboarding .req .row-actions{grid-column:2}.unlinked-onboarding .note{padding:12px 16px}.unlinked-onboarding .note .row-actions{margin-left:58px}.unlinked-onboarding nav .nav-ico{width:36px;height:36px}}
@media(max-width:900px){.unlinked-onboarding{padding:0 20px 30px}.unlinked-onboarding header{flex-wrap:wrap;gap:10px}.unlinked-onboarding .header-search{order:3;flex:1 0 100%;max-width:none}.unlinked-onboarding nav{gap:14px;font-size:14px;flex-wrap:wrap;margin-left:auto}.unlinked-onboarding .profile,.unlinked-onboarding .agentband{grid-template-columns:1fr}.unlinked-onboarding .land{grid-template-columns:1fr;gap:34px;padding-top:26px}.unlinked-onboarding .cta .button{width:100%}}
@media(max-width:600px){body:has(.unlinked-onboarding){font-size:16px}.unlinked-onboarding .me[open]>summary::before{background:rgba(16,24,40,.38)}.unlinked-onboarding .me-panel{position:fixed;left:0;right:0;top:auto;bottom:0;width:auto;padding:8px 0 calc(14px + env(safe-area-inset-bottom));border-radius:16px 16px 0 0;font-size:16px;box-shadow:0 -8px 32px rgba(16,24,40,.18)}.unlinked-onboarding .me-panel::before{content:"";display:block;width:36px;height:4px;margin:0 auto 8px;border-radius:2px;background:var(--line2)}.unlinked-onboarding .me-panel>a,.unlinked-onboarding .me .me-out{padding:14px 20px}.unlinked-onboarding .me-head{padding:8px 20px 16px}.unlinked-onboarding .scan-sheet{padding-top:18px}.unlinked-onboarding nav .hide-m{display:none}.unlinked-onboarding .panel,.unlinked-onboarding .card,.unlinked-onboarding .linkedin-lookup{padding:18px}.unlinked-onboarding .list{padding:4px 18px}.unlinked-onboarding .phead{padding:0 0 18px}}
@media(prefers-reduced-motion:reduce){.unlinked-onboarding *{scroll-behavior:auto;transition:none!important}}
.unlinked-onboarding .basic-marker{display:inline-flex;margin-left:5px;color:var(--muted);font-size:13px;vertical-align:middle;font-weight:400}
.unlinked-onboarding .sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
.unlinked-onboarding .depth-note{margin-top:12px}
.unlinked-onboarding .connection-filters{display:flex;flex-wrap:wrap;align-items:end;gap:12px;margin:20px 0}
.unlinked-onboarding .connection-filters label{display:grid;gap:6px;flex:1 1 200px;font-size:14px}
.unlinked-onboarding .connection-filters select{font:inherit;padding:11px;border:1px solid var(--line);border-radius:var(--r);background:#fff;color:var(--fg);min-height:44px}

/* Directory controls share the product's Public Sans, indigo, and quiet borders. */
.unlinked-onboarding:has([data-network]) header .header-search{display:none}
.unlinked-onboarding:has([data-network]) header nav{margin-left:auto}
.unlinked-onboarding .network-toolbar{background:#fff;border:1px solid var(--line2);border-radius:12px;padding:20px;margin:0 0 16px}
.unlinked-onboarding .network-scopes{gap:24px;border-bottom:1px solid var(--line);margin:-4px 0 18px;flex-wrap:wrap}
.unlinked-onboarding .network-scopes a{padding:10px 0;border-bottom:3px solid transparent}
.unlinked-onboarding .network-scopes a[aria-current]{border-color:var(--brand);font-weight:700;color:var(--brand-d)}
.unlinked-onboarding .network-scopes span{font-size:12px;border-radius:99px;background:var(--tint);padding:2px 6px}
.unlinked-onboarding .network-fields{display:flex;align-items:end;gap:14px;flex-wrap:wrap}
.unlinked-onboarding .network-fields label{margin:0;display:flex;flex-direction:column;gap:6px;font-size:14px;font-weight:600}
.unlinked-onboarding .network-query{flex:1;min-width:220px}
.unlinked-onboarding .network-fields input,.unlinked-onboarding .network-fields select{margin:0;width:100%;min-height:46px;border:1px solid var(--line2);border-radius:8px;background:#fff;padding:10px 12px;font:400 16px "Public Sans",system-ui,sans-serif;color:var(--fg)}
.unlinked-onboarding .network-fields select{padding-right:30px}
.unlinked-onboarding .network-fields input:focus-visible,.unlinked-onboarding .network-fields select:focus-visible,.unlinked-onboarding .network-segments a:focus-visible{outline:3px solid var(--brand);outline-offset:3px}
.unlinked-onboarding .network-filter-row{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-top:16px}
.unlinked-onboarding .network-segments{display:flex;gap:4px;flex-wrap:wrap;background:var(--page);border:1px solid var(--line);padding:4px;border-radius:9px;font-size:14px}
.unlinked-onboarding .network-segments a{padding:9px 12px;border-radius:6px;min-height:40px;text-decoration:none;color:var(--muted)}
.unlinked-onboarding .network-segments a:hover{background:var(--tint)}
.unlinked-onboarding .network-segments a[aria-current]{background:var(--brand);color:#fff;font-weight:600}
.unlinked-onboarding .network-reset{font-size:14px;margin-left:auto}
.unlinked-onboarding .network-count{min-height:22px;margin:14px 0}
.unlinked-onboarding [data-network-results][aria-busy=true]{opacity:.55}
.unlinked-onboarding .network-date{margin:4px 0}
.unlinked-onboarding details.sources{margin:4px 0;font-size:13px;color:var(--muted)}
.unlinked-onboarding details.sources summary{cursor:pointer;width:max-content;list-style:none}
.unlinked-onboarding details.sources summary::-webkit-details-marker{display:none}
.unlinked-onboarding details.sources summary::after{content:" ▸"}
.unlinked-onboarding details.sources[open] summary::after{content:" ▾"}
.unlinked-onboarding details.sources ul{margin:4px 0 0;padding-left:18px}
.unlinked-onboarding details.sources a{color:inherit}
.unlinked-onboarding [data-network-enhanced] .network-apply{display:none}
@media(max-width:600px){.unlinked-onboarding .network-toolbar{padding:14px}.unlinked-onboarding .network-query{min-width:100%}.unlinked-onboarding .network-sort{flex:1}.unlinked-onboarding .network-segments{width:100%;font-size:13px}.unlinked-onboarding .network-segments a{flex:1;text-align:center;padding:9px 5px}.unlinked-onboarding .network-reset{margin-left:0}}
.unlinked-onboarding .private-context{margin-top:16px;border-left:3px solid var(--brand)}
.unlinked-onboarding .private-context .pc-head{display:flex;align-items:center;gap:10px}
.unlinked-onboarding .private-context h3{margin:0}
.unlinked-onboarding .private-context .pc-only{display:inline-flex;font-size:12px;font-weight:600;color:var(--brand);background:var(--tint);border-radius:99px;padding:2px 8px;margin-left:auto;white-space:nowrap}
.unlinked-onboarding .private-context details{margin:0;padding:0;border:0}
.unlinked-onboarding .private-context summary{padding:0;display:flex;align-items:center;gap:6px;flex-wrap:wrap;cursor:pointer;min-height:32px;font-size:16px}
.unlinked-onboarding .private-context summary .small{margin:0}
.unlinked-onboarding .private-context h4{margin:14px 0 4px;font-size:15px}
.unlinked-onboarding .private-context h5{margin:14px 0 6px;font-size:13px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted)}
.unlinked-onboarding .private-context ul{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:8px}
.unlinked-onboarding .private-context li{padding:8px 10px;border:1px solid var(--line);border-radius:var(--r);background:var(--page);overflow-wrap:anywhere}
.unlinked-onboarding .private-context li p{margin:0;white-space:pre-wrap}
.unlinked-onboarding .private-context li .small{display:block;margin:4px 0 0;font-size:12px}
.unlinked-onboarding .private-context .pc-facts{margin:10px 0 0;font-size:14px;font-weight:600}
.unlinked-onboarding .private-context .pc-facts.due{color:#a3461b}
.unlinked-onboarding .private-context .pc-explore{margin-top:10px;min-height:36px}
.unlinked-onboarding .private-context .pc-hint{margin:14px 0 0;font-size:13px}
@media(max-width:600px){.unlinked-onboarding .private-context{margin-top:12px}}
`
