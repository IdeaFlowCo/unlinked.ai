import { sameAccount, verifiedLinkEmail } from './account-links.mjs'

const prefix = '/settings/login-identities'
export const linkSettings = '/settings#login-identities'
export const isAccountLinkPath = path => path === prefix || path.startsWith(prefix + '/')
export const isAccountLinkMutation = path => path === prefix || path === prefix + '/confirm'
const challengeCookie = '__Host-ul-link-confirm'
const minutes = 5 * 60000
const matches = (account, identity) => account?.issuer === identity?.issuer && account?.subject === identity?.subject
const deny = () => new Error('account_link_not_allowed')

export function createAccountLinkFlow({ links, login, pending, token, cookie, cookies, body, render, redirect, html, coordinate, liveSession, onChange, switchScope }) {
  const challenges = new Map()
  const expire = map => { for (const [id, item] of map) if (item.expiresAt <= Date.now()) map.delete(id) }
  const start = async (response, flow) => {
    expire(pending)
    if (pending.size >= 100 || flow.expiresAt <= Date.now()) throw deny()
    const result = await login.begin({ prompt: 'login' })
    const id = token()
    pending.set(id, { ...result.transaction, linkFlow: flow, expiresAt: flow.expiresAt })
    response.setHeader('Set-Cookie', [cookie('__Host-ul-login', id, 300), cookie(challengeCookie, '', 0)])
    redirect(response, result.location)
  }
  const form = (endpoint, csrf, content) => `<form method="post" action="${endpoint}"><input type="hidden" name="csrf" value="${html(csrf)}">${content}</form>`
  const step = (response, title, content) => render(response, title, `${content}<p><a href="${linkSettings}">Cancel and return to Settings</a></p>`)

  async function finishProof(request, response, flow, identity, session) {
    const email = verifiedLinkEmail(identity)
    const sid = cookies(request)['__Host-ul-session']
    if (!session || sid !== flow.sid || !email || flow.expiresAt <= Date.now()) throw deny()
    if (flow.stage === 'primary') {
      if (!matches(flow.actor, identity)) throw deny()
      if (flow.action === 'self') {
        // A same-origin POST between provider hops makes the user choose to
        // proceed, even if the provider account picker remembers both logins.
        const id = remember(response, { ...flow, stage: 'between', primaryProof: proof(identity) })
        step(response, 'Verify your other login', `<p>Your primary login is <strong>${html(email)}</strong>. Sign in again with the other Unlinked account.</p>${form(prefix + '/other', session.csrf, `<input type="hidden" name="challenge" value="${html(id)}"><button>Verify other login</button>`)}`)
        return
      }
      confirm(response, session, { ...flow, primaryProof: proof(identity) })
      return
    }
    if (flow.stage !== 'secondary' || identity.issuer !== flow.actor.issuer) throw deny()
    const target = await links.route(identity)
    if (!target || !sameAccount(target.source, target.primary) || sameAccount(target.source, flow.actor) || links.isAdmin(target.source)) throw deny()
    confirm(response, session, { ...flow, secondary: target.source, secondaryProof: proof(identity) })
  }

  function proof(identity) {
    return { issuer: identity.issuer, subject: identity.subject, providerEmailVerified: true, verifiedEmail: verifiedLinkEmail(identity) }
  }

  function remember(response, flow) {
    expire(challenges)
    if (challenges.size >= 100) throw deny()
    const id = token()
    challenges.set(id, flow)
    response.setHeader('Set-Cookie', [cookie('__Host-ul-login', '', 0), cookie(challengeCookie, id, 300)])
    return id
  }

  function confirm(response, session, flow) {
    const id = remember(response, { ...flow, stage: 'confirm' })
    const primary = flow.action === 'admin' ? flow.primary.email : verifiedLinkEmail(flow.primaryProof)
    const secondary = verifiedLinkEmail(flow.secondaryProof) ?? flow.secondary.email
    const unlink = flow.action === 'unlink'
    const title = unlink ? 'Unlink this login?' : 'Link these accounts?'
    step(response, title, `<dl><dt>Primary login</dt><dd>${html(primary)}</dd><dt>${unlink ? 'Login to unlink' : 'Login to add'}</dt><dd>${html(secondary)}</dd></dl>
      <p>${unlink ? 'The other login will open a separate Unlinked account again, with its original records and changes made while viewing those records. Unlinked will sign out active sessions for these accounts.' :
        'Both logins will open the primary account. The other account’s connections, notes, files and settings will be available under its login in Settings. Unlinked will sign out active sessions for these accounts.'}</p>
      ${form(prefix + '/confirm', session.csrf, `<input type="hidden" name="challenge" value="${html(id)}"><button>${unlink ? 'Unlink login' : 'Link accounts'}</button>`)}`)
  }

  const handle = async (request, response, path, session) => {
    if (request.method !== 'POST' || !session) { response.writeHead(404).end(); return }
    const sid = cookies(request)['__Host-ul-session']
    const input = new URLSearchParams((await body(request, 4096)).toString('utf8'))
    if (input.getAll('csrf').length !== 1 || input.get('csrf') !== session.csrf) throw deny()
    const fields = (...allowed) => {
      if ([...new Set(input.keys())].some(key => key !== 'csrf' && (!allowed.includes(key) || input.getAll(key).length !== 1)) ||
          allowed.some(key => !input.has(key))) throw deny()
    }
    if (path === prefix + '/scope') {
      fields('owner')
      await switchScope(request, response, session, input.get('owner'))
      return
    }
    if (!links.manage) { response.writeHead(404).end(); return }
    if (path === prefix + '/confirm' || path === prefix + '/other') {
      fields('challenge')
      expire(challenges)
      const id = cookies(request)[challengeCookie], flow = challenges.get(id)
      if (!flow || flow.sid !== sid || id !== input.get('challenge') ||
          flow.stage !== (path.endsWith('/other') ? 'between' : 'confirm')) throw deny()
      challenges.delete(id)
      if (flow.stage === 'between') { await start(response, { ...flow, stage: 'secondary' }); return }
      const keys = [flow.actor, flow.primary, flow.secondary].map(owner => 'owner:' + owner.ownerId)
      const result = await coordinate(keys, async () => {
        if (flow.expiresAt <= Date.now() || !await liveSession(sid, session)) throw deny()
        const result = await links.change({ ...flow, expectedLinkId: flow.secondary.linkId })
        onChange(result)
        return result
      }, { exclusive: true })
      response.setHeader('Set-Cookie', cookie(challengeCookie, '', 0))
      if (flow.action === 'admin') redirect(response, '/settings?identities=linked#login-identities')
      else {
        response.setHeader('Set-Cookie', [cookie(challengeCookie, '', 0), cookie('__Host-ul-session', '', 0), cookie('__Host-ul-signed-out', '1', 300)])
        response.setHeader('Clear-Site-Data', '"cache"')
        step(response, flow.action === 'unlink' ? 'Login unlinked' : 'Accounts linked',
          `<p>${flow.action === 'unlink' ? 'Each login now opens its own account.' : 'Either login now opens your primary account.'}</p><p><a class="action" href="/login?switch=1&amp;next=/settings">Sign in to Unlinked</a></p>`)
      }
      return result
    }
    if (path !== prefix) { response.writeHead(404).end(); return }
    const action = input.get('action')
    const actor = await links.account(session.primary.ownerId)
    if (!sameAccount(actor, session.primary) || actor.epoch !== session.linkEpoch || actor.primaryOwnerId) throw deny()
    let primary = actor, secondary = null
    if (action === 'admin') {
      fields('action', 'primary', 'secondary')
      if (session.subject !== actor.subject || !links.isAdmin(actor)) throw deny()
      primary = await links.account(input.get('primary'))
      secondary = await links.account(input.get('secondary'))
      if (!primary?.email || !secondary?.email || primary.primaryOwnerId || secondary.primaryOwnerId ||
          sameAccount(primary, secondary) || links.isAdmin(primary) || links.isAdmin(secondary)) throw deny()
    } else if (action === 'unlink') {
      fields('action', 'secondary')
      secondary = await links.account(input.get('secondary'))
      if (!secondary || secondary.primaryOwnerId !== primary.ownerId || !secondary.linkId) throw deny()
    } else if (action === 'self') {
      fields('action')
      if (links.isAdmin(primary)) throw deny()
    } else throw deny()
    await start(response, { action, actor, primary, secondary, sid, stage: 'primary', expiresAt: Date.now() + minutes })
  }
  return { handle, finishProof }
}
