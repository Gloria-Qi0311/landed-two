// @landed/extension-core — barrel export.
//
// Pure-logic modules extracted from the ApplyMint extension (subtree-imported
// from AntaresYuan/resume-filler in Sprint 3, then ported from IIFE to ESM
// in issue #26). Consumers can import either the whole namespace
// (`import * as core from '@landed/extension-core'`) or a single subpath
// (`import { splitName } from '@landed/extension-core/cross-lingual'`).
//
// What's NOT here:
//   - field-detect — uses document.querySelector for label resolution;
//     stays in apps/extension/lib/ until a future PR splits the DOM glue
//     from the pure scoring logic.
//   - schema — superseded by @landed/schema (the typed zod Resume).
//     apps/extension/schema.js remains as the MV3 runtime version until
//     #29/#30 collapse popup/options onto the shared package.
export * as crossLingual from './cross-lingual.js'
export * as labelClassifier from './label-classifier.js'
export * as llmMatch from './llm-match.js'
export * as llmProviders from './llm-providers.js'
export * as profiles from './profiles.js'
export * as validators from './validators.js'
export * as valueMatch from './value-match.js'
