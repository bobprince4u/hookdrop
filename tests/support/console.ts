import type { TestContext } from 'node:test'

/**
 * Collects everything the code under test logs during one test.
 *
 * Two kinds of assertion need this, and neither can be made against a format string.
 *
 * The first is §23: the delivery log must carry every identifier an operator needs to trace a
 * failed webhook — job, event, destination, delivery, attempt, result — and must carry none of
 * the signing secret, the provider signature or the request body. That is a claim about the
 * bytes that were emitted, in both directions, so the output has to be read back.
 *
 * The second is the schedulers, where a log line is part of the contract rather than
 * decoration. A retention run that stops at its per-run cap with customer data still eligible,
 * or that finds a `users.plan` value the catalogue does not know about, has no return value
 * and no database effect to observe — the warning *is* the outcome, and it is what an operator
 * is expected to act on. A sweep that silently stopped early would look exactly like a sweep
 * that had finished.
 *
 * `t.mock` rather than the module-level `mock`: the real `console` is restored when the test
 * ends whether it passed or threw. A leaked sink swallows the rest of the file's output, which
 * turns the next genuine failure into a silent one.
 *
 * All three levels land in one buffer in call order. Which method a message went to is not
 * something any assertion here is about — the tests ask whether a fact was reported, and
 * splitting the buffer by level would only invite them to depend on a choice of `warn` over
 * `log` that carries no meaning.
 */
export const captureConsole = (t: TestContext): (() => string) => {
  const lines: string[] = []

  const sink = (...args: unknown[]): void => {
    lines.push(
      args
        .map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg)))
        .join(' ')
    )
  }

  t.mock.method(console, 'log', sink)
  t.mock.method(console, 'warn', sink)
  t.mock.method(console, 'error', sink)

  return () => lines.join('\n')
}
