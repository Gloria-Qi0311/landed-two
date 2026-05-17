import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { App } from './App'
import './styles/globals.css'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Applications change rarely between sessions; 30s stale window is a
      // gentle balance between "live enough" + "no flicker on every nav".
      staleTime: 30 * 1000,
      // RLS errors aren't transient — don't burn retries on them.
      retry: (failureCount, error: any) => {
        const code = error?.code || error?.status;
        if (code === '42501' || code === 401 || code === 403) return false;
        return failureCount < 2;
      },
    },
  },
})

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </React.StrictMode>,
)
