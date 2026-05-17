// @landed/schema — canonical resume shape.
//
// Source of truth: AntaresYuan/resume-filler's schema.js (v2). Ported here
// to TS + zod so both apps/web (PDF upload + resume management) and
// apps/extension (auto-fill) consume the same shape — fixing the original
// duplication the merge in https://github.com/AntaresYuan/landed#decisions
// set out to eliminate.
//
// Conventions:
//   - Every field defaults to `''` (string) / `false` (bool) / `[]` (array)
//     so the same schema can parse partial input (LLM output) and fill in
//     blanks rather than reject.
//   - snake_case for date fields (start_date, end_date, apply_position)
//     matches the LLM prompt template ApplyMint already uses.
//   - `experience` and `internship` share an entry shape today; kept as
//     separate top-level arrays so the UI can group them differently.
import { z } from 'zod'

export const RESUME_SCHEMA_VERSION = 2

// ─── entry shapes ─────────────────────────────────────────────────────────

export const EducationEntrySchema = z.object({
  school: z.coerce.string().default(''),
  degree: z.coerce.string().default(''),
  major: z.coerce.string().default(''),
  gpa: z.coerce.string().default(''),
  start_date: z.coerce.string().default(''),
  end_date: z.coerce.string().default(''),
  location: z.coerce.string().default(''),
  description: z.coerce.string().default(''),
})
export type EducationEntry = z.infer<typeof EducationEntrySchema>

export const ExperienceEntrySchema = z.object({
  company: z.coerce.string().default(''),
  title: z.coerce.string().default(''),
  location: z.coerce.string().default(''),
  start_date: z.coerce.string().default(''),
  end_date: z.coerce.string().default(''),
  current: z.boolean().default(false),
  description: z.coerce.string().default(''),
})
export type ExperienceEntry = z.infer<typeof ExperienceEntrySchema>

// internship has the same shape as experience today; alias the type so
// callers can distinguish at the type level even if the runtime is identical.
export const InternshipEntrySchema = ExperienceEntrySchema
export type InternshipEntry = ExperienceEntry

export const ProjectEntrySchema = z.object({
  name: z.coerce.string().default(''),
  role: z.coerce.string().default(''),
  link: z.coerce.string().default(''),
  start_date: z.coerce.string().default(''),
  end_date: z.coerce.string().default(''),
  description: z.coerce.string().default(''),
})
export type ProjectEntry = z.infer<typeof ProjectEntrySchema>

// ─── section shapes ───────────────────────────────────────────────────────

export const BasicSchema = z.object({
  name: z.coerce.string().default(''),
  firstName: z.coerce.string().default(''),
  lastName: z.coerce.string().default(''),
  englishName: z.coerce.string().default(''),
  chineseName: z.coerce.string().default(''),
  email: z.coerce.string().default(''),
  phone: z.coerce.string().default(''),
  wechat: z.coerce.string().default(''),
  location: z.coerce.string().default(''),
  linkedin: z.coerce.string().default(''),
  github: z.coerce.string().default(''),
  portfolio: z.coerce.string().default(''),
})
export type Basic = z.infer<typeof BasicSchema>

export const IntentSchema = z.object({
  apply_position: z.coerce.string().default(''),
  salary: z.coerce.string().default(''),
  available_date: z.coerce.string().default(''),
  years_exp: z.coerce.string().default(''),
})
export type Intent = z.infer<typeof IntentSchema>

// ─── top-level resume ─────────────────────────────────────────────────────

export const ResumeSchema = z.object({
  version: z.literal(RESUME_SCHEMA_VERSION).default(RESUME_SCHEMA_VERSION),
  basic: BasicSchema.default(() => BasicSchema.parse({})),
  intent: IntentSchema.default(() => IntentSchema.parse({})),
  education: z.array(EducationEntrySchema).default([]),
  experience: z.array(ExperienceEntrySchema).default([]),
  internship: z.array(InternshipEntrySchema).default([]),
  projects: z.array(ProjectEntrySchema).default([]),
  skills: z.array(z.coerce.string()).default([]),
  languages: z.array(z.coerce.string()).default([]),
  summary: z.coerce.string().default(''),
})
export type Resume = z.infer<typeof ResumeSchema>

// ─── helpers ──────────────────────────────────────────────────────────────

/**
 * Returns a blank, fully-defaulted Resume. Useful as initial state for
 * forms before any LLM output / paste-back is available.
 */
export function emptyResume(): Resume {
  return ResumeSchema.parse({})
}

/**
 * Returns a blank entry for a given list section. Used by the options UI to
 * insert a new education / experience / internship / project row.
 */
export function blankEntry(
  section: 'education' | 'experience' | 'internship' | 'projects',
): EducationEntry | ExperienceEntry | ProjectEntry {
  switch (section) {
    case 'education':
      return EducationEntrySchema.parse({})
    case 'experience':
    case 'internship':
      return ExperienceEntrySchema.parse({})
    case 'projects':
      return ProjectEntrySchema.parse({})
  }
}

/**
 * Parse + normalize arbitrary input into a valid Resume. Missing fields get
 * defaults; wrong-type fields get dropped (zod throws on truly malformed
 * input, e.g. version mismatch). For LLM paste-back use `safeNormalize`.
 */
export function normalizeResume(input: unknown): Resume {
  return ResumeSchema.parse(input ?? {})
}

/**
 * Non-throwing variant. Returns `{ ok: true, resume }` on success or
 * `{ ok: false, error }` with a flattened zod error so the UI can render
 * field-by-field validation issues.
 */
export function safeNormalize(input: unknown):
  | { ok: true; resume: Resume }
  | { ok: false; error: z.ZodError } {
  const result = ResumeSchema.safeParse(input ?? {})
  if (result.success) return { ok: true, resume: result.data }
  return { ok: false, error: result.error }
}

/**
 * Whether the resume has any user-entered content. Used by the LoginScreen +
 * onboarding flow to decide whether to surface "upload your resume" CTAs.
 */
export function isResumeFilled(resume: Resume): boolean {
  const hasBasic = Object.values(resume.basic).some((v) => typeof v === 'string' && v.trim())
  const hasIntent = Object.values(resume.intent).some((v) => typeof v === 'string' && v.trim())
  const hasArrays =
    resume.education.length > 0 ||
    resume.experience.length > 0 ||
    resume.internship.length > 0 ||
    resume.projects.length > 0
  return hasBasic || hasIntent || hasArrays || resume.summary.trim() !== ''
}
