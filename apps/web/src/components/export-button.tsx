// "Export" on the Applications page: download the applications as a CSV
// spreadsheet (lib/export-csv.ts), from whichever store the account uses.
import { useState } from 'react'
import { Icon } from './primitives'
import { applicationsCsv } from '../lib/export-csv'
import { useStore } from '../lib/store'

export function ExportApplicationsButton() {
  const { store, ready } = useStore()
  const [busy, setBusy] = useState(false)
  const onExport = async () => {
    setBusy(true)
    try {
      const [apps, companies] = await Promise.all([store.listApplications(), store.listCompanies()])
      const url = URL.createObjectURL(new Blob([applicationsCsv(apps, companies)], { type: 'text/csv;charset=utf-8' }))
      const a = document.createElement('a')
      a.href = url
      const now = new Date()
      a.download = `landed-applications-${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}.csv`
      document.body.appendChild(a)
      a.click()
      a.remove()
      setTimeout(() => URL.revokeObjectURL(url), 10_000)
    } finally {
      setBusy(false)
    }
  }
  return (
    <button type="button" className="btn-secondary" disabled={!ready || busy} onClick={() => void onExport()}
      title="Download your applications as a spreadsheet (CSV: Excel, Numbers, Google Sheets)">
      <Icon name="download" size={13} /> {busy ? 'Exporting…' : 'Export'}
    </button>
  )
}
