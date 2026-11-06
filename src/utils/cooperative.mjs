// One implementation, two schedules. Heavy pure loops are written as
// generators that `yield` every few hundred iterations: `runSync` drives one
// to completion exactly as a plain function would, and `runAsync` gives the
// event loop a turn whenever a slice has run for `sliceMs`, so a cold-start
// build or a dataset validation never blocks every other request for seconds.
// Same steps, same result, same exceptions either way.
const turn = () => new Promise(resolve => setImmediate(resolve))
export function runSync(steps) {
  let step = steps.next()
  while (!step.done) step = steps.next()
  return step.value
}
export async function runAsync(steps, { sliceMs = 15 } = {}) {
  let started = performance.now(), step = steps.next()
  while (!step.done) {
    if (performance.now() - started >= sliceMs) { await turn(); started = performance.now() }
    step = steps.next()
  }
  return step.value
}
// `if (tick()) yield` inside a loop: true every `every` calls.
export const ticker = (every = 1024) => { let count = 0; return () => (++count & (every - 1)) === 0 }
