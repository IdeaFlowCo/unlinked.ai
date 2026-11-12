import test from 'node:test'
import assert from 'node:assert/strict'
import { renderPrivateList } from '../mcp-server/private-onboarding-views.mjs'
const props = { list: { id:'list1', name:'Example <list>' }, csrf:'test', members:[{ id:'one', name:'Ada <sample>', profileId:'ada', description:'Private context <script>sample</script>', email:'never-render@example.test', notes:'Never project arbitrary fields' }], nextCursor:'next' }
test('table uses explicit cells, escaped text, links, view title and scoped continuation', () => {
 const view=renderPrivateList({...props, view:'table'})
 assert.equal(view.title,'Example <list> · Table')
 assert.match(view.content, /<table role="table" class="private-members-table">/)
 assert.match(view.content, /<th role="columnheader" scope="col">Person<\/th><th role="columnheader" scope="col">Context/)
 assert.match(view.content, /<th role="rowheader" scope="row"><a href="\/people\/ada">Ada &lt;sample&gt;/)
 assert.match(view.content, /Private context &lt;script&gt;sample&lt;\/script&gt;/)
 assert.match(view.content, /href="\/lists\/private\/list1\?view=table&amp;after=next"/)
 assert.doesNotMatch(view.content, /never-render|Never project|<script>sample/)
})
test('list remains default; native switch preserves current page and query; search resets page', () => {
 const view=renderPrivateList({...props, after:'page2', query:'test & query'})
 assert.equal(view.title,'Example <list> · List')
 assert.match(view.content, /<article data-member-id="one">/)
 assert.match(view.content, /view=table&amp;after=page2&amp;q=test\+%26\+query/)
 assert.match(view.content, /type="hidden" name="view" value="list"/)
 assert.doesNotMatch(view.content.match(/<form method="get"[\s\S]*?<\/form>/)[0], /name="after"/)
 assert.doesNotMatch(view.content, /<table/)
})
test('full long context remains available without making every row a full biography', () => {
 const text='context '.repeat(100)
 const view=renderPrivateList({...props, members:[{id:'x',name:'Example',description:text}], view:'table'})
 const summary=view.content.match(/<summary>([\s\S]*?)<\/summary>/g).find(x=>x.includes('context'))
 const preview=summary.match(/<span class="list-context-preview">([^<]*)<\/span>/)[1]
 assert.ok(preview.length <= 181)
 assert.ok(view.content.includes('<p>'+text+'</p>'))
 assert.match(renderPrivateList({...props,members:[],nextCursor:null,view:'table'}).content,/This list has no people yet/)
 assert.doesNotMatch(renderPrivateList({error:'Unavailable',view:'table'}).content,/<table/)
})

test('short context appears once as plain text in both views; only long context needs disclosure', () => {
 for(const view of ['list','table']) {
  const page=renderPrivateList({...props,view,members:[{id:'s',name:'Short',description:'A brief professional context.'},{id:'l',name:'Long',description:'Detailed context. '.repeat(50)},{id:'e',name:'Empty'}]})
  assert.match(page.content, /<p class="list-context-text">A brief professional context\.<\/p>/)
  assert.equal(page.content.split('A brief professional context.').length-1,1)
  assert.equal((page.content.match(/<details class="list-context">/g)||[]).length,1)
  assert.match(page.content, /<span class="small">—<\/span>/)
 }
})
