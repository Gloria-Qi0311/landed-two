// Pure helpers for the menu-bar Apply Assist bridge. Kept separate from the
// service worker so browser snapshots and result summaries stay testable.
(function (global) {
  function browserLabel(userAgent, brave) {
    const ua = String(userAgent || '')
    if (/Edg\//.test(ua)) return 'Microsoft Edge'
    if (/OPR\//.test(ua)) return 'Opera'
    if (brave) return 'Brave'
    if (/Chrome\//.test(ua)) return 'Google Chrome'
    if (/Firefox\//.test(ua)) return 'Firefox'
    return 'Browser'
  }

  function publicTabs(tabs) {
    return (Array.isArray(tabs) ? tabs : [])
      .filter((tab) => Number.isInteger(tab && tab.id) && /^https?:\/\//i.test(tab.url || ''))
      .slice(0, 100)
      .map((tab) => ({
        id: tab.id,
        title: String(tab.title || 'Untitled page').slice(0, 300),
        url: String(tab.url).slice(0, 3000),
        active: !!tab.active,
      }))
  }

  function publicResumes(resumes) {
    return (Array.isArray(resumes) ? resumes : [])
      .filter((resume) => resume && typeof resume.id === 'string' && typeof resume.name === 'string')
      .slice(0, 50)
      .map((resume) => ({
        id: resume.id,
        name: resume.name.slice(0, 200),
        is_current: !!resume.is_current,
        created_at: typeof resume.created_at === 'string' ? resume.created_at.slice(0, 50) : '',
      }))
  }

  function fillSummary(results) {
    const list = Array.isArray(results) ? results : []
    const filled = list.reduce((sum, result) => sum + (Number(result && result.filled) || 0), 0)
    const review = list.reduce((sum, result) => sum + (Number(result && result.review) || 0), 0)
    const failed = list.filter((result) => !result || result.error).length
    return {
      filled,
      review,
      failed,
      summary: `${filled} filled · ${review} review${failed ? ` · ${failed} unavailable` : ''}`,
    }
  }

  global.LandedApplyAssistBridge = { browserLabel, publicTabs, publicResumes, fillSummary }
  if (typeof module !== 'undefined' && module.exports) module.exports = global.LandedApplyAssistBridge
})(typeof self !== 'undefined' ? self : globalThis)
