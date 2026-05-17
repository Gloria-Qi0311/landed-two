// Ambient types for the apps/extension content script.
//
// We don't pull in @types/chrome (~3 MB) — content.js touches a tiny slice
// of the chrome.* surface, and listing it explicitly here keeps the dep
// tree small + makes the contract visible.
//
// The window.ResumeFiller* globals are set by lib/*.js (IIFE wrappers
// loaded by the MV3 manifest before content.js). Their proper types live
// in packages/extension-core/src/*.js — until those gain JSDoc / .d.ts
// generation (Sprint 3 follow-up), the cross-module shape stays `any`
// here so type-checking content.js doesn't require typing the whole
// extension surface in one PR.

declare global {
  // ── chrome.* — just the slice content.js + popup.js + options.js use ──
  namespace chrome {
    namespace runtime {
      interface MessageSender {
        tab?: { id?: number; url?: string }
        frameId?: number
        id?: string
        url?: string
      }
      type MessageListener = (
        message: any,
        sender: MessageSender,
        sendResponse: (response?: any) => void,
      ) => boolean | void | Promise<any>
      const onMessage: {
        addListener(listener: MessageListener): void
        removeListener(listener: MessageListener): void
      }
      const lastError: { message?: string } | undefined
      function sendMessage<T = any>(message: any, callback?: (response: T) => void): void
      function getURL(path: string): string
    }
    namespace storage {
      interface StorageArea {
        get(
          keys: string | string[] | Record<string, any> | null,
          callback?: (items: Record<string, any>) => void,
        ): Promise<Record<string, any>>
        set(items: Record<string, any>, callback?: () => void): Promise<void>
        remove(keys: string | string[], callback?: () => void): Promise<void>
        clear(callback?: () => void): Promise<void>
      }
      const local: StorageArea
      const sync: StorageArea
    }
    namespace tabs {
      function query(query: any): Promise<any[]>
      function sendMessage<T = any>(tabId: number, message: any, callback?: (response: T) => void): void
    }
  }

  // ── window.ResumeFiller* — set by lib/*.js IIFEs ──
  // Typed as `any` for now; real types land when packages/extension-core
  // ships JSDoc + .d.ts generation. checkJs on content.js then gets the
  // benefit transitively.
  interface Window {
    ResumeFillerFieldDetect: any
    ResumeFillerValueMatch: any
    ResumeFillerCrossLingual: any
    ResumeFillerLabelClassifier: any
    ResumeFillerLLMMatch: any
    ResumeFillerLLMProviders: any
    ResumeFillerProfiles: any
    ResumeFillerValidators: any
    // Set by schema.js IIFE; consumed by content.js + options.js.
    normalizeResume: (input: any) => any
    flattenResumeForFill: (resume: any) => any
  }
}

// Required for the file to be treated as a module rather than a script.
export {}
