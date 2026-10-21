// The submit module is intentionally much stricter than form filling: it
// clicks one unmistakable final control only when nothing still needs a human.

beforeEach(() => {
  jest.resetModules()
  document.body.innerHTML = ''
  window.LandedFill = {
    deepAll: (selector) => Array.from(document.querySelectorAll(selector)),
    isRendered: () => true,
    detectApplyBlocker: () => null,
  }
  require('../../lib/fill/submit.js')
})

test('clicks exactly one unambiguous final submit control', () => {
  jest.useFakeTimers()
  document.body.innerHTML = '<form><input required value="Alex"><button type="button">Submit application</button></form>'
  const button = document.querySelector('button')
  const click = jest.spyOn(button, 'click').mockImplementation(() => {})
  expect(window.LandedFill.submitApplication()).toMatchObject({ ok: true, submitted: true })
  expect(click).not.toHaveBeenCalled()
  jest.runOnlyPendingTimers()
  expect(click).toHaveBeenCalledTimes(1)
  jest.useRealTimers()
})

test('never treats intermediate navigation as final submission', () => {
  document.body.innerHTML = '<button>Continue</button><button>Apply now</button><button>Review</button>'
  expect(window.LandedFill.submitApplication()).toMatchObject({ ok: false, blocker: { kind: 'submit' } })
})

test('required or flagged fields stop submission', () => {
  document.body.innerHTML = '<input required><button>Submit</button>'
  expect(window.LandedFill.submitApplication()).toMatchObject({ ok: false, blocker: { kind: 'answers' } })
  document.body.innerHTML = '<input value="check" data-landed-status="review"><button>Submit</button>'
  expect(window.LandedFill.submitApplication()).toMatchObject({ ok: false, blocker: { kind: 'review' } })
})

test('multiple submit controls are ambiguous', () => {
  document.body.innerHTML = '<button>Submit</button><button>Submit application</button>'
  expect(window.LandedFill.submitApplication()).toMatchObject({ ok: false, blocker: { kind: 'submit' } })
})
