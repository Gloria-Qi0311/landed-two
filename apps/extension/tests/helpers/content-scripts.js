// Load the autofill content script into the test's jsdom window the way the
// browser does: the files manifest.json lists, in that order. Portal parsers
// and the remote-AI libraries are left out (fill tests stub what they need).
// `before` runs right before content.js, e.g. to stub a portal parser.
const path = require('path')
const manifest = require('../../manifest.json')

const SKIP = [/^lib\/portal-parsers\//, /^lib\/llm-/]

function loadContentScripts({ before } = {}) {
  for (const file of manifest.content_scripts[0].js) {
    if (SKIP.some((re) => re.test(file))) continue
    if (file === 'content.js' && before) before()
    require(path.join(__dirname, '..', '..', file))
  }
}

module.exports = { loadContentScripts }
